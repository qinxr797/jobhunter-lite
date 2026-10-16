// 收件箱里的「找岗位」：一张待审表收五个来源（10/16 22:00 用户：「你这个肯定是连着网申和猎聘一块扫啊」）
//   BOSS / 51job / 智联：求职插件（后台插件浏览器里的侧边栏页）筛好的待审，用户在收件箱里按「投 / 不投」
//   猎聘：hunt-liepin.mjs 自己扫（HR Desk 9404），评分借插件页里的 evaluateJob
//   网申：campus-hunt.mjs（窗口 3）调插件的网申公告源
//   BOSS：10/16 22:11 起改在 HR Desk 的 BOSS 登录区里扫和投（hunt-boss.mjs）；智联 22:17 起也搬进 HR Desk（hunt-zhilian.mjs）——
//   9334 的 BOSS / 智联登录都被 HR Desk 挤掉了。插件现在只扫 51job
// 接口形状见 docs/api-contract.md「/api/hunt 多来源」
// 10/16 用户：「如果这个软件可以把我的海投给融合进去不是最好么」
// 插件那三个平台的筛选和发送还是插件干（它跑在平台页面里，搬出来要重写、容易出事）；收件箱只当操作台：看、改开场白、拍板。
// 做法：CDP 连到插件的侧边栏页，在它自己的上下文里读 chrome.storage、调 orchestrator 的 approve / dropQueued —— 和用户在侧边栏里点按钮走的是同一段代码
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { ensure as ensurePlugin, panelUrl, syncLogin, openLogin } from './plugin-host.mjs';
import path from 'node:path';
import { connect, withTimeout, sleep, HERE } from './lib.mjs';
import * as lp from './hunt-liepin.mjs';
import * as hb from './hunt-boss.mjs';
import * as hz from './hunt-zhilian.mjs';
import * as campus from './campus-hunt.mjs';
import * as tracker from './tracker.mjs';

const PANEL = 'src/sidepanel/panel.html';
const BACKUP_DIR = path.join(HERE, '..', '..', 'backups');
const SRC = { boss: 'boss', '51job': '51job', zhilian: 'zhilian' };
const bj = (t = Date.now()) => new Date(t + 8 * 3600e3).toISOString().slice(0, 19);

let onChange = () => {};
export function setOnChange(f) { onChange = f; lp.setOnChange(f); hb.setOnChange(f); hz.setOnChange(f); }

async function panel() {
  const h = await ensurePlugin();   // 插件跑在 watcher 自己拉起的后台浏览器里（plugin-host.mjs），端口和插件 id 运行时才知道
  if (!h.ok) throw Object.assign(new Error(h.why), { fix: h.fix });
  let c = await connect(h.port, PANEL).catch(() => null);
  if (!c) c = await connect(h.port, PANEL, panelUrl(h.extId), { keep: true }).catch(() => null);
  if (!c) throw Object.assign(new Error('连不上后台浏览器里的求职插件'), { fix: '关掉桌面助手再打开一次' });
  return c;
}

let cache = null, cacheAt = 0, inflight = null;
// 同一时刻只读一次：开着两个收件箱窗口、或者刚打开页面时几个请求一起来，以前会同时连好几次插件页；
// 侧边栏页没开着的话每一次都会去 后台插件浏览器里新开一个后台标签（keep 住不关），一下多出好几个
function readPlugin(fresh = false) {
  if (!fresh && cache && Date.now() - cacheAt < 20000) return Promise.resolve(cache);
  if (!inflight) inflight = readOnce().finally(() => { inflight = null; });
  return inflight;
}
async function readOnce() {
  let c;
  try { c = await panel(); } catch (e) { return { ok: false, why: e.message }; }
  try {
    const r = await withTimeout(c.ev(`(async()=>{const {runtime:rt={},review:rv,daily,config:cfg,platProgress:pp}=await chrome.storage.local.get(['runtime','review','daily','config','platProgress']);
      const o=await import(chrome.runtime.getURL('src/lib/orchestrator.js'));
      const q=(rt.queue||[]).map(x=>({jobId:x.job.jobId,platform:x.job.platform||'boss',title:x.job.title,company:x.job.company,fullCompany:x.job.fullCompany,companyInfo:x.job.companyInfo,
        salary:x.job.salary,city:x.job.city,hr:x.job.hr,href:x.job.href,jd:(x.job.jd||'').slice(0,3000),tags:x.job.tags||[],invite:!!x.job.invite,hrActive:x.job.hrActive||'',
        score:x.match_score,verdict:x.verdict,reasons:x.reasons||[],greeting:x.greeting||'',status:x.status,error:x.error||'',check:x.company_check||'',tier:x.company_tier||'',tierWhy:x.tier_why||'',
        addedAt:x.addedAt||0,approvedAt:x.approvedAt||0,greetedDefault:!!x.greetedDefault}));
      return {ok:true,queue:q,done:(rt.done||[]).slice(0,200),stats:rt.stats||{},logs:(rt.logs||[]).slice(-40).reverse(),
        review:rv?{at:rv.at,rows:rv.rows}:null,progress:pp?{at:pp.at,job51:pp.job51,zhilian:pp.zhilian}:null,running:o.isRunning(),platforms:o.runningPlatforms(),sending:o.isSending(),
        daily:daily||null,dailyLimit:(cfg&&cfg.pace&&cfg.pace.dailyLimit)||15,
        todayBusy:!!document.getElementById('btn-today-run')?.disabled,todayStatus:(document.getElementById('today-status')||{}).textContent||''}})()`), 20000, '读插件数据');
    cache = r?.ok ? r : { ok: false, why: '插件页没返回数据（侧边栏页可能坏了，在 后台插件浏览器里刷新一下）' }; cacheAt = Date.now();
    return cache;
  } catch (e) { return { ok: false, why: e.message }; } finally { await c.close(); }
}

/** /api/hunt：插件三个平台 + 猎聘 + 网申合成一张待审表（插件读不到时 ok=false，猎聘 / 网申照样有） */
export async function read(fresh = false) {
  const p = await readPlugin(fresh);
  // 插件待审里混进了已经投过的同一岗位（10/16 22:11 实测：美科-跨境电商选品 9/29 投过、高绮 今晚投过，又被插件筛回来了）：标出来，前端提示别再投
  const done = new Map();
  const plugId = (key) => { const m = /^(boss|51|zl):([^#]+)/.exec(key || ''); return m ? (m[1] === '51' ? `51job-${m[2]}` : m[2]) : ''; };   // tracker 主键 → 插件 jobId 写法
  try { for (const a of tracker.listApps({ view: 'all' }).items) if (a.appliedAt) for (const id of [a.jobId, plugId(a.key)]) if (id) done.set(id, a); } catch {}
  const pq = (p.queue || []).map((x) => {
    const a = done.get(x.jobId);
    return { ...x, source: SRC[x.platform] || 'boss', applyHow: 'plugin', deadline: null, applyUrl: null,
      ...(a && x.status === '待审核' ? { alreadyApplied: `${a.appliedAt.slice(5, 10).replace('-', '/')} 已经投过这个岗位（${a.platform}），别再投` } : {}) };
  });
  let lq = [], cq = [], bq = [], zq = [];
  try { lq = lp.list(); } catch {}
  try { bq = hb.list(); } catch {}
  try { zq = hz.list(); } catch {}
  try { cq = campus.list(); } catch {}
  const pend = (src) => pq.filter((x) => x.source === src && x.status === '待审核').length;
  const pluginFix = p.ok ? null : '在 后台插件浏览器里刷新一下插件侧边栏页';
  let cs = { n: cq.length, ok: true, note: '' };
  try { cs = campus.source(); } catch {}
  const hbi = hb.sourceInfo(), hzi = hz.sourceInfo();
  const sources = {
    boss: { n: pend('boss') + hbi.n, ok: !hbi.last?.err, note: hbi.last ? `${hbi.last.at.slice(11, 16)} 在 HR Desk 里扫的${hbi.last.err ? '：' + hbi.last.err : ''}` : '还没在 HR Desk 里扫过', fix: hbi.last?.err ? hbi.last.fix || null : null },
    '51job': { n: pend('51job'), ok: p.ok, note: p.ok ? '' : p.why, fix: pluginFix },
    zhilian: { n: pend('zhilian') + hzi.n, ok: !hzi.last?.err, note: hzi.last ? `${hzi.last.at.slice(11, 16)} 在 HR Desk 里扫的${hzi.last.err ? '：' + hzi.last.err : ''}` : '还没在 HR Desk 里扫过', fix: hzi.last?.err ? hzi.last.fix || null : null },
    liepin: lp.sourceInfo(),
    campus: cs,
  };
  return { ...p, ok: p.ok, queue: [...pq, ...bq, ...zq, ...lq, ...cq], sources, scan };
}

async function call(fn, args) {
  const c = await panel();
  try {
    const r = await withTimeout(c.ev(`import(chrome.runtime.getURL('src/lib/orchestrator.js')).then(m=>m.${fn}(...${JSON.stringify(args)})).then(()=>({ok:true}),e=>({ok:false,why:e.message}))`), 30000, fn);
    cacheAt = 0;
    return r || { ok: false, why: '插件页没返回' };
  } finally { await c.close(); }
}
const isLp = (id) => String(id).startsWith('liepin-');
const isHb = (id) => String(id).startsWith('boss-');
const isHz = (id) => String(id).startsWith('zl-');
const isCampus = (id) => String(id).startsWith('campus-');

/** 投：插件的会先复查开场白（BOSS），再进发送排队；猎聘进 hr-watch 自己的发送队列；网申不投递，返回要打开的投递链接 */
export async function approve(jobId, greeting) {
  if (isHb(jobId)) return hb.approve(jobId, greeting);
  if (isHz(jobId)) return hz.approve(jobId, greeting);
  if (isLp(jobId)) return lp.approve(jobId, greeting);
  if (isCampus(jobId)) {
    const x = campus.list().find((q) => q.jobId === jobId);
    if (!x) return { ok: false, why: '网申待审里没有这一条（可能截止了）' };
    campus.markOpened(jobId);
    onChange();
    return { ok: true, open: { tab: 'campus', url: x.applyUrl || x.href } };
  }
  return call('approve', greeting === undefined ? [jobId] : [jobId, greeting]);
}
/** 不投：从列表拿掉，记进去重，下次筛选不再出现 */
export async function drop(jobId) {
  if (isHb(jobId)) return hb.drop(jobId);
  if (isHz(jobId)) return hz.drop(jobId);
  if (isLp(jobId)) return lp.drop(jobId);
  if (isCampus(jobId)) { const r = campus.drop(jobId); onChange(); return r; }
  return call('dropQueued', [jobId]);
}
/** 撤回：排队还没发的改回待审（猎聘 / 网申的「不投」也能撤回，给前端 5 秒撤销用） */
export async function unapprove(jobId) {
  if (isHb(jobId)) return hb.unapprove(jobId);
  if (isHz(jobId)) return hz.unapprove(jobId);
  if (isLp(jobId)) return lp.unapprove(jobId);
  if (isCampus(jobId)) { const r = campus.undrop(jobId); onChange(); return r; }
  return call('unapprove', [jobId]);
}

/** 一批一起投 / 不投（二级页勾选后批量操作）。一家一家调，哪家没成单独报原因，不因为一家失败停下 */
export async function batch(action, items) {
  const out = [];
  for (const it of items) {
    const r = action === 'approve' ? await approve(it.jobId, it.greeting) : await drop(it.jobId);
    out.push({ jobId: it.jobId, ...r });
  }
  return { ok: out.every((x) => x.ok), results: out };
}

/**
 * 「开始筛选」：在插件侧边栏页里点它自己的「开始筛选」按钮 —— 和用户在侧边栏点一样，几个关键词 × BOSS / 51job 自动开搜索页、筛、关页，
 * 只看不点，筛出来的进「待审」。停止也是点它的「停止」。关键词等设置存在插件的 daily 里，这里可以改
 */
async function panelEval(expr) {
  const c = await panel();
  try { const r = await withTimeout(c.ev(expr), 15000, '插件页'); cacheAt = 0; return r; } finally { await c.close(); }
}
export const runToday = () => panelEval(`(()=>{const b=document.getElementById('btn-today-run');if(!b)return {ok:false,why:'插件页上没找到「开始筛选」按钮'};if(b.disabled)return {ok:false,why:'已经在筛了'};b.click();return {ok:true}})()`);
export const stopToday = () => panelEval(`(()=>{const b=document.getElementById('btn-today-stop');if(!b||b.hidden)return {ok:false,why:'现在没在筛'};b.click();return {ok:true}})()`);
export const setDaily = (patch) => panelEval(`(async()=>{const {daily}=await chrome.storage.local.get('daily');const d={...(daily||{}),...${JSON.stringify(patch)}};await chrome.storage.local.set({daily:d});return {ok:true,daily:d}})()`);

// ---------- 后台插件浏览器里 BOSS 还登着没有（10/16：用户在 HR Desk 里扫了 BOSS，9334 那边的登录被挤掉了）----------
const BOSS_FIX = 'BOSS 的搜和投都在桌面助手自己的登录区里做，后台插件浏览器不登 BOSS';
let bossLogin = { ok: null, at: 0 };
export async function checkBossLogin() {
  const r = await panelEval(`(async()=>{try{const j=await (await fetch('https://www.zhipin.com/wapi/zpuser/wap/getUserInfo.json',{credentials:'include'})).json();return {ok:j.code===0,msg:j.message||''}}catch(e){return {ok:null,msg:e.message}}})()`).catch((e) => ({ ok: null, msg: e.message }));
  bossLogin = { ok: r?.ok ?? null, at: Date.now(), msg: r?.msg || '' };
  return bossLogin;
}

// 动插件存储前整份备份（只留最近 10 份这种自动备份）
async function backupPlugin(tag) {
  const json = await panelEval('chrome.storage.local.get(null).then(x=>JSON.stringify(x))');
  if (!json) throw new Error('插件存储没备份成，不动它');
  mkdirSync(BACKUP_DIR, { recursive: true });
  const f = path.join(BACKUP_DIR, `plugin-storage-auto-${bj().replace(/[-:T]/g, '').slice(0, 12)}-${tag}.json`);
  writeFileSync(f, json);
  const old = readdirSync(BACKUP_DIR).filter((n) => n.startsWith('plugin-storage-auto-')).sort().slice(0, -10);
  for (const n of old) try { unlinkSync(path.join(BACKUP_DIR, n)); } catch {}
  return f;
}

// ---------- 一键扫全部来源（/api/hunt/scan-all）----------
let scan = null, stopAll = false;
export const scanState = () => scan;
const step = (source, patch) => { const s = scan.steps.find((x) => x.source === source); if (s) Object.assign(s, patch); onChange(); };

export function scanAll(sources) {
  if (scan?.running) return { ok: false, status: 409, err: '已经在扫了' };
  const want = new Set(sources?.length ? sources : ['boss', '51job', 'zhilian', 'liepin', 'campus']);
  stopAll = false;
  scan = { running: true, startedAt: bj(), finishedAt: null,
    steps: ['boss', '51job', 'zhilian', 'liepin', 'campus'].filter((s) => want.has(s)).map((s) => ({ source: s, state: 'waiting', found: 0, listed: 0, note: '', secs: 0, fix: null })) };
  onChange();
  const t0 = Date.now();
  const secs = () => Math.round((Date.now() - t0) / 1000);
  const plat = ['51job'].filter((s) => want.has(s));                 // BOSS / 智联不走插件了，见下面 hunt-boss / hunt-zhilian
  const jobs = [];
  if (want.has('boss')) jobs.push((async () => {
    step('boss', { state: 'running', note: '在 HR Desk 的 BOSS 里搜' });
    const r = await hb.scan({ onStep: (x) => step('boss', { found: x.found, listed: x.listed, note: x.note, secs: secs() }) });
    step('boss', { state: r.ok ? 'done' : 'error', found: r.found, listed: r.listed, note: r.note, fix: r.fix || null, secs: secs() });
  })().catch((e) => step('boss', { state: 'error', note: e.message, secs: secs() })));
  if (plat.length) jobs.push(runPlugin(plat, secs).catch((e) => { for (const s of plat) if (['waiting', 'running'].includes(scan.steps.find((x) => x.source === s)?.state)) step(s, { state: 'error', note: e.message, secs: secs() }); }));
  if (want.has('zhilian')) jobs.push((async () => {
    step('zhilian', { state: 'running', note: '在 HR Desk 的智联里搜' });
    const r = await hz.scan({ onStep: (x) => step('zhilian', { found: x.found, listed: x.listed, note: x.note, secs: secs() }) });
    step('zhilian', { state: r.ok ? 'done' : 'error', found: r.found, listed: r.listed, note: r.note, fix: r.fix || null, secs: secs() });
  })().catch((e) => step('zhilian', { state: 'error', note: e.message, secs: secs() })));
  if (want.has('liepin')) jobs.push((async () => {
    step('liepin', { state: 'running', note: '在 HR Desk 后台标签里搜' });
    const r = await lp.scan({ onStep: (x) => step('liepin', { found: x.found, listed: x.listed, note: x.note, secs: secs() }) });
    step('liepin', { state: r.ok ? 'done' : 'error', found: r.found, listed: r.listed, note: r.note, fix: r.fix || null, secs: secs() });
  })().catch((e) => step('liepin', { state: 'error', note: e.message, secs: secs() })));
  if (want.has('campus')) jobs.push((async () => {
    step('campus', { state: 'running', note: '拉网申公告' });
    const r = await campus.pull();
    step('campus', { state: r.ok ? 'done' : 'error', found: r.found || 0, listed: r.listed || 0, note: r.note || '', fix: r.fix || null, secs: secs() });
  })().catch((e) => step('campus', { state: 'error', note: e.message, secs: secs() })));
  Promise.all(jobs).finally(() => { scan.running = false; scan.finishedAt = bj(); cacheAt = 0; onChange(); });
  return { ok: true, scan };
}

export async function scanStop() {
  stopAll = true;
  lp.stopScan();
  hb.stopScan();
  hz.stopScan();
  if (scan?.steps.some((s) => ['boss', '51job', 'zhilian'].includes(s.source) && s.state === 'running')) await stopToday().catch(() => {});
  return { ok: true };
}

/** 插件那几个平台（现在只有 51job / 智联）：临时改 daily 开关（BOSS 一律关掉 —— BOSS 改在 HR Desk 里扫），点它的「开始筛选」，跑完把开关改回去 */
async function runPlugin(plat, secs) {   // plat 下面可能被改（51job 没登录就拿掉）
  for (const s of plat) step(s, { state: 'running', note: '插件在 后台插件浏览器里翻页' });
  const p = await readPlugin(true);
  if (!p.ok) throw new Error(p.why);
  if (p.todayBusy) throw new Error('插件已经在筛了，等它这一轮完');
  if (plat.includes('51job')) {   // 把桌面助手里 51job 的登录复制进后台插件浏览器（plugin-host.mjs syncLogin）；复制不成就弹窗口让用户登一次
    const s = await syncLogin('51job').catch((e) => ({ ok: false, why: e.message }));
    if (!s.ok) {
      const w = await openLogin('51job').catch(() => null);
      step('51job', { state: 'error', note: s.why, fix: w?.ok ? w.note : (s.fix || null), secs: secs() });
      plat = plat.filter((x) => x !== '51job'); if (!plat.length) return;
    }
  }
  if (plat.includes('boss')) await checkBossLogin();
  const d = p.daily || {};
  const orig = { boss: d.boss !== false, job51: d.job51 !== false, zhilian: d.zhilian !== false };
  const key = { boss: 'boss', '51job': 'job51', zhilian: 'zhilian' };
  const want = { boss: plat.includes('boss') && bossLogin.ok !== false && orig.boss, job51: plat.includes('51job') && orig.job51, zhilian: plat.includes('zhilian') && orig.zhilian };
  if (plat.includes('boss') && bossLogin.ok === false) step('boss', { state: 'error', note: '后台插件浏览器里 BOSS 登录掉了（被 HR Desk 的登录挤掉），这次跳过', fix: BOSS_FIX, secs: secs() });
  for (const s of plat) if (!orig[key[s]]) step(s, { state: 'skipped', note: '插件设置里没勾这个平台', secs: secs() });
  const live = plat.filter((s) => want[key[s]]);
  if (!live.length) return;
  // 新进几家 = 这次开扫以后加进待审的（插件扫的同时会把平台上已投过的老条目拿掉，按总数前后相减会抵消）
  const t0 = Date.now();
  const count = (q, s) => q.filter((x) => (x.platform || 'boss') === s && x.status === '待审核' && x.addedAt >= t0).length;
  // 只开这次要扫的平台（插件 runToday 按 daily 的开关扫）；改之前整份备份，点完 4 秒就改回原样
  const run = { boss: want.boss, job51: want.job51, zhilian: want.zhilian };
  const changed = run.boss !== orig.boss || run.job51 !== orig.job51 || run.zhilian !== orig.zhilian;
  if (changed) { await backupPlugin('scan-all'); await setDaily(run); }
  try {
    const r = await runToday();
    if (!r?.ok) throw new Error(r?.why || '插件「开始筛选」没点成');
    await sleep(4000);                                   // runToday 一开头就读了 daily，读完就可以改回去
  } finally { if (changed) await setDaily(orig).catch(() => {}); }
  // 等它跑完：每 10 秒看一眼按钮还禁着没有，最多等 60 分钟
  const NAME = { boss: 'BOSS', '51job': '51job', zhilian: '智联' };
  for (let i = 0; i < 360 && !stopAll; i++) {
    await sleep(10000);
    const q = await readPlugin(true);
    if (!q.ok) continue;
    for (const s of live) step(s, { listed: count(q.queue, s), note: q.todayStatus || '插件在翻页', secs: secs() });
    if (!q.todayBusy) {
      // 插件收尾那句：「跑完了：4 分钟，新进列表 5 家。去「岗位」审；没跑成的：智联「HR 邀请」：…；51job「xx」：…」—— 只认「没跑成的」后面以平台名开头的那几段
      const fails = (q.todayStatus.split('没跑成的：')[1] || '').split(/；(?=BOSS|51job|智联|前程无忧|碰到)/);
      for (const s of live) {
        const seg = fails.find((f) => f.startsWith(NAME[s]) || (s === '51job' && f.startsWith('前程无忧')));
        const login = seg && /login|登录|passport/.test(seg);
        const win = login && s === '51job' ? await openLogin('51job').catch(() => null) : null;   // 复制过去的登录网站不认：弹窗口让用户登一次
        step(s, { state: seg ? 'error' : 'done', note: seg ? `${NAME[s]} 没跑成：${login ? '后台插件浏览器里没登录（被跳到了登录页）' : seg.replace(/^[^：]*：/, '').slice(0, 80)}` : `插件扫完，新进待审 ${count(q.queue, s)} 家`, secs: secs(),
          fix: seg ? (login ? (win?.ok ? win.note : `在桌面助手「更多 › ${NAME[s]}」里重新扫码登录，再扫一次`) : `看看 后台插件浏览器里 ${NAME[s]} 是不是弹了验证`) : null });
      }
      return;
    }
  }
  for (const s of live) step(s, { state: stopAll ? 'done' : 'error', note: stopAll ? '停了' : '插件 60 分钟还没跑完', secs: secs() });
}
