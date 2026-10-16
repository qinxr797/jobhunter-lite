/**
 * 主循环。跑在侧边栏里（不是 service worker）—— MV3 的 service worker 空闲 30 秒就被杀，
 * 撑不住这种分钟级的长流程。侧边栏只要开着就一直活着，状态又全部落在 storage 里，
 * 关掉重开也不丢列表。
 *
 * v0.3.0 起分成两段，中间隔着你的审核（2026-09-24 你要求「不要无脑自动投，投之前我审一遍」）：
 *
 *   筛选 run()：扫列表 → 本地初筛 → 逐个进详情页 → 二筛（明文薪资）→ 模型按求职标准下结论
 *              → 不是「不投」的进筛选列表。**这一段一个按钮都不点。**
 *   发送 approve()：你在列表里按「投」→ 进发送排队 → 发送器一家一家发，每家之间照样按节奏间隔。
 *
 * 发送的点击和打字用 chrome.debugger 发真实输入事件（和手动跑通的纯 CDP 做法一样，不开 Runtime 域）。
 * 挂上 debugger 时 Chrome 顶部会出现「正在调试此浏览器」的提示条，属正常；点了提示条上的「取消」会让发送停下。
 */
import { getConfig, getRuntime, setRuntime } from './store.js';
import { prescreen, detailScreen, checkGreeting, workloadFlags, companyTier, cohortFlag, hrStale } from './scoring.js';
import { cohortOf } from './library.js';
import { evaluateJob, followupMessage } from './llm.js';
import { getArchive, recordChannel, appliedElsewhere, sameCompany, findEntry } from './company-archive.js';
import { readProgress } from './progress.js';

const CHAT_URL_RE = /zhipin\.com\/web\/geek\/chat/;

let stopSend = false;
let sending = false;   // 发送器在跑
// 正在跑的筛选，按平台分开：platformId -> { stop, detail }。
// 51job 不开详情页、只读接口，可以和别的平台同时筛；BOSS / 智联要占前台标签开详情页，这两个同一时间只能跑一个。
const runs = new Map();
const detailRunning = () => [...runs.values()].some((r) => r.detail);

/** 把标签放到前台。BOSS / 智联的列表滚动加载和详情页都要页面可见，后台标签不渲染、定时器被节流 */
async function front(me, tabId) {
  if (!tabId) return;
  if (me) me.focusTab = tabId;
  await chrome.tabs.update(tabId, { active: true }).catch(() => {});
}
/** 51job 这种不占前台的平台读完列表后，把前台还给正在开详情页的那个平台 */
async function handBackFront() {
  const d = [...runs.values()].find((r) => r.detail && r.focusTab);
  if (d) await front(null, d.focusTab);
}

export const isRunning = () => runs.size > 0;
export const runningPlatforms = () => [...runs.keys()];
export const isSending = () => sending;
export function requestStop() { for (const r of runs.values()) r.stop = true; stopSend = true; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

/** 可被「停止」打断的等待；顺便给发送器打心跳 */
async function waitSend(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end && !stopSend) {
    await beat();
    await sleep(Math.min(3000, end - Date.now()));
  }
}

/** 发送器心跳：别的侧边栏实例据此判断「发送中」是不是上次没跑完的残留。单独存一个 key，免得触发列表重画 */
const beat = () => chrome.storage.local.set({ senderBeat: Date.now() });

// ---------------------------------------------------------------- 真实输入（chrome.debugger）

const attached = new Set();
let detachedByUser = false;

chrome.debugger.onDetach.addListener((src, reason) => {
  attached.delete(src.tabId);
  if (reason === 'canceled_by_user') { detachedByUser = true; stopSend = true; }
});

const dbg = {
  async attach(tabId) {
    if (attached.has(tabId)) return;
    await chrome.debugger.attach({ tabId }, '1.3');
    attached.add(tabId);
    await sleep(700); // 提示条出现会让视口变矮，等布局稳定再量坐标
  },
  async detach(tabId) {
    if (!attached.has(tabId)) return;
    attached.delete(tabId);
    await chrome.debugger.detach({ tabId }).catch(() => {});
  },
  async detachAll() {
    for (const id of [...attached]) await dbg.detach(id);
  },
  send: (tabId, method, params = {}) => chrome.debugger.sendCommand({ tabId }, method, params),
  async clickAt(tabId, x, y) {
    await dbg.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await sleep(rand(80, 180));
    await dbg.send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await sleep(rand(60, 140));
    await dbg.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  },
  insertText: (tabId, text) => dbg.send(tabId, 'Input.insertText', { text }),
  async pressEnter(tabId) {
    await dbg.send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await sleep(rand(40, 90));
    await dbg.send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  },
};

// ---------------------------------------------------------------- 页面通信

/** 给内容脚本发消息。页面可能还没注入好，重试几次 */
async function tell(tabId, action, payload = {}, tries = 3, timeoutMs = 60000) {
  for (let i = 0; i < tries; i++) {
    try {
      let timer;
      const res = await Promise.race([
        chrome.tabs.sendMessage(tabId, { action, payload }),
        new Promise((_, bad) => { timer = setTimeout(() => bad(new Error(`页面 ${timeoutMs / 1000} 秒没回应（${action}）—— 多半是这个标签被切到后台了`)), timeoutMs); }),
      ]).finally(() => clearTimeout(timer));
      if (res !== undefined) return res;
    } catch (e) {
      if (/秒没回应/.test(e.message)) throw e;
      if (i === tries - 1) throw new Error(`页面没响应（${action}）：${e.message}`);
      // 内容脚本没起来，按网址手动注入对应平台的那一个
      try {
        const t = await chrome.tabs.get(tabId);
        const file = /51job\.com/.test(t.url || '') ? 'src/content/job51.js'
          : /zhaopin\.com/.test(t.url || '') ? 'src/content/zhilian.js' : 'src/content/agent.js';
        await chrome.scripting.executeScript({ target: { tabId }, files: [file] });
      } catch { /* 注入失败就靠下一轮重试 */ }
      await sleep(800);
    }
  }
  throw new Error(`页面没响应（${action}）`);
}

/** 等标签页加载完 */
async function waitLoaded(tabId, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error('标签页被关掉了');
    if (tab.status === 'complete') { await sleep(600); return tab; }
    await sleep(300);
  }
  throw new Error('页面加载超时');
}

/**
 * 找到聊天页所在的标签 —— 一般是工作标签原地跳过去，也兼容新开标签。
 * knownTabIds 是点击**之前**的标签快照：绝不去认你自己原本开着的聊天窗口，
 * 那样会把开场白发给另一个完全无关的 HR。
 */
async function findChatTab(workerTabId, knownTabIds, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const self = await chrome.tabs.get(workerTabId).catch(() => null);
    if (self && CHAT_URL_RE.test(self.url || '')) return workerTabId;
    const tabs = await chrome.tabs.query({ url: 'https://www.zhipin.com/*' });
    const fresh = tabs.find((t) => !knownTabIds.has(t.id) && CHAT_URL_RE.test(t.url || ''));
    if (fresh) return fresh.id;
    await sleep(500);
  }
  return null;
}

/**
 * 三个平台的差异都在这里（v0.4.0）：
 *   boss    BOSS 搜索结果页 → 逐个开详情页 → 按「投」= 立即沟通 + 发开场白
 *   51job   51job 搜索结果页 → 列表接口自带职位描述，不开详情页 → 按「投」= 点卡片上的「投递」
 *   zhilian 智联消息页 → HR 主动发来的新招呼 → 逐个开职位详情页 → 按「投」= 详情页「立即投递」
 */
const PLATFORMS = [
  { id: 'boss', name: 'BOSS直聘', re: /zhipin\.com\/web\/geek\/jobs/, scan: 'scanList', paged: true, detail: true },
  { id: '51job', name: '前程无忧', re: /we\.51job\.com\/pc\/search/, scan: 'scanList', paged: true, detail: false },
  { id: 'zhilian', name: '智联 HR 邀请', re: /i\.zhaopin\.com\/im/, scan: 'scanInvites', paged: false, detail: true },
];
export const platformOf = (url) => PLATFORMS.find((p) => p.re.test(url || '')) || null;
export const PLATFORM_NAMES = { boss: 'BOSS', '51job': '51job', zhilian: '智联', campus: '网申' };

/** 日志写进 runtime，侧边栏订阅 storage 变化自动刷新 */
async function log(level, text, extra = {}) {
  const entry = { at: Date.now(), level, text, ...extra };
  await setRuntime((rt) => ({ logs: [entry, ...(rt.logs || [])].slice(0, 300) }));
}

async function bumpStat(key) {
  await setRuntime((rt) => ({ stats: { ...rt.stats, [key]: (rt.stats[key] || 0) + 1 } }));
}

// ---------------------------------------------------------------- 筛选

/**
 * opts: { maxJobs:number, pages:number }
 * 只看、只评估，一个按钮都不点（BOSS 上点「立即沟通」那一下就会自动发出默认招呼语，收不回来）。
 */
export async function run(opts = {}) {
  // 1. 当前标签是哪个平台的哪一页
  const [listTab] = opts.tabId ? [await chrome.tabs.get(opts.tabId)] : await chrome.tabs.query({ active: true, currentWindow: true });
  const fu = opts.followup || null;   // v0.7.0 模块 C：网申后去 BOSS 找这家公司的 HR
  const P = platformOf(listTab?.url || '');
  if (!P) {
    const url = String(listTab?.url || '').slice(0, 80);
    throw new Error(`当前页面认不出来（${url || '没读到网址'}）。请停在这三种页面之一再点开始：BOSS 岗位搜索结果页 / 51job 搜索结果页（we.51job.com/pc/search）/ 智联「消息」页`);
  }
  if (runs.has(P.id)) throw new Error(`${P.name} 已经在筛了，等它筛完`);
  if (P.detail && detailRunning()) {
    const other = PLATFORMS.find((x) => runs.get(x.id)?.detail);
    throw new Error(`${other?.name || '别的平台'} 正在开详情页筛，${P.name} 也要占前台标签，等它筛完再点（51job 不受影响，随时可以同时筛）`);
  }
  if (P.detail && sending) throw new Error('正在发送你按了「投」的岗位，等它发完再筛（开详情页和发送都要占前台标签页）');
  const me = { stop: false, detail: P.detail };
  runs.set(P.id, me);

  let workerTabId = null;

  try {
    const config = await getConfig();
    if (!config.apiKey) throw new Error('没填 API Key，先去设置页填');
    if (!config.resume?.name && !config.resume?.rawText) throw new Error('还没录入简历，先去设置页导入 config.json');

    await log('info', `开始筛选 ${P.name}（只看不点，筛完进列表等你审）`);

    const collected = new Map(); // jobId -> job，滚动加载后会重复扫到前面的卡片
    const pages = Math.max(1, opts.pages || 1);

    for (let p = 0; p < (P.paged ? pages : 1); p++) {
      if (me.stop) break;
      if (P.detail) await front(me, listTab.id);
      const scan = await tell(listTab.id, P.scan, { pages });
      if (scan.error && p === 0) throw new Error(scan.error);
      if (scan.error) { await log('warn', `第 ${p + 1} 页没读到：${scan.error}`); break; }
      if (scan.end) { await log('info', `第 ${p + 1} 页是空的，搜索结果翻到头了`); break; }
      const before = collected.size;
      for (const j of scan.jobs) if (!collected.has(j.jobId)) collected.set(j.jobId, j);
      await log('info', `${P.paged ? `第 ${p + 1} 页` : P.name}：新扫到 ${collected.size - before} 个岗位`);
      if (P.paged && p < pages - 1) {
        if (P.detail) await front(me, listTab.id);
        const np = await tell(listTab.id, 'nextPage');
        if (!np.ok) { await log('warn', `加载更多停止：${np.reason}`); break; }
        await sleep(rand(2000, 4000));
      }
    }

    if (!P.detail) await handBackFront();

    // 51job / 智联：筛之前现读一遍平台投递记录（刚代投的也算上），后面去重和清待审都用这份
    if (P.id === '51job' || P.id === 'zhilian') await readProgress({ fresh: true }).catch(() => {});
    await pruneStaleQueued();

    // 2. 去重 + 本地初筛
    const rt0 = await getRuntime();
    const seen = cleanPrescreenSeen(rt0);
    const listed = new Set((rt0.queue || []).map((q) => q.job.jobId));

    const candidates = [];
    let skipped = 0;
    for (const job of collected.values()) {
      // 网申补一句：只看这家公司的岗位；以前看过的也重新看（那时还没网申）
      if (fu && !sameCompany(job.company, fu.company)) { skipped++; continue; }
      if ((!fu && seen[job.jobId]) || listed.has(job.jobId)) { skipped++; continue; }
      // v1.2.4：去重记录丢了（10/16 存储被清过）也不怕，51job / 智联再对一遍平台投递记录
      const prior = await appliedOnPlatform(job);
      if (prior) {
        skipped++; seen[job.jobId] = Date.now();
        await log('info', `之前已投过：${job.title} @ ${job.company}（${prior.appliedAt || '平台投递记录里有'}）`);
        continue;
      }
      const pre = prescreen(job, config);
      if (!pre.pass) {
        skipped++;
        await log('info', `初筛淘汰：${job.title} @ ${job.company} —— ${pre.reason}`);
        continue;
      }
      candidates.push(job);
    }
    await setRuntime({ seen });
    await log('info', `初筛：${collected.size} 个岗位 → ${candidates.length} 个进${P.detail ? '详情页' : '模型评估'}，${skipped} 个看过/淘汰`);

    if (!candidates.length) {
      await log(fu ? 'warn' : 'info', fu ? `BOSS 没搜到「${fu.company}」在招的岗位（或者都已经在列表里了）` : '没有需要看的新岗位，结束');
      return { listed: 0, found: 0 };
    }

    // 3. 逐个看详情。工作标签放前台 —— 后台标签的页面有些内容不渲染
    //    51job 的列表接口已经带职位描述，不用开详情页
    const limit = Math.min(candidates.length, opts.maxJobs || candidates.length);
    if (P.detail) {
      const worker = await chrome.tabs.create({
        url: candidates[0].href, active: true, windowId: listTab.windowId, index: listTab.index + 1,
      });
      workerTabId = worker.id;
      me.focusTab = workerTabId;
    }

    let listedThisRun = 0;

    for (let i = 0; i < limit; i++) {
      if (me.stop) { await log('warn', '收到停止指令'); break; }
      const job = candidates[i];

      try {
        let full = { ...job, platform: P.id };
        if (P.detail) {
          // 3a. 进详情页
          if (i > 0) await chrome.tabs.update(workerTabId, { url: job.href, active: true });
          await waitLoaded(workerTabId);

          await front(me, workerTabId);
          const detail = await tell(workerTabId, 'readDetail');
          if (detail.guard?.blocked) {
            await log('error', detail.error);
            if (config.pace.stopOnCaptcha) break;
          }
          if (detail.error) { await log('warn', `${job.title}：${detail.error}`); continue; }
          if (detail.alreadyChatted) {
            await log('info', `${job.title} @ ${job.company}：之前已沟通/已投递，跳过`);
            await markSeen(job.jobId);
            continue;
          }
          // 列表里的公司名是品牌简称，聊天页顶部显示的也是它，发送时核对聊天对象要用这个
          full = { ...job, ...detail, platform: P.id, company: job.company || detail.company, jobId: job.jobId, href: job.href };
        }

        // 3b. 二筛：详情页薪资是明文，这时候才能卡薪资
        const ds = detailScreen(full, config);
        if (!ds.pass) {
          await markSeen(job.jobId);
          await bumpStat('skipped');
          await log('info', `二筛淘汰：${full.title} @ ${full.company} ${full.salary} —— ${ds.reason}`);
          continue;
        }

        // 3c. 模型按求职标准下结论
        const ev = await evaluateJob(full, config);
        await bumpStat('evaluated');
        const gc = checkGreeting(ev.greeting, config);
        ev.greeting = gc.text;
        if (gc.problems.length && ev.verdict !== '不投') ev.red_flags = [...ev.red_flags, `开场白：${gc.problems.join('；')}`];
        // 卷不卷：模型会漏看福利标签，本地按字眼再标一遍；硬信号把「投」降成「等你定」
        const stale = hrStale(full.hrActive);
        if (stale) ev.red_flags = [stale, ...ev.red_flags];
        const wl = workloadFlags(full);
        if (wl.flags.length) ev.red_flags = [...wl.flags, ...ev.red_flags];
        if (wl.downgrade && ev.verdict === '投') ev.verdict = '等你定';
        // 公司档次：平台写明的人数/上市/国企为准，写不明的用模型的判断（模型认得出名企业）
        const cohort = cohortFlag(full, cohortOf(config.resume?.graduation));
        // 届别对不上的只标出来，不降级
        if (cohort) ev.red_flags = [cohort, ...ev.red_flags];
        const ct = companyTier(full);
        ev.company_tier = ct.tier !== '看不出' ? ct.tier : ev.company_tier;
        ev.tier_why = ct.tier !== '看不出' ? ct.why : '';
        if (/对不上/.test(ct.why)) ev.red_flags = [ct.why, ...ev.red_flags];
        // 小公司不自动降级，档次只用来排序

        // 公司档案（模块 C）：别的渠道投过的标出来
        const elsewhere = appliedElsewhere(await getArchive(), full.company, P.id);
        // 同一渠道同一家公司已经联系过（别的岗位）：BOSS 上重复打招呼 HR 会烦，标出来（参考 boss-helper「同公司跳过」）
        const same = findEntry(await getArchive(), full.company)?.[1]?.ch?.[P.id];
        if (same) { const d = new Date(same.at); ev.red_flags = [`这家 ${d.getMonth() + 1}/${d.getDate()} 已在 ${PLATFORM_NAMES[P.id]} 联系过（${same.title || '别的岗位'}），别重复`, ...ev.red_flags]; if (ev.verdict === '投') ev.verdict = '等你定'; }
        if (elsewhere) { ev.elsewhere = elsewhere; ev.red_flags = [elsewhere, ...ev.red_flags]; }
        // 网申补一句：开场白换成「已在官网投了 XX」那版
        if (fu && ev.verdict !== '不投') {
          try {
            const msg = await followupMessage(full, fu, config);
            const gc2 = checkGreeting(msg, config);
            ev.greeting = gc2.text;
            ev.followup = fu;
            ev.red_flags = [`网申后补一句：${fu.date} 已在官网投了「${fu.position || fu.company}」`, ...ev.red_flags.filter((f) => !/^开场白：/.test(f)), ...(gc2.problems.length ? [`开场白：${gc2.problems.join('；')}`] : [])];
          } catch (e) { ev.red_flags = [`网申后补一句的消息没起草成（${e.message}），用的是普通开场白`, ...ev.red_flags]; }
        }

        const score = ev.match_score;
        const label = `${full.title} @ ${full.company} ${full.salary}`;
        const why = [...ev.veto, ...ev.reasons].join('；');

        // 3d. 分流：不投的丢掉，其余进列表等你审
        if (ev.verdict === '不投') {
          await markSeen(job.jobId);
          await bumpStat('skipped');
          await log('info', `不投（${ev.priority}，${score}分）：${label} —— ${why}`);
        } else if (ev.verdict === '等你定' || score >= config.thresholds.askMe || fu) {
          await enqueue(full, ev);
          listedThisRun++;
          await log('ask', `进列表（${ev.verdict}，${ev.company_tier}，${ev.priority}，${score}分）：${label}`);
        } else {
          await markSeen(job.jobId);
          await bumpStat('skipped');
          await log('info', `匹配分太低没进列表（${score}分）：${label} —— ${why}`);
        }
      } catch (e) {
        await log('error', `${job.title}：${e.message}`);
        // 接口报错（余额、鉴权）没必要继续烧
        if (/HTTP 40[13]|api key|余额|credit|insufficient/i.test(e.message)) break;
      }

      // 只看详情页，歇一小会就行（模型评估本身也要 10~60 秒）；51job 不开页面，不用歇
      if (i < limit - 1 && !me.stop) await sleep(P.detail ? rand(4000, 9000) : rand(500, 1500));   // 9/28 模型换 DeepSeek 后只剩这点间隔，还留着防 BOSS 风控
    }

    await log('ok', `${P.name} 本轮筛完：新进列表 ${listedThisRun} 家，去「岗位」里审`);
    return { listed: listedThisRun, found: candidates.length };
  } catch (e) {
    await log('error', `${P.name} 筛选中断：${e.message}`);
    throw e;
  } finally {
    runs.delete(P.id);
    if (workerTabId) await chrome.tabs.remove(workerTabId).catch(() => {});
    if (P.detail && listTab) await chrome.tabs.update(listTab.id, { active: true }).catch(() => {});
  }
}

/**
 * v0.5.2 一次性清理：以前初筛淘汰的岗位也记进了去重，关键词大小写的 bug（「ai产品经理」被当成不含 AI）
 * 误伤的岗位就再也不出现了。初筛淘汰是一个循环里成批写的，时间戳挤在几毫秒内；
 * 模型评估过的是一家一家写的，间隔十几秒以上。把成批的那些删掉，评估过的留着（不重复花钱）。
 */
function cleanPrescreenSeen(rt) {
  const seen = { ...(rt.seen || {}) };
  if (rt.seenCleanV052) return seen;
  // v1.2.5（10/16）：这段清理早就跑过了，不再跑。存储被清空后标记也会没，这时候成批写回来的去重记录
  // 时间戳全挤在一起，会被当成「初筛淘汰」删掉（283 条删剩 148 条）。现在只补上标记，不删任何记录
  if (Object.keys(seen).length) { setRuntime({ seenCleanV052: true }); return seen; }
  const ts = Object.values(seen).sort((a, b) => a - b);
  const crowded = (t) => { const i = ts.indexOf(t); return (i > 0 && t - ts[i - 1] < 30) || (i < ts.length - 1 && ts[i + 1] - t < 30); };
  let n = 0;
  for (const [id, t] of Object.entries(seen)) if (crowded(t)) { delete seen[id]; n++; }
  setRuntime({ seen, seenCleanV052: true }).then(() => n && log('info', `去重记录里清掉 ${n} 个以前初筛淘汰的岗位，按新规则重新过一遍`));
  return seen;
}

// ---------------------------------------------------------------- 列表条目

async function markSeen(jobId) {
  await setRuntime((rt) => ({ seen: { ...rt.seen, [jobId]: Date.now() } }));
}

async function enqueue(job, ev) {
  await setRuntime((rt) => ({
    queue: [...(rt.queue || []).filter((q) => q.job.jobId !== job.jobId),
      { job, ...ev, status: '待审核', error: '', greetedDefault: false, addedAt: Date.now() }],
  }));
}

/** 改列表里某一条（按 jobId，不按下标 —— 发送器在后台增删条目，下标会变） */
async function updateItem(jobId, patch) {
  await setRuntime((rt) => ({ queue: (rt.queue || []).map((q) => (q.job.jobId === jobId ? { ...q, ...patch } : q)) }));
}

async function recordSent(item, chatSalary) {
  const job = item.job;
  await recordChannel(job.company, job.platform || 'boss', { title: job.title }).catch(() => {});
  await setRuntime((rt) => ({
    seen: { ...rt.seen, [job.jobId]: Date.now() },
    queue: (rt.queue || []).filter((q) => q.job.jobId !== job.jobId),
    done: [
      { jobId: job.jobId, title: job.title, company: job.company, salary: job.salary, chatSalary: chatSalary || '',
        score: item.match_score, verdict: item.verdict, priority: item.priority, variantId: item.variant_id,
        greeting: (job.platform || 'boss') === 'boss' ? item.greeting : '', platform: job.platform || 'boss', href: job.href, at: Date.now() },
      ...(rt.done || []),
    ].slice(0, 200),
    // stats.sent 只数 BOSS 的招呼（每天上限管的是它）；51job / 智联从 done 里按平台数
    stats: { ...rt.stats, sent: rt.stats.sent + ((job.platform || 'boss') === 'boss' ? 1 : 0) },
  }));
}

/**
 * v1.2.3（10/16）：待审里放了几天的岗位，期间你可能在平台上手动投过，插件不知道。
 * 拿 51job「我的申请」/ 智联「求职反馈」（progress.js，缓存 30 分钟）对一遍，按岗位 ID 或「公司 + 岗位名」认。
 * 读不到进度就当没投过，不拦。BOSS 没有这种列表，不查。
 */
const normCo = (s) => String(s || '').replace(/\s|（.*?）|\(.*?\)|有限公司|有限责任公司|股份/g, '');
const normTi = (s) => String(s || '').replace(/\s/g, '');
async function appliedOnPlatform(job, { fresh = false } = {}) {
  const plat = job.platform || 'boss';
  if (plat !== '51job' && plat !== 'zhilian') return null;
  const prog = await readProgress({ fresh }).catch(() => null);
  const items = (plat === '51job' ? prog?.job51?.items : prog?.zhilian?.items) || [];
  const id = String(job.rawId || job.jobId || '');
  const co = normCo(job.company), ti = normTi(job.title);
  return items.find((p) => (id && p.jobId && String(p.jobId) === id)
    || (co && normCo(p.company) === co && normTi(p.title) === ti)) || null;
}

/** 之前已经投过的：移出列表、记进去重和公司档案，不算今天投的、不占上限、不进「已投」 */
async function recordAlready(item, appliedAt = '') {
  const job = item.job;
  const at = Date.parse(String(appliedAt).replace(' ', 'T'));
  await recordChannel(job.company, job.platform || 'boss', { title: job.title, ...(Number.isFinite(at) ? { at } : {}) }).catch(() => {});
  await setRuntime((rt) => ({
    seen: { ...rt.seen, [job.jobId]: Date.now() },
    queue: (rt.queue || []).filter((q) => q.job.jobId !== job.jobId),
  }));
}

/** 筛选开始时：待审里的 51job / 智联岗位，在平台上已经投过的扫掉（v1.2.4 不再只看放了 3 天以上的） */
async function pruneStaleQueued() {
  const old = ((await getRuntime()).queue || []).filter((q) => q.status === '待审核'
    && ['51job', 'zhilian'].includes(q.job.platform));
  let n = 0;
  for (const q of old) {
    const prior = await appliedOnPlatform(q.job);
    if (prior) { await recordAlready(q, prior.appliedAt); n++; }
  }
  if (n) await log('info', `待审里 ${n} 个岗位在平台上已经投过了（你在平台上投过的），已从列表拿掉`);
}

/** 你按「不投」：从列表拿掉，记进去重，下次筛选不再出现 */
export async function dropQueued(jobId) {
  const rt = await getRuntime();
  const item = (rt.queue || []).find((q) => q.job.jobId === jobId);
  if (item && (item.status === '发送中')) throw new Error('这家正在发，等它发完');
  await setRuntime((cur) => ({
    queue: (cur.queue || []).filter((q) => q.job.jobId !== jobId),
    seen: { ...cur.seen, [jobId]: Date.now() },
  }));
}

/** 排队的撤回成待审核 */
export async function unapprove(jobId) {
  const rt = await getRuntime();
  const item = (rt.queue || []).find((q) => q.job.jobId === jobId);
  if (item?.status === '排队') await updateItem(jobId, { status: '待审核' });
}

/**
 * 侧边栏打开时调用：上次侧边栏被关掉时还在「排队 / 发送中」的，改回来。
 * 心跳 30 秒内还在跳，说明别的窗口的侧边栏正在发，不动它。
 */
export async function resetStale() {
  const { senderBeat = 0 } = await chrome.storage.local.get('senderBeat');
  if (Date.now() - senderBeat < 30000) return;
  const rt = await getRuntime();
  if (!(rt.queue || []).some((q) => q.status === '排队' || q.status === '发送中')) return;
  await setRuntime({
    queue: rt.queue.map((q) => {
      if (q.status === '排队') return { ...q, status: '待审核', error: '上次侧边栏关掉时还没轮到它，要投的话再按一次「投」' };
      if (q.status === '发送中') {
        return { ...q, status: '失败', greetedDefault: true,
          error: '上次发到一半侧边栏被关了，默认招呼可能已经发出去 —— 去 BOSS 聊天页看一眼，没发就在那边手动发' };
      }
      return q;
    }),
  });
}

// ---------------------------------------------------------------- 发送（你按了「投」之后）

/** 你按「投」：复查开场白 → 进发送排队 → 叫醒发送器 */
export async function approve(jobId, editedGreeting) {
  const config = await getConfig();
  const rt = await getRuntime();
  const item = (rt.queue || []).find((q) => q.job.jobId === jobId);
  if (!item) throw new Error('列表里没有这一项');
  const isBoss = (item.job.platform || 'boss') === 'boss';
  if (item.greetedDefault) {
    throw new Error(isBoss ? '这家的默认招呼已经发过了，去 BOSS 聊天页手动补开场白，补完按「不投」把它拿掉'
      : '这家可能已经投过了，去页面上确认一下，确认后按「不投」把它拿掉');
  }
  if (item.status === '排队' || item.status === '发送中') return;

  // 51job / 智联只投简历、不发开场白，不用复查
  let greeting = item.greeting;
  if (isBoss) {
    const gc = checkGreeting(editedGreeting ?? item.greeting, config);
    if (gc.problems.length) throw new Error(`开场白有问题，改了再投：${gc.problems.join('；')}`);
    greeting = gc.text;
  }

  await updateItem(jobId, { status: '排队', greeting, approvedAt: Date.now(), error: '' });
  sendWorker(); // 不等它，发送器在后台一家一家发
}

/** 发送器：同一时间只有一个，按你按「投」的先后顺序发，每家之间按节奏间隔 */
async function sendWorker() {
  if (sending) return;
  sending = true;
  stopSend = false;
  detachedByUser = false;
  let sentThisRound = 0;

  try {
    for (;;) {
      if (stopSend) break;
      await beat();
      if (detailRunning()) { await sleep(3000); continue; } // BOSS / 智联筛选占着前台标签，等它筛完（51job 筛选不占）

      const rt = await getRuntime();
      const config = await getConfig();
      const isBoss = (q) => (q.job.platform || 'boss') === 'boss';
      const full = rt.stats.sent >= config.pace.dailyLimit;
      if (full && (rt.queue || []).some((q) => q.status === '排队' && isBoss(q))) {
        await log('warn', `BOSS 今日上限 ${config.pace.dailyLimit} 个已经发满，排队的 BOSS 岗位改回待审核，明天再投`);
        await setRuntime((cur) => ({ queue: cur.queue.map((q) => (q.status === '排队' && isBoss(q) ? { ...q, status: '待审核', error: '今天的上限发满了' } : q)) }));
      }
      const next = (rt.queue || []).filter((q) => q.status === '排队' && !(full && isBoss(q))).sort((a, b) => a.approvedAt - b.approvedAt)[0];
      if (!next) break;

      // 发之前先对平台投递记录（51job「我的申请」/ 智联「求职反馈」），之前投过的直接拿掉，不开页面、不占上限
      const prior = await appliedOnPlatform(next.job);
      if (prior) {
        await recordAlready(next, prior.appliedAt);
        await log('info', `之前已投过，跳过：${next.job.title} @ ${next.job.company}（${prior.appliedAt || '平台投递记录里有'}，${prior.status || '已投递'}）`);
        continue;
      }

      await updateItem(next.job.jobId, { status: '发送中' });
      const res = await sendOne(next);
      const label = `${next.job.title} @ ${next.job.company}`;

      if (res.already) {
        await recordAlready(next);
        await log('info', `之前已投过，跳过：${label}（${res.note}），不算今天投的`);
        continue;
      }
      if (res.ok) {
        sentThisRound++;
        await recordSent(next, res.chatSalary);
        await log('ok', `已投：${label}${res.chatSalary ? `，聊天页薪资 ${res.chatSalary}` : ''}`, { greeting: next.greeting });
      } else {
        await updateItem(next.job.jobId, { status: '失败', error: res.error, greetedDefault: Boolean(res.greetedDefault) });
        await log('error', `没投成：${label} —— ${res.error}`);
      }

      // 验证码 / 限流 / 窗口被挡 / 你点了调试提示条的「取消」：停下，别硬来
      const hardStop = (res.guard?.blocked && config.pace.stopOnCaptcha) || res.hidden || detachedByUser;
      if (hardStop) {
        const why = res.guard?.msg || (res.hidden ? 'Chrome 窗口被挡住了' : '你点了调试提示条上的「取消」');
        await log('error', `发送暂停：${why}`);
        stopSend = true;
        break;
      }

      // 节奏：还有排队的就歇一会再发下一家
      const left = ((await getRuntime()).queue || []).some((q) => q.status === '排队');
      if (left && !stopSend) {
        if (sentThisRound > 0 && sentThisRound % config.pace.batchSize === 0) {
          await log('info', `连发 ${config.pace.batchSize} 个，歇 ${Math.round(config.pace.longRestMs / 60000)} 分钟再发下一家`);
          await waitSend(config.pace.longRestMs);
        } else {
          const d = rand(config.pace.minDelayMs, config.pace.maxDelayMs);
          await log('info', `${Math.round(d / 1000)} 秒后发下一家`);
          await waitSend(d);
        }
      }
    }
  } finally {
    sending = false;
    await dbg.detachAll();
    if (stopSend) {
      // 停下时还在排队的改回待审核，免得你以为还会发
      await setRuntime((rt) => ((rt.queue || []).some((q) => q.status === '排队')
        ? { queue: rt.queue.map((q) => (q.status === '排队' ? { ...q, status: '待审核', error: '发送停了，要投再按一次' } : q)) }
        : null));
    }
    await chrome.storage.local.set({ senderBeat: 0 });
    // 发送器正要收工时你又按了「投」：那一条 sendWorker() 见 sending=true 直接返回了，这里补叫一次，免得卡在「排队」
    if (!stopSend && ((await getRuntime()).queue || []).some((q) => q.status === '排队')) {
      const { pace } = await getConfig();
      const rt = await getRuntime();
      const blocked = rt.stats.sent >= pace.dailyLimit && rt.queue.every((q) => q.status !== '排队' || (q.job.platform || 'boss') === 'boss');
      if (!blocked) setTimeout(() => sendWorker().catch(() => {}), 0);
    }
  }
}

/** 开一个前台标签发一家，发完关掉、切回原来的标签 */
async function sendOne(item) {
  const [cur] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  let tab = null;
  const plat = item.job.platform || 'boss';
  try {
    // 三个平台都开职位详情页去点（51job 搜索排序每次都变，回搜索页找不回原来的卡片）
    const url = item.job.href;
    tab = await chrome.tabs.create({ url, active: true, ...(cur ? { windowId: cur.windowId } : {}) });
    await waitLoaded(tab.id);
    if (plat === 'boss') { const r = await doGreet(tab.id, item.greeting, item.job); if (r.keepTab) tab = null; return r; }
    return await doApply(tab.id, item, await getConfig());
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    await dbg.detachAll();
    if (tab) await chrome.tabs.remove(tab.id).catch(() => {});
    if (cur) await chrome.tabs.update(cur.id, { active: true }).catch(() => {});
  }
}

/** 变体 id → 附件简历在平台上的名字（如「张三-新媒体运营」），投递弹窗让选附件时用 */
function attachmentName(config, variantId) {
  const v = (config.variants || []).find((x) => x.id === variantId) || (config.variants || [])[0];
  const m = (v?.note || '').match(/([^\s：:]+)\.pdf/);
  return m ? m[1] : '';
}

/**
 * 51job / 智联投递：点「投递 / 立即投递」→ 有弹窗就按顺序处理（选对应附件 → 确认）→ 看到投递成功才算。
 * 返回 { ok, error, greetedDefault(=可能已经投出去，别再点), guard, hidden }
 *
 * 注意：这两个平台投递后的弹窗 2026-09-27 没实测过（点一下就是真投），这里按常见样子处理；
 * 遇到不认识的弹窗就停下来标出来，不瞎点。
 */
async function doApply(tabId, item, config) {
  await dbg.attach(tabId);
  const g0 = await tell(tabId, 'guardCheck');
  if (g0.blocked) return { ok: false, error: g0.msg, guard: g0 };
  if (g0.hidden) return { ok: false, hidden: true, error: 'Chrome 窗口被最小化或被完全挡住了，弹窗不会出来。把窗口露出来再按「投」' };

  const jobKey = item.job.rawId || item.job.jobId;
  const btn = await tell(tabId, 'locateApply', { jobId: jobKey });
  if (!btn.found) return { ok: false, error: btn.error || '找不到投递按钮', guard: btn.guard };
  // 还没点就显示「已投递」= 以前投过的，不是这次投成的（10/16：被当成刚投出，还占了上限）
  if (btn.applied) return { ok: true, already: true, note: '页面显示已经投递过' };

  await sleep(rand(600, 1400));
  await dbg.clickAt(tabId, btn.x, btn.y);
  await sleep(2500);
  // 点完按钮还是「立即沟通」、也没弹框 → 多半点空了：重新定位再点一次（只补一次）
  {
    const again = await tell(tabId, 'locate', { what: 'chatBtn' }).catch(() => ({}));
    const sd0 = await tell(tabId, 'locate', { what: 'startDialog' }).catch(() => ({}));
    if (again.found && !again.chatted && !sd0.found) {
      await sleep(rand(400, 900));
      await dbg.clickAt(tabId, again.x, again.y);
      await sleep(2500);
    }
  }

  const attach = attachmentName(config, item.variant_id);
  const clickText = async (texts, opts = {}) => {
    const t = await tell(tabId, 'locateText', { texts, ...opts }).catch(() => ({}));
    if (!t.found) return false;
    await sleep(rand(400, 900)); await dbg.clickAt(tabId, t.x, t.y); await sleep(1800);
    return t.text;
  };

  for (let k = 0; k < 5; k++) {
    // 9/29 实测：51job 点完「立即投递」不弹框，整页跳到 jobs.51job.com/applysuccess.php?jobid=…
    const cur = await chrome.tabs.get(tabId).catch(() => null);
    if (cur && /applysuccess/i.test(cur.url || '')) return { ok: true, note: '跳到了投递成功页' };
    const g = await tell(tabId, 'guardCheck').catch(() => ({}));
    if (g.blocked) return { ok: false, greetedDefault: true, error: g.msg, guard: g };
    const st = await tell(tabId, 'applyState').catch(() => ({ dialogs: [], toast: [] }));
    if (st.success) return { ok: true, note: [...(st.toast || []), ...(st.dialogs || [])].join(' ').slice(0, 60) };
    if ((st.dialogs || []).length) {
      // 让选附件的，选这个岗位该发的那份
      if (attach) await clickText([attach, attach + '.pdf'], { contains: true, dialogOnly: true });
      const c = await clickText(['确认投递', '确定投递', '立即投递', '继续投递', '投递', '确定', '确认', '提交'], { dialogOnly: true });
      if (c) continue;
      return { ok: false, greetedDefault: true, error: `投递后弹了个框插件不认识，停在这了：${st.dialogs[0].slice(0, 80)}` };
    }
    await sleep(1500);
  }
  // 最后看按钮是不是变成「已投递」
  const again = await tell(tabId, 'locateApply', { jobId: jobKey }).catch(() => ({}));
  if (again.applied) return { ok: true, note: '按钮已变成已投递' };
  // 10/16：51job 详情页投上了也常常不给提示（7 家里 6 家其实投上了）。去「我的申请」现读一遍再下结论
  await sleep(3000);
  const rec = await appliedOnPlatform(item.job, { fresh: true }).catch(() => null);
  if (rec) return { ok: true, note: `页面没提示，但${(item.job.platform || 'boss') === '51job' ? '「我的申请」' : '「求职反馈」'}里已经有这条` };
  return { ok: false, greetedDefault: true, error: '点了投递但没看到成功提示，投递记录里也没查到，去页面上确认一下投没投出去' };
}

/**
 * v1.0.2（9/29 实测）：在详情页弹出的小聊天框里发开场白。默认招呼此时已经发出去了，出错都带 greetedDefault。
 * 核对：框顶「公司·职务」要含这家公司；发完 textarea 清空、消息列表最后一条是开场白才算成。
 */
async function greetInDialog(tabId, greeting, job, sd) {
  const norm = (s) => String(s || '').replace(/\s|（.*?）|\(.*?\)|有限公司|有限责任公司|股份/g, '');
  const co = norm(job.company);
  if (co && !norm(sd.header).includes(co.slice(0, Math.min(4, co.length)))) {
    return { ok: false, greetedDefault: true, keepTab: true, error: `小聊天框里的公司对不上（预期「${job.company}」，框顶「${sd.header}」），开场白拒发` };
  }
  await sleep(rand(500, 1000));
  await dbg.clickAt(tabId, sd.x, sd.y);
  await sleep(rand(400, 800));
  await dbg.insertText(tabId, greeting);
  await sleep(rand(1200, 1800));
  const head = greeting.replace(/\s/g, '').slice(0, 20);
  const sentOk = (st) => !st.inputText && (st.messages || []).some((m) => m.replace(/\s/g, '').includes(head));
  let st = {};
  for (let k = 0; k < 3; k++) {
    const b = await tell(tabId, 'locate', { what: 'startDialogSend' }).catch(() => ({}));
    if (b.found && !b.disabled) await dbg.clickAt(tabId, b.x, b.y);
    await sleep(2000);
    st = await tell(tabId, 'locate', { what: 'startDialogSend' }).catch(() => ({}));
    if (sentOk(st)) return { ok: true };
    if (!st.inputText) break; // 字没了但列表里没看到 —— 别再点，交给你看
  }
  return { ok: false, greetedDefault: true, keepTab: true, error: st.inputText
    ? '开场白填进小聊天框了但没发出去（框里还有字），标签页留着，切过去看一眼'
    : '开场白发送后没在小聊天框里看到，标签页留着，去 BOSS 聊天页确认一下' };
}

/**
 * 真实打招呼：点「立即沟通」→ 弹窗点「继续沟通」→ 进聊天页 → 核对公司 → 输入开场白 → 发送。
 * 返回 { ok, error, greetedDefault, chatSalary, guard, hidden }
 *
 * 注意：点「立即沟通」那一下 BOSS 就会自动发出你账号设置的默认招呼语，
 * 所以从那一步之后出的错都带 greetedDefault=true，要让你知道。
 */
async function doGreet(tabId, greeting, job) {
  await dbg.attach(tabId);
  // v1.0.17（10/7）：10/5-10/6 连续 6 家报「默认招呼已发出」其实一家都没发（按钮还是「立即沟通」），根因没查实。
  // 实测排除了一个猜测：调试提示条只把视口从 931 缩到 875，按钮坐标不变。这里等一下只图稳；下面加了点空重试和照实报错
  await sleep(1800);

  const g0 = await tell(tabId, 'guardCheck');
  if (g0.blocked) return { ok: false, error: g0.msg, guard: g0 };
  if (g0.hidden) {
    return { ok: false, hidden: true, error: 'Chrome 窗口被最小化或被别的窗口完全挡住了，BOSS 的弹窗不会出来。把窗口露出来再按「投」' };
  }

  const btn = await tell(tabId, 'locate', { what: 'chatBtn' });
  if (!btn.found) return { ok: false, error: btn.error || '找不到「立即沟通」按钮', guard: btn.guard };
  if (btn.chatted) return { ok: false, error: '这个岗位之前已经沟通过了' };

  const before = await chrome.tabs.query({ url: 'https://www.zhipin.com/*' });
  const knownTabIds = new Set(before.map((t) => t.id));

  await sleep(rand(600, 1400));
  await dbg.clickAt(tabId, btn.x, btn.y);
  await sleep(2500);

  const g1 = await tell(tabId, 'guardCheck').catch(() => ({}));
  if (g1.blocked) return { ok: false, greetedDefault: true, error: g1.msg, guard: g1 };

  // 点完一般会弹「已向BOSS发送消息 · 留在此页 / 继续沟通」；也可能直接跳到聊天页
  // v1.0.1（9/29 实测）：BOSS 现在多半不弹框，原按钮直接变成「继续沟通」、上面带 redirect-url（聊天页地址），
  // 点它也不跳。所以 3 秒没弹框，就读这个地址把标签导过去
  let chatTabId = null;
  const t0 = Date.now();
  const end = t0 + 8000;
  while (Date.now() < end && !chatTabId) {
    const self = await chrome.tabs.get(tabId).catch(() => null);
    if (self && CHAT_URL_RE.test(self.url || '')) { chatTabId = tabId; break; }
    const sd = await tell(tabId, 'locate', { what: 'startDialog' }).catch(() => ({}));
    if (sd.found) return greetInDialog(tabId, greeting, job, sd);
    const form = await tell(tabId, 'locate', { what: 'formDialog' }).catch(() => ({}));
    if (form.found) {
      return { ok: false, greetedDefault: true, keepTab: true, error: `弹出了要填信息的框（${form.text.slice(0, 60)}）。标签页留着没关：切过去，在侧边栏「网申」页点「填这一页」（只填不交），检查完你自己点提交` };
    }
    const cont = await tell(tabId, 'locate', { what: 'continueChat' }).catch(() => ({}));
    if (cont.found) {
      await sleep(rand(500, 1100));
      await dbg.clickAt(tabId, cont.x, cont.y);
      chatTabId = await findChatTab(tabId, knownTabIds);
      break;
    }
    if (Date.now() - t0 > 3000) {
      const b2 = await tell(tabId, 'locate', { what: 'chatBtn' }).catch(() => ({}));
      if (b2.chatted && b2.redirect) {
        await chrome.tabs.update(tabId, { url: new URL(b2.redirect, 'https://www.zhipin.com').href });
        await sleep(1500);
        await waitLoaded(tabId).catch(() => {});
        chatTabId = tabId;
        break;
      }
    }
    await sleep(700);
  }
  if (!chatTabId) {
    // 别再报假的「已发出」：按钮还是「立即沟通」就说明根本没点上
    const b3 = await tell(tabId, 'locate', { what: 'chatBtn' }).catch(() => ({}));
    if (b3.found && !b3.chatted) return { ok: false, greetedDefault: false, error: '「立即沟通」点了两次都没反应（按钮没变），这家一条都没发出去，可以重试' };
    return { ok: false, greetedDefault: true, error: '默认招呼已发出，但没出现「继续沟通」也没进聊天页，自定义开场白没发' };
  }

  try {
    if (chatTabId !== tabId) await dbg.attach(chatTabId);
    await waitLoaded(chatTabId).catch(() => {});
    await sleep(rand(2500, 4000));

    // 核对聊天对象：顶部必须是这家公司。对不上就拒发 —— 宁可漏发，不能发错人
    let st = null;
    for (let k = 0; k < 5; k++) {
      st = await tell(chatTabId, 'chatState', { expectCompany: job.company, expectTitle: job.title });
      if (st.match) break;
      await sleep(1000);
    }
    if (!st?.match) {
      return { ok: false, greetedDefault: true, error: `聊天窗口对不上（预期「${job.company}」，页面顶部「${st?.header || '没读到'}」），自定义开场白拒发` };
    }

    const f = await tell(chatTabId, 'focusInput');
    if (!f.ok) return { ok: false, greetedDefault: true, error: f.error };
    await sleep(rand(500, 1000));
    await dbg.insertText(chatTabId, greeting);
    await sleep(rand(1500, 2100));

    // 发送按钮有时还没从 disabled 变过来：最多点三次，每次确认输入框清空了才算发出去
    let left = greeting;
    for (let k = 0; k < 3 && left; k++) {
      const s = await tell(chatTabId, 'locate', { what: 'sendBtn' });
      if (s.found) await dbg.clickAt(chatTabId, s.x, s.y);
      await sleep(2000);
      left = (await tell(chatTabId, 'chatState', {})).inputText;
    }
    // 9/29 实测：发送按钮点了没反应、在输入框里按回车能发出去
    if (left) {
      const f2 = await tell(chatTabId, 'focusInput');
      if (f2.ok) {
        await dbg.pressEnter(chatTabId);
        await sleep(2000);
        left = (await tell(chatTabId, 'chatState', {})).inputText;
      }
    }
    if (left) return { ok: false, greetedDefault: true, error: '开场白填进去了但没发出去（输入框里还有字），去聊天页看一眼' };

    const post = await tell(chatTabId, 'guardCheck').catch(() => ({}));
    if (post.blocked) return { ok: true, chatSalary: st.salary, guard: post };
    return { ok: true, chatSalary: st.salary };
  } finally {
    if (chatTabId !== tabId) {
      await dbg.detach(chatTabId);
      await chrome.tabs.remove(chatTabId).catch(() => {});
    }
  }
}
