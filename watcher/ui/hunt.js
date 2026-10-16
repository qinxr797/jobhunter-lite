// 找岗位 v2.3.0（10/16 22 点：一次扫全部来源 BOSS / 51job / 智联 / 猎聘 / 网申；顶上来源芯片可筛；网申显示截止日；「投」按 applyHow 分流）
// 找岗位 v2.2.0（10/16 晚：「排队/失败」「投递进度」两个标签并进投递页 /apps，这页只留待审 + 找岗位设置 + 去平台找新岗位）
// 海投工作台 v2.0.0（10/16 体检后重做）。蓝本：Twenty CRM 的「视图预设 + 筛选芯片 + 勾选批量条」、Chatwoot 的批量操作、
// boss-helper / get_jobs 的投递日志。数据和动作全走求职插件：GET /api/hunt，POST /api/hunt/{approve,drop,batch,unapprove,run,stop,daily}
// 这版重点：批量只作用于看得见的行；刷新不再把滚动 / 光标清零；行里不放投/不投按钮；不投有 5 秒撤销；筛选多了区域 / 性质 / 双休 / 月薪 / 筛到时间
const VERSION = 'v2.3.0';
const MOCK = /[?&]mock\b/.test(location.search);   // ?mock=1 读 ui/mock/hunt.json，任何 POST 都不发
// 新外壳开关：HR Desk v0.6.0 起（hrdesk.shell >= 2）或网址带 ?v2 才用新版（只留待审）；老外壳里照旧三个标签，过渡期不出坏页面
const V2 = (window.hrdesk?.shell || 0) >= 2 || /[?&]v2\b/.test(location.search);
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s = '') => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ico = (n) => `<svg class="i"><use href="#i-${n}"/></svg>`;
const safeHref = (u) => (/^https?:\/\//.test(u || '') ? esc(u) : '');
const PLAT = { boss: { name: 'BOSS', short: 'B', cls: 'p-boss' }, '51job': { name: '51job', short: '51', cls: 'p-51' }, zhilian: { name: '智联', short: '智', cls: 'p-zl' }, liepin: { name: '猎聘', short: '猎', cls: 'p-lp' }, campus: { name: '网申', short: '网', cls: 'p-campus' } };
const SRC_ORDER = ['boss', '51job', 'zhilian', 'liepin', 'campus'];
const SRC_ALIAS = { BOSS: 'boss', 智联: 'zhilian', zl: 'zhilian', 51: '51job', 猎聘: 'liepin', lp: 'liepin', 网申: 'campus' };
const srcOf = (x) => { const p = String(x?.source || x?.platform || (typeof x === 'string' ? x : '')); return PLAT[p] ? p : SRC_ALIAS[p] || 'boss'; };
const plat = (id) => PLAT[srcOf(id)] || PLAT.boss;
// 「投」怎么投（契约 applyHow）：plugin 插件发 / liepin 软件里走猎聘 / campus-tab 去网申标签自己填（不进批量）
const howOf = (x) => { const h = x.applyHow || (srcOf(x) === 'campus' ? 'campus' : srcOf(x) === 'liepin' ? 'liepin' : 'plugin'); return /^campus/.test(h) ? 'campus' : h; };
const hasGreet = (x) => ['boss', 'liepin'].includes(srcOf(x));
const VERDICT_RANK = { 投: 0, 等你定: 1 };
const UNDO_MS = 5000;
let DEFAULT_NEAR = [];   // 通勤能接受的区（设置里填），启动时从 /api/profile 取
fetch('/api/profile').then((r) => r.json()).then((p) => { DEFAULT_NEAR = p.nearDistricts || []; if (typeof S !== 'undefined' && !(S.near || []).length) S.near = [...DEFAULT_NEAR]; }).catch(() => {});

const S = {
  data: null, tab: 'review', sel: new Set(), open: null, cursor: null, drafts: {}, busy: false, lastClick: null,
  preset: 'focus', f: {}, sal: 0, score: 0, q: '', sort: 'rank', near: [...DEFAULT_NEAR],
  openFacet: null, dropping: new Map(), logAll: false, boardQ: '', sig: '', dirty: false, rows: [],
};

// ---------- 字段整理（插件给的是原始字符串，这里拆成能筛的） ----------
function parseSalary(s = '') {
  const m = String(s).match(/([\d.]+)\s*(千|万)?\s*[-~至]\s*([\d.]+)\s*(千|万)/);
  if (!m) return null;
  const u2 = m[4] === '万' ? 10 : 1, u1 = m[2] ? (m[2] === '万' ? 10 : 1) : u2;
  let lo = +m[1] * u1, hi = +m[3] * u2;
  const yearly = /\/年|年薪/.test(s);
  if (yearly) { lo /= 12; hi /= 12; }
  return { lo, hi, yearly, bonus: (s.match(/(\d+)薪/) || [])[1] || '' };
}
const kfmt = (n) => (Math.round(n * 10) / 10).toString().replace(/\.0$/, '');
function restOf(x) {
  const own = `${x.jd || ''} ${(x.tags || []).join(' ')}`;
  const said = `${x.check || ''} ${(x.reasons || []).join(' ')}`.replace(/(没写|没提|看不出|不确定|是否|有没有|不清楚)[^，。；,;]{0,10}(双休|单休|休息)/g, '');
  for (const t of [own, said]) {
    if (/单休|大小周|做六休一|六天|轮休|排班|倒班|月休/.test(t)) return '单休/大小周';
    if (/双休|周末休|五天八小时|做五休二|5天8小时|周六日休/.test(t)) return '双休';
  }
  return '没写';
}
function natureOf(info = '') {
  const s = String(info).split(/\s*·\s*/)[0] || '';
  if (/外资|外企/.test(s)) return '外资';
  if (/上市/.test(s)) return '上市';
  if (/国企|国有|央企/.test(s)) return '国企';
  if (/事业/.test(s)) return '事业单位';
  if (/合资/.test(s)) return '合资';
  if (/民营|私营/.test(s)) return '民营';
  if (/创业/.test(s)) return '创业公司';
  return s || '没写';
}
function expOf(tags = []) {
  const t = tags.find((x) => /年|经验|应届|在校/.test(x)) || '';
  if (!t) return '没写';
  if (/无需|应届|在校|不限/.test(t)) return '不限经验';
  if (/^1年|1-2年|^一年/.test(t)) return '1 年';
  if (/1-3年|2年|2-3年/.test(t)) return '1-3 年';
  return '3 年以上';
}
function deadlineInfo(d) {
  if (!d) return null;
  const day = String(d).slice(0, 10), t = new Date(), today = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  const left = Math.round((Date.parse(day + 'T00:00:00') - Date.parse(today + 'T00:00:00')) / 864e5);
  const md = `${+day.slice(5, 7)}/${+day.slice(8, 10)}`;
  return { day, left, late: left <= 3, text: left < 0 ? `已截止（${md}）` : left === 0 ? `今天截止` : `截止 ${md} · 还剩 ${left} 天` };
}
function enrich(x) {
  const sal = parseSalary(x.salary);
  const age = x.addedAt ? Math.floor((Date.now() - x.addedAt) / 864e5) : null;
  const score = x.score ?? null;
  return {
    ...x, sal,
    nature: natureOf(x.companyInfo), size: x.tier || '没写',
    district: (String(x.city || '').split('·')[1] || '').trim() || '没写区',
    rest: restOf(x), exp: expOf(x.tags || []),
    age, ageLabel: age == null ? '没写' : age <= 3 ? '3 天内' : age <= 7 ? '7 天内' : '7 天以上',
    vLabel: x.verdict === '投' ? '建议投' : x.verdict === '等你定' ? '你来定' : '其他',
    platName: plat(x.platform).name, src: srcOf(x), how: howOf(x), dl: deadlineInfo(x.deadline),
    // 插件的「建议」和分数打架的，标出来（10/16 体检第 8 条）
    odd: x.verdict === '投' && score != null && score < 55 ? `建议投但只有 ${score} 分` : x.verdict === '等你定' && score != null && score >= 75 ? `${score} 分却没建议投` : '',
    greetWarn: greetWarn(x),
  };
}
function greetWarn(x) {
  if (x.platform !== 'boss' || !x.greeting) return '';
  const g = x.greeting, w = [];
  if (/底薪|薪资|工资|待遇|休息|双休|加班|五险/.test(g)) w.push('在问待遇（你定的：前期不问）');
  return w.join('；');
}

// ---------- 筛选 ----------
const PRESETS = [
  { id: 'focus', name: '先看这些', tip: '建议投或 70 分以上，并且写了双休', fn: (r) => (r.verdict === '投' || (r.score || 0) >= 70) && r.rest === '双休' },
  { id: 'good', name: '好单位', tip: '国企 / 外资 / 合资 / 上市 / 事业单位，或者大单位', fn: (r) => ['国企', '外资', '合资', '上市', '事业单位'].includes(r.nature) || r.size === '大单位' },
  { id: 'near', name: '离家近', tip: () => `区在：${S.near.join('、')}`, fn: (r) => S.near.includes(r.district) },
  { id: 'old', name: '清旧账', tip: '筛到 7 天以上还没处理的，看完可以一起「都不投」', fn: (r) => r.age != null && r.age >= 7 },
  { id: 'all', name: '全部', tip: '不加预设', fn: () => true },
];
const FACETS = [
  { id: 'verdict', name: '建议', val: (r) => r.vLabel, order: ['建议投', '你来定', '其他'] },
  { id: 'nature', name: '单位性质', val: (r) => r.nature },
  { id: 'size', name: '规模', val: (r) => r.size, order: ['大单位', '中型', '小公司', '没写'] },
  { id: 'district', name: '区域', val: (r) => r.district },
  { id: 'rest', name: '休息', val: (r) => r.rest, order: ['双休', '单休/大小周', '没写'] },
  { id: 'exp', name: '经验', val: (r) => r.exp, order: ['不限经验', '1 年', '1-3 年', '3 年以上', '没写'] },
  { id: 'age', name: '筛到', val: (r) => r.ageLabel, order: ['3 天内', '7 天内', '7 天以上', '没写'] },
  { id: 'src', name: '来源', val: (r) => r.src, order: SRC_ORDER, chips: true },
];
const SAL = [0, 4, 5, 6, 8, 10];
const SCORE = [0, 60, 70, 80];
const presetDef = (id = S.preset) => PRESETS.find((p) => p.id === id) || PRESETS[0];
const fset = (id) => S.f[id] || (S.f[id] = new Set());
const qOk = (r) => { const q = S.q.trim().toLowerCase(); return !q || [r.company, r.fullCompany, r.title, r.salary, r.city, r.companyInfo, ...(r.reasons || [])].join(' ').toLowerCase().includes(q); };
// skip：算某一维的计数时不套用它自己
// 网申「等你定」的默认收起来（队长 22:05 拍板），点开「网申」芯片才看得到
const campusHidden = (r) => r.src === 'campus' && r.verdict !== '投' && !fset('src').has('campus');
function pass(r, skip = '') {
  if (skip !== 'src' && campusHidden(r)) return false;
  if (skip !== 'preset' && !presetDef().fn(r)) return false;
  for (const fc of FACETS) { if (fc.id === skip) continue; const s = S.f[fc.id]; if (s?.size && !s.has(fc.val(r))) return false; }
  if (skip !== 'sal' && S.sal && !(r.sal && r.sal.lo >= S.sal)) return false;
  if (skip !== 'score' && S.score && !((r.score || 0) >= S.score)) return false;
  if (skip !== 'q' && !qOk(r)) return false;
  return true;
}
const PENDING = (q) => !['排队', '发送中', '失败', '已发'].includes(q.status);
const queue = () => S.data?.queue || [];
const pendingRows = () => S.rows.filter((r) => !S.dropping.has(r.jobId));
function sortRows(list) {
  const by = {
    rank: (a, b) => (VERDICT_RANK[a.verdict] ?? 9) - (VERDICT_RANK[b.verdict] ?? 9) || (b.score || 0) - (a.score || 0),
    score: (a, b) => (b.score || 0) - (a.score || 0),
    salary: (a, b) => (b.sal?.lo || 0) - (a.sal?.lo || 0) || (b.sal?.hi || 0) - (a.sal?.hi || 0),
    new: (a, b) => (b.addedAt || 0) - (a.addedAt || 0),
  }[S.sort] || (() => 0);
  return list.sort(by);
}
const filtered = () => sortRows(pendingRows().filter((r) => pass(r)));
const flight = () => queue().filter((x) => x.status === '排队' || x.status === '发送中' || x.status === '失败');
const anyFilter = () => FACETS.some((f) => S.f[f.id]?.size) || S.sal || S.score || S.q.trim();

// 筛选 / 排序存 localStorage + 网址（10/16 体检第 7 条：以前一刷新全丢）
function saveState() {
  const o = { preset: S.preset, f: Object.fromEntries(Object.entries(S.f).filter(([, s]) => s.size).map(([k, s]) => [k, [...s]])), sal: S.sal, score: S.score, sort: S.sort, near: S.near };
  try { localStorage.setItem('hunt-v2', JSON.stringify(o)); if (!V2) localStorage.setItem('hunt-tab', S.tab); } catch {}
  const p = new URLSearchParams();
  if (V2 && /[?&]v2\b/.test(location.search)) p.set('v2', '');
  if (!V2 && S.tab !== 'review') p.set('tab', S.tab);
  if (S.preset !== 'focus') p.set('p', S.preset);
  for (const [k, v] of Object.entries(o.f)) p.set(k, v.join(','));
  if (S.sal) p.set('sal', S.sal); if (S.score) p.set('score', S.score); if (S.sort !== 'rank') p.set('sort', S.sort);
  const qs = p.toString();
  history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));
}
function loadState() {
  let o = null;
  try { o = JSON.parse(localStorage.getItem('hunt-v2') || 'null'); const t = localStorage.getItem('hunt-tab'); if (!V2 && t && ['review', 'flight', 'board'].includes(t)) S.tab = t; } catch {}
  const p = new URLSearchParams(location.search);
  p.delete('v2');
  if ([...p.keys()].length) {
    o = { preset: p.get('p') || 'focus', f: {}, sal: +p.get('sal') || 0, score: +p.get('score') || 0, sort: p.get('sort') || 'rank', near: o?.near };
    for (const fc of FACETS) if (p.get(fc.id)) o.f[fc.id] = p.get(fc.id).split(',');
    if (!V2 && p.get('tab')) S.tab = p.get('tab');
  }
  if (!o) return;
  if (PRESETS.some((x) => x.id === o.preset)) S.preset = o.preset;
  for (const [k, v] of Object.entries(o.f || {})) S.f[k] = new Set(v);
  S.sal = +o.sal || 0; S.score = +o.score || 0; S.sort = o.sort || 'rank';
  if (Array.isArray(o.near) && o.near.length) S.near = o.near;
}

// ---------- 数据 ----------
async function load(fresh = false) {
  try { S.data = await (await fetch(MOCK ? 'mock/hunt.json' : `/api/hunt${fresh ? '?fresh' : ''}`, { cache: 'no-store' })).json(); }
  catch { S.data = { ok: false, why: '收件箱后台没响应（inbox.mjs 没开？）' }; }
  S.rows = queue().filter(PENDING).map(enrich);
  clearTimeout(load.t);
  const active = S.data?.todayBusy || S.data?.running || S.data?.sending || S.data?.scan?.running;
  load.t = setTimeout(() => load(true), active ? 6000 : 30000);
  const sig = JSON.stringify([S.data.ok, queue().map((q) => [q.jobId, q.status, q.error, q.verdict, q.score]), S.data.running, S.data.sending, S.data.todayBusy, S.data.todayStatus, S.data.stats, S.data.review?.at, S.data.review?.rows?.length, S.data.sources, S.data.scan, (S.data.logs || [])[0]?.at, (S.data.done || []).length]);
  renderTop();
  if (sig === S.sig && !S.dirty) return;              // 没变就不重画，滚动 / 勾选 / 光标都不动
  if (busyUi()) { S.dirty = true; S.sig = sig; return; }   // 正在改开场白 / 开着菜单或弹框：先不刷，等手停下来
  S.sig = sig; S.dirty = false;
  renderBody();
}
// 用户手上正忙的时候自动刷新先让一让（10/16 体检第 2 条）
const busyUi = () => !!document.querySelector('.menu-pop') || !$('#hconfirm').hidden || !$('#hset').hidden || (document.activeElement?.tagName === 'TEXTAREA');
async function post(path, body = {}) {
  if (MOCK) return { ok: true, mock: true, results: (body.items || []).map((i) => ({ jobId: i.jobId, ok: true })) };   // 演示数据：什么都不发
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(r.status === 409 ? (j.err || '已经在扫了，等这一轮跑完') : j.err || `出错了（${r.status}）`);
  return j;
}
function toast(text, kind = '', opt = {}) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<span>${esc(text)}</span>${opt.action ? `<button>${esc(opt.action)}</button>` : ''}`;
  if (opt.action) el.querySelector('button').onclick = () => { el.remove(); opt.fn?.(); };
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), opt.ms || (opt.action ? 6000 : kind === 'bad' ? 7000 : 3500));
}

// ---------- 渲染 ----------
function renderBody() {
  const d = S.data;
  const showReview = S.tab === 'review' && d?.ok;
  $('#review').hidden = !showReview;
  if (!d) { $('#hmain').innerHTML = '<div class="empty">正在读求职插件的数据…</div>'; return; }
  if (!d.ok) { $('#hmain').innerHTML = `<div class="empty">读不到求职插件：${esc(d.why || '')}<br>要 后台插件浏览器开着、插件装着；开机一分钟后它会自动打开</div>`; $('#hbatch').hidden = true; $('#drawer').hidden = true; return; }
  if (showReview) { $('#hmain').innerHTML = ''; renderReview(); }
  else { $('#drawer').hidden = true; S.tab === 'flight' ? renderFlight() : renderBoard(); }
  renderBatch();
}

function renderTop() {
  const d = S.data || {};
  const failN = flight().filter((x) => x.status === '失败').length, qN = flight().length - failN;
  // 排队 / 没投成的不在这页管了，给一句去投递页的指路（投递页里叫「待发送 / 没投成」）
  const fly = [qN && `排队 ${qN}`, failN && `<b class="bad">没投成 ${failN}</b>`].filter(Boolean).join(' · ');
  if (V2) $('#tabs').innerHTML = `<button role="tab" class="cur" aria-selected="true">待审<span>${pendingRows().length || ''}</span></button>`
    + (fly ? `<a class="h-fly" href="/apps" title="排队和没投成的都在「投递」页（待发送 / 没投成），撤回、再投也在那儿">${fly} · 去投递页看</a>` : '');
  else {
    const tabs = [['review', '待审', pendingRows().length], ['flight', '排队 / 失败', flight().length], ['board', '投递进度', d.review?.rows?.length || 0]];
    $('#tabs').innerHTML = tabs.map(([id, name, n]) => `<button role="tab" class="${S.tab === id ? 'cur' : ''}" data-tab="${id}" aria-selected="${S.tab === id}">${name}<span class="${id === 'flight' && failN ? 'bad' : ''}">${n || ''}</span></button>`).join('');
  }
  const sent = d.stats?.sent || 0, lim = d.dailyLimit || 15;
  const busy = d.todayBusy || d.running || d.scan?.running;
  const state = !d.ok ? ['bad', '插件连不上'] : busy ? ['busy', '插件在平台上找岗位'] : d.sending ? ['busy', '正在投'] : ['on', '插件空闲'];
  $('#hright').innerHTML = `
    <div class="quota" title="今天已打招呼 / 投递的家数，上限是插件设置里的每日上限">
      <span>今天已投 <b>${sent}</b> / ${lim}</span><i><em style="transform:scaleX(${Math.min(1, sent / lim)})"></em></i>
    </div>
    <span class="hstate"><i class="dot ${state[0]}"></i>${state[1]}</span>
    <button class="btn ghost sm" data-act="settings" title="插件去平台找岗位用的关键词和平台">${ico('gear')}找岗位设置</button>
    ${busy ? `<button class="btn sm" data-act="stop">${ico('stop')}停止找</button>` : `<button class="btn sm" data-act="run" ${d.ok ? '' : 'disabled'} title="去 BOSS / 51job / 智联 / 猎聘 / 网申一起找新岗位，点了先给你看清单">${ico('play')}去平台找新岗位</button>`}`;
  const line = $('#hline');
  const steps = d.scan?.steps || [];
  const txt = d.todayStatus || '';
  // 扫描进度：每个来源一段，「在跑 / 找到几家进待审几家 / 出错 + 修法」（契约 scan.steps）
  const STEP = { waiting: '排队', running: '在找', done: '找完了', error: '没扫成', skipped: '跳过' };
  const stepTxt = (st) => {
    const name = String(st.source || '').split('|').map((p) => plat(p).name).join(' / ');
    const body = st.state === 'done' ? `找到 ${st.found || 0} 家，进待审 ${st.listed || 0} 家${st.secs ? `（${st.secs} 秒）` : ''}` : st.state === 'error' ? `${st.note || '没扫成'}${st.fix ? `，${st.fix}` : ''}` : `${STEP[st.state] || st.state}${st.note ? ` · ${st.note}` : ''}`;
    return `<span class="h-step ${st.state}">${st.state === 'running' ? '<i class="spin"></i>' : ''}<b>${esc(name)}</b> ${esc(body)}</span>`;
  };
  const showSteps = steps.length && (d.scan.running || (d.scan.finishedAt && Date.now() - Date.parse(d.scan.finishedAt) < 10 * 60e3));
  line.hidden = !(showSteps || (busy && txt));
  if (!line.hidden) line.innerHTML = showSteps ? `${d.scan.running ? '' : '<span class="h-step done"><b>这一轮找完了</b></span>'}${steps.map(stepTxt).join('')}` : `<i class="spin"></i>${esc(txt)}`;
}

function renderReview(resetScroll = false) {
  renderPresets();
  renderFacets();
  renderTable(resetScroll);
  renderDrawer();
}
function renderSources() {
  const el = $('#sources'); if (!el) return;
  const rows = pendingRows(), base = rows.filter((r) => pass(r, 'src')), s = fset('src');
  const st = Object.fromEntries(Object.entries(S.data?.sources || {}).map(([k, v]) => [srcOf(k), v]));
  const allN = base.filter((r) => !(r.src === 'campus' && r.verdict !== '投')).length;
  const campGo = base.filter((r) => r.src === 'campus' && r.verdict === '投').length;
  el.innerHTML = `<span class="h-src-l">来源</span><button class="chip ${s.size ? '' : 'on'}" data-src="" title="五个来源一起看（网申只算建议投的）">全部<span>${allN}</span></button>`
    + SRC_ORDER.map((id) => {
      const n = base.filter((r) => r.src === id).length, info = st[id], bad = info && info.ok === false;
      const tip = bad ? `${PLAT[id].name}：${info.note || '这次没扫成'}${info.fix ? `；${info.fix}` : ''}`
        : id === 'campus' && n > campGo ? `平时只显示建议投的 ${campGo} 家；点开看全部 ${n} 家（含你来定的）` : `只看${PLAT[id].name}（Ctrl 点可多选）`;
      return `<button class="chip ${s.has(id) ? 'on' : ''} ${n ? '' : 'zero'}" data-src="${id}" title="${esc(tip)}"><span class="plat-ico ${PLAT[id].cls}">${PLAT[id].short}</span>${PLAT[id].name}<span>${n}</span>${bad ? '<i class="dot bad"></i>' : ''}</button>`;
    }).join('')
    + Object.entries(S.data?.sources || {}).filter(([id, v]) => v && v.ok === false && !(S.data?.scan?.steps || []).some((st) => st.state === 'error' && String(st.source).split('|').includes(id))).map(([id, v]) =>   // 扫描进度条里已经报了的不重复说
 `<span class="h-src-warn">${ico('alert')}${esc(plat(id).name)}：${esc(v.note || '这次没扫成')}${v.fix ? `，${esc(typeof v.fix === 'string' ? v.fix : v.fix.label || '')}` : ''}</span>`).join('');
}
function renderPresets() {
  renderSources();
  const base = pendingRows().filter((r) => pass(r, 'preset'));
  $('#presets').innerHTML = PRESETS.map((p) => {
    const n = base.filter(p.fn).length;
    const tip = typeof p.tip === 'function' ? p.tip() : p.tip;
    return `<button class="chip ${S.preset === p.id ? 'on' : ''}" data-preset="${p.id}" title="${esc(tip)}">${p.name}<span>${n}</span></button>`;
  }).join('') + (S.preset === 'near' ? '<button class="edit" data-act="editNear">改区域</button>' : '');
}
function facetOptions(fc) {
  const rows = pendingRows();
  const base = rows.filter((r) => pass(r, fc.id));
  const all = [...new Set(rows.map(fc.val))];
  const ord = fc.order || all.sort((a, b) => rows.filter((r) => fc.val(r) === b).length - rows.filter((r) => fc.val(r) === a).length);
  return ord.filter((o) => all.includes(o) || fset(fc.id).has(o)).map((o) => [o, base.filter((r) => fc.val(r) === o).length]);
}
function renderFacets() {
  const rows = pendingRows();
  const parts = FACETS.filter((fc) => !fc.chips).map((fc) => {
    if (fc.hideSingle && new Set(rows.map(fc.val)).size < 2 && !fset(fc.id).size) return '';
    const s = fset(fc.id);
    const label = s.size ? `${fc.name}：${[...s].slice(0, 2).join('、')}${s.size > 2 ? ` 等 ${s.size} 个` : ''}` : fc.name;
    const pop = S.openFacet === fc.id ? `<div class="menu-pop">${facetOptions(fc).map(([o, n]) => `<label class="opt ${n ? '' : 'zero'}"><input type="checkbox" data-fopt="${fc.id}" value="${esc(o)}" ${s.has(o) ? 'checked' : ''}>${esc(o)}<span>${n}</span></label>`).join('')}
      <div class="pop-foot"><button class="btn ghost sm" data-act="fclear" data-id="${fc.id}">清掉这项</button><button class="btn sm" data-act="fclose">好</button></div></div>` : '';
    return `<div class="facet"><button class="chip ${s.size ? 'set' : ''}" data-facet="${fc.id}">${label}${ico('chev')}</button>${pop}</div>`;
  });
  const single = (id, name, list, cur, fmt) => {
    const base = pendingRows().filter((r) => pass(r, id));
    const test = id === 'sal' ? (r, v) => !v || (r.sal && r.sal.lo >= v) : (r, v) => !v || (r.score || 0) >= v;
    const pop = S.openFacet === id ? `<div class="menu-pop">${list.map((v) => `<label class="opt"><input type="radio" name="${id}" data-fsingle="${id}" value="${v}" ${cur === v ? 'checked' : ''}>${v ? fmt(v) : '不限'}<span>${base.filter((r) => test(r, v)).length}</span></label>`).join('')}</div>` : '';
    return `<div class="facet"><button class="chip ${cur ? 'set' : ''}" data-facet="${id}">${cur ? `${name}：${fmt(cur)}` : name}${ico('chev')}</button>${pop}</div>`;
  };
  parts.push(single('sal', '月薪', SAL, S.sal, (v) => `起薪 ≥ ${v}k`));
  parts.push(single('score', '匹配分', SCORE, S.score, (v) => `≥ ${v} 分`));
  $('#facets').innerHTML = `${ico('filter')}${parts.join('')}${anyFilter() ? '<button class="clear" data-act="clearAll">清空筛选</button>' : ''}`;
  $('#facets > .i').style.cssText = 'width:14px;height:14px;color:var(--text-4);margin-right:2px';
}

function salHtml(r) {
  if (!r.sal) return `<span class="muted">${esc(r.salary || '没写')}</span>`;
  return `<span title="${esc(r.salary)}${r.sal.yearly ? '（年薪，按 12 个月折算）' : ''}">${kfmt(r.sal.lo)}–${kfmt(r.sal.hi)}k${r.sal.yearly ? '<small class="yr">年薪折</small>' : ''}${r.sal.bonus ? `<small>${r.sal.bonus} 薪</small>` : ''}</span>`;
}
function renderTable(resetScroll = false) {
  const all = pendingRows(), list = filtered();
  const goN = list.filter((x) => x.verdict === '投').length;
  $('#tbar').innerHTML = `<span><b>${list.length}</b> 个岗位${list.length !== all.length ? `（待审共 ${all.length}）` : ''}</span>
    ${goN ? `<button class="btn ghost sm" data-act="pickGo">勾上这里建议投的 ${goN} 家</button>` : ''}
    <span class="keys"><kbd>J</kbd><kbd>K</kbd>上下 <kbd>X</kbd>勾 <kbd>Y</kbd>投 <kbd>N</kbd>不投 <kbd>Enter</kbd>详情</span>
    <label class="sortby">排序 <select id="sortby">${[['rank', '建议优先'], ['score', '匹配分'], ['salary', '月薪'], ['new', '最新筛到']].map(([v, l]) => `<option value="${v}" ${S.sort === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`;
  const sc = $('#tscroll'), top = sc.scrollTop;
  if (!list.length) {
    $('#table').innerHTML = `<div class="empty">${all.length ? `这个筛选下没有岗位${zeroHint()}` : '没有待审的岗位<br>点右上角「去平台找新岗位」，插件会按关键词去 BOSS、51job、智联找'}</div>`;
    return;
  }
  const allOn = list.every((x) => S.sel.has(x.jobId));
  const rows = list.map((x) => {
    const p = plat(x.platform), on = S.sel.has(x.jobId);
    return `<tr class="${on ? 'ck' : ''} ${S.open === x.jobId ? 'open' : ''} ${S.cursor === x.jobId ? 'cursor' : ''}" data-job="${esc(x.jobId)}">
      <td class="c-ck"><input type="checkbox" ${on ? 'checked' : ''} data-ck="${esc(x.jobId)}" aria-label="勾选 ${esc(x.company)}"></td>
      <td><div class="co"><span class="plat-ico ${p.cls}" title="${esc(p.name)}">${p.short}</span><div><b title="${esc(x.fullCompany || x.company)}">${esc(x.company)}</b><small title="${esc(x.title)}">${esc(x.title)}</small>${x.dl ? `<small class="dl ${x.dl.late ? 'late' : ''}">${esc(x.dl.text)}${x.opened ? '<em> · 打开过</em>' : ''}</small>` : ''}</div></div></td>
      <td class="c-sal">${salHtml(x)}</td>
      <td class="c-dist">${esc(x.district.replace('没写区', '—'))}</td>
      <td class="c-unit">${esc(x.nature)}<small>${esc(x.size)}</small></td>
      <td class="c-rest">${x.rest === '双休' ? '双休' : x.rest === '没写' ? '<span class="no">没写</span>' : `<span class="bad">${esc(x.rest)}</span>`}</td>
      <td class="c-score">${x.score != null ? `<span class="score ${x.score >= 75 ? 'hi' : x.score >= 60 ? 'mid' : ''}">${esc(x.score)}</span>` : '—'}${x.odd ? `<span class="odd" title="${esc(x.odd)}">${ico('alert')}</span>` : ''}</td>
      <td class="c-v">${x.verdict === '投' ? '<span class="pill s-good">建议投</span>' : x.verdict === '等你定' ? '<span class="pill s-look">你来定</span>' : `<span class="pill">${esc(x.verdict || '—')}</span>`}</td>
      <td class="c-age">${x.age == null ? '—' : x.age === 0 ? '今天' : `${x.age} 天前`}</td>
      <td class="c-why"><div>${esc((x.reasons || [])[0] || x.check || '')}</div></td>
    </tr>`;
  }).join('');
  $('#table').innerHTML = `<table>
    <thead><tr><th class="c-ck"><input type="checkbox" data-ckall ${allOn ? 'checked' : ''} aria-label="全选看得见的"></th><th>公司 · 岗位</th><th>月薪</th><th class="c-dist">区域</th><th>单位</th><th>休息</th><th>分</th><th>建议</th><th class="c-age">筛到</th><th class="c-why">理由</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
  sc.scrollTop = resetScroll ? 0 : top;
}
// 筛空了：告诉他去掉哪个条件能看到几家
function zeroHint() {
  const rows = pendingRows();
  const tries = [];
  if (S.preset !== 'all') tries.push([`预设「${presetDef().name}」`, () => rows.filter((r) => pass(r, 'preset')).length, 'preset']);
  for (const fc of FACETS) if (S.f[fc.id]?.size) tries.push([`「${fc.name}」`, () => rows.filter((r) => pass(r, fc.id)).length, fc.id]);
  if (S.sal) tries.push(['「月薪」', () => rows.filter((r) => pass(r, 'sal')).length, 'sal']);
  if (S.score) tries.push(['「匹配分」', () => rows.filter((r) => pass(r, 'score')).length, 'score']);
  if (S.q.trim()) tries.push(['搜索词', () => rows.filter((r) => pass(r, 'q')).length, 'q']);
  const best = tries.map(([n, f, id]) => [n, f(), id]).filter((t) => t[1]).sort((a, b) => b[1] - a[1]).slice(0, 3);
  return best.length ? `<div class="hint-zero">${best.map(([n, c, id]) => `<button class="btn sm" data-act="dropFilter" data-id="${id}">去掉${esc(n)}能看到 ${c} 家</button>`).join('')}</div>` : '';
}

function goBtn(x, cls) {
  if (x.how === 'campus') return `<button class="${cls}" data-act="campus" data-id="${esc(x.jobId)}" ${safeHref(x.applyUrl || x.href) ? '' : 'disabled title="这条网申没有链接"'}>${ico('ext')}去网申填</button>`;
  return `<button class="${cls}" data-act="go" data-id="${esc(x.jobId)}">${ico('send')}${x.how === 'liepin' ? '投（猎聘）' : '投'}</button>`;
}
// 网申：POST approve 拿 open.url（后台顺手记「打开过」），再去 HR Desk 的「网申」标签：window.open('/?go=campus&url=…')
// 走外壳的新窗口拦截（routeInbox），这页自己不跳走。不在新外壳里就新窗口开
async function openCampus(x) {
  const r = await act('/api/hunt/approve', { jobId: x.jobId });
  const u = r?.open?.url || x.applyUrl || x.href;
  if (!/^https?:\/\//.test(u || '')) return toast('这条网申没有投递链接', 'bad');
  if ((window.hrdesk?.shell || 0) >= 2) { window.open(`${location.origin}/?go=campus&url=${encodeURIComponent(u)}`); toast(`在「网申」标签打开了 ${x.company}，填完在右边面板点「我交了」`, 'ok'); }
  else { window.open(u, '_blank', 'noopener'); toast(`${x.company} 的网申页在新窗口打开了，填完回网申面板点「我交了」`, 'ok'); }
  S.sig = ''; load(true);
}
function renderDrawer() {
  const el = $('#drawer');
  const x = S.open && pendingRows().find((r) => r.jobId === S.open);
  if (!x || S.tab !== 'review') { el.hidden = true; return; }
  const keepTop = el.dataset.id === x.jobId ? $('.d-body', el)?.scrollTop : 0;
  el.hidden = false; el.dataset.id = x.jobId;
  const p = plat(x.platform), isBoss = hasGreet(x);
  const g = S.drafts[x.jobId] ?? x.greeting ?? '';
  const gw = isBoss ? greetWarn({ ...x, platform: 'boss', greeting: g }) : '';
  el.innerHTML = `<div class="d-head">
      <span class="plat-ico av ${p.cls}">${p.short}</span>
      <div class="r-id"><h2>${esc(x.fullCompany || x.company)}</h2>
        <div class="sub">${[x.title, x.salary || '薪资没写', x.city].filter(Boolean).map(esc).join('<i>·</i>')}</div>
        ${x.companyInfo || x.hr ? `<div class="facts">${[x.companyInfo, x.hr && `${x.hr}${x.hrActive ? '，' + x.hrActive : ''}`].filter(Boolean).map(esc).join('<i>·</i>')}</div>` : ''}</div>
      <button class="btn ghost sm icon" data-act="close" title="关掉（Esc）">${ico('close')}</button>
    </div>
    <div class="d-tags">${x.verdict === '投' ? '<span class="pill s-good">建议投</span>' : x.verdict === '等你定' ? '<span class="pill s-look">你来定</span>' : ''}
      ${x.score != null ? `<span class="pill">匹配 ${esc(x.score)} 分</span>` : ''}${x.odd ? `<span class="pill s-look">${esc(x.odd)}</span>` : ''}
      <span class="pill">${esc(x.nature)} · ${esc(x.size)}</span><span class="pill ${x.rest === '双休' ? 's-good' : x.rest === '没写' ? '' : 's-bad'}">${esc(x.rest === '没写' ? '休息没写' : x.rest)}</span>
      ${x.age != null ? `<span class="pill">${x.age === 0 ? '今天筛到' : `${x.age} 天前筛到`}</span>` : ''}${x.dl ? `<span class="pill ${x.dl.late ? 's-bad' : 's-waiting'}">${esc(x.dl.text)}</span>` : ''}</div>
    <div class="d-acts">
      ${goBtn(x, 'btn primary sm')}
      <button class="btn danger sm" data-act="drop" data-id="${esc(x.jobId)}">不投</button>
      ${safeHref(x.href) ? `<a class="btn ghost sm" href="${safeHref(x.href)}" target="_blank" rel="noopener">${ico('ext')}岗位页</a>` : ''}
      <span class="keys"><kbd>Y</kbd>投 <kbd>N</kbd>不投</span>
    </div>
    <div class="d-body">
      ${x.greetedDefault ? `<div class="why look">${ico('alert')}<div><b>平台上已经发过默认招呼了</b>，再按「投」插件会拒绝。去页面上补开场白，补完按「不投」把它拿掉</div></div>` : ''}
      ${gw ? `<div class="why bad" id="gwarn">${ico('alert')}<div><b>开场白${esc(gw)}</b>，投之前在下面改掉</div></div>` : ''}
      ${(x.reasons || []).length ? `<div class="why ${x.verdict === '投' ? 'info' : 'look'}">${ico('bot')}<div><b>插件的判断${x.score != null ? `（${esc(x.score)} 分）` : ''}：</b><ul class="reasons">${x.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></div></div>` : ''}
      ${x.check ? `<div class="why info">${ico('search')}<div><b>公司背调：</b>${esc(x.check)}</div></div>` : ''}
      ${x.how === 'campus' ? `<div class="why info">${ico('ext')}<div><b>网申要你自己去填：</b>点「去网申填」会在 HR Desk 的「网申」标签里打开${x.dl ? `，${esc(x.dl.text)}` : ''}。填完在网申面板点「我交了」，它就会进投递表</div></div>` : ''}
      ${isBoss ? `<div class="greet"><div class="greet-h">开场白（投的时候发给 HR，可以直接改${x.src === 'liepin' ? '，猎聘上 85 字以内' : ''}）<span id="gcnt">${g.length} 字</span></div><div class="box"><textarea id="greet" rows="5">${esc(g)}</textarea></div></div>`
        : x.how === 'campus' ? '' : '<div class="src">51job / 智联只投简历，不发开场白</div>'}
      ${x.jd ? `<details class="hist" open><summary>${ico('chev')}岗位描述</summary><div class="jd">${esc(x.jd)}</div></details>` : ''}
    </div>`;
  $('.d-body', el).scrollTop = keepTop || 0;
  const t = $('#greet');
  if (t) t.addEventListener('input', () => { S.drafts[x.jobId] = t.value; $('#gcnt').textContent = `${t.value.length} 字`; });
}

// 老外壳才用：排队 / 失败、投递进度（新外壳里并进投递页）
function renderFlight() {
  const fl = flight(), fail = fl.filter((x) => x.status === '失败'), q = fl.filter((x) => x.status !== '失败'), done = S.data.done || [];
  const logs = (S.data.logs || []).filter((l) => S.logAll || !/初筛淘汰/.test(l.text || ''));
  const row = (x) => {
    const p = plat(x.platform);
    return `<div class="f-row ${x.status === '失败' ? 'fail' : ''}"><span class="plat-ico ${p.cls}">${p.short}</span>
      <div class="f-main"><b>${esc(x.company)}</b><small>${esc(x.title)}</small>${x.error ? `<div class="f-err">${esc(x.error)}</div>` : ''}</div>
      ${x.status === '失败' ? '' : `<span class="pill s-waiting">${esc(x.status)}</span>`}
      <div class="f-act">${x.status === '排队' ? `<button class="btn ghost sm" data-act="undo" data-id="${esc(x.jobId)}">${ico('undo')}撤回</button>` : ''}
        ${x.status === '失败' ? `<button class="btn sm" data-act="retry" data-id="${esc(x.jobId)}">再投</button><button class="btn ghost sm" data-act="dropFail" data-id="${esc(x.jobId)}">不投了</button>` : ''}</div></div>`;
  };
  $('#hmain').innerHTML = `<div class="h-flight">
    <section>
      ${fail.length ? `<h3 class="bad">没投成 <span>${fail.length}</span></h3>${fail.map(row).join('')}` : ''}
      <h3 style="${fail.length ? 'margin-top:16px' : ''}">排队中 <span>${q.length}</span></h3>${q.length ? q.map(row).join('') : '<div class="empty sm">没有在排队的。投出去的岗位会在这里一家一家发，每家之间插件会按节奏隔一会</div>'}
    </section>
    <section><h3>今天投出去的 <span>${done.length}</span></h3>${done.length ? done.map((d) => `<div class="f-row"><span class="plat-ico ${plat(d.platform || 'boss').cls}">${plat(d.platform || 'boss').short}</span><div class="f-main"><b>${esc(d.company || '')}</b><small>${esc(d.title || '')}</small></div><span class="f-time">${d.at ? new Date(d.at).toTimeString().slice(0, 5) : ''}</span></div>`).join('') : '<div class="empty sm">今天还没投出去</div>'}</section>
    <section class="f-log"><h3>插件日志 <span>${logs.length}</span><button class="btn ghost sm" data-act="logAll">${S.logAll ? '只看要紧的' : '连「初筛淘汰」一起看'}</button></h3>${logs.slice(0, 40).map((l) => `<div class="lg ${l.level === 'error' ? 'bad' : l.level === 'warn' ? 'warn' : ''}"><span>${l.at ? new Date(l.at).toTimeString().slice(0, 5) : ''}</span>${esc(l.text || '')}</div>`).join('') || '<div class="empty sm">没有要紧的日志</div>'}</section>
  </div>`;
}

function renderBoard() {
  const rows = S.data.review?.rows || [];
  if (!rows.length) { $('#hmain').innerHTML = '<div class="empty">插件里还没有投递记录（每天第一次找岗位前它会回顾一遍）</div>'; return; }
  const q = S.boardQ.trim().toLowerCase();
  const hit = rows.filter((r) => !q || [r.company, r.title, r.state, r.next, r.last].join(' ').toLowerCase().includes(q));
  const cols = new Map();
  for (const r of [...hit].sort((a, b) => (a.level ?? 9) - (b.level ?? 9) || (b.at || 0) - (a.at || 0))) {
    const k = r.state || '其他';
    if (!cols.has(k)) cols.set(k, []);
    cols.get(k).push(r);
  }
  const prevOpen = Object.fromEntries($$('.b-grp').map((d) => [d.dataset.k, d.open]));
  const scroll = $('.h-board')?.scrollTop || 0;
  $('#hmain').innerHTML = `<div class="h-board">
    <div class="b-bar"><label class="search">${ico('search')}<input id="bq" placeholder="搜公司、岗位、状态" value="${esc(S.boardQ)}"></label><span class="muted">${hit.length} 家${q ? `（共 ${rows.length}）` : ''}</span></div>
    ${[...cols].map(([state, list], i) => `<details class="b-grp" data-k="${esc(state)}" ${(prevOpen[state] ?? (q || i < 3)) ? 'open' : ''}><summary>${esc(state)}<span>${list.length}</span>${ico('chev')}</summary>
      ${list.map((r) => `<div class="b-row">
        <div class="co"><span class="plat-ico ${plat(r.platform).cls}">${plat(r.platform).short}</span><div><b>${esc(r.company)}</b><small class="b-ttl-sm">${esc(r.title || '')}</small></div></div>
        <span class="muted b-ttl">${esc(r.salary || '')}</span>
        <span class="muted">${r.days != null ? (+r.days === 0 ? '今天投的' : `${esc(r.days)} 天前投`) : ''}</span>
        <p title="${esc(r.last || '')}">${esc(r.next || r.last || '')}</p>
        <a class="btn ghost sm" href="index.html?q=${encodeURIComponent(r.company || '')}" target="_blank" rel="noopener" title="新窗口里打开收件箱，找这家的聊天">${ico('msg')}聊天</a>
      </div>`).join('')}</details>`).join('') || '<div class="empty">没搜到</div>'}
  </div>`;
  $('.h-board').scrollTop = scroll;
}

function renderBatch() {
  const bar = $('#hbatch');
  const vis = new Set(filtered().map((x) => x.jobId));
  const pend = new Set(pendingRows().map((x) => x.jobId));
  for (const id of [...S.sel]) if (!pend.has(id)) S.sel.delete(id);      // 已经投 / 不投掉的自动去掉
  const shown = [...S.sel].filter((id) => vis.has(id)), hidden = [...S.sel].filter((id) => !vis.has(id));
  bar.hidden = !(S.tab === 'review' && S.sel.size);
  if (bar.hidden) return;
  const left = Math.max(0, (S.data.dailyLimit || 15) - (S.data.stats?.sent || 0) - flight().filter((x) => x.status !== '失败').length);
  const camp = campusIds(shown).length, goN = shown.length - camp;
  bar.innerHTML = `<span>已勾 <b>${shown.length}</b> 家</span>
    ${camp ? `<span class="hidden-n">其中网申 ${camp} 家要自己去填，「投」不含它们</span>` : ''}
    <span class="quota-n ${shown.length > left ? 'over' : ''}">今天还剩 ${left} 个名额</span>
    ${hidden.length ? `<span class="hidden-n">另 ${hidden.length} 家勾了但被筛掉了，不会动 <button data-act="dropHidden">取消它们</button></span>` : ''}
    <button class="btn primary sm" data-act="batchGo" ${S.busy || !goN ? 'disabled' : ''}>${ico('send')}投这 ${goN} 家</button>
    <button class="btn danger sm" data-act="batchDrop" ${S.busy || !shown.length ? 'disabled' : ''}>都不投</button>
    <button class="btn ghost sm" data-act="clearSel">取消勾选</button>`;
}
const visibleSelected = () => { const vis = new Set(filtered().map((x) => x.jobId)); return [...S.sel].filter((id) => vis.has(id)); };
// 批量「投」只投能自动投的；网申要一家家去填，不进这批
const campusIds = (ids) => ids.filter((id) => pendingRows().find((r) => r.jobId === id)?.how === 'campus');

// 勾选只动这一行和批量条，不整表重画（10/16 体检第 2 条：以前一勾就跳回顶）
function syncChecks() {
  for (const tr of $$('#table tbody tr')) { const on = S.sel.has(tr.dataset.job); tr.classList.toggle('ck', on); const ck = $('input[data-ck]', tr); if (ck) ck.checked = on; }
  const all = $('[data-ckall]'); if (all) { const ids = filtered().map((x) => x.jobId); all.checked = ids.length && ids.every((id) => S.sel.has(id)); }
  renderBatch();
}
function syncCursor() {
  for (const tr of $$('#table tbody tr')) { tr.classList.toggle('cursor', tr.dataset.job === S.cursor); tr.classList.toggle('open', tr.dataset.job === S.open); }
  $(`#table tr[data-job="${CSS.escape(S.cursor || '')}"]`)?.scrollIntoView({ block: 'nearest' });
}

function renderSettings() {
  const saved = S.data?.daily;
  const d = { keywords: ['跨境电商运营', '电商运营', 'AI产品经理', '产品运营', '新媒体运营', 'GEO运营', 'AI搜索优化'], boss: true, job51: true, zhilian: true, bigOnly: false, perKeyword: 8, ...(saved || {}) };
  const m = $('#hset');
  m.innerHTML = `<div class="modal-card set-card">
    <h3>找岗位设置</h3>
    <p>插件按这些关键词去平台上找新岗位，找到的进「待审」。和插件侧边栏「今天」里的设置是同一份。</p>
    ${saved ? '' : '<p class="set-note">插件里还没存过设置，下面是它的默认值；点「保存」会把这套写进插件。</p>'}
    <label>关键词（一行一个）<textarea id="skw" rows="7">${esc((d.keywords || []).join('\n'))}</textarea></label>
    <div class="set-row">
      <label><input type="checkbox" id="sboss" ${d.boss !== false ? 'checked' : ''}> BOSS</label>
      <label><input type="checkbox" id="s51" ${d.job51 !== false ? 'checked' : ''}> 51job</label>
      <label><input type="checkbox" id="szl" ${d.zhilian !== false ? 'checked' : ''}> 智联 HR 邀请</label>
    </div>
    <div class="set-row">
      <label>每个关键词细看 <input type="number" id="sper" min="1" max="30" value="${esc(d.perKeyword || 8)}"> 家</label>
      <label><input type="checkbox" id="sbig" ${d.bigOnly ? 'checked' : ''}> 只搜大单位</label>
    </div>
    <div class="modal-acts"><button class="btn ghost" data-act="closeSet">取消</button><button class="btn primary" data-act="saveSet">保存</button></div>
  </div>`;
  m.hidden = false;
}
// 批量确认框：列出公司名、名额、BOSS 的开场白（10/16 体检第 1 条：以前只问「投这 3 家？」）
function confirmBox({ title, desc, ids, okText, danger }) {
  return new Promise((resolve) => {
    const m = $('#hconfirm');
    const rows = ids.map((id) => pendingRows().find((r) => r.jobId === id)).filter(Boolean);
    const warnN = rows.filter((r) => greetWarn({ ...r, greeting: S.drafts[r.jobId] ?? r.greeting })).length;
    m.innerHTML = `<div class="modal-card">
      <h3>${esc(title)}</h3>${desc ? `<p>${desc}</p>` : ''}
      ${warnN ? `<div class="cf-warn">${warnN} 家 BOSS 的开场白有问题（问待遇），在下面标红了</div>` : ''}
      <div class="cf-list">${rows.map((r) => { const g = r.platform === 'boss' ? (S.drafts[r.jobId] ?? r.greeting ?? '') : ''; const w = g && greetWarn({ ...r, greeting: g });
        return `<div class="cf-row"><span class="plat-ico ${plat(r.platform).cls}">${plat(r.platform).short}</span><div><b>${esc(r.company)}</b><small>${esc(r.title)} · ${esc(r.salary || '薪资没写')} · ${esc(r.nature)} · ${esc(r.size)}</small>${g ? `<div class="g ${w ? 'bad' : ''}">${esc(g)}</div>` : ''}</div></div>`; }).join('')}</div>
      <div class="modal-acts"><button class="btn ghost" data-cf="0">取消</button><button class="btn ${danger ? 'danger' : 'primary'}" data-cf="1">${esc(okText)}</button></div></div>`;
    m.hidden = false;
    $('[data-cf="1"]', m).focus();
    m.onclick = (e) => { const b = e.target.closest('[data-cf]'); if (!b && e.target !== m) return; m.hidden = true; m.onclick = null; resolve(b?.dataset.cf === '1'); if (S.dirty) load(); };
  });
}

// 「去平台找新岗位」确认框：列出每个来源在哪跑、大概多久，可以去掉某个来源（用户 10/16 22:00：要连着网申和猎聘一块扫）
const RUN_DEFAULT = [
  { id: 'boss', how: '按你的关键词搜', where: '插件在 后台插件浏览器里翻页', eta: '约 5 分钟' },
  { id: '51job', how: '按你的关键词搜', where: '插件在 后台插件浏览器里翻页', eta: '约 4 分钟' },
  { id: 'zhilian', how: '读 HR 发来的邀请', where: '插件在 后台插件浏览器里', eta: '约 1 分钟' },
  { id: 'liepin', how: '按同一套关键词搜', where: 'HR Desk 软件里的猎聘页', eta: '约 3 分钟' },
  { id: 'campus', how: '拉网申公告，按你的标准初筛', where: '求职方舟公开公告，不用登录', eta: '约 1 分钟' },
];
function runBox() {
  return new Promise((resolve) => {
    const m = $('#hconfirm');
    const st = Object.fromEntries(Object.entries(S.data?.sources || {}).map(([k, v]) => [srcOf(k), v]));
    const rows = RUN_DEFAULT.map((d) => ({ ...d, ...(st[d.id] && st[d.id].ok === false ? { ok: false, note: [st[d.id].note, st[d.id].fix].filter((v) => typeof v === 'string' && v).join('，') } : {}) }));
    const kw = (S.data?.daily?.keywords || []).filter(Boolean);
    m.innerHTML = `<div class="modal-card run-card">
      <h3>去 ${rows.length} 个来源找新岗位？</h3>
      <p>找到的都进这页「待审」，你审过才会投，不会自动投出去。关键词：${kw.length ? esc(kw.slice(0, 6).join('、')) + (kw.length > 6 ? ` 等 ${kw.length} 个` : '') : '插件默认那套'}（右上角「找岗位设置」里改）。</p>
      <div class="run-list">${rows.map((r) => `<label class="run-row ${r.ok === false ? 'bad' : ''}"><input type="checkbox" value="${r.id}" ${r.ok === false ? '' : 'checked'}>
        <span class="plat-ico ${PLAT[r.id].cls}">${PLAT[r.id].short}</span>
        <div><b>${PLAT[r.id].name}</b><small>${esc(r.how)} · ${esc(r.where)}</small>${r.note ? `<small class="${r.ok === false ? 'bad' : ''}">${esc(r.note)}</small>` : ''}</div>
        <span class="eta">${esc(r.eta)}</span></label>`).join('')}</div>
      <p class="run-sum" id="runsum"></p>
      <div class="modal-acts"><button class="btn ghost" data-cf="0">取消</button><button class="btn primary" data-cf="1">开始找</button></div></div>`;
    const sum = () => {
      const on = $$('.run-list input:checked', m);
      const mins = on.map((i) => +(rows.find((r) => r.id === i.value).eta.match(/\d+/) || [0])[0]);
      const plug = on.filter((i) => ['boss', '51job', 'zhilian'].includes(i.value)).length;
      $('#runsum', m).textContent = on.length ? `大概 ${Math.max(...mins, 1)}～${mins.reduce((a, b) => a + b, 0) || 1} 分钟（几个来源一起跑，插件那几个排着来）${plug ? '，期间 后台插件浏览器在翻页，别关它' : ''}。` : '一个来源都没选';
      $('[data-cf="1"]', m).disabled = !on.length;
    };
    m.onchange = sum; sum();
    m.hidden = false;
    $('[data-cf="1"]', m).focus();
    m.onclick = (e) => {
      const b = e.target.closest('[data-cf]'); if (!b && e.target !== m) return;
      const picked = $$('.run-list input:checked', m).map((i) => i.value);
      m.hidden = true; m.onclick = null; m.onchange = null;
      resolve(b?.dataset.cf === '1' ? picked : null); if (S.dirty) load();
    };
  });
}

// ---------- 动作 ----------
async function act(path, body, okMsg, opt) {
  try {
    const r = await post(path, body);
    if (r.ok === false) { toast(r.why || '没成', 'bad'); return false; }
    if (okMsg) toast(okMsg, 'ok', opt);
    return r;
  } catch (e) { toast(e.message, 'bad'); return false; }
}
function nextOf(id) {
  const ids = filtered().map((x) => x.jobId);
  const i = ids.indexOf(id);
  return ids[i + 1] || ids[i - 1] || null;
}
const undoApprove = (ids) => async () => {
  for (const id of ids) await post('/api/hunt/unapprove', { jobId: id }).catch(() => {});
  toast('撤回了，回到待审（已经发出去的撤不回）'); load(true);
};
async function goOne(id) {
  const x = pendingRows().find((q) => q.jobId === id); if (!x) return;
  if (x.how === 'campus') return openCampus(x);
  const g = hasGreet(x) ? (S.open === id && $('#greet') ? $('#greet').value : S.drafts[id]) : undefined;
  const nx = nextOf(id);
  if (await act('/api/hunt/approve', { jobId: id, greeting: g }, x.how === 'liepin' ? `「${x.company}」进了发送排队（猎聘，软件里投）` : `「${x.company}」进了发送排队`, { action: '撤回', fn: undoApprove([id]) })) {
    delete S.drafts[id]; S.sel.delete(id);
    if (S.open === id) S.open = nx;
    if (S.cursor === id) S.cursor = nx;
  }
  S.sig = ''; await load(true);
}
// 不投：先在界面上拿掉，5 秒后才真告诉插件（插件那边不投是永久的，撤不回）
function dropLater(ids, label) {
  const nx = ids.length === 1 ? nextOf(ids[0]) : null;
  const timer = setTimeout(async () => {
    for (const id of ids) S.dropping.delete(id);
    if (ids.length === 1) await act('/api/hunt/drop', { jobId: ids[0] });
    else {
      const r = await act('/api/hunt/batch', { action: 'drop', items: ids.map((id) => ({ jobId: id })) });
      const bad = (r?.results || []).filter((x) => !x.ok);
      if (bad.length) toast(`${bad.length} 家没拿掉：${bad[0].why || ''}`, 'bad');
    }
    S.sig = ''; load(true);
  }, UNDO_MS);
  for (const id of ids) { S.dropping.set(id, timer); S.sel.delete(id); }
  if (ids.includes(S.open)) S.open = nx;
  if (ids.includes(S.cursor)) S.cursor = nx;
  renderTop(); renderReview(); renderBatch();
  toast(`不投${label}，以后筛选也不再出现`, '', { action: '撤销', ms: UNDO_MS, fn: () => {
    clearTimeout(timer); for (const id of ids) S.dropping.delete(id);
    renderTop(); renderReview(); renderBatch(); toast('撤销了，还在待审');
  } });
}
async function batchGo() {
  const camp = new Set(campusIds(visibleSelected()));
  const ids = visibleSelected().filter((id) => !camp.has(id)); if (!ids.length) return;
  const left = Math.max(0, (S.data.dailyLimit || 15) - (S.data.stats?.sent || 0) - flight().filter((x) => x.status !== '失败').length);
  const ok = await confirmBox({ title: `投这 ${ids.length} 家？`, okText: `投 ${ids.length} 家`,
    desc: `插件会一家一家发。今天还剩 <b>${left}</b> 个名额（共 ${S.data.dailyLimit || 15}）${ids.length > left ? `，<b style="color:var(--danger)">超出 ${ids.length - left} 家</b>` : ''}。`, ids });
  if (!ok) return;
  S.busy = true; renderBatch();
  const r = await act('/api/hunt/batch', { action: 'approve', items: ids.map((id) => ({ jobId: id, greeting: S.drafts[id] })) });
  S.busy = false;
  if (r) {
    const res = r.results || [];
    const bad = res.filter((x) => !x.ok), good = res.filter((x) => x.ok).map((x) => x.jobId);
    toast(`投了 ${good.length} 家${bad.length ? `，${bad.length} 家没成` : ''}`, bad.length ? 'bad' : 'ok', good.length ? { action: '撤回', fn: undoApprove(good) } : {});
    if (bad.length) setTimeout(() => alert(`没成的：\n${bad.slice(0, 5).map((b) => `${queue().find((q) => q.jobId === b.jobId)?.company || b.jobId}：${b.why}`).join('\n')}`), 50);
    for (const id of good) { S.sel.delete(id); delete S.drafts[id]; if (S.open === id) S.open = null; }
  }
  S.sig = ''; await load(true);
}
async function batchDrop() {
  const ids = visibleSelected(); if (!ids.length) return;
  const ok = await confirmBox({ title: `这 ${ids.length} 家都不投？`, okText: `都不投`, danger: true, desc: '不投的以后筛选也不会再出现。点了以后 5 秒内还能撤销。', ids });
  if (ok) dropLater(ids, ` ${ids.length} 家`);
}
function setPreset(id) { S.preset = id; S.cursor = null; saveState(); renderReview(true); renderBatch(); }
function filtersChanged() { saveState(); renderPresets(); renderFacets(); renderTable(true); renderDrawer(); renderBatch(); }

document.addEventListener('click', async (e) => {
  const tab = e.target.closest('[data-tab]');
  if (tab) { S.tab = tab.dataset.tab; S.openFacet = null; saveState(); renderTop(); renderBody(); return; }
  const sc = e.target.closest('[data-src]');
  if (sc) {
    const id = sc.dataset.src, s = fset('src');
    if (!id) s.clear();
    else if (e.ctrlKey || e.metaKey) s.has(id) ? s.delete(id) : s.add(id);
    else if (s.size === 1 && s.has(id)) s.clear();
    else { s.clear(); s.add(id); }
    S.cursor = null; return filtersChanged();
  }
  const pr = e.target.closest('[data-preset]');
  if (pr) return setPreset(pr.dataset.preset);
  const fb = e.target.closest('[data-facet]');
  if (fb) { S.openFacet = S.openFacet === fb.dataset.facet ? null : fb.dataset.facet; renderFacets(); return; }
  if (S.openFacet && !e.target.closest('.facet')) { S.openFacet = null; renderFacets(); if (S.dirty) load(); }
  const ck = e.target.closest('[data-ck]');
  if (ck) {
    const id = ck.dataset.ck;
    if (e.shiftKey && S.lastClick) {
      const ids = filtered().map((x) => x.jobId);
      const [a, b] = [ids.indexOf(S.lastClick), ids.indexOf(id)].sort((m, n) => m - n);
      if (a >= 0) for (const k of ids.slice(a, b + 1)) S.sel.add(k);
    } else ck.checked ? S.sel.add(id) : S.sel.delete(id);
    S.lastClick = id; syncChecks(); return;
  }
  if (e.target.closest('[data-ckall]')) { const ids = filtered().map((x) => x.jobId); const all = ids.every((id) => S.sel.has(id)); ids.forEach((id) => (all ? S.sel.delete(id) : S.sel.add(id))); syncChecks(); return; }
  const a = e.target.closest('[data-act]');
  if (a) {
    const id = a.dataset.id, k = a.dataset.act;
    if (k === 'go') return goOne(id);
    if (k === 'campus') { const x = pendingRows().find((r) => r.jobId === id); return x && openCampus(x); }
    if (k === 'drop') { const x = pendingRows().find((r) => r.jobId === id); return x && dropLater([id], `「${x.company}」`); }
    if (k === 'retry') { await act('/api/hunt/approve', { jobId: id }, '重新进了发送排队'); S.sig = ''; return load(true); }
    if (k === 'dropFail') { if (!confirm('这家不投了？以后筛选也不会再出现。')) return; await act('/api/hunt/drop', { jobId: id }, '拿掉了'); S.sig = ''; return load(true); }
    if (k === 'undo') { await act('/api/hunt/unapprove', { jobId: id }, '撤回了，回到待审'); S.sig = ''; return load(true); }
    if (k === 'logAll') { S.logAll = !S.logAll; return renderFlight(); }
    if (k === 'close') { S.open = null; syncCursor(); return renderDrawer(); }
    if (k === 'pickGo') { filtered().filter((x) => x.verdict === '投').forEach((x) => S.sel.add(x.jobId)); return syncChecks(); }
    if (k === 'clearSel') { S.sel.clear(); return syncChecks(); }
    if (k === 'dropHidden') { const vis = new Set(filtered().map((x) => x.jobId)); for (const x of [...S.sel]) if (!vis.has(x)) S.sel.delete(x); return syncChecks(); }
    if (k === 'batchGo') return batchGo();
    if (k === 'batchDrop') return batchDrop();
    if (k === 'fclear') { fset(a.dataset.id).clear(); S.openFacet = null; return filtersChanged(); }
    if (k === 'fclose') { S.openFacet = null; renderFacets(); if (S.dirty) load(); return; }
    if (k === 'clearAll') { S.f = {}; S.sal = 0; S.score = 0; S.q = ''; $('#fq').value = ''; return filtersChanged(); }
    if (k === 'dropFilter') {
      const f = a.dataset.id;
      if (f === 'preset') S.preset = 'all'; else if (f === 'sal') S.sal = 0; else if (f === 'score') S.score = 0; else if (f === 'q') { S.q = ''; $('#fq').value = ''; } else fset(f).clear();
      return filtersChanged();
    }
    if (k === 'editNear') { const n = prompt('「离家近」包括哪些区（逗号隔开）：', S.near.join('，')); if (n !== null) { const v = n.split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean).map((s) => (/区$/.test(s) ? s : s + '区')); if (v.length) { S.near = v; filtersChanged(); } } return; }
    if (k === 'run') {
      const picked = await runBox(); if (!picked) return;
      // 后台还没接上 scan-all（老 inbox.mjs）时退回老接口：只让插件找 BOSS / 51job / 智联，并说清楚
      try { await post('/api/hunt/scan-all', { sources: picked }); toast(`开始找了：${picked.map((id) => PLAT[id].name).join('、')}，找到的会陆续进「待审」`, 'ok'); }
      catch (e) {
        if (!/404/.test(e.message)) { toast(e.message, 'bad'); return; }
        await act('/api/hunt/run', {}, '后台还没接上猎聘和网申，这次只让插件找了 BOSS / 51job / 智联');
      }
      setTimeout(() => load(true), 1500); return;
    }
    if (k === 'stop') { const scan = S.data?.scan?.running; if (await act(scan ? '/api/hunt/scan-stop' : '/api/hunt/stop', {}, scan ? '停下了：插件手上这一家走完就停，猎聘也停；网申几秒就拉完，不用停' : '让插件停下了，手上这一家走完就停')) setTimeout(() => load(true), 2500); return; }
    if (k === 'settings') return renderSettings();
    if (k === 'closeSet') { $('#hset').hidden = true; return; }
    if (k === 'saveSet') {
      const body = { keywords: $('#skw').value.split('\n'), boss: $('#sboss').checked, job51: $('#s51').checked, zhilian: $('#szl').checked, perKeyword: +$('#sper').value, bigOnly: $('#sbig').checked };
      if (await act('/api/hunt/daily', body, '保存了')) { $('#hset').hidden = true; load(true); }
      return;
    }
  }
  const tr = e.target.closest('tr[data-job]');
  if (tr && !e.target.closest('button,input,a')) { S.open = S.open === tr.dataset.job ? null : tr.dataset.job; S.cursor = tr.dataset.job; syncCursor(); renderDrawer(); return; }
  if (e.target.id === 'hset') $('#hset').hidden = true;
});
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'sortby') { S.sort = t.value; saveState(); renderTable(true); return; }
  if (t.dataset.fopt) { const s = fset(t.dataset.fopt); t.checked ? s.add(t.value) : s.delete(t.value); return filtersChanged(); }
  if (t.dataset.fsingle) { S[t.dataset.fsingle] = +t.value; S.openFacet = null; return filtersChanged(); }
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'bq') { S.boardQ = e.target.value; const pos = e.target.selectionStart; renderBoard(); const q = $('#bq'); q.focus(); q.setSelectionRange(pos, pos); }
  if (e.target.id === 'fq') { S.q = e.target.value; renderPresets(); renderTable(true); renderBatch(); if (S.openFacet) renderFacets(); }
});
document.addEventListener('focusout', () => setTimeout(() => { if (S.dirty && !busyUi()) load(); }, 0));

document.addEventListener('keydown', (e) => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) && document.activeElement?.type !== 'checkbox';
  if (e.key === 'Escape') {
    if (S.openFacet) { S.openFacet = null; renderFacets(); }
    else if (!$('#hconfirm').hidden) $('#hconfirm').onclick?.({ target: $('#hconfirm') });
    else if (!$('#hset').hidden) $('#hset').hidden = true;
    else if (typing) document.activeElement.blur();
    else if (S.open) { S.open = null; syncCursor(); renderDrawer(); }
    return;
  }
  if (typing || e.ctrlKey || e.metaKey || e.altKey || S.tab !== 'review' || !$('#hconfirm').hidden || !$('#hset').hidden) return;
  const ids = filtered().map((x) => x.jobId);
  const i = ids.indexOf(S.cursor);
  const k = e.key.toLowerCase();
  const step = (d) => { S.cursor = ids[Math.max(0, Math.min(ids.length - 1, i < 0 ? 0 : i + d))] || null; if (S.open) S.open = S.cursor; syncCursor(); if (S.open) renderDrawer(); };
  if (k === 'j' && e.shiftKey) { if (S.cursor) S.sel.add(S.cursor); step(1); if (S.cursor) S.sel.add(S.cursor); syncChecks(); }
  else if (k === 'k' && e.shiftKey) { if (S.cursor) S.sel.add(S.cursor); step(-1); if (S.cursor) S.sel.add(S.cursor); syncChecks(); }
  else if (k === 'j' || k === 'k') step(k === 'j' ? 1 : -1);
  else if (k === 'x' && S.cursor) { S.sel.has(S.cursor) ? S.sel.delete(S.cursor) : S.sel.add(S.cursor); syncChecks(); }
  else if (k === 'y' && S.cursor) goOne(S.cursor);
  else if (k === 'n' && S.cursor) { const x = pendingRows().find((r) => r.jobId === S.cursor); if (x) dropLater([x.jobId], `「${x.company}」`); }
  else if (k === 'enter' && S.cursor) { S.open = S.open === S.cursor ? null : S.cursor; syncCursor(); renderDrawer(); }
  else if (k === '/') { e.preventDefault(); $('#fq')?.focus(); }
  else return;
  e.preventDefault();
});

$('#ver').textContent = VERSION;
if (!V2) { document.title = '海投工作台'; $('#hname').textContent = '海投工作台'; $('#hback').hidden = false; }
loadState();
load(true);
