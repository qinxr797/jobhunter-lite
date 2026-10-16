// 今天页 v2.2.0：只放要用户动手的事。分组照 Linear Inbox（你接 → 要回 → 逾期 → 今天，空组隐藏），
// 逾期 / 今天照 Todoist Today，稍后照 Superhuman Remind Me。完成 / 稍后先从列表拿掉，5 秒后才真提交，期间能撤销。
// ?mock=1 读 mock/today.json，?mock=empty 读全清空的样子；否则读 /api/today（接口见 hr-desk\docs\api-contract.md）。
const VERSION = 'v2.2.0';
const REFRESH_MS = 30000;
const UNDO_MS = 5000;

const $ = (s, el = document) => el.querySelector(s);
// 平台网页里的私有区图标字（显示成方框）一并去掉
const esc = (s) => String(s ?? '').replace(/[-]/g, '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ico = (id) => `<svg class="i"><use href="#i-${id}"/></svg>`;
const pad = (n) => String(n).padStart(2, '0');
const localIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
const WEEK = '日一二三四五六';

const PLAT = {
  BOSS: { short: 'B', cls: 'p-boss' }, 智联: { short: '智', cls: 'p-zl' }, '51job': { short: '51', cls: 'p-51' }, 前程无忧: { short: '51', cls: 'p-51' },
  猎聘: { short: '猎', cls: 'p-lp' }, 网申: { short: '申', cls: 'p-campus' },
};

const IN_SHELL = Number(window.hrdesk?.shell) >= 2;
// 盯梢平台 id → 外壳「更多」里的平台标签（/?go=xx，主进程切标签）
const GO = { boss: 'boss', zl: 'zl', 51: '51', lp: 'lp', qcc: 'qcc' };
const qs = new URLSearchParams(location.search);
const MOCK = qs.get('mock');
const S = {
  data: null,        // 最近一次 /api/today
  err: '',
  sel: null,         // 选中的 task id
  pending: new Map(), // id → { task, status, until, label, timer }，5 秒撤销窗口里的
  gone: new Map(),    // id → 提交时间；后台还没来得及去掉的先藏着
  undoStack: [],      // 按 Z 撤销最近一下
  pop: null,
};

// ---------- 取数 ----------
async function load() {
  try {
    const url = MOCK ? `mock/${MOCK === 'empty' ? 'today-empty' : 'today'}.json` : '/api/today';
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status === 404 ? '收件箱后台还是旧版，没有「今天」的数据' : '收件箱后台出了点问题，没取到今天的事');
    S.data = await r.json();
    S.err = '';
  } catch (e) {
    S.err = /Failed to fetch|NetworkError/.test(e.message) ? '连不上收件箱后台，它可能还没起来' : /JSON/.test(e.message) ? '收件箱后台给的数据看不懂' : e.message;
  }
  // 后台已经不再返回的，就不用继续藏了
  const live = new Set(allTasks().map((t) => t.id));
  for (const id of S.gone.keys()) if (!live.has(id) || (!MOCK && Date.now() - S.gone.get(id) > 120000)) S.gone.delete(id);
  render();
}

async function post(path, body) {
  if (MOCK) { (window.__posts ||= []).push({ path, body }); return { ok: true }; } // 演示数据不碰后台
  let r;
  try { r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), keepalive: true }); }
  catch { throw new Error('连不上收件箱后台，这一下没记上'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.err || `后台没记上（${r.status}）`);
  return j;
}

const allTasks = () => (S.data?.groups || []).flatMap((g) => g.items || []);
const hidden = (id) => S.pending.has(id) || S.gone.has(id);
function visibleGroups() {
  return (S.data?.groups || [])
    .map((g) => ({ ...g, items: (g.items || []).filter((t) => !hidden(t.id)) }))
    .filter((g) => g.items.length);
}
const flat = () => visibleGroups().flatMap((g) => g.items);

// ---------- 文案 ----------
function dayDiff(a, b) { // b - a，按天
  const d = (s) => new Date(`${s.slice(0, 10)}T00:00:00`);
  return Math.round((d(b) - d(a)) / 86400000);
}
function dueText(t, today) {
  if (!t.due) return { text: '', cls: '' };
  const n = Number.isFinite(t.overdueDays) && t.overdueDays > 0 ? t.overdueDays : dayDiff(t.due, today);
  const hm = t.due.length > 10 ? ` ${t.due.slice(11, 16)}` : '';
  if (t.overdue || n > 0) return { text: n > 0 ? `逾期 ${n} 天` : `过点了${hm}`, cls: 'over' };
  if (n === 0) return { text: hm ? `今天${hm}` : '', cls: 'today' };
  if (n === -1) return { text: `明天${hm}`, cls: '' };
  return { text: `${+t.due.slice(5, 7)}/${+t.due.slice(8, 10)}${hm}`, cls: '' };
}
function dateText(s) {
  const d = new Date(`${s}T00:00:00`);
  return `${d.getMonth() + 1}月${d.getDate()}日 周${WEEK[d.getDay()]}`;
}
function reportText(r, short) {
  if (!r) return '';
  const who = [r.byMe ? `你 ${r.byMe}` : '', r.byClaude ? `助手 ${r.byClaude}` : ''].filter(Boolean).join(' · ');
  const parts = [`投 <b>${r.applied ?? 0}</b>${who ? `（${who}）` : ''}`, `HR 新消息 <b>${r.hrNew ?? 0}</b>`];
  if (!short || r.autoReplied) parts.push(`自动回 ${r.autoReplied ?? 0}`);
  if (!short || r.pushed) parts.push(`推给你 ${r.pushed ?? 0}`);
  return `今日：${parts.join(' · ')}`;
}
const actIcon = (t) => /^https?:/.test(t.action?.href || '') ? 'ext' : t.convKey || /^\/\?c=/.test(t.action?.href || '') ? 'msg' : 'arrow';

// ---------- 渲染（按 id 局部更新，不整页重画，滚动和选中都不跳） ----------
function taskHtml(t, today) {
  const p = PLAT[t.platform];
  const plat = p ? `<span class="plat-ico ${p.cls}" title="${esc(t.platform)}">${p.short}</span>` : `<span class="plat-ico p-none">${ico('list')}</span>`;
  const due = dueText(t, today);
  const a = t.action || {};
  return `${plat}
    <div class="main"><div class="ttl">${esc(t.title)}${t.jobTitle ? `<span class="job">${esc(t.jobTitle)}</span>` : ''}</div>${t.detail ? `<div class="det" title="${esc(t.detail)}">${esc(t.detail)}</div>` : ''}</div>
    <span class="due ${due.cls}">${esc(due.text)}</span>
    <div class="acts">
      ${a.href ? `<button class="btn go" data-act="go" title="Enter">${ico(actIcon(t))}${esc(a.label || '去看')}</button>` : ''}
      <button class="btn ghost" data-act="done" title="完成（E）：从今天的清单拿掉，不会给 HR 发任何东西">${ico('check')}<span class="lbl">完成</span><kbd>E</kbd></button>
      <button class="btn ghost" data-act="snooze" title="稍后（M）：到点再放回来">${ico('clock')}<span class="lbl">稍后</span><kbd>M</kbd></button>
    </div>`;
}

function render() {
  const d = S.data;
  const today = d?.date || localIso(new Date()).slice(0, 10);
  const groups = visibleGroups();
  const items = groups.flatMap((g) => g.items);
  if (S.sel != null && !items.some((t) => t.id === S.sel)) S.sel = null;
  if (S.sel == null && items.length) S.sel = items[0].id;

  $('#date').textContent = `${dateText(today)}${items.length ? ` · 还剩 ${items.length} 件` : ''}`;
  document.title = items.length ? `今天（${items.length}）` : '今天';
  // HR Desk 新外壳（shell >= 2）顶栏已经常驻盯梢状态，这里不再重复；普通浏览器里照旧显示
  if (IN_SHELL) $('#watch').hidden = true; else renderWatch(d?.watch);

  const box = $('#groups');
  if (!d && S.err) {
    box.innerHTML = `<div class="load-err"><b>${esc(S.err)}</b>页面每 30 秒自己再试一次；一直这样就重开桌面助手。<div style="margin-top:12px"><button class="btn" data-act="retry">现在再试</button></div></div>`;
    $('#report').innerHTML = '';
    return;
  }
  if (!d) return;
  if (!items.length) {
    // 盯梢停着时不能说「都办完了」：只是新消息进不来
    const w = d.watch || {};
    const blind = w.alive === false ? '盯梢没在跑，新的 HR 消息进不来。到顶栏右边的盯梢状态那里把它打开。'
      : w.paused ? '盯梢暂停中，新的 HR 消息进不来。到顶栏右边的盯梢状态那里点「恢复」。' : '';
    box.innerHTML = `<div class="done-all">${blind
      ? `<div class="badge warn">${ico('clock')}</div><h2>眼下没有要你动手的事</h2><p class="blind">${esc(blind)}</p>`
      : `<div class="badge">${ico('check')}</div><h2>今天的事都办完了</h2>${d.report?.tasksDone ? `<p class="win">今天处理了 ${d.report.tasksDone} 件</p>` : ''}`}
      <p>${reportText(d.report, true)}</p>
      <div class="next"><a class="btn" href="/hunt">${ico('arrow')}去找新岗位</a><a class="btn ghost" href="/apps">看投递进度</a></div></div>`;
    $('#report').innerHTML = '';
    return;
  }
  box.querySelector('.done-all, .load-err')?.remove();

  // 分组：有就更新，没有就建，顺序照后台给的
  const seenG = new Set();
  let prevG = null;
  for (const g of groups) {
    seenG.add(g.id);
    let sec = box.querySelector(`.grp[data-g="${CSS.escape(g.id)}"]`);
    if (!sec) {
      sec = document.createElement('section');
      sec.className = 'grp';
      sec.dataset.g = g.id;
      sec.innerHTML = `<div class="grp-head"><span class="mark"></span><span class="nm"></span><span class="n"></span></div><div class="rows" role="list"></div>`;
    }
    $('.nm', sec).textContent = g.name;
    $('.n', sec).textContent = g.items.length;
    const want = prevG ? prevG.nextSibling : box.firstChild;
    if (want !== sec) box.insertBefore(sec, want);
    prevG = sec;

    const rows = $('.rows', sec);
    const seenT = new Set();
    let prevT = null;
    for (const t of g.items) {
      const key = String(t.id);
      seenT.add(key);
      const isSel = t.id === S.sel;
      const sig = JSON.stringify([t, today]); // 选中与否只动 class，不重建行（不然稍后菜单的锚点会丢）
      let row = rows.querySelector(`:scope > .task[data-id="${CSS.escape(key)}"]`) || box.querySelector(`.task[data-id="${CSS.escape(key)}"]`);
      if (!row) {
        row = document.createElement('div');
        row.className = 'task';
        row.dataset.id = key;
        row.setAttribute('role', 'listitem');
      }
      if (row.dataset.sig !== sig) {
        row.innerHTML = taskHtml(t, today);
        row.dataset.sig = sig;
      }
      row.classList.toggle('sel', isSel);
      row.setAttribute('aria-current', isSel ? 'true' : 'false');
      for (const b of row.querySelectorAll('button')) b.tabIndex = isSel ? 0 : -1; // Tab 只走选中那一行，换行用 J/K
      const wantT = prevT ? prevT.nextSibling : rows.firstChild;
      if (wantT !== row) rows.insertBefore(row, wantT);
      prevT = row;
    }
    for (const row of [...rows.children]) if (!seenT.has(row.dataset.id)) row.remove();
  }
  for (const sec of [...box.querySelectorAll('.grp')]) if (!seenG.has(sec.dataset.g)) sec.remove();

  $('#report').innerHTML = `<span>${reportText(d.report)}</span>
    <span class="keys"><kbd>J</kbd><kbd>K</kbd> 上下 · <kbd>Enter</kbd> 去做 · <kbd>E</kbd> 完成 · <kbd>M</kbd> 稍后
    <button class="btn ghost" data-act="help" title="全部快捷键">${ico('help')}</button><span class="ver">${VERSION}</span></span>`;
}

function renderWatch(w) {
  const el = $('#watch');
  if (!w) { el.innerHTML = S.err ? `<span class="dot bad"></span><b>${esc(S.err)}</b>` : ''; return; }
  const state = !w.alive ? ['bad', '盯梢没在跑'] : w.paused ? ['warn', '盯梢暂停中'] : ['on', '盯梢运行中'];
  const pf = (w.platforms || []).map((p) => {
    const cls = !p.ok ? 'bad' : p.live ? 'live' : '';
    const note = p.note || (p.live ? '实时' : '定时');
    // 坏了先用后台给的人话修法（fix），没有就给通用说法
    const fix = p.fix || `到顶栏「更多 › ${p.name}」里重新登录（扫码）就好`;
    const tip = p.ok ? `${p.name}：${note}${p.at ? `（${p.at} 看过）` : ''}` : `${p.name}${note}，这个平台的新消息暂时进不来。${fix}`;
    const go = GO[p.id] ? `<a class="fix" href="/?go=${GO[p.id]}">去登录</a>` : '';
    return `<span class="pf ${cls}" title="${esc(tip)}">${esc(p.name)} ${esc(note)}${p.ok ? '' : `${p.fix ? ` · ${esc(p.fix)}` : ''}${go ? ` · ${go}` : ''}`}</span>`;
  });
  const next = w.alive && !w.paused && w.next ? `下一轮 ${esc(w.next)}` : '';
  const stTip = [w.doing ? `正在${w.doing}` : '', w.lastDone ? `上一轮 ${w.lastDone} 跑完` : ''].filter(Boolean).join('，');
  el.innerHTML = [`<span class="dot ${state[0]}"></span><b title="${esc(stTip)}">${state[1]}</b>`, ...pf, next, w.fix ? `<span class="pf bad">${esc(w.fix)}</span>` : ''].filter(Boolean).join('<span class="sep">·</span>');
}

// ---------- 选中 / 键盘 ----------
function select(id, scroll = true) {
  S.sel = id;
  render();
  if (scroll) $(`.task[data-id="${CSS.escape(String(id))}"]`)?.scrollIntoView({ block: 'nearest' });
}
function move(step) {
  const list = flat();
  if (!list.length) return;
  const i = list.findIndex((t) => t.id === S.sel);
  const n = i < 0 ? 0 : Math.max(0, Math.min(list.length - 1, i + step));
  select(list[n].id);
}
const selTask = () => flat().find((t) => t.id === S.sel);

function go(t) {
  const href = t?.action?.href;
  if (!href) return;
  if (/^https?:/.test(href)) window.open(href, '_blank', 'noopener');
  else location.href = href; // /?c=convKey 由 HR Desk 外壳切到消息标签
}

// ---------- 完成 / 稍后（5 秒撤销） ----------
function nextAfter(id) {
  const list = flat();
  const i = list.findIndex((t) => t.id === id);
  return list[i + 1]?.id ?? list[i - 1]?.id ?? null;
}
function act(t, status, until, label) {
  if (!t || S.pending.has(t.id)) return;
  closePop();
  const wasSel = S.sel === t.id;
  const nxt = nextAfter(t.id);
  const job = { task: t, status, until, label };
  job.timer = setTimeout(() => commit(t.id), UNDO_MS);
  S.pending.set(t.id, job);
  S.undoStack.push(t.id);
  if (wasSel) S.sel = nxt;
  render();
  toast(`${label}：${t.title}`, '', { action: '撤销', ms: UNDO_MS, fn: () => undo(t.id) }).dataset.id = t.id;
}
async function commit(id) {
  const job = S.pending.get(id);
  if (!job) return;
  S.pending.delete(id);
  S.undoStack = S.undoStack.filter((x) => x !== id);
  S.gone.set(id, Date.now());
  try {
    await post('/api/task', { id, status: job.status, ...(job.until ? { until: job.until } : {}) });
  } catch (e) {
    S.gone.delete(id);
    render();
    toast(`「${job.task.title}」${e.message}，已放回列表`, 'bad');
  }
}
function undo(id) {
  const job = S.pending.get(id);
  if (!job) return;
  clearTimeout(job.timer);
  S.pending.delete(id);
  S.undoStack = S.undoStack.filter((x) => x !== id);
  document.querySelector(`.toast[data-id="${CSS.escape(String(id))}"]`)?.remove();
  select(id);
  toast('撤销了，放回原处');
}
// 关页面 / 切走前把等着的提交掉，别丢
function flushAll() { for (const id of [...S.pending.keys()]) { clearTimeout(S.pending.get(id).timer); commit(id); } }
addEventListener('pagehide', flushAll);

// 稍后的三个时间点
function snoozeOpts() {
  const now = new Date();
  const fmt = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const h1 = new Date(now.getTime() + 3600000);
  // 号码固定：1 一小时、2 今晚、3 明早；太晚了「今晚」变灰，但号码不挪
  const tonight = new Date(now); tonight.setSeconds(0, 0);
  const th = now.getHours() < 19 ? 20 : now.getHours() < 22 ? 23 : null;
  if (th) tonight.setHours(th, 0);
  const morning = new Date(now); morning.setDate(now.getDate() + 1); morning.setHours(9, 0, 0, 0);
  return [
    { key: '1', name: '1 小时后', at: h1, hint: fmt(h1) },
    th ? { key: '2', name: '今晚', at: tonight, hint: `${th}:00` } : { key: '2', name: '今晚', off: true, hint: '已经很晚了' },
    { key: '3', name: '明早', at: morning, hint: `${morning.getMonth() + 1}/${morning.getDate()} 09:00` },
  ];
}
function openSnooze(t, anchor) {
  closePop();
  if (!t) return;
  const opts = snoozeOpts();
  const pop = document.createElement('div');
  pop.className = 'pop';
  pop.setAttribute('role', 'menu');
  pop.innerHTML = opts.map((o) => `<button role="menuitem" data-k="${o.key}" ${o.off ? 'disabled' : ''}><kbd>${o.key}</kbd>${o.name}<em>${o.hint}</em></button>`).join('');
  document.body.appendChild(pop);
  // 锚点每次现查：传进来的按钮可能已经被刷新换掉
  const btn = $(`.task[data-id="${CSS.escape(String(t.id))}"] [data-act="snooze"]`) || (anchor?.isConnected ? anchor : null);
  btn?.scrollIntoView({ block: 'nearest' });
  const r = btn?.getBoundingClientRect();
  if (r) {
    const w = pop.offsetWidth, h = pop.offsetHeight;
    pop.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.right - w))}px`;
    pop.style.top = `${r.bottom + 4 + h > innerHeight - 8 ? r.top - h - 4 : r.bottom + 4}px`;
  }
  const pick = (k) => {
    const o = opts.find((x) => x.key === k && !x.off);
    if (o) act(t, 'snooze', localIso(o.at), `${o.name}（${o.hint}）再提醒`);
  };
  pop.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) pick(b.dataset.k); });
  S.pop = { el: pop, pick, id: t.id };
  pop.querySelector('button:not([disabled])')?.focus();
}
function closePop() { S.pop?.el.remove(); S.pop = null; }

// ---------- 事件 ----------
document.addEventListener('click', (e) => {
  if (S.pop && !e.target.closest('.pop') && !e.target.closest('[data-act="snooze"]')) closePop();
  const b = e.target.closest('[data-act]');
  const row = e.target.closest('.task');
  const t = row && allTasks().find((x) => String(x.id) === row.dataset.id);
  if (row && t && t.id !== S.sel) select(t.id, false);
  if (!b) return;
  const a = b.dataset.act;
  if (a === 'go') go(t);
  else if (a === 'done') act(t, 'done', null, '完成了');
  else if (a === 'snooze') { if (S.pop?.id === t?.id) closePop(); else openSnooze(t, b); }
  else if (a === 'help') $('#help').hidden = false;
  else if (a === 'closeHelp') $('#help').hidden = true;
  else if (a === 'retry') load();
});

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.('input, textarea, [contenteditable]')) return;
  const k = e.key.toLowerCase();
  if (k === 'escape') { closePop(); $('#help').hidden = true; return; }
  if (S.pop) {
    if (/^[1-3]$/.test(k)) { e.preventDefault(); S.pop.pick(k); return; }
    if (k === 'm') { e.preventDefault(); closePop(); return; }
    if (k === 'enter' || k === ' ') return; // 让焦点所在的菜单项自己响应
  }
  if (!$('#help').hidden && k !== '?') return;
  if (k === 'j' || k === 'arrowdown') { e.preventDefault(); move(1); }
  else if (k === 'k' || k === 'arrowup') { e.preventDefault(); move(-1); }
  else if (k === 'enter') { if (e.target.closest?.('button')) return; e.preventDefault(); go(selTask()); }
  else if (k === 'e') { e.preventDefault(); act(selTask(), 'done', null, '完成了'); }
  else if (k === 'm') { e.preventDefault(); openSnooze(selTask()); }
  else if (k === 'z') { const id = S.undoStack.at(-1); if (id != null) { e.preventDefault(); undo(id); } }
  else if (k === '?') $('#help').hidden = !$('#help').hidden;
});

// toast(文字, ''|'bad', { action: '撤销', fn, ms })，带撤销的底部有倒计时细条
function toast(text, kind = '', opt = {}) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  const ms = opt.ms || (opt.action ? 6000 : kind === 'bad' ? 7000 : 3000);
  el.innerHTML = `<span>${esc(text)}</span>${opt.action ? `<button>${esc(opt.action)}<kbd style="margin-left:6px;background:transparent;color:inherit;border-color:currentColor;opacity:.6">Z</kbd></button><i class="bar" style="animation:drain ${ms}ms linear forwards"></i>` : ''}`;
  if (opt.action) el.querySelector('button').onclick = () => { el.remove(); opt.fn?.(); };
  const box = $('#toasts');
  while (box.children.length >= 3) box.firstChild.remove();
  box.appendChild(el);
  setTimeout(() => el.remove(), ms);
  return el;
}

// ---------- 启动：每 30 秒拉一次，窗口切回来也拉 ----------
load();
setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
