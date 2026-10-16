// HR 收件箱前端 v2.2.0：三栏照 Folo（左：视图 / 中：按日期分组的会话 / 右：聊天和处理记录），会话状态和快捷键照 Chatwoot，
// 按钮层级照 Chatwoot / Inbox Zero：每块一个主按钮，次要的进「⋯」；会改动东西的操作都给撤销（10/16 体检后重做）
const VERSION = 'v2.2.0';
// 设置里的个人项（微信小号等），启动时从 /api/profile 取
let PROFILE = {};
fetch('/api/profile').then((r) => r.json()).then((p) => { PROFILE = p || {}; }).catch(() => {});
// 新外壳开关：HR Desk v0.6.0 起（hrdesk.shell >= 2，状态在顶栏、找岗位在顶栏）或网址带 ?v2 才去掉左栏状态卡和海投入口；
// 老外壳 / 普通浏览器里照旧显示，过渡期不出坏页面
const V2 = (window.hrdesk?.shell || 0) >= 2 || /[?&]v2\b/.test(location.search);
const $ = (s, el = document) => el.querySelector(s);
const esc = (s = '') => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeHref = (u = '') => (/^https?:\/\//i.test(String(u)) ? esc(u) : '');
const SELF_MARK = /^(📎|❌|📱)\s*/u;
const ACTIVE = ['queued', 'waiting', 'running'];
const ico = (n, cls = 'i') => `<svg class="${cls}"><use href="#i-${n}"/></svg>`;
const pad = (n) => String(n).padStart(2, '0');
const localIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
const todayStr = () => localIso(new Date()).slice(0, 10);
const daysAgo = (iso) => (iso ? (Date.now() - new Date(iso).getTime()) / 864e5 : 0);
const FOLLOW_DAYS = 2;
const UNDO_MS = 5000;                     // 发送 / 不谈了 / 已处理 的后悔时间

const PLAT = { boss: { name: 'BOSS', short: 'B', cls: 'p-boss' }, zl: { name: '智联', short: '智', cls: 'p-zl' }, 51: { name: '前程无忧', short: '51', cls: 'p-51' }, lp: { name: '猎聘', short: '猎', cls: 'p-lp' } };
const PLAT_ORDER = ['boss', 'zl', 'lp', '51'];
// 左栏只留 5 个视图（10/16 体检：9 个太多）。原来的「盯梢回过的 / 你手动回的 / 不用回 / 已处理」变成「全部」里的筛选
const VIEWS = [
  { id: 'need', name: '要你处理', icon: 'alert', f: (c) => c.status === 'need', hot: true },
  { id: 'look', name: '值得看', icon: 'star', f: (c) => c.status === 'look', acc: true },
  { id: 'waiting', name: '等 HR 回', icon: 'hourglass', f: (c) => c.status === 'waiting' },
  { id: 'snoozed', name: '稍后', icon: 'clock', f: (c) => c.status === 'snoozed' },
  { id: 'all', name: '全部', icon: 'layers', f: () => true },
];
const SUBS = {
  all: [['auto', '盯梢回过的', (c) => c.auto], ['manual', '你手动回的', (c) => c.manual], ['quiet', '不用回', (c) => c.status === 'quiet' || c.status === 'other'], ['done', '已处理 / 不谈了', (c) => c.status === 'done' || c.status === 'pass']],
  waiting: [['follow', '该跟进', (c) => isFollow(c)]],
};
const OLD_VIEW = { auto: ['all', 'auto'], manual: ['all', 'manual'], quiet: ['all', 'quiet'], done: ['all', 'done'] };
const STATUS = { need: '要你处理', look: '值得看', waiting: '等 HR 回', quiet: '不用回', other: '其他', done: '已处理', pass: '不谈了', snoozed: '稍后再看' };
const DEFAULT_PHRASES = [
  '您好，附件简历已经发您了，麻烦您查收。',
  '好的，谢谢您，期待您的消息。',
  '方便问一下这个岗位日常主要负责哪些工作吗？',
    '好的，这个时间我可以，到时候准时过去。',
];

const S = { hunt: null, variants: [], model: null, view: 'need', sub: '', pf: '', q: '', sel: null, drafts: {}, applied: {}, seenJobs: {}, needKeys: null, readerSig: '', compKey: null, offline: false, pendingSend: {}, checks: {}, jds: {} };
try {
  const v = localStorage.getItem('hr-inbox-view');
  if (v && OLD_VIEW[v]) { S.view = OLD_VIEW[v][0]; S.sub = OLD_VIEW[v][1]; }
  else if (v && (VIEWS.some((x) => x.id === v) || v === 'log')) S.view = v;
  S.pf = localStorage.getItem('hr-inbox-pf') || '';
} catch {}

// ---------- 数据 ----------
async function loadHunt() {
  if (V2) return;
  try { S.hunt = await (await fetch('/api/hunt', { cache: 'no-store' })).json(); } catch { S.hunt = null; }
  if (S.model) renderSide();
}
async function load() {
  try {
    const r = await fetch('/api/model', { cache: 'no-store' });
    if (!r.ok) throw new Error();
    S.model = await r.json();
  } catch {
    if (!S.offline) { S.offline = true; showOffline(); }
    return;
  }
  if (S.offline) { S.offline = false; showOffline(); toast('收件箱后台连上了', 'ok'); }
  notifyNew();
  watchJobs();
  render();
}
function showOffline() {
  let el = $('#offline');
  if (!S.offline) { el?.remove(); return; }
  if (!el) { el = document.createElement('div'); el.id = 'offline'; document.body.appendChild(el); }
  el.innerHTML = `${ico('alert')}<span><b>连不上收件箱后台。</b>${S.model ? '下面是断开前的数据，不会更新；' : ''}双击桌面「HR收件箱」会自动把它开起来，开好后这里自己恢复。</span>`;
}
let tm = null;
const reload = () => { clearTimeout(tm); tm = setTimeout(load, 250); };
function connectStream() {
  const es = new EventSource('/api/stream');
  es.onmessage = reload;
  es.onopen = reload;
  es.onerror = () => { es.close(); reload(); setTimeout(connectStream, 3000); };
}
async function post(path, body = {}) {
  let r;
  try { r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
  catch { throw new Error('连不上收件箱后台，这一下没做成'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.err || `后台出错了（${r.status}）`);
  return j;
}

function notifyNew() {
  const need = S.model.convs.filter((c) => c.status === 'need');
  const keys = new Set(need.map((c) => c.key));
  if (S.needKeys) {
    for (const c of need) if (!S.needKeys.has(c.key)) {
      toast(`新的要你处理：${c.company || c.name}，${c.last?.why || c.last?.tell || '要你接'}`);
      if (window.Notification?.permission === 'granted') new Notification(`要你处理：${c.company || c.name}`, { body: c.last?.why || c.last?.tell || c.preview, tag: c.key });
    }
  }
  S.needKeys = keys;
  document.title = need.length ? `(${need.length}) HR 收件箱` : 'HR 收件箱';
}
function watchJobs() {
  for (const j of S.model.jobs || []) {
    const prev = S.seenJobs[j.id];
    if (prev === j.state) continue;
    S.seenJobs[j.id] = j.state;
    if (prev === undefined && (j.state === 'ok' || j.state === 'fail')) continue;
    if (j.state === 'ok') { toast(j.type === 'send' ? '发出去了' : `${JOB_WHAT[j.type] || '操作'}：${j.msg}`, 'ok'); if (j.type === 'send') { delete S.drafts[j.key]; if (S.sel === j.key) { const t = $('#txt'); if (t) { t.value = ''; updCount(); } } } }
    if (j.state === 'fail') toast(`${JOB_WHAT[j.type] || '操作'}没成：${j.msg}`, 'bad');
  }
}
const JOB_WHAT = { send: '发送', refresh: '拉最新聊天', resume: '发简历', agree: '点「同意」', reject: '点「拒绝」' };

// ---------- 过滤 ----------
function viewDef(id = S.view) {
  if (id === 'log') return { id, name: '盯梢日志' };
  return VIEWS.find((v) => v.id === id) || VIEWS[0];
}
const subDef = () => (SUBS[S.view] || []).find((s) => s[0] === S.sub);
function baseList() {                      // 当前视图 + 子筛选（不含平台、搜索）
  const v = viewDef();
  if (!v.f) return [];
  const sd = subDef();
  return S.model.convs.filter(v.f).filter((c) => !sd || sd[2](c));
}
function visible() {
  const q = S.q.trim().toLowerCase();
  return baseList().filter((c) => !S.pf || c.pid === S.pf)
    .filter((c) => !q || [c.company, c.name, c.title, c.preview, ...c.thread.map((t) => t.text)].join(' ').toLowerCase().includes(q));
}
const isFollow = (c) => c.status === 'waiting' && daysAgo(c.waitSince) >= FOLLOW_DAYS;

// ---------- 渲染 ----------
function render() {
  if (!S.model) return;
  renderSide();
  renderList();
  renderReader();
}

// 海投待审数：和海投工作台的口径一样（排队 / 发送中 / 失败 / 已发的不算）
const huntPendingN = () => (S.hunt?.ok ? (S.hunt.queue || []).filter((q) => !['排队', '发送中', '失败', '已发'].includes(q.status)).length : null);
// 老外壳才显示的盯梢状态卡（新外壳里挪到 HR Desk 顶栏右侧）
function statusCard() {
  const m = S.model, st = m.status || {};
  const busy = /扫|看|想|发|等收件箱/.test(st.doing || '');
  const dot = !st.alive ? 'bad' : st.paused ? 'warn' : busy ? 'busy' : 'on';
  const title = !st.alive ? '盯梢没开' : st.paused ? '盯梢暂停中' : busy ? '盯梢在干活' : '盯梢在等消息';
  const doing = !st.alive ? 'HR 的消息现在没人看' : `正在：<b>${esc(st.doing || '—')}</b>`;
  const when = st.alive ? [st.roundAt && `上一轮 ${esc(st.roundAt)}`, st.next && `下一轮约 ${esc(st.next)}`].filter(Boolean).join(' · ') : '';
  const lockNote = st.lock?.who === 'inbox' ? '<div class="doing">收件箱正在用页面发消息</div>' : '';
  const fix = { boss: 'BOSS', zl: '智联', lp: '猎聘' };
  const alerts = st.alive ? Object.entries(fix).map(([id, label]) => {
    const p = st[`p_${id}`]; if (!p || p.ok) return '';
    const where = id === 'boss' ? '桌面 2 的 BOSS 浏览器' : '智联后台浏览器';
    const what = /登录/.test(p.note) ? `${label} 登录掉了，去${where}扫码登录` : /验证/.test(p.note) ? `${label} 弹了人机验证，去${where}点一下` : `${label} ${esc(p.note || '连不上')}`;
    return `<div class="alert-line" title="在那之前 ${label} 的消息没人看，也发不出去">${ico('alert')}<span><b>${what}</b>，弄好点「立即扫一轮」</span></div>`;
  }).join('') : '';
  const stale = st.alive && st.updated && m.now && (Date.parse(m.now) - Date.parse(st.updated)) / 60e3 > 20
    ? `<div class="alert-line">${ico('alert')}<span>盯梢 ${Math.round((Date.parse(m.now) - Date.parse(st.updated)) / 60e3)} 分钟没动静了，可能卡住了。先点「立即扫一轮」，还不动就关掉再打开</span></div>` : '';
  const chip = (id, label) => { const p = st[`p_${id}`]; const lv = id === 'boss' ? st.live_boss : id === 'zl' ? st.live_zl : null;
    return `<span><i class="dot ${p ? (p.ok ? 'on' : 'bad') : ''}"></i>${label}${lv ? `<b class="live ${lv.ok ? 'on' : ''}" title="${esc(lv.note)}">${lv.ok ? '实时' : '轮询'}</b>` : ''}<em title="${p ? esc(p.note) : ''}">${p ? esc(p.note) + ' · ' + esc(p.at) : '还没看过'}</em></span>`; };
  const seg = (id, label, on) => `<button class="${on ? 'cur' : ''}" data-act="${id}">${on ? `<i class="dot ${dot}"></i>` : ''}${label}</button>`;
  return `<div class="status">
      <div class="status-top"><i class="dot ${dot}"></i>${title}</div>
      <div class="doing">${doing}${when ? `<br>${when}` : ''}</div>${lockNote}${alerts}${stale}
      <div class="seg" role="group" aria-label="盯梢开关">${seg('wRun', '运行', st.alive && !st.paused)}${seg('wPause', '暂停', st.alive && st.paused)}${seg('wOff', '关闭', !st.alive)}</div>
      ${st.alive && !st.paused ? `<button class="btn sm block" data-act="kick">${ico('refresh')}立即扫一轮</button>` : ''}
      <div class="pchips">${chip('boss', 'BOSS')}${chip('zl', '智联')}${chip('lp', '猎聘')}${chip('51', '51job')}</div>
    </div>`;
}
// v2.2.0 新外壳：盯梢状态卡挪到 HR Desk 顶栏右侧，海投入口挪到顶栏「找岗位」，这里只留会话
function renderSide() {
  const m = S.model;
  const hn = V2 ? null : huntPendingN();
  const cnt = (f) => m.convs.filter(f).length;
  const nav = VIEWS.map((v, i) => {
    const n = cnt(v.f);
    const cls = v.hot && n ? 'hot' : v.acc && n ? 'acc' : '';
    return `<button class="nav-item ${S.view === v.id ? 'cur' : ''}" data-view="${v.id}" title="快捷键 ${i + 1}">${ico(v.icon)}<span>${v.name}</span><span class="n ${cls}">${n || ''}</span></button>`;
  }).join('');
  $('#side').innerHTML = `
    <div class="brand"><span class="logo">${ico('inbox')}</span>HR 收件箱<span class="ver">${VERSION}</span>
      <button class="btn ghost sm icon" data-act="help" title="快捷键（?）">${ico('help')}</button></div>
    ${V2 ? '' : statusCard()}
    <div class="today" title="今天（${todayStr()}）">
      <div><b>${m.stats.hr}</b><span>新消息</span></div>
      <div><b>${m.stats.auto}</b><span>自动回</span></div>
      <div><b>${m.stats.escalate}</b><span>推给你</span></div>
      <div><b>${m.stats.manual}</b><span>你回的</span></div>
    </div>
    <nav class="nav">${nav}</nav>
    ${V2 ? '' : `<nav class="nav"><h4>海投</h4>
      <a class="nav-item" href="hunt.html">${ico('send')}<span>海投工作台</span><span class="n ${hn ? 'acc' : ''}" title="待你审的岗位">${hn ?? ''}</span></a>
    </nav>`}
    <nav class="nav"><h4>动态</h4><button class="nav-item ${S.view === 'log' ? 'cur' : ''}" data-view="log">${ico('activity')}<span>盯梢日志</span><span class="n">${m.activity.filter((x) => !(x.round && !x.events)).length || ''}</span></button></nav>
    <div class="side-foot">数据有变化自动刷新</div>`;
}

function dayLabel(d) {
  if (!d) return '更早';
  const t = todayStr();
  if (d === t) return '今天';
  const y = new Date(Date.now() - 864e5); if (d === localIso(y).slice(0, 10)) return '昨天';
  const dt = new Date(d + 'T12:00:00');
  return `${dt.getMonth() + 1} 月 ${dt.getDate()} 日 周${'日一二三四五六'[dt.getDay()]}`;
}
const shortTime = (iso) => (!iso ? '' : iso.slice(0, 10) === todayStr() ? iso.slice(11, 16) : `${+iso.slice(5, 7)}/${+iso.slice(8, 10)}`);

function pillFor(c, inList = false) {
  if (isFollow(c)) return `<span class="pill s-follow">该跟进 · 等了 ${Math.floor(daysAgo(c.waitSince))} 天</span>`;
  if (c.status === 'snoozed') return `<span class="pill s-snoozed">稍后 · ${esc(shortTime(c.user.until))}</span>`;
  if (c.status === 'other' || c.status === 'quiet') return c.auto ? '<span class="pill s-auto">已自动回</span>' : `<span class="pill s-${c.status}">${STATUS[c.status]}</span>`;
  // 在「要你处理」视图里每行都挂「要你处理」是废话（10/16 体检第 18 条），列表里只在别的视图显示
  const same = inList && S.view === c.status;
  if (c.status === 'need' && c.last?.worth === '别理') return `${same ? '' : '<span class="pill s-need">要你处理</span>'}<span class="pill s-other">盯梢觉得不用理</span>`;
  if (c.status === 'waiting' && c.repliedElsewhere) return '<span class="pill s-waiting">等 HR 回 · 平台上已回过</span>';
  if (same) return '';
  return `<span class="pill s-${c.status}">${STATUS[c.status]}</span>`;
}

function renderChips() {
  const el = $('#chips');
  const v = viewDef();
  if (!v.f) { el.innerHTML = ''; return; }
  const base = baseList();
  const subs = (SUBS[S.view] || []).map(([id, name, f]) => {
    const n = S.model.convs.filter(v.f).filter(f).length;
    return `<button class="chip ${S.sub === id ? 'on' : ''}" data-sub="${id}" ${!n && S.sub !== id ? 'disabled' : ''}>${name}<span>${n}</span></button>`;
  }).join('');
  const plats = PLAT_ORDER.map((id) => [id, base.filter((c) => c.pid === id).length]).filter(([id, n]) => n || S.pf === id);
  const pchips = plats.length > 1 || S.pf
    ? `<button class="chip ${!S.pf ? 'on' : ''}" data-pf="">全部平台<span>${base.length}</span></button>` + plats.map(([id, n]) => `<button class="chip ${S.pf === id ? 'on' : ''}" data-pf="${id}">${PLAT[id].name}<span>${n}</span></button>`).join('')
    : '';
  el.innerHTML = subs + (subs && pchips ? '<span style="width:4px"></span>' : '') + pchips;
}

function renderList() {
  const v = viewDef();
  $('#viewName').textContent = v.name + (subDef() ? ` · ${subDef()[1]}` : '');
  renderChips();
  if (v.id === 'log') { $('#listMenu').innerHTML = ''; return renderLog(); }
  const list = visible();
  const old = v.id === 'need' ? list.filter((c) => daysAgo(c.lastAt) >= 3) : [];
  $('#viewCount').textContent = list.length ? `${list.length} 家` : '';
  $('#listMenu').innerHTML = old.length ? `<button class="btn ghost sm icon" data-act="listMenu" data-n="${old.length}" title="更多">${ico('more')}</button>` : '';
  if (!list.length) {
    $('#items').innerHTML = `<div class="empty">${S.q ? `没搜到「${esc(S.q)}」` : S.pf || S.sub ? '这个筛选下是空的' : v.id === 'need' ? '没有要你处理的，盯梢都接住了' : '这里是空的'}</div>`;
    return;
  }
  let html = '', day = null;
  for (const c of list) {
    const d = (c.lastAt || '').slice(0, 10);
    if (d !== day) { day = d; html += `<div class="day">${dayLabel(d)}</div>`; }
    const p = PLAT[c.pid] || PLAT.boss;
    html += `<div class="item ${S.sel === c.key ? 'cur' : ''}" data-key="${esc(c.key)}" tabindex="0" role="option" aria-selected="${S.sel === c.key}">
      ${c.unread ? '<i class="unread" title="有新消息"></i>' : ''}
      <span class="plat-ico av ${p.cls}">${p.short}</span>
      <div class="body">
        <div class="meta">${pillFor(c, true)}${c.goodUnit ? '<span class="pill s-good">好单位</span>' : ''}${c.auto ? `<span title="盯梢回过">${ico('bot')}</span>` : ''}${c.manual ? `<span title="你回过">${ico('hand')}</span>` : ''}<span class="t">${esc(shortTime(c.lastAt) || c.listTime)}</span></div>
        <div class="ttl">${esc(c.company || '（没读到公司）')} <span class="hr">${esc(c.name)}</span></div>
        <div class="desc">${c.previewMe ? '<span class="me">我：</span>' : ''}${esc(c.preview)}</div>
      </div></div>`;
  }
  const box = $('#items'), top = box.scrollTop;
  box.innerHTML = html;
  box.scrollTop = top;
  if (S.scrollSel) { S.scrollSel = false; $('#items .item.cur')?.scrollIntoView({ block: 'nearest' }); }
}

function renderLog() {
  const q = S.q.trim().toLowerCase();
  const a = S.model.activity.filter((x) => !(x.round && !x.events)).filter((x) => !q || x.text.toLowerCase().includes(q));
  $('#viewCount').textContent = `最近 ${a.length} 条${q ? '（搜索中）' : ''}`;
  let html = '', day = null;
  for (const x of a) {
    const d = x.at.slice(0, 10);
    if (d !== day) { day = d; html += `<div class="day">${dayLabel(d)}</div>`; }
    const ic = /^[a-z]+$/.test(x.icon || '') ? ico(x.icon) : '';
    html += `<div class="act ${x.key ? 'link' : ''}" ${x.key ? `data-key="${esc(x.key)}" tabindex="0" title="点开看这家的聊天"` : ''}><span class="tm">${esc(x.at.slice(11, 16))}</span><span class="ic t-${esc(x.tone || '')}">${ic}</span><span class="tx">${esc(x.text)}</span></div>`;
  }
  const box = $('#items'), top = box.scrollTop;
  box.innerHTML = html || `<div class="empty">${q ? '没搜到' : '还没有日志'}</div>`;
  box.scrollTop = top;
}

const curConv = () => S.model?.convs.find((c) => c.key === S.sel);

function whoLabel(m, c) {
  if (m.fromList) return m.me ? '我方 · 消息列表上看到的最后一句' : `${esc(c.name || 'HR')} · 消息列表上看到的最后一句`;
  if (m.by === 'hr') return `${esc(c.name || 'HR')}`;
  if (m.by === 'auto') return `${ico('bot')}盯梢自动回`;
  if (m.by === 'manual') return `${ico('hand')}你在收件箱回的`;
  if (m.by === 'claude') return `${ico('bot')}助手 代回的`;
  return '我方 · 开场白或别处发的';
}
const evText = (e) => ({
  reply: e.sent === false ? '想回但没发出去' : '自动回了',
  send_resume: `发简历${e.resume ? '：' + e.resume : ''}`,
  escalate: '推给你',
  ignore: '没回',
  claude: '助手 手动处理',
}[e.action] || (e.err ? '出错' : e.action || ''));

function renderReader() {
  const c = S.sel && S.model ? curConv() : null;
  const R = $('#reader');
  if (!c || viewDef().id === 'log') {
    S.readerSig = ''; S.compKey = null;
    const v = viewDef();
    R.innerHTML = `<div class="r-empty"><div class="big">${ico('msg')}</div>${v.id === 'log' ? '点日志里的一条，跳到那家的聊天' : visible().length ? '左边选一家看聊天<br><span class="muted">J / K 上下切换</span>' : '这个视图是空的'}</div>`;
    return;
  }
  const job = [...(S.model.jobs || [])].reverse().find((j) => j.key === c.key);
  const health = S.model.status?.[`p_${c.pid}`] || null;
  const sig = JSON.stringify([c, S.applied[c.key], job, health?.ok, health?.note, !!S.pendingSend[c.key], S.checks[c.company], S.jds[c.key]]);
  if (sig !== S.readerSig || !$('#rScroll')) {
    const fresh = S.compKey !== c.key;
    const sc = $('#rScroll');
    const keep = sc && !fresh ? sc.scrollTop : null;
    const atBottom = sc && !fresh ? sc.scrollHeight - sc.scrollTop - sc.clientHeight < 40 : false;
    const histOpen = !fresh ? $('#rScroll details.hist')?.open : undefined;
    if (fresh) {
      R.innerHTML = `<div id="rHead"></div><div class="r-scroll" id="rScroll"></div><div id="rComp"></div>`;
      S.compKey = c.key;
      renderComposer(c);
      loadApplied(c);
      loadIntel(c);
    }
    $('#rHead').innerHTML = headHtml(c);
    $('#rScroll').innerHTML = bodyHtml(c);
    if (histOpen !== undefined && $('#rScroll details.hist')) $('#rScroll details.hist').open = histOpen;
    renderJobbar(c, job);
    const s2 = $('#rScroll');
    // 打开一家时：有「为什么推给你」就停在顶上让它整块露出来（10/16 体检第 12 条），没有就到最新一句
    if (fresh) s2.scrollTop = $('#rScroll .why.need, #rScroll .why.look') ? 0 : s2.scrollHeight;
    else if (atBottom) s2.scrollTop = s2.scrollHeight;
    else if (keep !== null) s2.scrollTop = keep;
    S.readerSig = sig;
  }
}

function headHtml(c) {
  const p = PLAT[c.pid] || PLAT.boss;
  const a = S.applied[c.key];
  const done = c.status === 'done' || c.status === 'pass';
  const tags = [
    pillFor(c),
    c.goodUnit ? `<span class="pill s-good" title="${esc(c.unitWhy)}">好单位 · 第 ${esc(c.goodUnit)} 条</span>` : '',
    c.mine ? '<span class="pill s-waiting">这家你自己回</span>' : '',
    c.user?.note ? `<span class="pill s-other" title="${esc(c.user.note)}">${ico('pen')}有备注</span>` : '',
  ].join('');
  const facts = [a?.day && `${esc(a.day)} 投的`, a?.size && esc(a.size), a?.rest && esc(a.rest)].filter(Boolean);
  return `<div class="r-bar">
      <div class="r-bar-l">${tags}</div>
      <div class="r-tools">
        ${done ? `<button class="btn sm" data-act="reopen">${ico('refresh')}重新打开</button>` : `<button class="btn sm" data-act="done" title="快捷键 E">${ico('check')}已处理</button>`}
        <div class="menu"><button class="btn ghost sm" data-act="snoozeMenu" title="快捷键 M = 3 小时">${ico('clock')}稍后${ico('chev')}</button></div>
        <button class="btn ghost sm" data-act="note" title="给这家写个备注（只你自己看）">${ico('pen')}备注</button>
        <div class="menu"><button class="btn ghost sm icon" data-act="convMenu" title="更多">${ico('more')}</button></div>
      </div>
    </div>
    <div class="r-head">
      <span class="plat-ico av ${p.cls}">${p.short}</span>
      <div class="r-id">
        <h2>${esc(c.company || '（没读到公司）')}</h2>
        <div class="sub">${esc(c.title || S.jds[c.key]?.title || '岗位名还没读到')}<i>·</i>${esc(c.name)}${c.hrRole ? `（${esc(c.hrRole)}）` : ''}<i>·</i>${esc(c.platform)}</div>
        ${facts.length ? `<div class="facts" title="${esc(a?.bg || '')}">${facts.join('<i>·</i>')}</div>` : ''}
      </div>
    </div>`;
}

function bodyHtml(c) {
  const L = c.last;
  let why = '';
  if (c.status === 'need' && L) why = `<div class="why need">${ico('alert')}<div><b>为什么推给你${L.kind ? '（' + esc(L.kind) + '）' : ''}：</b>${esc(L.why || L.tell || '')}${L.why && L.tell && L.why !== L.tell ? '<br>' + esc(L.tell) : ''}${L.worth === '别理' ? '<br><span class="muted">盯梢自己的判断是「不用理」，只是碰到面试类字眼按规矩交给你。看过没问题就按 E 标成已处理</span>' : ''}</div></div>`;
  else if (c.repliedElsewhere && L) why = `<div class="why info">${ico('check')}<div><b>平台上已经回过了</b>（消息列表最后一句是我方说的，多半是你在手机上回的），不再算「要你处理」。之前推给你的原因：${esc(L.why || L.tell || '')}</div></div>`;
  else if (c.status === 'look' && L) why = `<div class="why look">${ico('star')}<div><b>HR 主动找来的，看着值得看：</b>${esc(L.tell || '')}<br><span class="muted">HR 主动来的盯梢一律不回，要聊你自己回</span></div></div>`;
  else if (L) why = `<div class="why info">${ico('bot')}<div><b>盯梢最后一次判断</b>（${esc(L.at.slice(5, 16).replace('T', ' '))}）：${esc(L.kind || '')} · ${esc(L.tell || L.why || '')}</div></div>`;
  if (isFollow(c)) why += `<div class="why look">${ico('hourglass')}<div><b>HR 已经 ${Math.floor(daysAgo(c.waitSince))} 天没回了。</b>可以点下面「AI 写跟进」发一条轻提醒，不想跟了就在「⋯」里点「不谈了」</div></div>`;
  if (c.user?.note) why += `<div class="why info">${ico('pen')}<div><b>你的备注：</b>${esc(c.user.note)}</div></div>`;
  const src = c.pid === '51'
    ? '51job 网页上聊不了天，这里只有「我的申请」里的状态'
    : c.snapAt ? `聊天记录是 ${esc(c.snapAt.slice(5, 16).replace('T', ' '))} 从平台读的（最近 14 条）· <a data-act="refresh">拉最新</a>`
      : c.thread.length === 1 && c.thread[0].fromList ? `盯梢还没点开过这家，只有消息列表上的最后一句 · <a data-act="refresh">去平台读完整聊天</a>`
      : `这家是用盯梢日志拼出来的，可能不全 · <a data-act="refresh">去平台读完整聊天</a>`;
  const lastCardIdx = {};
  c.thread.forEach((m, i) => { const t = cardType(m); if (t) lastCardIdx[t] = i; });
  let prevWho = '';
  const thread = c.thread.map((m, i) => {
    const cls = m.by === 'hr' ? 'hr' : `me ${m.by === 'auto' || m.by === 'claude' ? 'auto' : m.by === 'manual' ? 'manual' : 'other'}`;
    const who = `${m.by}|${m.fromList ? 1 : 0}|${(m.at || '').slice(0, 16)}`;
    const cont = who === prevWho; prevWho = who;
    const mark = m.me && m.text.match(SELF_MARK)?.[1];
    const ct = cardType(m);
    const body = ct ? cardHtml(c, m, ct, lastCardIdx[ct] === i)
      : mark ? `<div class="bub file">${ico(mark === '📎' ? 'file' : mark === '❌' ? 'x' : 'msg')}${esc(m.text.replace(SELF_MARK, ''))}</div>`
      : `<div class="bub">${esc(m.text)}</div>`;
    return `<div class="msg ${cls}${cont ? ' cont' : ''}">${cont ? '' : `<span class="who">${whoLabel(m, c)}${m.at ? ` · ${esc(m.at.slice(5, 16).replace('T', ' '))}` : ''}</span>`}${body}</div>`;
  }).join('') || '<div class="empty">还没有聊天内容</div>';
  const evs = [...c.events].reverse().map((e) => `<div class="ev"><span class="tm">${esc(e.at.slice(5, 16).replace('T', ' '))}</span><div class="tx">
      <b>${esc(evText(e))}</b>${e.kind ? ' · ' + esc(e.kind) : ''}${e.tell || e.why || e.err ? '：' + esc([e.why, e.tell, e.err].filter(Boolean).join('；')) : ''}
      ${e.reply && e.sent !== true ? `<div class="draft"><span class="muted">盯梢的草稿（没发）：</span>${esc(e.reply)}<br><button class="btn sm" data-act="useDraft" data-text="${esc(e.reply)}">用这稿</button></div>` : ''}
    </div></div>`).join('');
  return `${why}${intelHtml(c)}<div class="src">${src}</div><div class="thread">${thread}</div>
    ${evs ? `<details class="hist" ${c.status === 'need' ? 'open' : ''}><summary>${ico('chev')}盯梢处理记录（${c.events.length} 次）</summary>${evs}</details>` : ''}`;
}

// ---------- HR 发来的请求卡片（要附件简历 / 交换微信 / 交换电话） ----------
function cardType(m) {
  if (m.by !== 'hr' || !/是否同意|同意.*拒绝|拒绝.*同意/.test(m.text)) return '';
  return /简历/.test(m.text) ? 'resume' : /微信/.test(m.text) ? 'wechat' : /电话|手机/.test(m.text) ? 'phone' : '';
}
function cardHtml(c, m, type, isLast) {
  const text = m.text.replace(/(\s+(拒绝|同意))+\s*$/, '').trim();
  const snap = (c.cards || []).filter((x) => x.type === type).pop();
  const pending = snap ? snap.pending : true;
  const job = [...(S.model.jobs || [])].reverse().find((j) => j.key === c.key && ACTIVE.includes(j.state));
  let btns = '';
  if (!isLast) btns = '';
  else if (!pending) btns = '<div class="card-done">已经处理过了</div>';
  else if (c.pid !== 'boss') btns = '<div class="card-done">智联的这类请求要在 APP 里点</div>';
  else if (job) btns = `<div class="card-done"><i class="spin"></i>${esc(job.msg || '处理中')}</div>`;
  else if (type === 'resume') {
    const vs = variantList(c);
    btns = `<div class="card-btns"><div class="split"><button class="btn sm" data-act="cardAgree" data-card="resume" data-variant="${esc(vs[0].id)}">同意，发「${esc(vs[0].label)}」版</button>
      <div class="menu"><button class="btn sm" data-act="variantMenu" data-mode="card" title="换一版简历">${ico('chev')}</button></div></div>
      <button class="btn ghost sm" data-act="cardReject" data-card="resume">拒绝</button></div>`;
  } else if (type === 'wechat') {
    btns = `<div class="card-btns"><button class="btn sm" data-act="wechatAlt">改发微信小号</button><button class="btn ghost sm" data-act="cardReject" data-card="wechat">拒绝</button></div>
      <div class="card-note">平台上点「同意」会把大号发出去，所以不点；要给就发小号</div>`;
  } else if (type === 'phone') {
    btns = `<div class="card-btns"><button class="btn sm" data-act="cardAgree" data-card="phone">同意交换电话</button><button class="btn ghost sm" data-act="cardReject" data-card="phone">拒绝</button></div>`;
  }
  return `<div class="bub card"><div class="card-tx">${ico(type === 'resume' ? 'file' : 'msg')}<span>${esc(text)}</span></div>${btns}</div>`;
}
function variantList(c) {
  const vs = S.variants.length ? [...S.variants] : [{ id: 'general', label: '通用' }];
  const i = vs.findIndex((v) => v.id === c.variant);
  if (i > 0) vs.unshift(vs.splice(i, 1)[0]);
  return vs;
}
function phraseList() {
  try { const p = JSON.parse(localStorage.getItem('hr-inbox-phrases') || 'null'); if (Array.isArray(p) && p.length) return p; } catch {}
  return DEFAULT_PHRASES;
}

function renderComposer(c) {
  const box = $('#rComp');
  if (c.pid === '51') { box.innerHTML = `<div class="composer"><div class="disabled-note">51job 网页上聊不了天，HR 的消息和面试通知要在 51job APP 里看和回。</div></div>`; return; }
  const follow = c.status === 'waiting';
  box.innerHTML = `<div class="composer">
    <div class="box">
      <textarea id="txt" placeholder="自己写，或者点「${follow ? 'AI 写跟进' : 'AI 起草'}」先出一稿再改"></textarea>
      <label class="hint">${ico('sparkles')}<input id="hint" placeholder="给 AI 的意思（可空）：答应周四下午 / 婉拒 / 问做什么"></label>
      <div class="box-bar">
        <div class="split"><button class="btn ghost sm" data-act="draft" data-mode="${follow ? 'follow' : 'reply'}">${ico('sparkles')}${follow ? 'AI 写跟进' : 'AI 起草'}</button>
          <div class="menu"><button class="btn ghost sm" data-act="aiMenu" title="换一种起草">${ico('chev')}</button></div></div>
        <div class="menu"><button class="btn ghost sm" data-act="phraseMenu" title="常用短语">${ico('quote')}短语${ico('chev')}</button></div>
        ${c.pid === 'boss' ? `<div class="menu"><button class="btn ghost sm" data-act="variantMenu" data-mode="send" title="发附件简历">${ico('file')}发简历${ico('chev')}</button></div>` : ''}
        <span class="cnt" id="cnt"></span>
        <button class="btn primary sm send" data-act="send" title="Ctrl + Enter">${ico('send')}发送</button>
      </div>
    </div>
    <div id="warn" class="warn-line" hidden></div>
    <div id="jobbar"></div>
  </div>`;
  const t = $('#txt');
  t.value = S.drafts[c.key] || '';
  t.addEventListener('input', () => { S.drafts[c.key] = t.value; updCount(); autoGrow(t); });
  updCount(); autoGrow(t);
}
function autoGrow(t) { t.style.height = 'auto'; t.style.height = Math.min(200, Math.max(64, t.scrollHeight)) + 'px'; }
function updCount() {
  const t = $('#txt'); if (!t) return;
  const v = t.value;
  $('#cnt').textContent = v ? `${v.length} 字` : '';
  const w = [];
  if (PROFILE.wechatAlt && /微信|vx|VX/.test(v) && !v.includes(PROFILE.wechatAlt)) w.push(`提到了微信但不是你设的小号 ${PROFILE.wechatAlt}`);
  if (/\d{11}/.test(v)) w.push('里面有一串像手机号的数字');
  if (/[～~]|[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(v)) w.push('有波浪号或表情（你定的语气里不用）');
  if (v.length > 160) w.push('超过 160 字了，HR 不爱看长的');
  const el = $('#warn'); el.hidden = !w.length; el.textContent = w.length ? '注意：' + w.join('；') : '';
}
function renderJobbar(c, job) {
  const el = $('#jobbar'); if (!el) return;
  const h = S.model.status?.[`p_${c.pid}`];
  const down = c.pid !== '51' && h && !h.ok ? `<div class="jobbar fail">${ico('alert')}${esc(c.platform)} 现在${esc(h.note || '连不上')}，这时候点发送会失败，等弄好了再发</div>` : '';
  const busy = !!job && ACTIVE.includes(job.state);
  const pend = !!S.pendingSend[c.key];
  const send = $('[data-act="send"]', $('#rComp'));
  const tx = $('#txt'); if (tx) tx.readOnly = pend;
  if (send) { send.disabled = pend || (busy && job.type === 'send'); send.innerHTML = pend ? '<i class="spin"></i>5 秒后发' : `${ico('send')}发送`; }
  const pendLine = pend ? `<div class="jobbar">${ico('clock')}5 秒后发出，点右下角提示里的「撤销」可以收回</div>` : '';
  if (!job || (job.state !== 'fail' && !busy && daysAgo(job.at) * 1440 > 2)) { el.innerHTML = down + pendLine; return; }
  const what = JOB_WHAT[job.type] || '操作';
  const txt = { queued: `${what}：排队中`, waiting: `${what}：${job.msg}`, running: `${what}：${job.msg}`, ok: `${what}：${job.msg}`, fail: `${what}没成：${job.msg}` }[job.state];
  el.innerHTML = down + pendLine + `<div class="jobbar ${job.state}">${busy ? '<i class="spin"></i>' : job.state === 'ok' ? ico('check') : ''}${esc(txt)}</div>`;
}
// ---------- 10/16 岗位与背调（用户：聊天页上没有岗位描述、也没背调，很不好）----------
// 背调走 HR Desk 软件（window.hrdesk，插件的「查公司」：百度 + 企查查 + DeepSeek）；在普通浏览器里打开收件箱就没有背调按钮。
// 岗位描述走收件箱后台 /api/jd（从平台接口读，读过的存盘）
const VERDICT_CLS = { 值得投: 's-good', 可以投但留个心: 's-waiting', 谨慎: 's-need', 别投: 's-bad', 信息太少: 's-other' };
// 背调用全称搜：简称（「捷路通」）会把外地同名公司全搜进来。全称取自岗位详情里的工商信息 / 智联的公司全称，没有才用会话上的简称
const fullNameOf = (c, jd) => (jd?.business || []).map((x) => x.match(/^公司名称\s*(.+)$/)?.[1]).find(Boolean) || (jd?.company && jd.company.length > (c.company || '').length ? jd.company : '') || c.company;
async function loadIntel(c, force = false) {
  if (S.jds[c.key] === undefined || force) {
    S.jds[c.key] = { loading: true };
    try {
      const r = await fetch(`/api/jd?key=${encodeURIComponent(c.key)}${force ? '&fresh=1' : ''}`);
      const j = await r.json().catch(() => ({}));
      S.jds[c.key] = r.ok ? j : { err: j.err || (r.status === 404 ? '' : `读不到（${r.status}）`) };
    } catch (e) { S.jds[c.key] = { err: e.message }; }
    rerenderIf(c);
  }
  const key = c.company;
  if (!key || !window.hrdesk || (!force && S.checks[key] !== undefined)) return;
  const name = fullNameOf(c, S.jds[c.key]);
  S.checks[key] = { loading: '看看以前查过没有…', name };
  try {
    const old = force ? null : (await window.hrdesk.getCheck(name));
    if (old) S.checks[key] = old;
    else {
      S.checks[key] = { loading: `开始背调「${name}」…`, name };
      rerenderIf(c);
      S.checks[key] = await window.hrdesk.check(name);
    }
  } catch (e) { S.checks[key] = { err: String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }; }
  rerenderIf(c);
}
const rerenderIf = (c) => { if (S.sel === c.key) { S.readerSig = ''; renderReader(); } };
if (window.hrdesk) window.hrdesk.onCheckProgress((name, text) => {
  const key = Object.keys(S.checks).find((k) => S.checks[k]?.loading !== undefined && S.checks[k].name === name);
  if (!key) return;
  S.checks[key] = { loading: text, name };
  const c = curConv?.();
  if (c && c.company === key) rerenderIf(c);
});

function intelHtml(c) {
  const ck = S.checks[c.company], jd = S.jds[c.key];
  if (!window.hrdesk && !(jd && (jd.desc || jd.title))) return '';
  const R = ck?.report;
  let check = '';
  if (!window.hrdesk) check = '';
  else if (!c.company) check = '<div class="intel-sec muted">没读到公司名，背调不了</div>';
  else if (!ck || ck.loading) check = `<div class="intel-sec muted">${ico('refresh')} 背调中：${esc(ck?.loading || '…')}<br><span class="muted">百度搜 4 次 + 企查查 + AI 总结，约半分钟</span></div>`;
  else if (ck.err) check = `<div class="intel-sec"><span class="muted">背调没成：${esc(ck.err)}</span> <a data-act="recheck">再试一次</a></div>`;
  else if (R) {
    const li = (arr) => arr.map((x) => `<li>${esc(x)}</li>`).join('');
    check = `<div class="intel-sec">
      <div class="intel-top"><span class="pill ${VERDICT_CLS[R.verdict] || 's-other'}">${esc(R.verdict)}</span><span class="pill s-other">${esc(R.tier)}</span>${R.workload?.level ? `<span class="pill ${R.workload.level === '不卷' ? 's-good' : R.workload.level === '卷' ? 's-bad' : 's-other'}">${esc(R.workload.level)}</span>` : ''}<b>${esc(R.full_name && R.full_name !== '不确定' ? R.full_name : c.company)}</b></div>
      <p>${esc(R.one_line)}</p>
      ${R.facts?.length ? `<div class="intel-facts">${R.facts.map((f) => `<span title="${esc(f.src)}"><i>${esc(f.k)}</i>${esc(f.v)}</span>`).join('')}</div>` : ''}
      ${R.workload?.evidence ? `<p class="muted">加班 / 双休：${esc(R.workload.evidence)}</p>` : ''}
      ${R.risks?.length ? `<div class="intel-risk"><b>风险</b><ul>${li(R.risks)}</ul></div>` : ''}
      ${R.good?.length ? `<details><summary>好的地方（${R.good.length}）</summary><ul>${li(R.good)}</ul></details>` : ''}
      ${R.hefei ? `<p class="muted">${esc(PROFILE.city || '本地')}：${esc(R.hefei)}</p>` : ''}
      ${R.todo?.length ? `<p class="muted">还要你核对：${R.todo.map(esc).join('；')}</p>` : ''}
      <div class="muted intel-foot">${new Date(ck.at).toLocaleString('zh-CN', { hour12: false }).slice(0, -3)} 查的${ck.notes?.length ? ' · ' + esc(ck.notes.join('；')) : ''} · <a data-act="recheck">重新背调</a></div>
    </div>`;
  }
  let job = '';
  if (jd?.loading) job = '<div class="intel-sec muted">读岗位描述…</div>';
  else if (jd && (jd.desc || jd.title)) job = `<div class="intel-sec">
      <div class="intel-top"><b>${esc(jd.title || c.title || '')}</b>${jd.salary ? `<span class="pill s-other">${esc(jd.salary)}</span>` : ''}</div>
      ${[jd.city, jd.exp, jd.degree, jd.scale, jd.industry].filter(Boolean).length ? `<div class="intel-facts">${[jd.city, jd.exp, jd.degree, jd.scale, jd.industry].filter(Boolean).map((x) => `<span>${esc(x)}</span>`).join('')}</div>` : ''}
      ${jd.address ? `<p class="muted">地址：${esc(jd.address)}</p>` : ''}
      ${jd.desc ? `<div class="jd-text">${esc(jd.desc)}</div>` : ''}
      ${jd.keywords?.length ? `<div class="intel-facts">${jd.keywords.slice(0, 10).map((k) => `<span>${esc(k)}</span>`).join('')}</div>` : ''}
      ${jd.business?.length ? `<details><summary>工商信息（平台上写的）</summary><ul>${jd.business.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></details>` : ''}
      ${jd.intro ? `<details><summary>公司介绍</summary><p>${esc(jd.intro)}</p></details>` : ''}
      <div class="muted intel-foot">${jd.hrActive ? `HR ${esc(jd.hrActive)} · ` : ''}${esc(jd.from || '')}${jd.url ? ` · <a href="${esc(jd.url)}" target="_blank" rel="noopener">平台原页</a>` : ''}</div>
    </div>`;
  else if (jd?.err) job = `<div class="intel-sec muted">岗位描述读不到：${esc(jd.err)}</div>`;
  if (!check && !job) return '';
  return `<details class="intel" open><summary>${ico('star')}<b>岗位与背调</b></summary>${job}${check}</details>`;
}

async function loadApplied(c) {
  if (S.applied[c.key] !== undefined) return;
  S.applied[c.key] = null;
  try { S.applied[c.key] = await (await fetch(`/api/applied?company=${encodeURIComponent(c.company)}&title=${encodeURIComponent(c.title)}`)).json(); } catch {}
  if (S.sel === c.key) { S.readerSig = ''; renderReader(); }
}

// ---------- 动作 ----------
function select(key) {
  S.sel = key; S.scrollSel = true;
  renderList();
  renderReader();
  try { if (window.Notification && Notification.permission === 'default') Notification.requestPermission(); } catch {}
}
function move(d) {
  const list = viewDef().id === 'log' ? [] : visible();
  if (!list.length) return;
  const i = list.findIndex((c) => c.key === S.sel);
  const n = list[Math.max(0, Math.min(list.length - 1, i < 0 ? 0 : i + d))];
  if (n) select(n.key);
}
// 切视图：选中这个视图的第一家；视图是空的就清掉选中，右边显示空状态（10/16 体检第 13 条：以前会残留上一家）
function fixSel() {
  const list = S.model ? visible() : [];
  if (!list.some((c) => c.key === S.sel)) { S.sel = list[0]?.key || null; S.scrollSel = true; }
}
function setView(v, sub = '') {
  S.view = v; S.sub = sub;
  try { localStorage.setItem('hr-inbox-view', v); } catch {}
  if (v === 'log') S.sel = null; else fixSel();
  render();
}
async function markAndNext(status, extra = {}, label = '') {
  if (!viewDef().f || !curConv()) return false;
  const c = curConv();
  const list = visible();
  const i = list.findIndex((x) => x.key === S.sel);
  const next = i < 0 ? null : list[i + 1] || list[i - 1];
  await post('/api/mark', { key: c.key, status, ...extra });
  if (S.view !== 'all' && next) { S.sel = next.key; S.scrollSel = true; }
  await load();
  // 已处理 / 稍后 / 不谈了 都能撤销（10/16 体检第 14 条）
  const back = status === 'pass' ? 'unpass' : 'open';
  toast(`${label || '好了'}：${c.company || c.name}`, '', { action: '撤销', fn: async () => { await post('/api/mark', { key: c.key, status: back }); S.sel = c.key; S.scrollSel = true; await load(); toast('撤销了'); } });
  return true;
}
function snoozeAt(kind) {
  const d = new Date();
  if (kind === '1h') d.setHours(d.getHours() + 1);
  else if (kind === '3h') d.setHours(d.getHours() + 3);
  else if (kind === 'tonight') { d.setHours(20, 0, 0, 0); if (d < new Date()) d.setDate(d.getDate() + 1); }
  else if (kind === 'tomorrow') { d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); }
  else if (kind === 'monday') { d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); d.setHours(9, 0, 0, 0); }
  return localIso(d);
}
// 发送先等 5 秒再真发，期间能撤销（10/16 体检第 14 条：以前一按就排队发出）
function doSend() {
  const c = curConv(); const t = $('#txt');
  if (!c || !t) return;
  const text = t.value.trim();
  if (!text) { toast('回复框是空的'); return; }
  if (S.pendingSend[c.key]) return;
  if ((S.model.jobs || []).some((j) => j.key === c.key && j.type === 'send' && ACTIVE.includes(j.state))) { toast('上一条还在发，等它发完再发下一条'); return; }
  const key = c.key, who = c.company || c.name;
  const timer = setTimeout(async () => {
    delete S.pendingSend[key]; S.readerSig = '';
    try { await post('/api/send', { key, text }); toast(`已排队，马上去平台上发给 ${who}`); await load(); }
    catch (e) { toast(e.message, 'bad'); renderReader(); }
  }, UNDO_MS);
  S.pendingSend[key] = timer; S.readerSig = ''; renderReader();
  toast(`5 秒后发给 ${who}`, '', { action: '撤销', ms: UNDO_MS, fn: () => {
    clearTimeout(S.pendingSend[key]); delete S.pendingSend[key]; S.readerSig = ''; renderReader(); toast('没发，字还在回复框里');
  } });
}
async function doDraft(mode) {
  const c = curConv(); if (!c) return;
  const btn = $('[data-act="draft"]', $('#rComp'));
  const old = btn.innerHTML; btn.innerHTML = '<i class="spin"></i>起草中'; btn.disabled = true;
  try {
    const d = await post('/api/draft', { key: c.key, hint: $('#hint').value.trim(), mode });
    const t = $('#txt'); t.value = d.reply; S.drafts[c.key] = d.reply; updCount(); autoGrow(t); t.focus();
    if (d.note) toast(`AI：${d.note}`);
  } catch (e) { toast(`起草失败：${e.message}`, 'bad'); }
  btn.innerHTML = old; btn.disabled = false;
}
function popMenu(anchor, html, cls = '') {
  closeMenus();
  const pop = document.createElement('div'); pop.className = `menu-pop ${cls}`; pop.innerHTML = html;
  anchor.closest('.menu').appendChild(pop);
  pop.querySelector('button')?.focus();
}
const closeMenus = () => document.querySelectorAll('.menu-pop').forEach((p) => p.remove());

document.addEventListener('click', async (e) => {
  const v = e.target.closest('[data-view]');
  if (v) { closeMenus(); return setView(v.dataset.view); }
  const sb = e.target.closest('[data-sub]');
  if (sb) { S.sub = S.sub === sb.dataset.sub ? '' : sb.dataset.sub; fixSel(); return render(); }
  const pf = e.target.closest('[data-pf]');
  if (pf) { S.pf = pf.dataset.pf; try { localStorage.setItem('hr-inbox-pf', S.pf); } catch {} fixSel(); return render(); }
  const it = e.target.closest('[data-key]');
  if (it && it.closest('#items')) {
    const key = it.dataset.key;
    if (viewDef().id === 'log') { const c = S.model.convs.find((x) => x.key === key); if (!c) return; S.view = 'all'; S.sub = ''; S.pf = ''; try { localStorage.setItem('hr-inbox-view', 'all'); } catch {} S.sel = key; S.scrollSel = true; return render(); }
    return select(key);
  }
  const a = e.target.closest('[data-act]');
  if (!a) { if (!e.target.closest('.menu-pop')) closeMenus(); if (e.target.id === 'help') $('#help').hidden = true; return; }
  const act = a.dataset.act;
  if (!/Menu$/.test(act)) closeMenus();
  const c = curConv();
  const st = S.model?.status || {};
  try {
    if (act === 'kick') { await post('/api/kick'); toast('好，盯梢 5 秒内开始扫'); }
    else if (act === 'wRun') {
      if (!st.alive) { await post('/api/watch', { on: true }); toast('盯梢打开了'); }
      else if (st.paused) { await post('/api/pause', { on: false }); toast('继续盯'); }
    }
    else if (act === 'wPause') {
      if (!st.alive) toast('盯梢没开，先点「运行」');
      else if (!st.paused) { await post('/api/pause', { on: true }); toast('暂停了：盯梢不看也不回，直到你点「运行」'); }
    }
    else if (act === 'wOff') { if (st.alive && confirm('关掉盯梢？关了 HR 的消息就没人看了。')) { await post('/api/watch', { on: false }); toast('盯梢关了'); } }
    else if (act === 'help') $('#help').hidden = false;
    else if (act === 'closeHelp') $('#help').hidden = true;
    else if (act === 'listMenu') popMenu(a, `<button data-act="clearOld">${ico('check')}3 天前的 ${a.dataset.n} 条标成已处理</button>`);
    else if (act === 'clearOld') {
      const old = visible().filter((x) => daysAgo(x.lastAt) >= 3);
      if (!confirm(`把 3 天前推给你、还挂着的 ${old.length} 家标成「已处理」？HR 再来新消息会自动回到这里。`)) return;
      for (const x of old) await post('/api/mark', { key: x.key, status: 'done' });
      await load();
      toast(`标好了 ${old.length} 家`, '', { action: '撤销', fn: async () => { for (const x of old) await post('/api/mark', { key: x.key, status: 'open' }); await load(); toast('撤销了'); } });
    }
    else if (!c) return;
    else if (act === 'done') await markAndNext('done', {}, '标成已处理');
    else if (act === 'reopen') { await post('/api/mark', { key: c.key, status: 'open' }); await load(); }
    else if (act === 'convMenu') {
      popMenu(a, `<button data-act="mine">${ico('hand')}${c.mine ? '交回给盯梢自动回' : '这家我自己回'}${c.mine ? `<span class="chk">${ico('check')}</span>` : ''}</button>
        ${c.pid !== '51' ? `<button data-act="refresh">${ico('refresh')}去平台拉最新聊天</button>` : ''}
        <hr>${c.status === 'pass' ? `<button data-act="unpass">${ico('refresh')}撤销「不谈了」</button>` : `<button class="danger" data-act="pass">${ico('x')}不谈了</button>`}`);
    }
    else if (act === 'pass') await markAndNext('pass', {}, '不谈了');
    else if (act === 'unpass') { await post('/api/mark', { key: c.key, status: 'unpass' }); await load(); }
    else if (act === 'mine') { await post('/api/manual', { key: c.key, on: !c.mine }); toast(c.mine ? '交回给盯梢自动回' : '好，这家来新消息我只提醒你、不替你回'); }
    else if (act === 'recheck') { S.checks[c.company] = undefined; loadIntel(c, true); }
    else if (act === 'refresh') { await post('/api/refresh', { key: c.key }); toast('去平台上读这家的聊天，读完自动刷新'); }
    else if (act === 'snoozeMenu') popMenu(a, [['1h', '1 小时后'], ['3h', '3 小时后'], ['tonight', '今晚 8 点'], ['tomorrow', '明早 9 点'], ['monday', '下周一 9 点']].map(([k, l]) => `<button data-act="snooze" data-k="${k}">${l}</button>`).join(''));
    else if (act === 'snooze') await markAndNext('snooze', { until: snoozeAt(a.dataset.k) }, `稍后（${a.textContent}）再看`);
    else if (act === 'note') { const n = prompt('给这家写个备注（只你自己看，清空就是删掉）', c.user?.note || ''); if (n !== null) { await post('/api/note', { key: c.key, note: n }); toast(n.trim() ? '备注记下了' : '备注删了'); } }
    else if (act === 'send') doSend();
    else if (act === 'aiMenu') {
      const follow = $('[data-act="draft"]', $('#rComp'))?.dataset.mode === 'follow';
      popMenu(a, `<button data-act="draftAs" data-mode="reply">${ico('sparkles')}起草回复${!follow ? `<span class="chk">${ico('check')}</span>` : ''}</button><button data-act="draftAs" data-mode="follow">${ico('hourglass')}写一条跟进提醒${follow ? `<span class="chk">${ico('check')}</span>` : ''}</button>`, 'up left');
    }
    else if (act === 'draft') await doDraft(a.dataset.mode);
    else if (act === 'draftAs') await doDraft(a.dataset.mode);
    else if (act === 'phraseMenu') {
      const ps = phraseList();
      popMenu(a, ps.map((p, i) => `<button data-act="phrase" data-i="${i}" title="${esc(p)}"><span class="ph">${esc(p)}</span></button>`).join('') + `<hr><button data-act="editPhrases">${ico('pen')}改常用短语…</button>`, 'up left');
    }
    else if (act === 'phrase') {
      const t = $('#txt'); const p = phraseList()[+a.dataset.i];
      if (t.value.includes(p)) { toast('这句已经在回复框里了'); return; }
      t.value = t.value.trim() ? `${t.value.trimEnd()}${/[。！？!?，,]$/.test(t.value.trim()) ? '' : '，'}${p}` : p;
      S.drafts[c.key] = t.value; updCount(); autoGrow(t); t.focus();
    }
    else if (act === 'editPhrases') {
      const n = prompt('常用短语，一行一条：', phraseList().join('\n'));
      if (n !== null) { try { localStorage.setItem('hr-inbox-phrases', JSON.stringify(n.split('\n').map((s) => s.trim()).filter(Boolean))); } catch {} toast('改好了'); }
    }
    else if (act === 'variantMenu') {
      popMenu(a, variantList(c).map((v, i) => `<button data-act="${a.dataset.mode === 'card' ? 'cardAgree' : 'sendResume'}" data-card="resume" data-variant="${esc(v.id)}">${ico('file')}${esc(v.label)}版${i === 0 ? '（按岗位推荐）' : ''}</button>`).join(''), a.dataset.mode === 'send' ? 'up left' : 'left');
    }
    else if (act === 'sendResume') { const v = S.variants.find((x) => x.id === a.dataset.variant); if (!confirm(`给 ${c.company} 发「${v?.label || ''}」版附件简历？`)) return; await post('/api/resume', { key: c.key, variant: a.dataset.variant }); toast('已排队，去 BOSS 上发简历'); }
    else if (act === 'cardAgree') {
      if (a.dataset.card === 'phone' && !confirm('同意后 HR 能看到你的手机号，确定？')) return;
      if (a.dataset.card === 'resume') { const v = S.variants.find((x) => x.id === a.dataset.variant); if (!confirm(`同意 ${c.company} 要简历，发「${v?.label || '推荐'}」版？`)) return; }
      await post('/api/card', { key: c.key, action: 'agree', card: a.dataset.card, variant: a.dataset.variant }); toast('已排队，去 BOSS 上点「同意」');
    }
    else if (act === 'cardReject') { if (!confirm('确定点「拒绝」？')) return; await post('/api/card', { key: c.key, action: 'reject', card: a.dataset.card }); toast('已排队，去 BOSS 上点「拒绝」'); }
    else if (act === 'wechatAlt') { const t = $('#txt'); if (t) { t.value = PROFILE.wechatAlt ? `我的微信是 ${PROFILE.wechatAlt}，麻烦您加一下。` : ''; S.drafts[c.key] = t.value; updCount(); autoGrow(t); t.focus(); } }
    else if (act === 'useDraft') { const t = $('#txt'); if (t) { t.value = a.dataset.text; S.drafts[c.key] = t.value; updCount(); autoGrow(t); t.focus(); } }
  } catch (err) { toast(err.message, 'bad'); }
});

$('#q').addEventListener('input', (e) => { S.q = e.target.value; renderList(); });

document.addEventListener('keydown', (e) => {
  const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName);
  if (e.key === 'Escape') { if (document.querySelector('.menu-pop')) { closeMenus(); return; } document.activeElement?.blur(); $('#help').hidden = true; return; }
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && document.activeElement?.id === 'txt') { e.preventDefault(); doSend(); return; }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  // 键盘走到列表里的一家，回车 / 空格打开
  const it = document.activeElement?.closest?.('#items [data-key]');
  if (it && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); it.click(); return; }
  const k = e.key.toLowerCase();
  if (k === 'j') move(1);
  else if (k === 'k') move(-1);
  else if (k === '/') { e.preventDefault(); $('#q').focus(); }
  else if (k === 'r') { e.preventDefault(); $('#txt')?.focus(); }
  else if (k === 'e') markAndNext('done', {}, '标成已处理').catch((err) => toast(err.message, 'bad'));
  else if (k === 'm') markAndNext('snooze', { until: snoozeAt('3h') }, '3 小时后再提醒').catch((err) => toast(err.message, 'bad'));
  else if (k === '?') $('#help').hidden = false;
  else if (/^[1-5]$/.test(k) && VIEWS[+k - 1]) setView(VIEWS[+k - 1].id);
});

// toast(文字, 'ok'|'bad'|'', { action: '撤销', fn, ms })
function toast(text, kind = '', opt = {}) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<span>${esc(text)}</span>${opt.action ? `<button>${esc(opt.action)}</button>` : ''}`;
  if (opt.action) el.querySelector('button').onclick = () => { el.remove(); opt.fn?.(); };
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), opt.ms || (opt.action ? 6000 : kind === 'bad' ? 7000 : 3500));
}

// 从别的页点过来：?q=公司名 → 在「全部」里搜这家；?c=会话 key（今天页 / 投递页的「去消息」）→ 直接打开那家
let wantConv = null;
try {
  const sp = new URLSearchParams(location.search);
  const q = sp.get('q'); wantConv = sp.get('c');
  if (q && !wantConv) { S.view = 'all'; S.sub = ''; S.pf = ''; S.q = q; $('#q').value = q; }
  if (q || wantConv) history.replaceState(null, '', location.pathname + (/[?&]v2\b/.test(location.search) ? '?v2' : ''));
} catch {}
// 打开指定会话：切到它所在的视图（找不到就「全部」），清掉平台筛选和搜索，选中并滚到它
function openConv(key) {
  const c = S.model?.convs.find((x) => x.key === key);
  if (!c) { toast('收件箱里没找到这家会话（可能还没聊过，或者太久没动静）', 'bad'); return false; }
  const v = VIEWS.find((x) => x.id !== 'all' && x.f(c)) || VIEWS.find((x) => x.id === 'all');
  S.view = v.id; S.sub = ''; S.pf = ''; S.q = ''; $('#q').value = '';
  try { localStorage.setItem('hr-inbox-view', v.id); } catch {}
  S.sel = key; S.scrollSel = true; S.readerSig = '';
  render();
  return true;
}
load().then(() => {
  if (wantConv && openConv(wantConv)) return;
  if (S.view !== 'log' && !S.sel) { fixSel(); render(); }
});
connectStream();
setInterval(load, 60000);
loadHunt();
if (!V2) setInterval(loadHunt, 60000);
fetch('/api/variants').then((r) => r.json()).then((v) => { S.variants = v; }).catch(() => {});
