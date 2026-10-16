// 找岗位的智联来源，改在 HR Desk 的智联 / 51job 登录区（9403 兼容口）里扫和投（10/16 22:17 队长拍板）
// 原因同 BOSS：用户在 HR Desk 扫了码，9334 插件那边的智联登录被挤掉了（22:14 实测插件被跳到 passport 登录页）；插件扫智联本来也只看「HR 邀请」，
// 那部分盯梢在 HR Desk 里实时看着。这里补的是「按关键词搜本地的岗位」。
// 搜：智联搜索页 www.zhaopin.com/jobs/?jl=664&kw= 的 __INITIAL_STATE__（照 autopilot\manual\scanzl.mjs）→ 去重 → 插件初筛 →
//     读详情（导航到岗位页读正文，照 jdzl.mjs）→ 插件页里跑插件的 evaluateJob（hunt-liepin.mjs 的 evaluate，platform 传 zhilian）
// 投：照 autopilot\manual\zlapply_desk.mjs（10/16 晚实投验过）：岗位页点「立即投递」→ 消息页找到这家的会话 → 打开场白 → 回读核对 → 退回 /im
// 结果存 data\hunt-zhilian.json；hunt.mjs read() 合进待审（jobId 前缀 zl-，source zhilian，applyHow desk-zhilian）
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { cfg } from './config.mjs';
import { stripPlace } from './config.mjs';
import path from 'node:path';
import { DATA, connect, withTimeout, sleep, lock, unlock } from './lib.mjs';
import { blockedHit } from './tracker-rules.mjs';
import * as tracker from './tracker.mjs';
import { panel, IMPORTS, evaluate, sameCoLoose, polishGreeting } from './hunt-liepin.mjs';

const FILE = process.env.HUNT_ZL_FILE || path.join(DATA, 'hunt-zhilian.json');
const TAB_PORT = cfg().ports.deskTabs.zhaopin;   // 桌面助手给智联 / 51job 登录区开新标签的兼容口
const JL = cfg().cityCodes.zhilian || '';   // 智联城市代码（设置里填；空着就不按城市筛）
const DAILY_MAX = 15;
const PER_SCAN = Number(process.env.HUNT_ZL_MAX) || 20;
const PAGES = 2;
const DEFAULT_KW = ['跨境电商运营', '电商运营', 'AI产品经理', '产品运营', '新媒体运营', 'GEO运营', 'AI搜索优化'];
const PAUSE = path.join(DATA, 'pause');
const bj = (t = Date.now()) => new Date(t + 8 * 3600e3).toISOString().slice(0, 19);
const load = () => { try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return { at: '', scans: [], items: {} }; } };
const save = (s) => writeFileSync(FILE, JSON.stringify(s, null, 1));
const T = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const zlId = (url = '') => (String(url).match(/(CC\w+?J\w+?)\.htm/) || [])[1] || '';

let stop = false, scanning = false, onChange = () => {};
export const setOnChange = (f) => { onChange = f; };
export const stopScan = () => { stop = true; };
export function list() {
  return Object.values(load().items).filter((x) => ['待审核', '排队', '发送中', '失败'].includes(x.status)).map(({ card, ...x }) => x);
}
export function sourceInfo() {
  const s = load();
  return { n: Object.values(s.items).filter((x) => x.status === '待审核').length, last: s.scans?.[0] };
}

async function openTab(url) {
  const mark = `hrdesk=${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const u = url + (url.includes('?') ? '&' : '?') + mark;
  const t = await (await fetch(`http://127.0.0.1:${TAB_PORT}/json/new?${u}`, { method: 'PUT' })).json();
  await sleep(6000);
  const c = await connect(cfg().ports.zhaopin, mark);
  if (!c) { await fetch(`http://127.0.0.1:${TAB_PORT}/json/close/${t.id}`).catch(() => {}); throw new Error('智联新标签开了但连不上'); }
  const close0 = c.close;
  c.close = async () => { await close0(); await fetch(`http://127.0.0.1:${TAB_PORT}/json/close/${t.id}`).catch(() => {}); };
  await c.send('Page.enable').catch(() => {});
  return c;
}

const GRAB = `(()=>{const out=[];const walk=(o,d)=>{if(!o||typeof o!=='object'||d>8)return;if(Array.isArray(o)){if(o.length&&o[0]&&o[0].positionURL){for(const j of o)out.push(j);return}for(const x of o)walk(x,d+1);return}for(const k in o)walk(o[k],d+1)};walk(window.__INITIAL_STATE__,0);
  return out.map(j=>({url:j.positionURL,title:j.name,salary:j.salary60||j.salaryReal||'',company:j.companyName,prop:j.property||j.propertyName||'',size:j.companySize||'',city:[j.workCity,j.cityDistrict,j.streetName].filter(Boolean).join('·'),edu:j.education||'',exp:j.workingExp||'',ind:j.industryName||'',welfare:(j.welfareTagList||[]).join('、'),skills:(j.skillLabel||[]).map(s=>s.value||s),hr:[j.staffCard&&j.staffCard.staffName,j.staffCard&&j.staffCard.hrJob].filter(Boolean).join(' ')}))})()`;

export async function scan({ keywords, onStep = () => {}, dry = false } = {}) {
  if (scanning) return { ok: false, note: '智联已经在扫了' };
  scanning = true; stop = false;
  const t0 = Date.now();
  const st = load();
  let found = 0, listed = 0, pc = null, c = null, res;
  const out = (o) => ({ found, listed, secs: Math.round((Date.now() - t0) / 1000), ...o });
  try {
    pc = await panel();
    const pre = await withTimeout(pc.ev(`(async()=>{${IMPORTS}const {daily,runtime}=await chrome.storage.local.get(['daily','runtime']);
      return {keywords:(daily&&daily.keywords&&daily.keywords.length)?daily.keywords:null,seen:Object.keys((runtime&&runtime.seen)||{}).filter(k=>/^CC/.test(k)),filter:!!config.filter}})()`), 20000, '读插件设置');
    if (!pre?.filter) throw Object.assign(new Error('读不到插件的筛选设置'), { fix: '在 后台插件浏览器里刷新一下插件侧边栏页' });
    const kws = keywords?.length ? keywords : pre.keywords || DEFAULT_KW;
    const pluginSeen = new Set(pre.seen);
    const all = tracker.listApps({ view: 'all' }).items;
    const apps = all.filter((a) => a.pid === 'zl');
    const ids = new Set(apps.map((a) => zlId(a.url) || (a.key.match(/^zl:([^#]+)/) || [])[1]).filter(Boolean));
    const sameJob = (co, t) => apps.some((a) => sameCoLoose(a.company, co) && tracker.titleNorm(a.title) === tracker.titleNorm(t));
    const elsewhere = (co) => all.find((a) => sameCoLoose(a.company, co) && a.appliedAt);
    c = await openTab('https://www.zhaopin.com/');
    const cand = new Map();
    for (const kw of kws) {
      if (stop) break;
      onStep(out({ note: `搜「${kw}」` }));
      for (let pg = 1; pg <= PAGES; pg++) {
        await c.send('Page.navigate', { url: `https://www.zhaopin.com/jobs/?jl=${JL}&kw=${encodeURIComponent(kw)}${pg > 1 ? `&p=${pg}` : ''}` });
        await sleep(6000 + Math.random() * 2000);
        const head = T(await c.ev('document.body.innerText.slice(0,300)'));
        if (/安全验证|滑块|验证码/.test(head)) throw Object.assign(new Error('智联搜索页弹了验证，先停'), { fix: '在 HR Desk「更多 › 智联」里过一下验证再扫' });
        const rows = (await c.ev(GRAB)) || [];
        if (!rows.length) break;
        let fresh = 0;
        for (const x of rows) {
          found++;
          const id = zlId(x.url);
          if (!id) continue;
          const jid = `zl-${id}`;
          if (cand.has(jid) || st.items[jid] || pluginSeen.has(id) || ids.has(id)) continue;
          if (blockedHit(x.company) || sameJob(x.company, x.title)) continue;
          cand.set(jid, { ...x, id, kw }); fresh++;
        }
        if (!fresh) break;
      }
      await sleep(2000 + Math.random() * 3000);
    }
    const cards = [...cand.values()];
    const pres = await withTimeout(pc.ev(`(async()=>{${IMPORTS}return ${JSON.stringify(cards.map((x) => ({ title: x.title, company: x.company, salary: x.salary, tags: [x.exp, x.edu].filter(Boolean), city: x.city, chatted: false })))}.map(j=>S.prescreen(j,config))})()`), 20000, '插件初筛');
    const pass = cards.filter((x, i) => pres?.[i]?.pass !== false);
    for (const [i, x] of cards.entries()) if (pres?.[i] && !pres[i].pass) st.items[`zl-${x.id}`] = { jobId: `zl-${x.id}`, status: '初筛淘汰', why: pres[i].reason, company: x.company, title: x.title, addedAt: Date.now() };
    onStep(out({ note: `搜到 ${found} 个，新的 ${cards.length} 个，初筛剩 ${pass.length} 个` }));
    if (dry) { save(st); res = out({ ok: true, note: `试跑：新的 ${cards.length} 个，初筛剩 ${pass.length} 个（没读详情、没评分）`, sample: pass.slice(0, 8).map((x) => `${x.company} · ${x.title} · ${x.salary}`) }); return res; }
    const byKw = new Map(); for (const x of pass) byKw.set(x.kw, [...(byKw.get(x.kw) || []), x]);
    const mixed = []; for (let i = 0; mixed.length < pass.length; i++) for (const l of byKw.values()) if (l[i]) mixed.push(l[i]);
    for (const x of mixed.slice(0, PER_SCAN)) {
      if (stop) break;
      const jid = `zl-${x.id}`;
      onStep(out({ note: `读详情 + 评分：${x.company} · ${x.title}` }));
      await c.send('Page.navigate', { url: x.url });
      await sleep(5000 + Math.random() * 3000);
      const d = await c.ev(`(()=>{const b=document.body.innerText.replace(/\\s+/g,' ');if(/安全验证|滑块验证/.test(b.slice(0,300)))return {err:'验证'};const i=b.indexOf('职位描述');const j=b.indexOf('工作地点',i);
        const act=(document.querySelector('.summary-planes__action')||{}).innerText||'';
        return {jd:(i>=0?b.slice(i+4,j>i?Math.min(j,i+2500):i+2000):'').trim(),address:(b.match(/工作地点\\s*(\\S[^ ]{2,40})/)||[])[1]||'',chatted:/继续沟通|已投递/.test(act),act:act.trim().slice(0,20)}})()`).catch((e) => ({ err: e.message }));
      if (d?.err) { if (/验证/.test(d.err)) throw Object.assign(new Error('智联详情页弹了验证，先停'), { fix: '在 HR Desk「更多 › 智联」里过一下验证再扫' }); continue; }
      if (d.chatted) { st.items[jid] = { jobId: jid, status: '聊过', company: x.company, title: x.title, addedAt: Date.now() }; continue; }
      const job = { platform: 'zhilian', title: x.title, company: x.company, salary: x.salary, city: x.city, address: d.address || '', tags: [x.exp, x.edu, ...(x.skills || [])].filter(Boolean).slice(0, 10),
        welfare: x.welfare, companyInfo: [x.prop, x.size, x.ind].filter(Boolean).join(' · '), hr: x.hr, jd: d.jd || '' };
      const r = await evaluate(pc, job);
      const el = elsewhere(x.company);
      const base = { jobId: jid, platform: 'zhilian', source: 'zhilian', applyHow: 'desk-zhilian', deadline: null, applyUrl: null,
        title: x.title, company: x.company, fullCompany: x.company, companyInfo: job.companyInfo, salary: x.salary, city: x.city, hr: x.hr,
        href: x.url, jd: (d.jd || '').slice(0, 3000), tags: job.tags, invite: false, hrActive: '', addedAt: Date.now(), approvedAt: 0, error: '',
        card: { url: x.url, title: x.title, company: x.company } };
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
const BAD = /[～~]|无责底薪|底薪是多少|双休吗|几点下班|薪资|待遇|加班/;
function patch(jobId, p) { const st = load(); if (!st.items[jobId]) return null; st.items[jobId] = { ...st.items[jobId], ...p }; save(st); onChange(); return st.items[jobId]; }
export function approve(jobId, greeting) {
  const x = load().items[jobId];
  if (!x) return { ok: false, why: '智联待审里没有这一条' };
  if (!['待审核', '失败'].includes(x.status)) return { ok: false, why: `这条现在是「${x.status}」` };
  const g = greeting !== undefined ? String(greeting) : x.greeting;
  if (g && BAD.test(g)) return { ok: false, why: '开场白带了不该说的（～ / 待遇这类），改一下再投' };
  patch(jobId, { status: '排队', approvedAt: Date.now(), error: '', greeting: g || '' });
  pump();
  return { ok: true };
}
export function drop(jobId) {
  const x = load().items[jobId];
  if (!x) return { ok: false, why: '智联待审里没有这一条' };
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
export async function pump({ dry = process.env.HUNT_ZL_DRY === '1' } = {}) {
  if (sending) return;
  sending = true;
  try {
    for (;;) {
      const st = load();
      const next = Object.values(st.items).filter((x) => x.status === '排队').sort((a, b) => a.approvedAt - b.approvedAt)[0];
      if (!next) break;
      const today = Object.values(st.items).filter((x) => x.status === '已投' && bj(x.appliedAt || 0).slice(0, 10) === bj().slice(0, 10)).length;
      if (!dry && today >= DAILY_MAX) {
        for (const x of Object.values(st.items)) if (x.status === '排队') st.items[x.jobId] = { ...x, status: '待审核', error: `智联今天已经投了 ${DAILY_MAX} 家，明天再投` };
        save(st); onChange(); break;
      }
      patch(next.jobId, { status: '发送中' });
      const r = await applyOne(next, { dry }).catch((e) => ({ ok: false, why: e.message }));
      if (dry) { patch(next.jobId, { status: '待审核', error: `试跑：${r.ok ? r.how : r.why}` }); continue; }
      if (r.ok || r.applied) {
        patch(next.jobId, { status: '已投', appliedAt: Date.now(), how: r.ok ? r.how : `投上了，开场白没发成：${r.why}` });
        try { tracker.appendApplied({ platform: '智联', company: next.company, title: next.title, url: next.href, by: 'me', src: 'hunt-zhilian', note: r.how || r.why || '' }); } catch {}
      } else patch(next.jobId, { status: '失败', error: r.why || '没投成' });
      if (r.stop) break;
      await sleep(15000 + Math.random() * 15000);
    }
  } finally { sending = false; onChange(); }
}

/** 一家：岗位页点「立即投递」→ 消息页找到这家的会话发开场白 → 回读核对 → 退回 /im（照 zlapply_desk.mjs） */
async function applyOne(x, { dry }) {
  const p = x.card;
  const c = await openTab(p.url);
  try {
    await sleep(1500);
    const head = T(await c.ev('document.body.innerText.slice(0,600)'));
    if (/安全验证|滑块验证/.test(head)) return { ok: false, why: '岗位页弹了验证，先停', stop: true };
    if (!head.includes(p.title.slice(0, 4))) return { ok: false, why: `岗位页标题对不上（可能下线了）：${head.slice(0, 40)}` };
    const state = T(await c.ev(`document.querySelector('.summary-planes__action')?.innerText||''`));
    let applied = false;
    if (/继续沟通|已投递/.test(state)) applied = true;                 // 已经投上了（别处投的）：只补开场白
    else {
      const btn = await c.ev(`(()=>{const b=document.querySelector('.summary-planes__action button');if(!b||!b.offsetWidth)return null;b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,t:b.innerText.trim()}})()`);
      if (!btn || btn.t !== '立即投递') return { ok: false, why: `岗位页上没找到「立即投递」（${btn?.t || '没按钮'}）` };
      if (dry) return { ok: true, how: '找到了「立即投递」，没点' };
      // 10/16 实测：带弧度的长轨迹点一次没反应，直接移过去按下就成；没弹成功框再点一次（照 zlapply_desk）
      for (let k = 0; k < 2 && !applied; k++) {
        for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) { await c.send('Input.dispatchMouseEvent', { type, x: btn.x, y: btn.y, button: 'left', clickCount: 1 }); await sleep(90); }
        await sleep(5000);
        const modal = T(await c.ev(`[...document.querySelectorAll('[class*=modal],[class*=dialog]')].filter(e=>e.offsetWidth).map(e=>e.innerText).join(' | ')`));
        const st2 = T(await c.ev(`document.querySelector('.summary-planes__action')?.innerText||''`));
        applied = /已向对方发送/.test(modal) || /继续沟通/.test(st2);
      }
      if (!applied) return { ok: false, why: '点了「立即投递」没看到成功提示，去智联上确认一下' };
    }
    if (dry) return { ok: true, how: '已经投过（继续沟通），只会补开场白' };
    if (!x.greeting) return { ok: true, applied: true, how: '投上了（没有开场白）' };
    // 消息页补开场白：拿锁 + 放 pause，和盯梢不抢
    const mine = !existsSync(PAUSE);
    if (mine) writeFileSync(PAUSE, 'hunt-zhilian');
    if (!(await lock('hunt-zhilian', 180000))) { if (mine) try { unlinkSync(PAUSE); } catch {} return { ok: false, applied: true, why: '盯梢占着页面，开场白没发' }; }
    try {
      await c.send('Page.navigate', { url: 'https://i.zhaopin.com/im' });
      await sleep(8000);
      const co4 = stripPlace(p.company).slice(0, 4);
      const sess = await c.ev(`(()=>{const it=[...document.querySelectorAll('.im-session-item')].find(e=>{const s=e.__vue__&&e.__vue__.$props&&e.__vue__.$props.session;const txt=e.innerText||'';
          return s?(String(s.companyName||'').includes(${JSON.stringify(co4)})&&String(s.jobTitle||'').includes(${JSON.stringify(p.title.slice(0, 4))})):(txt.includes(${JSON.stringify(co4)}))});
        if(!it)return null;it.scrollIntoView({block:'center'});const b=it.getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2}})()`);
      if (!sess) return { ok: false, applied: true, why: '消息页里没找到这家的会话，开场白没发' };
      await c.click(sess);
      await sleep(4500);
      const box = await c.ev(`(()=>{const e=document.querySelector('textarea.im-sender__input');if(!e||!e.offsetWidth)return null;e.scrollIntoView({block:'center'});const b=e.getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2}})()`);
      if (!box) return { ok: false, applied: true, why: '没找到输入框，开场白没发' };
      await c.click(box);
      await sleep(300);
      await c.send('Input.insertText', { text: x.greeting });
      await sleep(500);
      let val = await c.ev(`document.querySelector('textarea.im-sender__input')?.value||''`);
      if (!val.includes(x.greeting.slice(0, 10))) {
        await c.ev(`(()=>{const e=document.querySelector('textarea.im-sender__input');e.focus();return document.execCommand('insertText',false,${JSON.stringify(x.greeting)})})()`);
        await sleep(400);
        val = await c.ev(`document.querySelector('textarea.im-sender__input')?.value||''`);
      }
      if (!val.includes(x.greeting.slice(0, 10))) return { ok: false, applied: true, why: '字没打进输入框，开场白没发' };
      await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
      await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await sleep(3500);
      const after = await c.ev(`(()=>{const m=[...document.querySelectorAll('.im-message__bubble-inner, [class*=bubble]')].map(e=>(e.innerText||'').replace(/\\s+/g,' ')).filter(Boolean);return {last:m.slice(-2),left:(document.querySelector('textarea.im-sender__input')||{}).value||''}})()`);
      const sent = (after?.last || []).some((t) => t.includes(x.greeting.slice(0, 12))) && !after.left;
      await c.send('Page.navigate', { url: 'https://i.zhaopin.com/im' });   // 别停在会话上（停着 HR 再来消息会被自动已读）
      await sleep(2500);
      return sent ? { ok: true, how: '立即投递 + 开场白（回读核对过）' } : { ok: false, applied: true, why: '开场白可能没发出去，去智联消息里看一眼' };
    } finally {
      unlock();
      try { if (mine && readFileSync(PAUSE, 'utf8') === 'hunt-zhilian') unlinkSync(PAUSE); } catch {}
    }
  } finally { await c.close().catch(() => {}); }
}
