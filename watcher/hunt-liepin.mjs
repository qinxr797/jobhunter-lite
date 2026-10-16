// 找岗位的猎聘来源（10/16 22:00 用户：「你这个肯定是连着网申和猎聘一块扫啊」）
// 扫：插件同一套关键词 → liepin.search（本地）→ 去重（tracker / applied.json / blocked.txt / 插件 seen / 自己看过的）→ 插件同一套初筛 →
//     读详情（liepin.jobInfo）→ 在插件侧边栏页里调插件自己的 evaluateJob + checkGreeting（同一份提示词、同一个 DeepSeek key、同一套开场白规矩）
// 选「在插件页里跑」不另写一份提示词：评分和开场白跟 BOSS / 51job 完全一个口径，插件改了规矩这里自动跟上，不会两边各说各话
// 结果存 data\hunt-liepin.json；hunt.mjs read() 合进待审 queue（jobId 前缀 liepin-）。投 = liepin.applyJob（「聊一聊」+ 开场白），一次一家
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { cfg } from './config.mjs';
import { ensure as ensurePlugin, panelUrl } from './plugin-host.mjs';
import path from 'node:path';
import { DATA, connect, withTimeout, sleep } from './lib.mjs';
import * as lp from './liepin.mjs';
import { blockedHit } from './tracker-rules.mjs';
import * as tracker from './tracker.mjs';

const FILE = process.env.HUNT_LP_FILE || path.join(DATA, 'hunt-liepin.json');      // 试跑时指到别处
const PANEL = 'src/sidepanel/panel.html';
const DAILY_MAX = 10;                                       // 猎聘一天最多投 10 家（插件 BOSS 那边是 15，各算各的）
const PER_SCAN = Number(process.env.HUNT_LP_MAX) || 30;                                        // 一轮最多读 30 个详情、评 30 次（详情页读多了会弹验证，模型也花钱）
const DEFAULT_KW = ['跨境电商运营', '电商运营', 'AI产品经理', '产品运营', '新媒体运营', 'GEO运营', 'AI搜索优化'];   // 插件 today-ui.js DEFAULT_DAILY
const bj = (t = Date.now()) => new Date(t + 8 * 3600e3).toISOString().slice(0, 19);
const load = () => { try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return { at: '', scans: [], items: {} }; } };
const save = (s) => writeFileSync(FILE, JSON.stringify(s, null, 1));
const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };

let stop = false, scanning = null, onChange = () => {};
export const setOnChange = (f) => { onChange = f; };
export const isScanning = () => !!scanning;
export function stopScan() { stop = true; }

/** 给 hunt.mjs：待审 / 排队 / 发送中 / 失败的，整成和插件队列一样的条目 */
export function list() {
  const s = load();
  return Object.values(s.items).filter((x) => ['待审核', '排队', '发送中', '失败'].includes(x.status)).map(({ card, state, ...x }) => x);
}
export function sourceInfo() {
  const s = load();
  const last = s.scans?.[0];
  return { n: Object.values(s.items).filter((x) => x.status === '待审核').length, ok: !last || !last.err, note: last ? `${last.at.slice(11, 16)} 扫的${last.err ? '：' + last.err : ''}` : '还没扫过', fix: last?.err ? last.fix || null : null };
}

// ---------- 插件侧边栏页：读设置、跑插件自己的初筛 / 评估 ----------
export async function panel() {
  const h = await ensurePlugin();   // 插件跑在 watcher 自己拉起的后台浏览器里（plugin-host.mjs），端口和插件 id 运行时才知道
  if (!h.ok) throw Object.assign(new Error(h.why), { fix: h.fix });
  let c = await connect(h.port, PANEL).catch(() => null);
  if (!c) c = await connect(h.port, PANEL, panelUrl(h.extId), { keep: true }).catch(() => null);
  if (!c) throw Object.assign(new Error('连不上后台浏览器里的求职插件'), { fix: '关掉桌面助手再打开一次' });
  return c;
}
export const IMPORTS = `const S=await import(chrome.runtime.getURL('src/lib/scoring.js'));const L=await import(chrome.runtime.getURL('src/lib/llm.js'));const T=await import(chrome.runtime.getURL('src/lib/store.js'));const config=await T.getConfig();`;

/** 一个岗位在插件页里评：kick 之后轮询（评一家 10~60 秒，CDP 单条命令 30 秒会超时） */
export async function evaluate(c, job) {
  const id = `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await c.ev(`(()=>{window.__hl=window.__hl||{};window.__hl[${JSON.stringify(id)}]={state:'running'};(async()=>{try{${IMPORTS}
    const job=${JSON.stringify(job)};const ds=S.detailScreen(job,config);if(!ds.pass){window.__hl[${JSON.stringify(id)}]={state:'done',skip:ds.reason};return}
    const ev=await L.evaluateJob(job,config);const gc=S.checkGreeting(ev.greeting,config);ev.greeting=gc.text;
    if(gc.problems.length&&ev.verdict!=='不投')ev.red_flags=[...ev.red_flags,'开场白：'+gc.problems.join('；')];
    const wl=S.workloadFlags(job);if(wl.flags.length)ev.red_flags=[...wl.flags,...ev.red_flags];if(wl.downgrade&&ev.verdict==='投')ev.verdict='等你定';
    const co=S.cohortFlag(job);if(co)ev.red_flags=[co,...ev.red_flags];
    window.__hl[${JSON.stringify(id)}]={state:'done',ev,askMe:(config.thresholds&&config.thresholds.askMe)||45}}catch(e){window.__hl[${JSON.stringify(id)}]={state:'error',err:e.message}}})();return true})()`);
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    const r = await c.ev(`(()=>{const r=window.__hl&&window.__hl[${JSON.stringify(id)}];if(r&&r.state!=='running')delete window.__hl[${JSON.stringify(id)}];return r})()`);
    if (r && r.state !== 'running') return r;
  }
  return { state: 'error', err: '模型 3 分钟没回' };
}

// ---------- 开场白硬检查（10/16 22:22 队长：插件 checkGreeting 的上限不是 85，HR Desk 这几条线进待审前再按用户的规矩查一遍）----------
// 规矩见 memory hr-reply-tone：正文（不算结尾作品集那句）两句、≤85 字；数字最多 1 个；第一句「JD 原词 + 这块，」+ 真经历；第二句「JD 具体活 + 我都能直接上手」；末尾作品集那句
const PORTFOLIO = /做过的项目都在作品集网站[^。]*。?/;
export function greetingProblems(g = '') {
  if (!g) return [];
  const body = g.replace(PORTFOLIO, '').trim();
  const out = [];
  const n = [...body].length;
  if (n > 85) out.push(`正文 ${n} 字，超过 85`);
  const nums = body.match(/\d+(?:\.\d+)?/g) || [];
  if (nums.length > 1) out.push(`数字 ${nums.length} 个，最多 1 个`);
  if (!/这块，/.test(body.split(/[。！？]/)[0] || '')) out.push('第一句没用「JD 原词 + 这块，」点题');
  if (!/直接上手|独立接/.test(body)) out.push('没有亮胜任那句（「……我都能直接上手」）');
  if (cfg().portfolio && !PORTFOLIO.test(g)) out.push('结尾少了作品集那句');
  return out;
}
const REWRITE_SYS = `你帮一个应届生改求职开场白。只改写，不新增任何经历、数字、公司、项目；原文没有的事实一个字都不许加。硬规矩：
1. 正文两句、85 个字以内（不算结尾作品集那句）。
2. 第一句以岗位 JD 里的原词开头，接「这块，」，后面紧跟原文里的一条真实经历。
3. 第二句用 JD 里的具体工作原词说「……我都能直接上手」。
4. 全段最多一个数字。不写短板，不问薪资休息，不用「～」和表情，不用「学习能力强」「非常适合」这类套话。
5. 原文结尾如果有作品集那句，原样保留。
只返回 JSON：{"greeting": "改好的整段"}`;
const bodyLen = (g) => [...String(g || '').replace(PORTFOLIO, '').trim()].length;
/** 不合规矩就让模型（插件那份 DeepSeek）重写，最多两次（第二次告诉它还差多少字）；还不行返回问题清单，进待审时标「开场白要你改」 */
export async function polishGreeting(pc, job, ev) {
  let g = ev.greeting || '';
  let probs = greetingProblems(g);
  if (!g || !probs.length) return { greeting: g, problems: probs };
  let cur = g, curProbs = probs;
  for (let attempt = 0; attempt < 2 && curProbs.length; attempt++) {
    const id = `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const n = bodyLen(cur);
    const user = `岗位：${job.title}（${job.company}）\nJD 最看重的：${(ev.jd_needs || []).join('；') || '（看 JD）'}\nJD 摘要：${String(job.jd || '').slice(0, 600)}\n原文：${cur}\n原文的问题：${curProbs.join('；')}`
      + (n > 85 ? `\n正文现在 ${n} 字，要删到 80 字左右：经历只留一个动作和一个结果，删掉「代码用 AI 写」这类过程描述。` : '');
    await pc.ev(`(()=>{window.__hg=window.__hg||{};window.__hg[${JSON.stringify(id)}]={state:'running'};(async()=>{try{${IMPORTS}
      const d=await L.callJson(L.forTask(config,'screen'),{system:${JSON.stringify(REWRITE_SYS)},user:${JSON.stringify(user)},schema:{type:'object',properties:{greeting:{type:'string'}},required:['greeting'],additionalProperties:false},maxTokens:1200});
      const gc=S.checkGreeting(String(d.greeting||''),config);window.__hg[${JSON.stringify(id)}]={state:'done',g:gc.text,p:gc.problems}}catch(e){window.__hg[${JSON.stringify(id)}]={state:'error',err:e.message}}})();return true})()`);
    let r = null;
    for (let i = 0; i < 45; i++) {
      await sleep(2000);
      r = await pc.ev(`(()=>{const r=window.__hg&&window.__hg[${JSON.stringify(id)}];if(r&&r.state!=='running')delete window.__hg[${JSON.stringify(id)}];return r})()`);
      if (r && r.state !== 'running') break;
    }
    if (r?.state !== 'done' || !r.g) break;
    const p2 = [...greetingProblems(r.g), ...(r.p || [])];
    // 问题更少，或者一样多但更短，就用新的
    if (p2.length < curProbs.length || (p2.length === curProbs.length && bodyLen(r.g) < bodyLen(cur))) { cur = r.g; curProbs = p2; }
  }
  return { greeting: cur, problems: curProbs };
}

// ---------- 去重 ----------
function dedupeSets() {
  const apps = tracker.listApps({ view: 'all' }).items;
  const applied = readJson(path.join(DATA, 'applied.json'), []);
  const lpIds = new Set(apps.filter((a) => a.pid === 'lp').map((a) => String(a.url || '').match(/\/job\/(\d+)/)?.[1]).filter(Boolean));
  const sameJob = (co, title) => apps.some((a) => a.pid === 'lp' && sameCoLoose(a.company, co) && tracker.titleNorm(a.title) === tracker.titleNorm(title))
    || applied.some((r) => /猎聘/.test(r.platform) && sameCoLoose(r.company, co) && tracker.titleNorm(r.title) === tracker.titleNorm(title));
  const elsewhere = (co) => apps.find((a) => a.pid !== 'lp' && sameCoLoose(a.company, co) && a.appliedAt);
  return { lpIds, sameJob, elsewhere };
}
export function sameCoLoose(a, b) {
  const x = tracker.coNorm(a), y = tracker.coNorm(b);
  if (!x || !y) return false;
  const [s, l] = x.length <= y.length ? [x, y] : [y, x];
  return s === l || (s.length >= 3 && l.includes(s)) || (s.length >= 2 && l.startsWith(s));
}

/**
 * 扫一轮。onStep({found, listed, note}) 报进度。返回 { ok, found, listed, secs, note, fix? }
 * dry：只搜、只初筛，不读详情不评分（试跑看去重对不对）
 */
export async function scan({ keywords, onStep = () => {}, dry = false } = {}) {
  if (scanning) return { ok: false, note: '猎聘已经在扫了' };
  stop = false;
  const t0 = Date.now();
  const st = load();
  let found = 0, listed = 0, pc = null, c = null;
  const out = (o) => ({ found, listed, secs: Math.round((Date.now() - t0) / 1000), ...o });
  scanning = (async () => {
    try {
      pc = await panel();
      const pre = await withTimeout(pc.ev(`(async()=>{${IMPORTS}const {daily,runtime}=await chrome.storage.local.get(['daily','runtime']);
        return {keywords:(daily&&daily.keywords&&daily.keywords.length)?daily.keywords:null,seen:Object.keys((runtime&&runtime.seen)||{}).filter(k=>k.startsWith('liepin-')),filter:!!config.filter}})()`), 20000, '读插件设置');
      if (!pre?.filter) throw Object.assign(new Error('读不到插件的筛选设置'), { fix: '在 后台插件浏览器里刷新一下插件侧边栏页' });
      const kws = keywords?.length ? keywords : pre.keywords || DEFAULT_KW;
      const pluginSeen = new Set(pre.seen);
      const D = dedupeSets();
      c = await lp.openTab();
      const cand = new Map();
      for (const kw of kws) {
        if (stop) break;
        onStep(out({ note: `搜「${kw}」` }));
        const r = await lp.search(c, kw);
        if (r.err) {
          if (/登录|login|未登录|40[13]/i.test(r.err)) throw Object.assign(new Error('猎聘没登录'), { fix: '在 HR Desk「更多 › 猎聘」里扫码登录' });
          throw Object.assign(new Error(`猎聘搜索出错：${r.err.slice(0, 60)}`), { fix: '过几分钟再扫；一直不行就看看 HR Desk 里的猎聘页是不是弹了验证' });
        }
        for (const x of r.list || []) {
          found++;
          const jid = `liepin-${x.jobId}`;
          if (cand.has(jid) || st.items[jid] || pluginSeen.has(jid) || D.lpIds.has(String(x.jobId))) continue;
          if (x.chatted) continue;                                          // 以前跟这个 HR 聊过
          if (blockedHit(x.compName) || D.sameJob(x.compName, x.title)) continue;
          cand.set(jid, { ...x, kw });
        }
        await sleep(1500 + Math.random() * 2000);
      }
      // 插件同一套列表初筛（关键词 / 城市 / 薪资 / 经验 / 黑名单），不花钱
      const cards = [...cand.values()];
      const pres = await withTimeout(pc.ev(`(async()=>{${IMPORTS}return ${JSON.stringify(cards.map((x) => ({ title: x.title, company: x.compName, salary: x.salary, tags: [x.years, x.edu].filter(Boolean), city: x.dq, chatted: !!x.chatted })))}.map(j=>S.prescreen(j,config))})()`), 20000, '插件初筛');
      const pass = cards.filter((x, i) => pres?.[i]?.pass !== false);
      for (const [i, x] of cards.entries()) if (pres?.[i] && !pres[i].pass) st.items[`liepin-${x.jobId}`] = { jobId: `liepin-${x.jobId}`, status: '初筛淘汰', why: pres[i].reason, company: x.compName, title: x.title, addedAt: Date.now() };
      onStep(out({ note: `搜到 ${found} 个，新的 ${cards.length} 个，初筛剩 ${pass.length} 个` }));
      if (dry) { save(st); return out({ ok: true, note: `试跑：新的 ${cards.length} 个，初筛剩 ${pass.length} 个（没读详情、没评分）`, sample: pass.slice(0, 8).map((x) => `${x.compName} · ${x.title} · ${x.salary}`) }); }

      // 各关键词轮着来（以前按搜索顺序取前 N 个，15 个全是第一个关键词的）
      const byKw = new Map(); for (const x of pass) byKw.set(x.kw, [...(byKw.get(x.kw) || []), x]);
      const mixed = []; for (let i = 0; mixed.length < pass.length; i++) for (const l of byKw.values()) if (l[i]) mixed.push(l[i]);
      for (const x of mixed.slice(0, PER_SCAN)) {
        if (stop) break;
        const jid = `liepin-${x.jobId}`;
        onStep(out({ note: `读详情 + 评分：${x.compName} · ${x.title}` }));
        const d = await lp.jobInfo(c, { link: x.link });
        if (d?.err) {
          if (/验证/.test(d.err)) throw Object.assign(new Error('猎聘详情页弹了验证，先停'), { fix: '在 HR Desk「更多 › 猎聘」里过一下验证再扫' });
          continue;
        }
        const el = D.elsewhere(x.compName);
        const job = {
          platform: 'boss',                // 插件的 jobToText 只认 boss / 51job / zhilian；猎聘「聊一聊」和 BOSS 打招呼一样是聊天开场，按 BOSS 的口径写开场白
          title: d.title || x.title, company: x.compName, salary: d.salary || x.salary, city: d.city || x.dq, address: d.address || '',
          tags: [x.years, x.edu, ...(d.labels || [])].filter(Boolean).slice(0, 8), companyInfo: [x.compScale, x.compIndustry, ...(d.companyBase || [])].filter(Boolean).slice(0, 6).join(' · '),
          hr: [x.hr, x.hrTitle].filter(Boolean).join(' '), hrActive: x.hrOnline || '', jd: d.jd || '',
        };
        const r = await evaluate(pc, job);
        const base = {
          jobId: jid, platform: '猎聘', source: 'liepin', applyHow: 'liepin', deadline: null, applyUrl: null,
          title: job.title, company: x.compName, fullCompany: d.company || x.compName, companyInfo: job.companyInfo, salary: job.salary, city: job.city, hr: job.hr,
          href: x.link, jd: (d.jd || '').slice(0, 3000), tags: job.tags, invite: false, hrActive: job.hrActive, addedAt: Date.now(), approvedAt: 0, error: '',
          card: { link: x.link, hrImId: x.hrImId, jobId: x.jobId, kw: x.kw },
        };
        if (r.state === 'error') { st.items[jid] = { ...base, status: '评分失败', why: r.err }; if (/40[13]|key|余额|insufficient/i.test(r.err)) throw Object.assign(new Error(`评分接口出错：${r.err}`), { fix: '看看插件设置里 DeepSeek 的 key / 余额' }); continue; }
        if (r.skip) { st.items[jid] = { ...base, status: '初筛淘汰', why: r.skip }; continue; }
        const ev = r.ev;
        const flags = [...(ev.red_flags || [])];
        let verdict = ev.verdict;
        if (verdict !== '不投' && ev.greeting) {                     // 开场白按用户的规矩再查一遍，不合就重写一次，还不行标出来
          const pg = await polishGreeting(pc, job, ev);
          const changed = pg.greeting !== ev.greeting;
          ev.greeting = pg.greeting;
          if (changed) for (let k = flags.length - 1; k >= 0; k--) if (/^开场白：/.test(flags[k])) flags.splice(k, 1);   // 插件 checkGreeting 标的是改写前那版，改写后作废
          if (pg.problems.length) { flags.unshift(`开场白要你改：${pg.problems.join('；')}`); if (verdict === '投') verdict = '等你定'; }
        }
        if (el) { flags.unshift(`这家 ${el.appliedAt.slice(5, 10).replace('-', '/')} 已在 ${el.platform} 投过（${el.title || '别的岗位'}）`); if (verdict === '投') verdict = '等你定'; }
        const item = { ...base, score: ev.match_score, verdict, reasons: [...(ev.veto || []), ...(ev.reasons || [])], greeting: ev.greeting || '', check: ev.company_check || '',
          tier: ev.company_tier || '', tierWhy: '', redFlags: flags, priority: ev.priority || '', variantId: ev.variant_id || '' };
        if (verdict === '不投' || (verdict === '投' && ev.match_score < r.askMe)) { st.items[jid] = { ...item, status: '模型不投' }; continue; }
        st.items[jid] = { ...item, status: '待审核' };
        listed++;
        save(st); onChange();
        await sleep(2000 + Math.random() * 3000);
      }
      return out({ ok: true, note: stop ? '停了' : `新进待审 ${listed} 家` });
    } catch (e) {
      return out({ ok: false, note: e.message, fix: e.fix || null });
    } finally {
      if (c) await c.close().catch(() => {});
      if (pc) await pc.close().catch(() => {});
    }
  })();
  const res = await scanning;
  scanning = null;
  st.at = bj();
  st.scans = [{ at: bj(), found: res.found, listed: res.listed, secs: res.secs, err: res.ok ? '' : res.note, fix: res.fix || null }, ...(st.scans || [])].slice(0, 20);
  save(st); onChange();
  return res;
}

// ---------- 投 / 不投 / 撤回 ----------
const sentToday = (st) => Object.values(st.items).filter((x) => x.status === '已投' && bj(x.appliedAt || 0).slice(0, 10) === bj().slice(0, 10)).length;
function patch(jobId, p) { const st = load(); if (!st.items[jobId]) return null; st.items[jobId] = { ...st.items[jobId], ...p }; save(st); onChange(); return st.items[jobId]; }

export function approve(jobId, greeting) {
  const x = load().items[jobId];
  if (!x) return { ok: false, why: '猎聘待审里没有这一条' };
  if (!['待审核', '失败'].includes(x.status)) return { ok: false, why: `这条现在是「${x.status}」` };
  patch(jobId, { status: '排队', approvedAt: Date.now(), error: '', ...(greeting !== undefined ? { greeting: String(greeting) } : {}) });
  pump();
  return { ok: true };
}
export function drop(jobId) {
  const x = load().items[jobId];
  if (!x) return { ok: false, why: '猎聘待审里没有这一条' };
  if (x.status === '发送中') return { ok: false, why: '这家正在发，等它发完' };
  patch(jobId, { status: '不投', droppedAt: Date.now() });
  return { ok: true };
}
export function unapprove(jobId) {
  const x = load().items[jobId];
  if (x?.status !== '排队') return { ok: false, why: '只有排队还没发的能撤回' };
  patch(jobId, { status: '待审核' });
  return { ok: true };
}

// 一次一家地发。dry = true 只打开详情页看按钮，不点（试跑用：HUNT_LP_DRY=1）
let sending = false;
export const isSending = () => sending;
export async function pump({ dry = process.env.HUNT_LP_DRY === '1' } = {}) {
  if (sending) return;
  sending = true;
  try {
    for (;;) {
      const st = load();
      const next = Object.values(st.items).filter((x) => x.status === '排队').sort((a, b) => a.approvedAt - b.approvedAt)[0];
      if (!next) break;
      if (!dry && sentToday(st) >= DAILY_MAX) {
        for (const x of Object.values(st.items)) if (x.status === '排队') st.items[x.jobId] = { ...x, status: '待审核', error: `猎聘今天已经投了 ${DAILY_MAX} 家，明天再投` };
        save(st); onChange(); break;
      }
      patch(next.jobId, { status: '发送中' });
      let r;
      let c = null;
      try {
        c = await lp.openTab();
        r = dry ? await dryApply(c, next.card) : await lp.applyJob(c, next.card, next.greeting);
      } catch (e) { r = { ok: false, why: e.message }; } finally { if (c) await c.close().catch(() => {}); }
      if (dry) { patch(next.jobId, { status: '待审核', error: `试跑：${r.ok ? '找到了「聊一聊」，没点' : r.why}` }); continue; }
      if (r.ok) {
        patch(next.jobId, { status: '已投', appliedAt: Date.now(), how: r.how || '' });
        try { tracker.appendApplied({ platform: '猎聘', company: next.fullCompany || next.company, title: next.title, url: next.href, by: 'me', src: 'hunt-liepin', note: r.how || '' }); } catch {}
      } else patch(next.jobId, { status: '失败', error: r.why || '没投成，原因没记下来' });
      await sleep(8000 + Math.random() * 7000);
    }
  } finally { sending = false; onChange(); }
}
async function dryApply(c, card) {
  await c.send('Page.navigate', { url: card.link });
  await sleep(6000);
  const title = await c.ev('document.title');
  if (/安全验证|验证码/.test(title || '')) return { ok: false, why: '详情页弹了验证' };
  const t = await c.ev(`(()=>{const s=document.querySelector('section.job-apply-container');return s?s.innerText.replace(/\\s+/g,' '):''})()`);
  if (/继续聊/.test(t || '')) return { ok: false, why: '以前聊过（按钮是「继续聊」）' };
  return /聊一聊/.test(t || '') ? { ok: true } : { ok: false, why: '详情页上没找到「聊一聊」' };
}
