// 找岗位的 BOSS 来源，改在 HR Desk 的 BOSS 登录区里扫（10/16 22:11 队长拍板）
// 为什么搬：BOSS 网页只认一处登录，用户在 HR Desk 扫了码，9334 插件那边就被挤掉了（10/16 22:0x 实测 getUserInfo「当前登录状态已失效」）；
// 9334 重扫码又会反过来挤掉 HR Desk、盯梢收不到 BOSS 消息。所以 BOSS 的「找」和「投」都走 HR Desk（9402 兼容口开屏幕外标签）。
// 照猎聘的做法：搜索页自己发的 joblist 接口返回用 CDP 旁听拿（不自己调接口，不碰 __zp_stoken__）→ 去重 → 插件同一套初筛 →
//   读详情（同源 fetch job_detail 页，和 boss.jobInfo 一样）→ 在插件页里跑插件的 evaluateJob（hunt-liepin.mjs 的 evaluate）
// 投：照 tools\autopilot\bossapply9402.mjs（10/16 晚实投 15 家验过）：岗位页点「立即沟通」→ 自己的聊天标签里找到这家 → 发开场白 → 回读核对
// 结果存 data\hunt-boss.json；hunt.mjs read() 合进待审（jobId 前缀 boss-，source boss，applyHow desk-boss）
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { cfg, cityCodes } from './config.mjs';
import path from 'node:path';
import { DATA, connect, withTimeout, sleep, lock, unlock, recordSent } from './lib.mjs';
import * as boss from './boss.mjs';
import { blockedHit } from './tracker-rules.mjs';
import * as tracker from './tracker.mjs';
import { panel, IMPORTS, evaluate, sameCoLoose, polishGreeting } from './hunt-liepin.mjs';

const FILE = process.env.HUNT_BOSS_FILE || path.join(DATA, 'hunt-boss.json');
const TAB_PORT = cfg().ports.deskTabs.boss;   // 桌面助手给 BOSS 登录区开新标签的兼容口
const DAILY_MAX = cfg().dailyLimit;                                      // BOSS 一天最多打 15 个招呼（求职标准）
const PER_SCAN = Number(process.env.HUNT_BOSS_MAX) || 15;   // 一轮最多读 15 个详情（详情页读多了会弹验证）
const DEFAULT_KW = ['跨境电商运营', '电商运营', 'AI产品经理', '产品运营', '新媒体运营', 'GEO运营', 'AI搜索优化'];
const PAUSE = path.join(DATA, 'pause');
const bj = (t = Date.now()) => new Date(t + 8 * 3600e3).toISOString().slice(0, 19);
const load = () => { try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return { at: '', scans: [], items: {} }; } };
const save = (s) => writeFileSync(FILE, JSON.stringify(s, null, 1));

let stop = false, scanning = false, onChange = () => {};
export const setOnChange = (f) => { onChange = f; };
export const stopScan = () => { stop = true; };

export function list() {
  return Object.values(load().items).filter((x) => ['待审核', '排队', '发送中', '失败'].includes(x.status)).map(({ card, ...x }) => x);
}
export function sourceInfo() {
  const s = load();
  const last = s.scans?.[0];
  return { n: Object.values(s.items).filter((x) => x.status === '待审核').length, last };
}

/** 在 HR Desk 的 BOSS 登录区开一张自己的标签（网址带记号，connect 只连它，不碰软件自己的页面） */
async function openTab(url) {
  const mark = `hrdesk=${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const u = url + (url.includes('?') ? '&' : '?') + mark;
  const t = await (await fetch(`http://127.0.0.1:${TAB_PORT}/json/new?${u}`, { method: 'PUT' })).json();
  await sleep(6000);
  const c = await connect(cfg().ports.boss, mark);
  if (!c) { await fetch(`http://127.0.0.1:${TAB_PORT}/json/close/${t.id}`).catch(() => {}); throw new Error('BOSS 新标签开了但连不上'); }
  const close0 = c.close;
  c.close = async () => { await close0(); await fetch(`http://127.0.0.1:${TAB_PORT}/json/close/${t.id}`).catch(() => {}); };
  return c;
}

/** 搜一个关键词：导航到搜索页，旁听页面自己发的 joblist 接口；旁听不到就退回读卡片 */
async function searchKw(c, kw) {
  const got = [];
  const reqs = new Map();
  c.on('Network.responseReceived', (p) => { if (/\/wapi\/zpgeek\/search\/joblist\.json/.test(p.response?.url || '')) reqs.set(p.requestId, true); });
  c.on('Network.loadingFinished', async (p) => {
    if (!reqs.has(p.requestId)) return;
    reqs.delete(p.requestId);
    const b = await c.send('Network.getResponseBody', { requestId: p.requestId }).catch(() => null);
    try { const j = JSON.parse(b?.result?.body || '{}'); if (j.code === 0) got.push(...(j.zpData?.jobList || [])); else got.push({ __err: j.message || `code ${j.code}` }); } catch {}
  });
  await c.send('Network.enable').catch(() => {});
  await c.send('Page.navigate', { url: `https://www.zhipin.com/web/geek/jobs?city=${(await cityCodes()).boss}&query=${encodeURIComponent(kw)}` });
  await sleep(7000 + Math.random() * 3000);
  const head = (await c.ev(`document.body.innerText.slice(0,400)`)) || '';
  if (/安全验证|验证码|异常访问/.test(head)) throw Object.assign(new Error('BOSS 搜索页弹了验证，先停'), { fix: '在 HR Desk「更多 › BOSS」里过一下验证再扫' });
  if (/登录\/注册|扫码登录/.test(head) && !got.length) throw Object.assign(new Error('HR Desk 里 BOSS 没登录'), { fix: '在 HR Desk「更多 › BOSS」里扫码登录' });
  await c.ev(`(document.querySelector('.job-list-container')||document.scrollingElement).scrollBy(0,4000),window.scrollBy(0,4000)`).catch(() => {});
  await sleep(3000);
  const err = got.find((x) => x.__err);
  const jobs = got.filter((x) => !x.__err && x.encryptJobId);
  if (jobs.length) return jobs.map((x) => ({
    jobId: x.encryptJobId, title: x.jobName, salary: x.salaryDesc, company: x.brandName, scale: x.brandScaleName || '', industry: x.brandIndustry || '',
    city: [x.cityName, x.areaDistrict, x.businessDistrict].filter(Boolean).join('·'), years: x.jobExperience || '', edu: x.jobDegree || '',
    tags: [...(x.skills || []), ...(x.jobLabels || [])], welfare: (x.welfareList || []).join('、'), hr: [x.bossName, x.bossTitle].filter(Boolean).join(' '), hrName: x.bossName || '',
    link: `https://www.zhipin.com/job_detail/${x.encryptJobId}.html`, kw,
  }));
  if (err) throw Object.assign(new Error(`BOSS 搜索接口：${err.__err}`), { fix: '过几分钟再扫；一直不行看看 HR Desk 里 BOSS 是不是要验证' });
  // 退回读卡片（照 autopilot\manual\bscan.mjs）
  const r = await c.ev(`[...document.querySelectorAll('li.job-card-box, li.job-card-wrapper, .job-card-wrap')].map(c=>{const a=c.querySelector('a[href*="job_detail"]');const t=s=>((c.querySelector(s)||{}).innerText||'').trim();
    return a?{link:a.href.split('?')[0],title:t('.job-name'),salary:t('.job-salary, .salary'),company:t('.boss-name, .company-name'),city:t('.company-location, .job-area'),txt:c.innerText.replace(/\\s+/g,' ').slice(0,200)}:null}).filter(Boolean)`).catch(() => []);
  return (r || []).map((x) => ({ ...x, jobId: (x.link.match(/job_detail\/([\w-]+?)\.html/) || [])[1] || '', tags: [], kw })).filter((x) => x.jobId);
}

/** 详情：导航到岗位页读正文。10/16 22:20 实测：在搜索页上同源 fetch job_detail 拿到的是空壳（6 家全没读到 JD），要真打开页面 */
async function detail(c, link) {
  await c.send('Page.navigate', { url: link });
  await sleep(6000 + Math.random() * 3000);
  return c.ev(`(()=>{const t=e=>(e&&e.textContent||'').replace(/\\s+/g,' ').trim();
    if(/安全验证|验证码|异常访问/.test(document.body.innerText.slice(0,400)))return {err:'详情页弹了验证'};
    const jd=document.querySelector('.job-sec-text');const txt=jd?jd.innerText.replace(/\\n\\s*\\n+/g,'\\n').trim():'';
    const btn=[...document.querySelectorAll('a,button,span,div')].find(x=>x.offsetWidth&&x.children.length<2&&/^(立即沟通|继续沟通)$/.test((x.innerText||'').trim()));
    const biz=[...document.querySelectorAll('.level-list li')].map(t).filter(Boolean);
    return {jd:txt,address:t(document.querySelector('.location-address')),keywords:[...document.querySelectorAll('.job-keyword-list li')].map(t),
      companyBase:[...document.querySelectorAll('.sider-company p')].map(t).filter(Boolean).slice(1),business:biz.slice(0,6),
      hrActive:t(document.querySelector('.boss-active-time')),fullCompany:(biz.find(x=>/企业名称|公司名称/.test(x))||'').replace(/^(企业|公司)名称：?/,''),
      chatted:!!btn&&/继续沟通/.test(btn.innerText)}})()`).catch((e) => ({ err: e.message }));
}

export async function scan({ keywords, onStep = () => {}, dry = false } = {}) {
  if (scanning) return { ok: false, note: 'BOSS 已经在扫了' };
  scanning = true; stop = false;
  const t0 = Date.now();
  const st = load();
  let found = 0, listed = 0, pc = null, c = null;
  const out = (o) => ({ found, listed, secs: Math.round((Date.now() - t0) / 1000), ...o });
  let res;
  try {
    pc = await panel();
    const pre = await withTimeout(pc.ev(`(async()=>{${IMPORTS}const {daily,runtime}=await chrome.storage.local.get(['daily','runtime']);
      return {keywords:(daily&&daily.keywords&&daily.keywords.length)?daily.keywords:null,bigOnly:!!(daily&&daily.bigOnly),seen:Object.keys((runtime&&runtime.seen)||{}).filter(k=>!/^(51job-|CC|liepin-|campus-)/.test(k)),filter:!!config.filter}})()`), 20000, '读插件设置');
    if (!pre?.filter) throw Object.assign(new Error('读不到插件的筛选设置'), { fix: '在 后台插件浏览器里刷新一下插件侧边栏页' });
    const kws = keywords?.length ? keywords : pre.keywords || DEFAULT_KW;
    const pluginSeen = new Set(pre.seen);
    const apps = tracker.listApps({ view: 'all' }).items.filter((a) => a.pid === 'boss');
    const ids = new Set(apps.map((a) => String(a.url || '').match(/job_detail\/([\w-]+?)\.html/)?.[1]).filter(Boolean));
    const sameJob = (co, t) => apps.some((a) => sameCoLoose(a.company, co) && tracker.titleNorm(a.title) === tracker.titleNorm(t));
    const elsewhere = (co) => apps.find((a) => sameCoLoose(a.company, co) && a.appliedAt) || tracker.listApps({ view: 'all' }).items.find((a) => a.pid !== 'boss' && sameCoLoose(a.company, co) && a.appliedAt);
    c = await openTab('https://www.zhipin.com/web/geek/jobs?city=${(await cityCodes()).boss}');
    const cand = new Map();
    for (const kw of kws) {
      if (stop) break;
      onStep(out({ note: `搜「${kw}」` }));
      const list = await searchKw(c, kw);
      for (const x of list) {
        found++;
        const jid = `boss-${x.jobId}`;
        if (cand.has(jid) || st.items[jid] || pluginSeen.has(x.jobId) || ids.has(x.jobId)) continue;
        if (blockedHit(x.company) || sameJob(x.company, x.title)) continue;
        cand.set(jid, x);
      }
      await sleep(3000 + Math.random() * 4000);
    }
    const cards = [...cand.values()];
    const pres = await withTimeout(pc.ev(`(async()=>{${IMPORTS}return ${JSON.stringify(cards.map((x) => ({ title: x.title, company: x.company, salary: x.salary, tags: [x.years, x.edu, ...x.tags].filter(Boolean), city: x.city, chatted: false })))}.map(j=>S.prescreen(j,config))})()`), 20000, '插件初筛');
    const pass = cards.filter((x, i) => pres?.[i]?.pass !== false);
    for (const [i, x] of cards.entries()) if (pres?.[i] && !pres[i].pass) st.items[`boss-${x.jobId}`] = { jobId: `boss-${x.jobId}`, status: '初筛淘汰', why: pres[i].reason, company: x.company, title: x.title, addedAt: Date.now() };
    onStep(out({ note: `搜到 ${found} 个，新的 ${cards.length} 个，初筛剩 ${pass.length} 个` }));
    if (dry) { save(st); res = out({ ok: true, note: `试跑：新的 ${cards.length} 个，初筛剩 ${pass.length} 个（没读详情、没评分）`, sample: pass.slice(0, 8).map((x) => `${x.company} · ${x.title} · ${x.salary}`) }); return res; }
    // 各关键词轮着来（以前按搜索顺序取前 N 个，15 个全是第一个关键词的）
    const byKw = new Map(); for (const x of pass) byKw.set(x.kw, [...(byKw.get(x.kw) || []), x]);
    const mixed = []; for (let i = 0; mixed.length < pass.length; i++) for (const l of byKw.values()) if (l[i]) mixed.push(l[i]);
    for (const x of mixed.slice(0, PER_SCAN)) {
      if (stop) break;
      const jid = `boss-${x.jobId}`;
      onStep(out({ note: `读详情 + 评分：${x.company} · ${x.title}` }));
      const d = await detail(c, x.link);
      if (d?.err) { if (/验证/.test(d.err)) throw Object.assign(new Error('BOSS 详情页弹了验证，先停'), { fix: '在 HR Desk「更多 › BOSS」里过一下验证再扫' }); continue; }
      if (d.chatted) { st.items[jid] = { jobId: jid, status: '聊过', company: x.company, title: x.title, addedAt: Date.now() }; continue; }
      const job = {
        platform: 'boss', title: x.title, company: x.company, salary: x.salary, city: x.city, address: d.address || '',
        tags: [x.years, x.edu, ...x.tags, ...(d.keywords || [])].filter(Boolean).slice(0, 10), welfare: x.welfare,
        companyInfo: [x.scale, x.industry, ...(d.companyBase || [])].filter(Boolean).slice(0, 6).join(' · '), business: (d.business || []).join('；'),
        hr: x.hr, hrActive: d.hrActive || '', jd: d.jd || '',
      };
      const r = await evaluate(pc, job);
      const el = elsewhere(x.company);
      const base = {
        jobId: jid, platform: 'boss', source: 'boss', applyHow: 'desk-boss', deadline: null, applyUrl: null,
        title: x.title, company: x.company, fullCompany: d.fullCompany || x.company, companyInfo: job.companyInfo, salary: x.salary, city: x.city, hr: x.hr,
        href: x.link, jd: (d.jd || '').slice(0, 3000), tags: job.tags, invite: false, hrActive: job.hrActive, addedAt: Date.now(), approvedAt: 0, error: '',
        card: { link: x.link, hrName: x.hrName, company: x.company, fullCompany: d.fullCompany || '' },
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
      if (el) { flags.unshift(`这家 ${el.appliedAt.slice(5, 10).replace('-', '/')} 已在 ${el.platform} 投过（${el.title || '别的岗位'}），别重复`); if (verdict === '投') verdict = '等你定'; }
      const item = { ...base, score: ev.match_score, verdict, reasons: [...(ev.veto || []), ...(ev.reasons || [])], greeting: ev.greeting || '', check: ev.company_check || '',
        tier: ev.company_tier || '', tierWhy: '', redFlags: flags, priority: ev.priority || '', variantId: ev.variant_id || '' };
      if (verdict === '不投' || (verdict === '投' && ev.match_score < r.askMe)) { st.items[jid] = { ...item, status: '模型不投' }; continue; }
      st.items[jid] = { ...item, status: '待审核' };
      listed++;
      save(st); onChange();
      await sleep(4000 + Math.random() * 5000);                // BOSS 详情页读多了会弹验证，歇一会
    }
    res = out({ ok: true, note: stop ? '停了' : `新进待审 ${listed} 家` });
  } catch (e) {
    res = out({ ok: false, note: e.message, fix: e.fix || null });
  } finally {
    if (c) await c.close().catch(() => {});
    if (pc) await pc.close().catch(() => {});
    scanning = false;
  }
  st.at = bj();
  st.scans = [{ at: bj(), found: res.found, listed: res.listed, secs: res.secs, err: res.ok ? '' : res.note, fix: res.fix || null }, ...(st.scans || [])].slice(0, 20);
  save(st); onChange();
  return res;
}

// ---------- 投 / 不投 / 撤回 ----------
const BAD = /[～~]|无责底薪|底薪是多少|双休吗|几点下班|薪资|待遇|加班/;  // 照 bossapply9402.mjs
function patch(jobId, p) { const st = load(); if (!st.items[jobId]) return null; st.items[jobId] = { ...st.items[jobId], ...p }; save(st); onChange(); return st.items[jobId]; }
export function approve(jobId, greeting) {
  const x = load().items[jobId];
  if (!x) return { ok: false, why: 'BOSS 待审里没有这一条' };
  if (!['待审核', '失败'].includes(x.status)) return { ok: false, why: `这条现在是「${x.status}」` };
  const g = greeting !== undefined ? String(greeting) : x.greeting;
  if (!g || BAD.test(g)) return { ok: false, why: '开场白是空的，或者带了不该说的（～ / 待遇这类），改一下再投' };
  patch(jobId, { status: '排队', approvedAt: Date.now(), error: '', greeting: g });
  pump();
  return { ok: true };
}
export function drop(jobId) {
  const x = load().items[jobId];
  if (!x) return { ok: false, why: 'BOSS 待审里没有这一条' };
  if (x.status === '发送中') return { ok: false, why: '这家正在发，等它发完' };
  patch(jobId, { status: '不投', droppedAt: Date.now() });
  return { ok: true };
}
export function unapprove(jobId) {
  const x = load().items[jobId];
  if (!x || !['排队', '不投'].includes(x.status)) return { ok: false, why: '只有排队还没发的、或刚点了不投的能撤回' };
  patch(jobId, { status: '待审核' });
  return { ok: true };
}

let sending = false;
export async function pump({ dry = process.env.HUNT_BOSS_DRY === '1' } = {}) {
  if (sending) return;
  sending = true;
  try {
    for (;;) {
      const st = load();
      const next = Object.values(st.items).filter((x) => x.status === '排队').sort((a, b) => a.approvedAt - b.approvedAt)[0];
      if (!next) break;
      const today = Object.values(st.items).filter((x) => x.status === '已投' && bj(x.appliedAt || 0).slice(0, 10) === bj().slice(0, 10)).length;
      if (!dry && today >= DAILY_MAX) {
        for (const x of Object.values(st.items)) if (x.status === '排队') st.items[x.jobId] = { ...x, status: '待审核', error: `BOSS 今天已经打了 ${DAILY_MAX} 个招呼，明天再投` };
        save(st); onChange(); break;
      }
      patch(next.jobId, { status: '发送中' });
      const r = await applyOne(next, { dry }).catch((e) => ({ ok: false, why: e.message }));
      if (dry) { patch(next.jobId, { status: '待审核', error: `试跑：${r.ok ? r.how : r.why}` }); continue; }
      if (r.ok) {
        patch(next.jobId, { status: '已投', appliedAt: Date.now(), how: r.how || '' });
        try { tracker.appendApplied({ platform: 'BOSS', company: next.fullCompany || next.company, title: next.title, url: next.href, by: 'me', src: 'hunt-boss', note: r.how || '' }); } catch {}
      } else patch(next.jobId, { status: r.clicked ? '已投' : '失败', error: r.why || '没投成', ...(r.clicked ? { appliedAt: Date.now(), how: `招呼打了，开场白没发成：${r.why}` } : {}) });
      if (r.stop) break;
      await sleep(25000 + Math.random() * 20000);              // 照 bossapply9402：一家间隔 25~45 秒
    }
  } finally { sending = false; onChange(); }
}

/** 一家：① 岗位页点「立即沟通」② 自己的聊天标签里找到这家、发开场白、回读核对（拿锁 + 放 pause，和盯梢不抢页面） */
async function applyOne(x, { dry }) {
  const card = x.card;
  let hr = card.hrName || '';
  let c = await openTab(card.link);
  try {
    const head = (await c.ev(`document.body.innerText.slice(0,400)`)) || '';
    if (/安全验证|验证码|异常访问/.test(head)) return { ok: false, why: '岗位页弹了验证，先停', stop: true };
    hr = (await c.ev(`((document.querySelector('.job-boss-info .name')||{}).innerText||'').trim().split(/\\s+/)[0]`)) || hr;
    const find = `(()=>{const e=[...document.querySelectorAll('a,button,span,div')].find(x=>x.offsetWidth&&x.children.length<2&&/^(立即沟通|继续沟通)$/.test((x.innerText||'').trim()));if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,t:e.innerText.trim()}})()`;
    await c.ev(find); await sleep(800);
    const btn = await c.ev(find);
    if (!btn) return { ok: false, why: '岗位页上没找到「立即沟通」（岗位可能下线了）' };
    if (btn.t === '继续沟通') return { ok: false, why: '以前聊过（页面是「继续沟通」），不重复打招呼' };
    if (dry) return { ok: true, how: `找到了「立即沟通」，HR ${hr || '没读到'}，没点` };
    await c.click(btn);
    await sleep(4500);
  } finally { await c.close().catch(() => {}); }

  const mine = !existsSync(PAUSE);
  if (mine) writeFileSync(PAUSE, 'hunt-boss');
  if (!(await lock('hunt-boss', 180000))) { if (mine) try { unlinkSync(PAUSE); } catch {} return { ok: false, clicked: true, why: '盯梢占着 BOSS 页面，开场白没发（招呼已打）' }; }
  try {
    c = await openTab('https://www.zhipin.com/web/geek/chat?ka=hunt-boss');
    try {
      const items = (await boss.listApi(c))?.items || [];
      const co = card.company || x.company, full = card.fullCompany || '';
      const it = items.find((i) => i.name === hr && (i.company.includes(co.slice(0, 2)) || co.includes(i.company.slice(0, 2)) || full.includes(i.company.slice(0, 2)))) || items.find((i) => i.name === hr);
      if (!it) return { ok: false, clicked: true, why: `聊天列表里没找到 ${hr}/${co}（招呼已打，开场白没发）` };
      await boss.readList(c);
      const conv = await boss.openConv(c, it);
      if (!conv) return { ok: false, clicked: true, why: `会话没点开（${hr}）` };
      const s = await boss.sendText(c, x.greeting);
      await sleep(1500);
      const again = await boss.openConv(c, it).catch(() => null);
      const last = again?.msgs?.filter((m) => m.me).pop()?.text || '';
      if (!last.includes(x.greeting.slice(0, 12))) return { ok: false, clicked: true, why: `开场白没核上：${s?.why || ''}（最后一条「${last.slice(0, 20)}」）` };
      recordSent(`boss|${it.name}|${it.company}|${it.title}`, x.greeting, 'manual');
      return { ok: true, how: '立即沟通 + 开场白（聊天里核过最后一条）' };
    } finally { await c.close().catch(() => {}); }
  } finally {
    unlock();
    try { if (mine && readFileSync(PAUSE, 'utf8') === 'hunt-boss') unlinkSync(PAUSE); } catch {}
  }
}
