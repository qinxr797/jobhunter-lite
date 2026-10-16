// 投递总表 v2.2.0（10/16 重做）：所有渠道、所有人投的一张表。蓝本：Simplify 的表格 / 看板切换 + 保存筛选 + 归档不删、
// JobSync 的字段和阶段时间线、Linear 的键盘（J/K、Enter、/、Esc）。数据：GET /api/tracker?view=all（一次拿全，视图和筛选在前端算，计数和看到的永远一致）、
// GET /api/tracker/item?id=（时间线）、POST /api/tracker/stage（手动改阶段）、POST /api/hunt/unapprove（撤回待发送）。?mock=1 读 ui/mock/，不发任何 POST。
// 这版要点：刷新按行对比只换变了的行，不丢滚动 / 焦点 / 光标；改阶段和撤回都有 5 秒撤销；筛选和视图存 localStorage + 网址。
const VERSION = 'v2.2.0';
const MOCK = new URLSearchParams(location.search).has('mock');
const UNDO_MS = 5000;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s = '') => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ico = (n) => `<svg class="i"><use href="#i-${n}"/></svg>`;
const safeHref = (u) => (/^https?:\/\//.test(u || '') ? esc(u) : '');

const PLAT = { boss: ['BOSS', 'B', 'p-boss'], zl: ['智联', '智', 'p-zl'], 51: ['51job', '51', 'p-51'], lp: ['猎聘', '猎', 'p-lp'], campus: ['网申', '网', 'p-campus'] };
const PID_OF = { BOSS: 'boss', 智联: 'zl', '51job': '51', 猎聘: 'lp', 网申: 'campus' };
const pidOf = (x) => x.pid || PID_OF[x.platform] || 'boss';
const platIco = (x) => { const p = PLAT[pidOf(x)] || PLAT.boss; return `<span class="plat-ico ${p[2]}" title="${esc(p[0])}">${p[1]}</span>`; };
// 阶段：名字 + 颜色类，表格 / 看板 / 抽屉同一套（一致性）
const STAGE = { queued: ['待发送', 'wait'], sending: ['发送中', 'wait sending'], failed: ['没投成', 'bad'], applied: ['已投', 'plain'], viewed: ['HR 看了', 'seen'], replied: ['HR 回了', 'reply'], interview: ['约面', 'good'], offer: ['给 offer 了', 'good'], closed: ['结束', 'quiet'] };
const OUTCOME = { rejected: '婉拒', ghosted: '没戏', withdrawn: '不投了', declined: '我不去' };
// plugin = 你在海投里点的、插件替你发出去的（数据层这么记），所以也算「你」
const BY = { me: '你', plugin: '你·海投', claude: '助手', hr: 'HR 主动' };
const MINE = (by) => by === 'me' || by === 'plugin';
const stageName = (x) => (x.stage === 'closed' && OUTCOME[x.outcome] ? `结束 · ${OUTCOME[x.outcome]}` : STAGE[x.stage]?.[0] || x.stage || '—');
const stPill = (x) => `<span class="st ${STAGE[x.stage]?.[1] || 'plain'}">${esc(stageName(x))}</span>`;
const SORT_STAGE = ['failed', 'queued', 'sending', 'interview', 'offer', 'replied', 'viewed', 'applied', 'closed'];

const VIEWS = [
  { id: 'active', name: '进行中', fn: (x) => x.stage !== 'closed' },
  { id: 'today', name: '今天投的', fn: (x) => isToday(x) },
  { id: 'replied', name: '有回音', fn: (x) => ['replied', 'interview', 'offer'].includes(x.stage) },
  { id: 'interview', name: '约面', fn: (x) => ['interview', 'offer'].includes(x.stage) },
  { id: 'closed', name: '结束', fn: (x) => x.stage === 'closed' },
  { id: 'all', name: '全部', fn: () => true },
];
const FACETS = [
  { id: 'plat', name: '平台', val: pidOf, label: (v) => PLAT[v]?.[0] || v, order: Object.keys(PLAT) },
  { id: 'by', name: '谁投的', val: (x) => x.by ?? 'null', label: (v) => BY[v] || (v === 'null' ? '没判出' : v), order: [...Object.keys(BY), 'null'] },
  { id: 'stage', name: '阶段', val: (x) => x.stage, label: (v) => STAGE[v]?.[0] || v, order: Object.keys(STAGE) },
  { id: 'co', name: '单位', val: (x) => x.company, label: (v) => v, search: true },
];
const BCOLS = [
  { id: 'applied', name: '已投', st: ['applied'] },
  { id: 'viewed', name: 'HR 看了', st: ['viewed'] },
  { id: 'replied', name: 'HR 回了', st: ['replied'] },
  { id: 'interview', name: '约面', st: ['interview', 'offer'] },
  { id: 'closed', name: '结束', st: ['closed'] },
];
const BOARD_CAP = 60;

const S = {
  data: null, err: '', view: 'active', mode: 'table', f: {}, q: '', sort: 'stage',
  open: null, cursor: null, openFacet: null, facetQ: '', stageMenu: false,
  sig: '', dirty: false, first: true, prevStage: new Map(),
  patch: new Map(), hide: new Set(), pend: new Map(), tl: {}, mockEvents: null,
};

// ---------- 时间 ----------
const nowMs = () => (MOCK && S.data?.now ? Date.parse(S.data.now) : Date.now());
const pad = (n) => String(n).padStart(2, '0');
const dayOf = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const TODAY = () => (S.data?.now || '').slice(0, 10) || dayOf(Date.now());
const isToday = (x) => (x.appliedAt || '').startsWith(TODAY()) || (['queued', 'sending', 'failed'].includes(x.stage) && (x.stageAt || '').startsWith(TODAY()));
function fmtTime(s) {
  if (!s) return '';
  const t = Date.parse(s), d = new Date(t), day = s.slice(0, 10), hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (day === TODAY()) return `今天 ${hm}`;
  if (day === dayOf(Date.parse(TODAY() + 'T12:00:00') - 864e5)) return `昨天 ${hm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}
function rel(s) {
  if (!s) return '';
  const m = Math.max(0, Math.round((nowMs() - Date.parse(s)) / 6e4));
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  if (m < 60 * 24) return `${Math.floor(m / 60)} 小时前`;
  return `${Math.floor(m / 1440)} 天前`;
}
function dueInfo(due) {
  if (!due) return null;
  const diff = Math.round((Date.parse(due.slice(0, 10) + 'T00:00:00') - Date.parse(TODAY() + 'T00:00:00')) / 864e5);
  if (diff < 0) return { late: true, text: `逾期 ${-diff} 天` };
  if (diff === 0) return { late: false, text: '今天' };
  if (diff === 1) return { late: false, text: '明天' };
  const d = new Date(due.slice(0, 10) + 'T00:00:00');
  return { late: false, text: `${d.getMonth() + 1}/${d.getDate()} 前` };
}

// ---------- 数据 + 筛选 ----------
const items = () => (S.data?.items || []).filter((x) => !S.hide.has(x.id)).map((x) => (S.patch.has(x.id) ? { ...x, ...S.patch.get(x.id) } : x));
const byId = (id) => items().find((x) => String(x.id) === String(id));
const viewDef = (id = S.view) => VIEWS.find((v) => v.id === id) || VIEWS[0];
const fset = (id) => S.f[id] || (S.f[id] = new Set());
const qOk = (x) => { const q = S.q.trim().toLowerCase(); return !q || [x.company, x.fullCompany, x.title, x.lastEvent, x.city, x.salary, x.next?.text, x.bg].join(' ').toLowerCase().includes(q); };
function pass(x, skip = '') {
  if (skip !== 'view' && !viewDef().fn(x)) return false;
  for (const fc of FACETS) { if (fc.id === skip) continue; const s = S.f[fc.id]; if (s?.size && !s.has(String(fc.val(x)))) return false; }
  if (skip !== 'q' && !qOk(x)) return false;
  return true;
}
const SORTS = {
  recent: ['最近动静', (a, b) => (b.stageAt || '').localeCompare(a.stageAt || '')],
  applied: ['投递时间', (a, b) => (b.appliedAt || '9').localeCompare(a.appliedAt || '9') || (b.stageAt || '').localeCompare(a.stageAt || '')],
  stage: ['阶段', (a, b) => SORT_STAGE.indexOf(a.stage) - SORT_STAGE.indexOf(b.stage) || (b.stageAt || '').localeCompare(a.stageAt || '')],
};
// 「今天投的」按最近动静排时，你自己（含海投）投的排前面：用户要一眼看到自己今晚投的那几家
const mineFirst = () => S.view === 'today' && !fset('by').size;
const filtered = () => { const by = (SORTS[S.sort] || SORTS.recent)[1]; return items().filter((x) => pass(x)).sort(mineFirst() ? (a, b) => MINE(b.by) - MINE(a.by) || by(a, b) : by); };
const anyFilter = () => FACETS.some((f) => S.f[f.id]?.size) || S.q.trim();

// 视图 / 筛选 / 排序 / 表格看板存 localStorage + 网址（刷新、从别的页跳回来都不丢）
function saveState() {
  const f = Object.fromEntries(Object.entries(S.f).filter(([, s]) => s.size).map(([k, s]) => [k, [...s]]));
  try { localStorage.setItem('apps-v1', JSON.stringify({ view: S.view, mode: S.mode, f, sort: S.sort })); } catch {}
  const p = new URLSearchParams();
  if (MOCK) p.set('mock', '1');
  if (S.view !== 'active') p.set('v', S.view);
  if (S.mode !== 'table') p.set('mode', S.mode);
  for (const [k, v] of Object.entries(f)) p.set(k, v.join('|'));
  if (S.q.trim()) p.set('q', S.q.trim());
  if (S.sort !== 'stage') p.set('sort', S.sort);
  if (S.open) p.set('id', S.open);
  const qs = p.toString();
  history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));
}
function loadState() {
  let o = null;
  try { o = JSON.parse(localStorage.getItem('apps-v1') || 'null'); } catch {}
  const p = new URLSearchParams(location.search);
  const keys = [...p.keys()].filter((k) => k !== 'mock' && k !== 'id');
  if (keys.length) {
    o = { view: p.get('v') || 'active', mode: p.get('mode') || o?.mode || 'table', sort: p.get('sort') || 'stage', f: {} };
    for (const fc of FACETS) if (p.get(fc.id)) o.f[fc.id] = p.get(fc.id).split('|');
    S.q = p.get('q') || '';
    $('#fq').value = S.q;
  }
  if (p.get('id')) S.open = S.cursor = p.get('id');
  if (!o) return;
  if (VIEWS.some((v) => v.id === o.view)) S.view = o.view;
  if (['table', 'board'].includes(o.mode)) S.mode = o.mode;
  if (SORTS[o.sort]) S.sort = o.sort;
  for (const [k, v] of Object.entries(o.f || {})) S.f[k] = new Set(v);
}

async function getJson(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(r.status === 404 ? '投递数据接口还没接上（/api/tracker 404）' : `后台出错了（${r.status}）`);
  return r.json();
}
async function load() {
  clearTimeout(load.t);
  try {
    S.data = await getJson(MOCK ? 'mock/tracker.json' : '/api/tracker?view=all');
    S.err = '';
  } catch (e) {
    S.err = /Failed to fetch|NetworkError/.test(e.message) ? '收件箱后台没响应（inbox.mjs 没开？）' : e.message;
  }
  load.t = setTimeout(load, document.hidden ? 60000 : 30000);
  const sig = S.err + JSON.stringify((S.data?.items || []).map((x) => [x.id, x.stage, x.outcome, x.stageAt, x.lastEvent, x.next?.text, x.next?.due, x.convKey]));
  if (sig === S.sig && !S.dirty) return;            // 没变就不动，滚动 / 光标 / 焦点都在原地
  S.sig = sig;
  if (busyUi()) { S.dirty = true; return; }          // 手上开着菜单：等手停下来再刷（不打断）
  S.dirty = false;
  render();
}
const busyUi = () => !!document.querySelector('.menu-pop');
async function post(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.why || j.err || `后台没收下（${r.status}）`);
  return j;
}
function toast(text, kind = '', actions = [], ms) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<span>${esc(text)}</span>${actions.map((a, i) => `<button data-i="${i}">${esc(a.label)}</button>`).join('')}`;
  el.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; el.remove(); actions[+b.dataset.i].fn(); });
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms || (actions.length ? UNDO_MS + 500 : kind === 'bad' ? 7000 : 3500));
}

// ---------- 渲染 ----------
function render() {
  renderViews(); renderFacets(); renderAlert(); renderTbar();
  $('#tscroll').hidden = S.mode !== 'table';
  $('#board').hidden = S.mode !== 'board';
  for (const b of $$('[data-mode]')) { b.classList.toggle('cur', b.dataset.mode === S.mode); b.setAttribute('aria-pressed', b.dataset.mode === S.mode); }
  S.mode === 'table' ? renderTable() : renderBoard();
  renderDrawer();
  for (const x of S.data?.items || []) S.prevStage.set(x.id, x.stage);
  S.first = false;
}

function renderViews() {
  const base = items().filter((x) => pass(x, 'view'));
  $('#views').innerHTML = VIEWS.map((v, i) => `<button role="tab" data-view="${v.id}" class="${S.view === v.id ? 'cur' : ''}" aria-selected="${S.view === v.id}" title="按 ${i + 1} 切过来">${v.name}<span>${base.filter(v.fn).length}</span></button>`).join('');
}

function facetOptions(fc) {
  const all = items().filter((x) => viewDef().fn(x) || fset(fc.id).size);
  const base = items().filter((x) => pass(x, fc.id));
  const cnt = new Map();
  for (const x of base) { const v = String(fc.val(x)); cnt.set(v, (cnt.get(v) || 0) + 1); }
  let vals = [...new Set([...all.map((x) => String(fc.val(x))), ...fset(fc.id)])];
  vals = fc.order ? fc.order.filter((v) => vals.includes(v)) : vals.sort((a, b) => (cnt.get(b) || 0) - (cnt.get(a) || 0) || a.localeCompare(b, 'zh'));
  return vals.map((v) => [v, cnt.get(v) || 0]);
}
function optsHtml(fc) {
  const q = S.facetQ.trim().toLowerCase(), s = fset(fc.id);
  let opts = facetOptions(fc);
  if (fc.search && q) opts = opts.filter(([v]) => v.toLowerCase().includes(q));
  const shown = opts.slice(0, 150);
  return shown.map(([v, n]) => `<label class="opt ${n ? '' : 'zero'}"><input type="checkbox" data-fopt="${fc.id}" value="${esc(v)}" ${s.has(v) ? 'checked' : ''}><em>${esc(fc.label(v))}</em><span>${n}</span></label>`).join('')
    + (opts.length > shown.length ? `<div class="muted" style="padding:6px 10px;font-size:var(--fs-xs)">还有 ${opts.length - shown.length} 家，打字缩小范围</div>` : '')
    + (!opts.length ? '<div class="muted" style="padding:8px 10px;font-size:var(--fs-sm)">没有对得上的</div>' : '');
}
function renderFacets() {
  const parts = FACETS.map((fc) => {
    const s = fset(fc.id);
    const names = [...s].map(fc.label);
    const label = s.size ? `${fc.name}：${names.slice(0, 2).join('、')}${s.size > 2 ? ` 等 ${s.size} 个` : ''}` : fc.name;
    const pop = S.openFacet === fc.id ? `<div class="menu-pop">${fc.search ? `<label class="search pop-q">${ico('search')}<input id="facetq" placeholder="搜单位" value="${esc(S.facetQ)}" autocomplete="off"></label>` : ''}
      <div id="fopts">${optsHtml(fc)}</div>
      <div class="pop-foot"><button class="btn ghost sm" data-act="fclear" data-id="${fc.id}">清掉这项</button><button class="btn sm" data-act="fclose">好</button></div></div>` : '';
    return `<div class="facet"><button class="chip ${s.size ? 'set' : ''}" data-facet="${fc.id}" aria-expanded="${S.openFacet === fc.id}">${esc(label)}${ico('chev')}</button>${pop}</div>`;
  });
  $('#facets').innerHTML = `${ico('filter')}${parts.join('')}${anyFilter() ? '<button class="clear" data-act="clearAll">清空筛选</button>' : ''}`;
  const fq = $('#facetq'); if (fq && document.activeElement !== fq) { fq.focus(); fq.setSelectionRange(fq.value.length, fq.value.length); }
}

// 提醒条：没投成 / 待发送不进看板列，统一在这里提醒（表格、看板都显示）
function renderAlert() {
  const el = $('#alert');
  const base = items().filter((x) => pass(x, 'view'));
  const fail = base.filter((x) => x.stage === 'failed'), wait = base.filter((x) => x.stage === 'queued' || x.stage === 'sending');
  const onlyThese = fset('stage').size && [...fset('stage')].every((s) => ['failed', 'queued', 'sending'].includes(s));
  if ((!fail.length && !wait.length) || onlyThese || S.err) { el.hidden = true; return; }
  el.hidden = false;
  el.className = `a-alert ${fail.length ? '' : 'wait'}`;
  const tonight = fail.filter(isToday).length;
  el.innerHTML = `${ico('alert')}${fail.length ? `<span><b>${fail.length} 家没投成</b>${tonight && tonight < fail.length ? `（今天 ${tonight} 家）` : tonight ? '（都是今天的）' : ''}：插件点了投递，但没看到成功提示，要去平台上看一眼</span>
      <button class="lnk" data-act="only" data-st="failed">只看这 ${fail.length} 家</button>` : ''}
    ${fail.length && wait.length ? '<span class="sep">·</span>' : ''}
    ${wait.length ? `<span>${wait.length} 家待发送，插件会一家一家发</span><button class="lnk" data-act="only" data-st="queued,sending">看待发送</button>` : ''}`;
}

function renderTbar() {
  const list = filtered();
  const who = Object.keys(BY).map((k) => [k, list.filter((x) => x.by === k).length]).filter(([, n]) => n);
  const lead = S.view === 'today' ? '今天投的' : viewDef().name;
  $('#tbar').innerHTML = S.err ? '' : `<span>${esc(lead)} <b>${list.length}</b> 家${who.length ? '：' : ''}</span>
    ${who.length ? `<span class="who">${who.map(([k, n]) => `<button class="lnk-who ${fset('by').has(k) ? 'on' : ''}" data-act="who" data-by="${k}" title="只看${BY[k]}投的">${BY[k]} <b>${n}</b></button>`).join(' · ')}${list.some((x) => !x.by) ? ` · 没判出 <b>${list.filter((x) => !x.by).length}</b>` : ''}</span>` : ''}
    <label>排序 <select id="sortby">${Object.entries(SORTS).map(([v, [l]]) => `<option value="${v}" ${S.sort === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <span class="keys"><kbd>J</kbd><kbd>K</kbd>上下 <kbd>Enter</kbd>详情 <kbd>/</kbd>搜索 <kbd>V</kbd>表格/看板 <kbd>1</kbd>–<kbd>6</kbd>切视图</span>`;
}

function nextHtml(x, big = false) {
  const cls = big ? 'btn primary sm' : 'btn sm';
  const d = dueInfo(x.next?.due);
  const dueTxt = [/^去消息/.test(x.next?.text || '') ? '' : x.next?.text, d?.text].filter(Boolean).join(' · ');   // 「去消息看…」和按钮重复，不再写一遍
  const due = (t) => (t ? `<span class="due ${d?.late ? 'late' : ''}">${esc(t)}</span>` : '');
  if (x.stage === 'queued' && x.jobId) return `<button class="${big ? 'btn sm' : cls}" data-act="unqueue" data-id="${x.id}">${ico('undo')}撤回</button>${big ? '' : due('还没发出')}`;
  if (x.stage === 'sending') return `<span class="txt">插件正在发</span>`;
  if (x.stage === 'failed') return safeHref(fixHref(x)) ? `<a class="${cls}" href="${safeHref(fixHref(x))}" target="_blank" rel="noopener">去平台确认${ico('ext')}</a>${big ? '' : due(d?.late ? d.text : '')}` : `<span class="txt">去平台确认（没链接）</span>`;
  if (x.convKey) return `<a class="${cls}" href="/?c=${encodeURIComponent(x.convKey)}">${ico('msg')}去消息</a>${big ? '' : due(dueTxt)}`;
  if (big) return '';
  return `<span class="txt">${esc(x.next?.text || '—')}</span>${d ? due(d.text) : ''}`;
}
const fixHref = (x) => x.problem?.fix?.href || x.url;
const lastOf = (x) => { const t = ((x.stage === 'failed' && x.problem?.text) || x.lastEvent || '').replace(/^\d{1,2}\/\d{1,2}( \d{1,2}:\d{2})?\s*/, ''); return /^(助手 代投|插件投出|你投的|投了|已投出)$/.test(t) ? '' : t; };
function byHtml(x) { return MINE(x.by) ? `<span class="me" title="${x.by === 'plugin' ? '你在海投里点的，插件发出去' : '你自己投的'}">${BY[x.by]}</span>` : esc(BY[x.by] || x.by || '—'); }
function rowCells(x) {
  const p = PLAT[pidOf(x)] || PLAT.boss;
  return `<td class="c-stage">${stPill(x)}</td>
    <td class="c-co"><div class="co">${platIco(x)}<div><b title="${esc(x.fullCompany || x.company)}">${esc(x.company)}</b><small>${esc(x.city || '')}</small></div></div></td>
    <td class="c-job"><span title="${esc(x.title)}">${esc(x.title || '—')}</span><small>${esc(x.salary || '')}</small></td>
    <td class="c-plat"><span class="pl">${platIco(x)}${esc(p[0])}</span></td>
    <td class="c-by">${byHtml(x)}</td>
    <td class="c-time">${x.appliedAt ? esc(fmtTime(x.appliedAt)) : `<span class="none">${x.by === 'hr' ? 'HR 先找的' : '还没投出'}</span>`}</td>
    <td class="c-last"><div title="${esc(lastOf(x))}">${esc(lastOf(x) || '—')}</div><small>${esc(rel(x.stageAt))}</small></td>
    <td class="c-next">${nextHtml(x)}</td>`;
}
function renderTable() {
  const list = filtered();
  if (!$('#thead').innerHTML) $('#thead').innerHTML = '<tr><th class="c-stage">阶段</th><th>公司</th><th>岗位</th><th class="c-plat">平台</th><th>谁投的</th><th class="c-time">投递时间</th><th class="c-last">最后动静</th><th class="c-next">下一步</th></tr>';
  const tb = $('#tbody'), emptyEl = $('#tempty');
  if (S.err || !list.length) {
    tb.innerHTML = ''; $('#table').hidden = true;
    emptyEl.innerHTML = emptyHtml();
    return;
  }
  $('#table').hidden = false; emptyEl.innerHTML = '';
  // 按行对比：没变的行原样留着（滚动、按钮焦点都不动），变了的只换这一行（体检第 2 条）
  const have = new Map($$('tr', tb).map((tr) => [tr.dataset.id, tr]));
  let prev = null;
  // 「今天投的」分两组：你投的（含海投）在上、别人代投的在下，各带一行组标题
  const seq = [];
  if (mineFirst() && list.some((x) => MINE(x.by))) {
    const mine = list.filter((x) => MINE(x.by)), rest = list.filter((x) => !MINE(x.by));
    seq.push({ grp: 'mine', text: `你投的 ${mine.length} 家` }, ...mine);
    if (rest.length) seq.push({ grp: 'rest', text: `助手 代投和其他 ${rest.length} 家` }, ...rest);
  } else seq.push(...list);
  for (const x of seq) {
    const id = x.grp ? `g-${x.grp}` : String(x.id), html = x.grp ? `<td colspan="8">${esc(x.text)}</td>` : rowCells(x);
    let tr = have.get(id);
    if (tr) { have.delete(id); if (tr._h !== html) { tr.innerHTML = html; tr._h = html; } }
    else { tr = document.createElement('tr'); tr.dataset.id = id; tr.innerHTML = html; tr._h = html; if (x.grp) tr.className = 'grp'; }
    if (x.grp) { const want = prev ? prev.nextSibling : tb.firstChild; if (tr !== want) tb.insertBefore(tr, want); prev = tr; continue; }
    const want = prev ? prev.nextSibling : tb.firstChild;
    if (tr !== want) tb.insertBefore(tr, want);
    tr.classList.toggle('open', id === String(S.open));
    tr.classList.toggle('cursor', id === String(S.cursor));
    if (!S.first && S.prevStage.has(x.id) && S.prevStage.get(x.id) !== x.stage) { tr.classList.remove('flash'); void tr.offsetWidth; tr.classList.add('flash'); }
    prev = tr;
  }
  for (const tr of have.values()) tr.remove();
}
function emptyHtml() {
  if (S.err) return `<div class="empty">${esc(S.err)}<br><button class="btn sm" data-act="reload">再读一次</button>${MOCK ? '' : ' <a class="btn ghost sm" href="?mock=1">先看演示数据</a>'}</div>`;
  const all = items();
  if (!all.length) return '<div class="empty">还没有投递记录<br>去「找岗位」审一批，投出去的会出现在这里<br><a class="btn sm" href="/hunt">去找岗位</a></div>';
  const tries = [];
  if (S.view !== 'all') tries.push([`切到「全部」`, all.filter((x) => pass(x, 'view')).length, 'view']);
  for (const fc of FACETS) if (S.f[fc.id]?.size) tries.push([`去掉「${fc.name}」`, all.filter((x) => pass(x, fc.id)).length, fc.id]);
  if (S.q.trim()) tries.push(['去掉搜索词', all.filter((x) => pass(x, 'q')).length, 'q']);
  const best = tries.filter((t) => t[1]).sort((a, b) => b[1] - a[1]).slice(0, 3);
  return `<div class="empty">「${esc(viewDef().name)}」${anyFilter() ? '加上现在的筛选' : ''}下没有投递${best.length ? `<div>${best.map(([n, c, id]) => `<button class="btn sm" data-act="dropFilter" data-id="${id}" style="margin:12px 4px 0">${esc(n)}能看到 ${c} 家</button>`).join('')}</div>` : ''}</div>`;
}

function cardHtml(x) {
  const d = dueInfo(x.next?.due);
  const multi = x.stage === 'offer' || (x.stage === 'closed' && x.outcome);
  return `<div class="card ${String(S.open) === String(x.id) ? 'open' : ''} ${String(S.cursor) === String(x.id) ? 'cursor' : ''}" data-id="${x.id}" tabindex="-1">
    <div class="top">${platIco(x)}<b title="${esc(x.fullCompany || x.company)}">${esc(x.company)}</b></div>
    <div class="ttl" title="${esc(x.title)}">${esc(x.title || '—')}</div>
    ${lastOf(x) ? `<div class="last">${esc(lastOf(x))}</div>` : ''}
    <div class="foot">${MINE(x.by) ? `<span class="me">${BY[x.by]}</span>` : `<span>${esc(BY[x.by] || '—')}</span>`}<span>·</span><span>${esc(rel(x.stageAt))}</span>
      ${d?.late && x.stage !== 'closed' ? `<span class="late">${esc(d.text)}</span>` : multi ? `<span class="st ${STAGE[x.stage][1]}">${esc(x.stage === 'closed' ? OUTCOME[x.outcome] : '给 offer 了')}</span>` : ''}</div>
  </div>`;
}
function renderBoard() {
  const el = $('#board');
  if (S.err || !items().length) { el.innerHTML = `<div style="grid-column:1/-1">${emptyHtml()}</div>`; return; }
  const list = filtered();
  const keep = Object.fromEntries($$('.col', el).map((c) => [c.dataset.col, $('.cards', c)?.scrollTop || 0]));
  const top = el.scrollTop, left = el.scrollLeft;
  el.innerHTML = BCOLS.map((c) => {
    const rows = list.filter((x) => c.st.includes(x.stage));
    const none = c.id === 'closed' && !viewDef().fn({ stage: 'closed' })
      ? `<div class="none">「${esc(viewDef().name)}」不含结束的<br><button class="btn ghost sm" data-act="view" data-v="closed">看结束的</button></div>`
      : '<div class="none">这一列现在没有</div>';
    return `<section class="col" data-col="${c.id}"><h3><span class="st ${STAGE[c.st[0]][1]}">${c.name}</span><span>${rows.length}</span></h3>
      <div class="cards">${rows.length ? rows.slice(0, BOARD_CAP).map(cardHtml).join('') : none}</div>
      ${rows.length > BOARD_CAP ? `<button class="btn ghost sm more" data-act="colTable" data-st="${c.st.join(',')}">还有 ${rows.length - BOARD_CAP} 家，在表格里看</button>` : ''}</section>`;
  }).join('');
  for (const c of $$('.col', el)) { const cs = $('.cards', c); if (cs) cs.scrollTop = keep[c.dataset.col] || 0; }
  el.scrollTop = top; el.scrollLeft = left;
}

// ---------- 抽屉 ----------
function stageMenuHtml(x) {
  const opt = (st, oc, label) => { const cur = x.stage === st && (x.outcome || null) === (oc || null); return `<button data-act="setStage" data-st="${st}" ${oc ? `data-oc="${oc}"` : ''} class="${cur ? 'cur' : ''}">${esc(label)}${cur ? `<span class="chk">${ico('check')}</span>` : ''}</button>`; };
  return `<div class="menu-pop">
    ${opt('applied', null, '已投')}${opt('viewed', null, 'HR 看了')}${opt('replied', null, 'HR 回了')}${opt('interview', null, '约面')}${opt('offer', null, '给 offer 了')}
    <hr><div class="ph">结束（归档，不删，「结束」视图里还能找到）</div>
    ${Object.entries(OUTCOME).map(([k, v]) => opt('closed', k, v)).join('')}</div>`;
}
function renderDrawer() {
  const el = $('#drawer');
  const x = S.open != null && byId(S.open);
  document.body.classList.toggle('drawer-open', !!x);
  if (!x) { el.hidden = true; el.dataset.id = ''; return; }
  const sig = JSON.stringify([x, S.tl[x.id]?.state, S.stageMenu]);
  if (!el.hidden && el.dataset.id === String(x.id) && el._sig === sig) return;
  const keepTop = el.dataset.id === String(x.id) ? $('.d-body', el)?.scrollTop || 0 : 0;
  el.hidden = false; el.dataset.id = x.id; el._sig = sig;
  const d = dueInfo(x.next?.due);
  const tl = S.tl[x.id];
  if (!tl || tl.stageAt !== x.stageAt) loadTimeline(x);
  const main = nextHtml(x, true);
  el.innerHTML = `<div class="d-head">${platIco(x)}
      <div><h2>${esc(x.fullCompany || x.company)}</h2>
        <div class="sub">${[x.title, x.salary, x.city].filter(Boolean).map(esc).join('<i>·</i>')}</div></div>
      <button class="btn ghost sm icon" data-act="close" title="关掉（Esc）" aria-label="关掉">${ico('close')}</button>
    </div>
    <div class="d-state">${stPill(x)}<span>${x.by === 'hr' ? 'HR 主动找来的' : (x.by ? `${esc(BY[x.by] || x.by)}投的` : '谁投的没判出来')}${x.appliedAt ? ` · ${esc(fmtTime(x.appliedAt))}` : ''}</span><span>· ${esc(PLAT[pidOf(x)]?.[0] || x.platform)}</span></div>
    <div class="d-acts">${main}
      ${['queued', 'sending'].includes(x.stage) ? '<span class="muted d-note">还没发出去，发完才能改阶段</span>' : `<div class="menu"><button class="btn ghost sm" data-act="stageMenu" aria-expanded="${S.stageMenu}">改阶段${ico('chev')}</button>${S.stageMenu ? stageMenuHtml(x) : ''}</div>`}
    </div>
    <div class="d-body">
      ${x.stage === 'failed' && x.problem ? `<div class="why bad">${ico('alert')}<div><b>没投成：</b>${esc(x.problem.text)}<br>先去平台上看一眼投没投出去；真没投出去再点「再投一次」${x.problem.alt?.jobId ? `<div style="margin-top:8px"><button class="btn sm" data-act="retry" data-id="${x.id}">${ico('send')}${esc(x.problem.alt.label || '再投一次')}</button></div>` : ''}</div></div>` : ''}
      ${x.why ? `<div class="d-sec"><h4>HR 原话</h4><div class="d-bg">${esc(x.why)}</div></div>` : ''}
      ${x.next?.text && x.stage !== 'failed' ? `<div class="d-sec"><h4>下一步</h4><div class="d-next ${d?.late ? 'late' : ''}"><span>${esc(x.next.text)}</span>${d ? `<small>${esc(d.text)}</small>` : ''}</div></div>` : ''}
      <div class="d-sec"><h4>时间线</h4>${timelineHtml(x)}</div>
      ${factsHtml(x)}
      <div class="d-sec"><h4>链接</h4><div class="d-links">
        ${safeHref(x.url) ? `<a href="${safeHref(x.url)}" target="_blank" rel="noopener">${ico('ext')}岗位页（${esc(PLAT[pidOf(x)]?.[0] || '')}）</a>` : '<span class="muted">没有岗位链接</span>'}
        ${x.convKey ? `<a href="/?c=${encodeURIComponent(x.convKey)}">${ico('msg')}和 HR 的聊天</a>` : ''}
        <span class="key">${esc(x.key || '')}</span></div></div>
    </div>`;
  $('.d-body', el).scrollTop = keepTop;
}
function factsHtml(x) {
  const e = x.extra || {}, bg = x.bg || e.bg;
  const rows = [['单位', e.size], ['休息', e.rest], ['通勤', [e.addr, e.commute].filter(Boolean).join(' · ')], ['HR', e.hr], ['背调', bg]].filter(([, v]) => v);
  if (!rows.length) return '';
  return `<div class="d-sec"><h4>这家单位</h4><dl class="d-facts">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl></div>`;
}
function timelineHtml(x) {
  const tl = S.tl[x.id];
  if (!tl || tl.state === 'loading') return '<ul class="tl"><li class="loading">读时间线…</li></ul>';
  if (tl.state === 'err') return `<div class="muted" style="font-size:var(--fs-sm)">时间线读不到：${esc(tl.why)} <button class="btn ghost sm" data-act="tlRetry">再读</button></div>`;
  const evs = tl.events || [];
  if (!evs.length) return `<div class="muted" style="font-size:var(--fs-sm)">还没有记录。${esc(x.lastEvent || '')}</div>`;
  const WHO = { ...BY, hr: 'HR', rule: '规则', manual: '你', watch: '盯梢', verify: '核实', platform: '平台', review: '回顾', conv: '聊天', xlsx: '代投记录', system: '系统' };
  return `<ul class="tl">${evs.map((e) => `<li><span class="t">${esc(fmtTime(e.at))}<span class="who">${esc(WHO[e.by] || e.by || '')}</span></span>${esc(e.text || (e.to ? STAGE[e.to]?.[0] : '') || e.type || '')}</li>`).join('')}</ul>`;
}
async function loadTimeline(x) {
  S.tl[x.id] = { state: 'loading', stageAt: x.stageAt };
  try {
    let evs;
    if (MOCK) { S.mockEvents ||= await getJson('mock/tracker-events.json'); evs = S.mockEvents[x.id] || []; }
    else evs = (await getJson(`/api/tracker/item?id=${encodeURIComponent(x.id)}`)).events || [];
    S.tl[x.id] = { state: 'ok', stageAt: x.stageAt, events: evs };
  } catch (e) { S.tl[x.id] = { state: 'err', stageAt: x.stageAt, why: e.message }; }
  if (String(S.open) === String(x.id)) renderDrawer();
}

// ---------- 动作（都给 5 秒撤销，到点才真发；关页面时立刻补发） ----------
function later(key, path, body, onUndo) {
  const job = { path, body, timer: setTimeout(() => commit(key), UNDO_MS) };
  S.pend.set(key, job);
  return () => { clearTimeout(job.timer); S.pend.delete(key); onUndo(); };
}
async function commit(key) {
  const job = S.pend.get(key); if (!job) return;
  S.pend.delete(key);
  if (MOCK) return;                                   // 演示数据：只在页面上改，不发给后台
  try { await post(job.path, job.body); }
  catch (e) { toast(`没改成：${e.message}`, 'bad'); job.fail?.(); }
  S.sig = ''; await load();
  job.done?.();
}
const viewFor = (st) => (st === 'closed' ? 'closed' : ['interview', 'offer'].includes(st) ? 'interview' : st === 'replied' ? 'replied' : 'active');
function setStage(id, stage, outcome) {
  const x = byId(id); if (!x) return;
  const label = stage === 'closed' ? `结束 · ${OUTCOME[outcome]}` : STAGE[stage][0];
  const pad2 = (n) => String(n).padStart(2, '0'), d = new Date(nowMs());
  const at = `${dayOf(nowMs())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:00`;
  // 没投成 → 已投这类：投递时间沿用原来那次，不会从「今天投的」里掉出去；下一步等后台按新阶段重算
  S.patch.set(x.id, { stage, outcome: stage === 'closed' ? outcome : null, stageAt: at, appliedAt: x.appliedAt || (x.by === 'hr' ? null : x.stageAt), lastEvent: `你手动改成「${label}」`, next: { text: '', due: null } });
  S.stageMenu = false;
  const key = `stage:${x.id}`;
  if (S.pend.has(key)) { clearTimeout(S.pend.get(key).timer); S.pend.delete(key); }
  const undo = later(key, '/api/tracker/stage', { id: x.id, stage, ...(stage === 'closed' ? { outcome } : {}) }, () => { S.patch.delete(x.id); render(); toast('撤销了，阶段没改'); });
  const job = S.pend.get(key);
  job.done = () => { S.patch.delete(x.id); render(); };
  job.fail = () => S.patch.delete(x.id);
  if (MOCK) job.done = null;
  render();
  const gone = !viewDef().fn({ ...x, stage });
  const acts = [{ label: '撤销', fn: undo }];
  if (gone) acts.push({ label: `去「${viewDef(viewFor(stage)).name}」看`, fn: () => { switchView(viewFor(stage)); S.open = S.cursor = x.id; saveState(); render(); } });
  toast(`${x.company} → ${label}${gone ? `，移到「${viewDef(viewFor(stage)).name}」` : ''}${MOCK ? '（演示）' : ''}`, 'ok', acts);
}
function unqueue(id) {
  const x = byId(id); if (!x || !x.jobId) return;
  const ids = rowIds(), i = ids.indexOf(String(x.id));
  S.hide.add(x.id);
  if (String(S.open) === String(x.id)) S.open = null;
  if (String(S.cursor) === String(x.id)) S.cursor = ids[i + 1] || ids[i - 1] || null;
  const undo = later(`unq:${x.id}`, '/api/hunt/unapprove', { jobId: x.jobId }, () => { S.hide.delete(x.id); render(); toast('撤销了，还在待发送'); });
  const job = S.pend.get(`unq:${x.id}`);
  job.done = () => S.hide.delete(x.id);              // 后台已经把它挪回待审，下一次读数据它自然不在了
  job.fail = () => S.hide.delete(x.id);
  render();
  toast(`${x.company} 撤回了，回到找岗位的「待审」${MOCK ? '（演示）' : ''}`, 'ok', [{ label: '撤销', fn: undo }, { label: '去找岗位', fn: () => { location.href = '/hunt'; } }]);
}
function retry(id) {
  const x = byId(id); const jobId = x?.problem?.alt?.jobId || x?.jobId; if (!x || !jobId) return;
  S.patch.set(x.id, { stage: 'queued', lastEvent: '你点了再投一次，等插件发', problem: null, next: { text: '等插件发', due: null } });
  const key = `retry:${x.id}`;
  const undo = later(key, x.problem?.alt?.api || '/api/hunt/approve', { jobId }, () => { S.patch.delete(x.id); render(); toast('撤销了，没有再投'); });
  const job = S.pend.get(key);
  job.done = () => { S.patch.delete(x.id); render(); };
  job.fail = () => S.patch.delete(x.id);
  if (MOCK) job.done = null;
  render();
  toast(`${x.company} 重新进了待发送${MOCK ? '（演示）' : ''}`, 'ok', [{ label: '撤销', fn: undo }]);
}
function flushPending() {
  if (MOCK) return;
  for (const [, job] of S.pend) { clearTimeout(job.timer); fetch(job.path, { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify(job.body) }).catch(() => {}); }
  S.pend.clear();
}
addEventListener('pagehide', flushPending);

// ---------- 交互 ----------
function switchView(v) { S.view = v; S.cursor = null; }
function filtersChanged(resetScroll = true) {
  saveState(); render();
  if (resetScroll) { $('#tscroll').scrollTop = 0; $('#board').scrollTop = 0; }
}
const rowIds = () => (S.mode === 'table' ? $$('#tbody tr:not(.grp)').map((t) => t.dataset.id) : $$('#board .card').map((c) => c.dataset.id));
function syncCursor() {
  const sel = S.mode === 'table' ? '#tbody tr' : '#board .card';
  for (const el of $$(sel)) { el.classList.toggle('cursor', el.dataset.id === String(S.cursor)); el.classList.toggle('open', el.dataset.id === String(S.open)); }
  $(`${sel}[data-id="${CSS.escape(String(S.cursor ?? ''))}"]`)?.scrollIntoView({ block: 'nearest' });
}
function openItem(id) {
  S.open = String(S.open) === String(id) ? null : id; S.cursor = id; S.stageMenu = false;
  saveState(); syncCursor(); renderDrawer();
}
function closeMenus() {
  let had = false;
  if (S.openFacet) { S.openFacet = null; S.facetQ = ''; renderFacets(); had = true; }
  if (S.stageMenu) { S.stageMenu = false; renderDrawer(); had = true; }
  if (had && S.dirty) { S.dirty = false; render(); }
  return had;
}

document.addEventListener('click', (e) => {
  const t = e.target;
  const v = t.closest('[data-view]');
  if (v) { closeMenus(); switchView(v.dataset.view); return filtersChanged(); }
  const m = t.closest('[data-mode]');
  if (m) { S.mode = m.dataset.mode; S.cursor = null; return filtersChanged(false); }
  const fb = t.closest('[data-facet]');
  if (fb) { const id = fb.dataset.facet; const was = S.openFacet === id; closeMenus(); if (!was) { S.openFacet = id; S.facetQ = ''; renderFacets(); } return; }
  if (S.openFacet && !t.closest('.facet')) closeMenus();
  if (S.stageMenu && !t.closest('.menu')) closeMenus();
  const a = t.closest('[data-act]');
  if (a) {
    const k = a.dataset.act, id = a.dataset.id;
    if (k === 'unqueue') return unqueue(id);
    if (k === 'close') { S.open = null; S.stageMenu = false; saveState(); syncCursor(); return renderDrawer(); }
    if (k === 'stageMenu') { S.stageMenu = !S.stageMenu; return renderDrawer(); }
    if (k === 'setStage') return setStage(S.open, a.dataset.st, a.dataset.oc);
    if (k === 'retry') return retry(id);
    if (k === 'who') { const b = a.dataset.by, f = fset('by'); f.size === 1 && f.has(b) ? f.clear() : (f.clear(), f.add(b)); return filtersChanged(); }
    if (k === 'tlRetry') { const x = byId(S.open); if (x) { delete S.tl[x.id]; renderDrawer(); } return; }
    if (k === 'fclear') { fset(id).clear(); S.openFacet = null; return filtersChanged(); }
    if (k === 'fclose') { S.openFacet = null; S.facetQ = ''; return filtersChanged(false); }
    if (k === 'clearAll') { S.f = {}; S.q = ''; $('#fq').value = ''; return filtersChanged(); }
    if (k === 'dropFilter') { if (id === 'view') switchView('all'); else if (id === 'q') { S.q = ''; $('#fq').value = ''; } else fset(id).clear(); return filtersChanged(); }
    if (k === 'only' || k === 'colTable') { if (k === 'only') switchView('all'); S.f.stage = new Set(a.dataset.st.split(',')); S.mode = 'table'; return filtersChanged(); }
    if (k === 'view') { switchView(a.dataset.v); return filtersChanged(); }
    if (k === 'reload') { S.sig = ''; return load(); }
    return;
  }
  if (t.closest('a, button, input, select, label')) return;
  const row = t.closest('#tbody tr:not(.grp), #board .card');
  if (row) openItem(row.dataset.id);
});
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'sortby') { S.sort = t.value; return filtersChanged(); }
  if (t.dataset.fopt) {
    const s = fset(t.dataset.fopt); t.checked ? s.add(t.value) : s.delete(t.value);
    saveState(); renderViews(); renderAlert(); renderTbar(); S.mode === 'table' ? renderTable() : renderBoard(); renderDrawer();
    // 只换菜单里的选项和芯片文字，菜单不关、搜单位的字不丢
    const fc = FACETS.find((f) => f.id === t.dataset.fopt);
    const chip = $(`[data-facet="${fc.id}"]`); const names = [...s].map(fc.label);
    chip.firstChild.textContent = s.size ? `${fc.name}：${names.slice(0, 2).join('、')}${s.size > 2 ? ` 等 ${s.size} 个` : ''}` : fc.name;
    chip.classList.toggle('set', !!s.size);
    const clr = $('#facets .clear');
    if (anyFilter() && !clr) $('#facets').insertAdjacentHTML('beforeend', '<button class="clear" data-act="clearAll">清空筛选</button>');
    if (!anyFilter() && clr) clr.remove();
    $('#tscroll').scrollTop = 0;
  }
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'fq') { S.q = e.target.value; saveState(); renderViews(); renderAlert(); renderTbar(); S.mode === 'table' ? renderTable() : renderBoard(); renderFacetsChipsOnly(); }
  if (e.target.id === 'facetq') { S.facetQ = e.target.value; const fc = FACETS.find((f) => f.id === S.openFacet); if (fc) $('#fopts').innerHTML = optsHtml(fc); }
});
function renderFacetsChipsOnly() {
  const clr = $('#facets .clear');
  if (anyFilter() && !clr) $('#facets').insertAdjacentHTML('beforeend', '<button class="clear" data-act="clearAll">清空筛选</button>');
  if (!anyFilter() && clr) clr.remove();
}
document.addEventListener('keydown', (e) => {
  const ae = document.activeElement;
  const typing = /INPUT|TEXTAREA|SELECT/.test(ae?.tagName) && ae?.type !== 'checkbox';
  if (e.key === 'Escape') {
    if (closeMenus()) return;
    if (typing) { ae.blur(); return; }
    if (S.open) { S.open = null; saveState(); syncCursor(); renderDrawer(); }
    return;
  }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  const ids = rowIds(), i = ids.indexOf(String(S.cursor));
  const step = (d) => {
    if (!ids.length) return;
    S.cursor = ids[Math.max(0, Math.min(ids.length - 1, i < 0 ? 0 : i + d))];
    if (S.open) { S.open = S.cursor; S.stageMenu = false; saveState(); renderDrawer(); }
    syncCursor();
  };
  if (k === 'j' || k === 'arrowdown') step(1);
  else if (k === 'k' || k === 'arrowup') step(-1);
  else if ((k === 'enter' || k === 'o') && S.cursor) openItem(S.cursor);
  else if (k === '/') { $('#fq').focus(); $('#fq').select(); }
  else if (k === 'v') { S.mode = S.mode === 'table' ? 'board' : 'table'; S.cursor = null; filtersChanged(false); }
  else if (/^[1-6]$/.test(k)) { closeMenus(); switchView(VIEWS[+k - 1].id); filtersChanged(); }
  else return;
  e.preventDefault();
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });

$('#ver').textContent = VERSION + (MOCK ? ' · 演示数据' : '');
loadState();
load();
