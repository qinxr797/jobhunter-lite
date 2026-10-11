import { getConfig, setConfig, getRuntime, setRuntime, setupMissing } from '../lib/store.js';
import { cityCodes } from '../lib/cities.js';
import { run, requestStop, isRunning, runningPlatforms, isSending, approve, unapprove, dropQueued, resetStale, PLATFORM_NAMES } from '../lib/orchestrator.js';
import { tailorResume } from '../lib/llm.js';
import { initCampus } from './campus-ui.js';
import { initAutofill } from './autofill-ui.js';
import { initCompany, openCompany } from './company-ui.js';
import { initArchive } from './archive-ui.js';
import { initToday, getDaily } from './today-ui.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// 你在开场白框里改到一半的字。列表重画（筛选跑着时会不停进新条目）也不能把它冲掉
const drafts = new Map(); // jobId -> text
let lastQueueJson = '';

// 列表排序：正在发的、排队的、没发成的放最上面；待审核里「投」在「等你定」前面，再按优先级、匹配分
const STATE_ORDER = { 发送中: 0, 排队: 1, 失败: 2, 待审核: 3 };
const VERDICT_ORDER = { 投: 0, 等你定: 1 };
const PRIORITY_ORDER = { 首选: 0, 对口: 1, 能干: 2, 不相关: 3 };
// 同一结论里大单位排前面，再看方向
const TIER_ORDER = { 大单位: 0, 中型: 1, 看不出: 2, 小公司: 3 };

function sorted(queue) {
  return [...queue].sort((a, b) =>
    (STATE_ORDER[a.status || '待审核'] ?? 9) - (STATE_ORDER[b.status || '待审核'] ?? 9)
    || (VERDICT_ORDER[a.verdict] ?? 9) - (VERDICT_ORDER[b.verdict] ?? 9)
    || (TIER_ORDER[a.company_tier] ?? 2) - (TIER_ORDER[b.company_tier] ?? 2)
    || (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9)
    || (b.match_score || 0) - (a.match_score || 0));
}

// ---------------------------------------------------------------- 渲染

async function render(force = true) {
  const [config, rt] = await Promise.all([getConfig(), getRuntime()]);

  const used = rt.stats.sent;
  const cap = config.pace.dailyLimit;
  $('quota-fill').style.transform = `scaleX(${Math.min(1, used / cap)})`;
  $('quota-text').textContent = `BOSS 今日 ${used} / ${cap}`;

  const queue = rt.queue || [];
  const nq = queue.filter((q) => (q.status || '待审核') === '待审核').length;
  $('badge-queue').textContent = String(nq);
  $('badge-queue').toggleAttribute('data-zero', !nq);
  // 顶栏状态：在筛 / 在发
  const pill = $('run-pill');
  const ptxt = isRunning() ? `筛选中：${runningPlatforms().map((x) => PLATFORM_NAMES[x] || x).join('、')}` : isSending() ? '正在一家家发' : '';
  pill.hidden = !ptxt; pill.textContent = ptxt;

  // 只有列表真变了才重画，免得日志一刷新，正在打字的开场白框就丢焦点
  const qj = JSON.stringify(queue);
  if (force || qj !== lastQueueJson) {
    lastQueueJson = qj;
    renderQueue(queue, config);
  }
  renderDone(rt.done || []);
  renderLog(rt.logs || []);

  const busy = isRunning();
  // 不同平台可以同时筛（51job 随时能开；BOSS 和智联要轮流），冲突时 run() 会说清楚，所以按钮不再置灰
  $('btn-run').disabled = false;
  $('btn-run').textContent = busy ? `开始筛选（正在筛：${runningPlatforms().map((p) => PLATFORM_NAMES[p] || p).join('、')}）` : '开始筛选';
  $('btn-stop').disabled = !busy && !isSending();
  // 发送器停了，「已排队」这类提示就过时了
  if (!isSending() && /^已排队/.test($('status').textContent)) status('');
  if (isSending() && !busy && /^(已排队|)$/.test($('status').textContent)) status('正在发你按了「投」的岗位，每家之间隔一会儿…');
  if (!isSending() && /^正在发你按了/.test($('status').textContent)) status('发完了，结果看「已投」和列表里标红的');
}

function renderQueue(queue, config) {
  const box = $('queue-list');
  // 重画前记下正在编辑哪个框、光标在哪、滚到哪，画完还原
  const active = document.activeElement?.matches?.('textarea[data-g]') ? document.activeElement : null;
  const focus = active ? { id: active.dataset.g, a: active.selectionStart, b: active.selectionEnd } : null;
  const scroll = document.querySelector('main')?.scrollTop || 0;
  renderQueueInner(queue, config, box);
  if (document.querySelector('main')) document.querySelector('main').scrollTop = scroll;
  if (focus) {
    const ta = box.querySelector(`textarea[data-g="${CSS.escape(focus.id)}"]`);
    if (ta && !ta.disabled) { ta.focus(); ta.setSelectionRange(focus.a, focus.b); }
  }
}

// 列表界面状态（v1.0.0）：展开了哪几条、勾了哪几条、按什么筛。都是界面上的小偏好，不进 storage
const opened = new Set();
const picked = new Set();
let qFilter = { plat: 'all', verdict: 'all' };

const ICON = {
  chev: '<svg class="i" viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>',
  ext: '<svg class="i" viewBox="0 0 24 24"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>',
  warn: '<svg class="i" viewBox="0 0 24 24"><path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
};

function renderQueueInner(queue, config, box) {
  if (!queue.length) {
    box.innerHTML = '<p class="empty">列表是空的。<br>去「今天」点「开始」，插件会自己把 BOSS / 51job / 智联筛一遍，筛出来的排在这里等你审。</p>';
    return;
  }
  const pending = (q) => (q.status || '待审核') === '待审核';
  const n = (f) => queue.filter(f).length;
  const cnt = {
    go: n((q) => q.verdict === '投' && pending(q)), ask: n((q) => q.verdict === '等你定' && pending(q)),
    sending: n((q) => q.status === '排队' || q.status === '发送中'), failed: n((q) => q.status === '失败'),
  };
  for (const id of [...picked]) if (!queue.some((q) => q.job.jobId === id && pending(q))) picked.delete(id);

  const shown = sorted(queue).filter((q) => (qFilter.plat === 'all' || (q.job.platform || 'boss') === qFilter.plat)
    && (qFilter.verdict === 'all' || (qFilter.verdict === 'go' ? q.verdict === '投' : qFilter.verdict === 'ask' ? q.verdict === '等你定' : !pending(q))));
  const chip = (k, v, label) => `<button class="${qFilter[k] === v ? 'on' : ''}" data-qf="${k}:${v}">${label}</button>`;
  const plats = ['boss', '51job', 'zhilian'].filter((p) => queue.some((q) => (q.job.platform || 'boss') === p));

  box.innerHTML = `
    <div class="qbar">
      <div class="chips">
        ${chip('verdict', 'all', `全部 ${queue.length}`)}${chip('verdict', 'go', `建议投 ${cnt.go}`)}${chip('verdict', 'ask', `等你定 ${cnt.ask}`)}${cnt.sending + cnt.failed ? chip('verdict', 'busy', `发送中 / 失败 ${cnt.sending + cnt.failed}`) : ''}
        ${plats.length > 1 ? `<span class="hint" style="margin:0 2px">｜</span>${chip('plat', 'all', '全部平台')}${plats.map((p) => chip('plat', p, PLATFORM_NAMES[p])).join('')}` : ''}
      </div>
      <div class="row" style="width:100%">
        <button class="primary" data-act="approve-picked" data-id="*" ${picked.size ? '' : 'disabled'}>投选中的 ${picked.size || ''}</button>
        ${cnt.go > 1 ? `<button data-act="pick-go" data-id="*">勾上全部建议投</button>` : ''}
        ${picked.size ? `<button class="ghost" data-act="pick-none" data-id="*">清空勾选</button>` : ''}
        <span class="sel">点一行展开看理由和开场白</span>
      </div>
    </div>` + (shown.length ? shown.map((it) => row(it, config)).join('') : '<p class="empty">这个筛选下没有。</p>');

  box.querySelectorAll('textarea[data-g]').forEach((ta) => {
    ta.addEventListener('input', () => {
      drafts.set(ta.dataset.g, ta.value);
      const cc = box.querySelector(`[data-cc="${CSS.escape(ta.dataset.g)}"]`);
      if (cc) cc.textContent = String(ta.value.length);
    });
  });
}

function row(it, config) {
  const j = it.job;
  const id = esc(j.jobId);
  const st = it.status || '待审核';
  const cls = { 排队: 'is-queued', 发送中: 'is-sending', 失败: 'is-failed' }[st] || '';
  const greeting = drafts.has(j.jobId) ? drafts.get(j.jobId) : it.greeting;
  const locked = st === '排队' || st === '发送中';
  const plat = j.platform || 'boss';
  const isBoss = plat === 'boss';
  const canPick = st === '待审核' && !it.greetedDefault;
  const stateText = { 排队: '已按投，排队中', 发送中: '正在发…', 失败: '没投成' }[st] || '';
  const firstFlag = (it.red_flags || [])[0];
  const buttons = locked
    ? (st === '排队' ? `<button data-act="unapprove" data-id="${id}">撤回</button>` : '')
    : `<button class="primary" data-act="approve" data-id="${id}" ${it.greetedDefault ? 'disabled' : ''}>${st === '失败' ? '再投一次' : '投'}</button>
       <button data-act="drop" data-id="${id}">不投</button>
       <button class="ghost" data-act="blacklist" data-id="${id}" title="以后这家公司的岗位都不再看">拉黑公司</button>`;
  return `<div class="job ${cls} ${opened.has(j.jobId) ? 'open' : ''} ${picked.has(j.jobId) ? 'sel' : ''}" data-row="${id}">
    <div class="jrow" data-toggle="${id}">
      <span class="ck">${canPick ? `<input type="checkbox" data-pick="${id}" ${picked.has(j.jobId) ? 'checked' : ''} title="勾上，一起投">` : ''}</span>
      <div>
        <div class="t">${platTag(plat, j.invite)}${tierTag(it.company_tier, it.tier_why)}${verdictTag(it.verdict)}${jargonTag(jargonOf(j))}${esc(j.title)}</div>
        <div class="m">${esc(j.company)} · ${esc(j.salary || '薪资没读到')}${j.city ? ' · ' + esc(String(j.city).split('·')[0]) : ''}${j.hrActive ? ' · ' + esc(j.hrActive) : ''}${stateText ? ` · <b class="state ${st === '失败' ? 'failed' : 'queued'}">${stateText}</b>` : ''}</div>
        ${!opened.has(j.jobId) && (it.reasons || [])[0] ? `<div class="one-line">${esc(it.reasons[0].slice(0, 90))}${firstFlag ? ` <span class="flags">${ICON.warn} ${esc(firstFlag.slice(0, 40))}</span>` : ''}</div>` : ''}
      </div>
      <div class="s ${(it.match_score || 0) >= 75 ? 'hi' : (it.match_score || 0) >= 55 ? 'mid' : ''}">${it.match_score ?? ''}<small>匹配分</small></div>
    </div>
    <div class="jbody">
      ${it.error ? `<div class="state-note">${esc(it.error)}</div>` : ''}
      ${it.greetedDefault ? (isBoss ? '<div class="warn-box">BOSS 默认招呼语已经发出去了，自定义开场白没发成 —— 去 BOSS 聊天页手动补，补完按「不投」把它从列表拿掉</div>' : '<div class="warn-box">投递按钮已经点了，但后面的弹窗没认出来 —— 去「看岗位」确认投上没有，投上了按「不投」把它从列表拿掉</div>') : ''}
      ${it.company_check ? `<div class="company-check"><b>公司</b>　${esc(it.company_check)}</div>` : ''}
      <ul class="reasons">${(it.reasons || []).map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
      ${(it.red_flags || []).length ? `<div class="flags">${ICON.warn} ${(it.red_flags).map(esc).join('；')}</div>` : ''}
      ${jargonBlock(jargonOf(j))}
      ${it.variant_id ? `<div class="variant">${isBoss ? 'HR 要简历时发' : '投递用附件'}：${esc(variantLabel(config, it.variant_id))}</div>` : ''}
      ${isBoss ? `<textarea data-g="${id}" ${locked ? 'disabled' : ''}>${esc(greeting)}</textarea>
      <div class="charcount"><span data-cc="${id}">${(greeting || '').length}</span> / ${config.greeting.maxChars} 字</div>` : '<div class="state-note">这个平台直接投简历，不发开场白</div>'}
      <div class="row">
        ${buttons}
        <button data-act="open" data-id="${id}">看岗位 ${ICON.ext}</button>
        <button data-act="tailor" data-id="${id}">定制简历</button>
        <button data-act="company" data-id="${id}">查公司</button>
      </div>
    </div>
  </div>`;
}

// 黑话翻译官：按 JD 原文逐条对词典，给每家一个判决和几句人话（纯本地，不花模型的钱）
const jargonCache = new Map(); // jobId -> { key, R }
function jargonOf(j) {
  const JDD = globalThis.JDD;
  if (!JDD || !j.jd) return null;
  const text = `${j.jd}
${j.welfare || ''}
薪资：${j.salary || ''}`;
  const key = text.length + text.slice(0, 60);
  const hit = jargonCache.get(j.jobId);
  if (hit && hit.key === key) return hit.R;
  const R = JDD.analyze(text, JDD.PRESET);
  jargonCache.set(j.jobId, { key, R });
  return R;
}

function jargonTag(R) {
  if (!R) return '';
  const name = globalThis.JDD.LEVELS[R.level].name;
  const tip = R.vetos.length ? '一票否决：' + R.vetos.map((v) => v.k).join('、') : `坑度 ${R.score} / 100`;
  return `<span class="jg jg-${R.level}" title="JD 黑话翻译 · ${esc(tip)}">黑话·${esc(name)}</span>`;
}

function jargonBlock(R) {
  if (!R) return '';
  const bad = R.items.filter((x) => x.w > 0);
  const good = R.items.filter((x) => x.w < 0);
  const line = (x) => `<li><b>${esc(x.quote)}</b>${x.n > 1 ? `×${x.n}` : ''}　${esc(x.say)}</li>`;
  return `<details class="jargon jg-box-${R.level}" ${R.vetos.length ? 'open' : ''}>
    <summary>JD 黑话翻译 · <b>${esc(globalThis.JDD.LEVELS[R.level].name)}</b> · 坑度 ${R.score}${bad.length ? ` · 坑 ${bad.length}` : ''}${good.length ? ` · 好信号 ${good.length}` : ''}</summary>
    ${R.vetos.length ? `<div class="jg-veto">一票否决：${R.vetos.map((v) => esc(v.k)).join('、')}</div>` : ''}
    ${bad.length ? `<ul>${bad.slice(0, 6).map(line).join('')}</ul>` : '<div class="hint">没翻出黑话。</div>'}
    ${good.length ? `<div class="jg-good">好信号：${good.map((x) => esc(x.quote)).join('、')}</div>` : ''}
  </details>`;
}

function tierTag(tier, why) {
  if (!tier || tier === '看不出') return '';
  const cls = { 大单位: 'tier-big', 中型: 'tier-mid', 小公司: 'tier-small' }[tier] || '';
  return `<span class="tier ${cls}" title="${esc(why || '')}">${esc(tier)}</span>`;
}

function platTag(plat, invite) {
  const name = PLATFORM_NAMES[plat] || plat;
  return `<span class="plat plat-${esc(plat)}">${esc(name)}${invite ? '·HR邀请' : ''}</span>`;
}

function verdictTag(v) {
  if (!v) return '';
  const cls = v === '投' ? 'go' : v === '不投' ? 'no' : 'ask';
  const text = v === '投' ? '建议投' : v;
  return `<span class="verdict ${cls}">${esc(text)}</span>`;
}

function variantLabel(config, id) {
  const v = (config.variants || []).find((x) => x.id === id);
  return v ? `${v.label}${v.note ? '（' + v.note + '）' : ''}` : id;
}

function renderDone(done) {
  const box = $('done-list');
  const real = done.filter((d) => !d.dryRun);
  if (!real.length) { box.innerHTML = '<p class="empty">今天还没投过。</p>'; return; }
  box.innerHTML = real.map((d) => `<div class="job">
    <span class="score hi">${d.score ?? ''}</span>
    <h4>${platTag(d.platform || 'boss')}${esc(d.title)}</h4>
    <div class="meta">${esc(d.company)} ｜ ${esc(d.salary)}${d.chatSalary ? `（聊天页 ${esc(d.chatSalary)}）` : ''} ｜ ${d.priority ? esc(d.priority) + ' ｜ ' : ''}${new Date(d.at).toLocaleTimeString('zh-CN')}</div>
    ${d.variantId ? `<div class="variant">${(d.platform || 'boss') === 'boss' ? 'HR 要简历时发' : '投递用附件'}：${esc(d.variantId)}</div>` : ''}
    ${d.greeting ? `<div class="reasons">${esc(d.greeting)}</div>` : ''}
  </div>`).join('');
}

function renderLog(logs) {
  const box = $('panel-log');
  if (!logs.length) { box.innerHTML = '<p class="empty">还没有日志。</p>'; return; }
  box.innerHTML = logs.map((l) => `<div class="log-line ${l.level}">
    <time>${new Date(l.at).toLocaleTimeString('zh-CN')}</time><span>${esc(l.text)}</span>
  </div>`).join('');
}

function status(text, isErr = false) {
  const el = $('status');
  if (el.textContent === text) return;
  el.textContent = text;
  el.className = isErr ? 'status err' : 'status';
}

// ---------------------------------------------------------------- 事件

$('ver').textContent = `v${chrome.runtime.getManifest().version}`;
$('btn-options').onclick = () => chrome.runtime.openOptionsPage();

$('btn-run').onclick = async () => {
  status('筛选中…（只看不点）');
  const p = run({
      pages: parseInt($('pages').value, 10) || 1,
      maxJobs: parseInt($('max-jobs').value, 10) || 15,
  });
  await render();
  try {
    await p;
    status(isRunning() ? '一个平台筛完了，还有平台在筛' : '筛完了，在「待审」里审');
  } catch (e) {
    status(e.message, true);
  }
  await render();
};

const QUICK = {
  boss: (kw, cc) => `https://www.zhipin.com/web/geek/jobs?${cc.boss ? `city=${cc.boss}&` : ''}scale=304,305,306&query=${encodeURIComponent(kw)}`,
  '51type': (kw, cc) => `https://we.51job.com/pc/search?keyword=${encodeURIComponent(kw)}&searchType=2${cc.job51 ? `&jobArea=${cc.job51}` : ''}&companyType=10,04,01,02,03`,
  '51size': (kw, cc) => `https://we.51job.com/pc/search?keyword=${encodeURIComponent(kw)}&searchType=2${cc.job51 ? `&jobArea=${cc.job51}` : ''}&companySize=04,05,06,07`,
};
document.querySelectorAll('[data-qs]').forEach((btn) => {
  btn.onclick = async () => {
    const kw = $('qs-kw').value;
    if (!kw) { status('先在「今天」页的「筛什么」里填搜索关键词', true); return; }
    chrome.tabs.create({ url: QUICK[btn.dataset.qs](kw, cityCodes(await getConfig())) });
  };
});

/** 「打开大单位搜索页」的下拉跟着「今天」页的关键词走 */
async function fillQuickKeywords() {
  const kws = (await getDaily()).keywords;
  const sel = $('qs-kw');
  const cur = sel.value;
  sel.innerHTML = kws.map((k) => `<option>${esc(k)}</option>`).join('');
  if (kws.includes(cur)) sel.value = cur;
}
fillQuickKeywords();
chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && (ch.daily || ch.config)) fillQuickKeywords(); });

/** 第一次用：缺什么就在顶上挂一条，点了去设置页 */
async function renderSetup() {
  const miss = setupMissing(await getConfig());
  const el = $('setup-banner');
  el.hidden = !miss.length;
  if (!miss.length) return;
  el.innerHTML = `<b>第一次用，还差 ${miss.length} 步：</b>${miss.map((m) => esc(m.text)).join('、')}<button class="primary sm" id="btn-setup">去设置</button>`;
  $('btn-setup').onclick = () => chrome.runtime.openOptionsPage();
}
renderSetup();
chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.config) renderSetup(); });

$('btn-stop').onclick = () => { requestStop(); status('正在停止，等手上这一家走完…'); };

$('panel-queue').addEventListener('click', async (e) => {
  // 筛选按钮
  const qf = e.target.closest('[data-qf]');
  if (qf) { const [k, v] = qf.dataset.qf.split(':'); qFilter = { ...qFilter, [k]: v }; await render(true); return; }
  // 勾选
  const pk = e.target.closest('input[data-pick]');
  if (pk) {
    if (pk.checked) picked.add(pk.dataset.pick); else picked.delete(pk.dataset.pick);
    await render(true);
    return;
  }
  const btn = e.target.closest('button[data-act]');
  // 点一行的空白处：展开 / 收起
  if (!btn) {
    const tg = e.target.closest('[data-toggle]');
    if (tg && !e.target.closest('textarea, input, a')) {
      const id = tg.dataset.toggle;
      if (opened.has(id)) opened.delete(id); else opened.add(id);
      tg.closest('.job')?.classList.toggle('open', opened.has(id));
      const ol = tg.querySelector('.one-line');
      if (ol) ol.hidden = opened.has(id);
    }
    return;
  }
  const id = btn.dataset.id;
  const act = btn.dataset.act;
  if (act === 'approve-all') { await approveAll(btn); return; }
  if (act === 'pick-go' || act === 'pick-none') {
    const rt0 = await getRuntime();
    picked.clear();
    if (act === 'pick-go') for (const q of rt0.queue || []) if (q.verdict === '投' && (q.status || '待审核') === '待审核' && !q.greetedDefault) picked.add(q.job.jobId);
    await render(true);
    return;
  }
  if (act === 'approve-picked') { await approveList([...picked], btn); picked.clear(); await render(true); return; }
  const rt = await getRuntime();
  const item = (rt.queue || []).find((q) => q.job.jobId === id);
  if (!item) return;

  try {
    if (act === 'company') { openCompany(item.job.company); return; }
    if (act === 'open') {
      chrome.tabs.create({ url: item.job.href });
    } else if (act === 'blacklist') {
      // 参考 boss-helper / get_jobs 的公司黑名单：加进排除词，以后初筛直接挡掉，不花模型
      const co = item.job.company;
      if (!confirm(`拉黑「${co}」？以后这家的岗位在初筛就挡掉。`)) return;
      const cfg = await getConfig();
      // 单独存 config.blacklist：预设（config.json）更新时只覆盖 filter，不会冲掉这份
      if (!(cfg.blacklist || []).includes(co)) await setConfig({ blacklist: [...(cfg.blacklist || []), co] });
      await dropQueued(id);
      drafts.delete(id);
      status(`已拉黑「${co}」`);
    } else if (act === 'drop') {
      await dropQueued(id);
      drafts.delete(id);
    } else if (act === 'unapprove') {
      await unapprove(id);
    } else if (act === 'approve') {
      const edited = $('panel-queue').querySelector(`textarea[data-g="${CSS.escape(id)}"]`)?.value;
      btn.disabled = true;
      await approve(id, edited);
      drafts.delete(id);
      status(isRunning() ? '已排队，等筛选跑完就开始发' : '已排队，马上开始发');
    } else if (act === 'tailor') {
      btn.disabled = true;
      status('按这个岗位从素材库挑经历、定讲法，大概 30-90 秒…');
      const config = await getConfig();
      const data = await tailorResume(item.job, config);
      await openResume(item.job, data);
      status('定制简历已在新标签页打开，点「下载 PDF」就存到「下载」文件夹里的「求职简历」');
      btn.disabled = false;
    }
  } catch (err) {
    status(err.message, true);
    btn.disabled = false;
  }
  await render(false);
});

/** 建议投的一键全投：每家用列表里当前的开场白（你改过的也算），有问题的跳过并说明 */
async function approveAll(btn) {
  const rt = await getRuntime();
  const ids = (rt.queue || []).filter((q) => q.verdict === '投' && (q.status || '待审核') === '待审核' && !q.greetedDefault).map((q) => q.job.jobId);
  await approveList(ids, btn);
}

/** 投一批（勾选的 / 全部建议投）：确认后按顺序排进发送队列，照样一家家发、守间隔和每天上限 */
async function approveList(ids, btn) {
  const rt = await getRuntime();
  const list = (rt.queue || []).filter((q) => ids.includes(q.job.jobId) && (q.status || '待审核') === '待审核' && !q.greetedDefault);
  if (!list.length) return;
  const names = list.map((q) => `· ${q.job.company}｜${q.job.title}`).join('\n');
  const { pace } = await getConfig();
  if (!confirm(`把这 ${list.length} 家排进发送队列？\n${names}\n\n照样一家家发，每家隔 ${Math.round(pace.minDelayMs / 1000)}～${Math.round(pace.maxDelayMs / 1000)} 秒，BOSS 每天最多 ${pace.dailyLimit} 个。`)) return;
  btn.disabled = true;
  const bad = [];
  for (const q of list) {
    const edited = $('panel-queue').querySelector(`textarea[data-g="${CSS.escape(q.job.jobId)}"]`)?.value;
    try { await approve(q.job.jobId, edited); drafts.delete(q.job.jobId); } catch (e) { bad.push(`${q.job.company}：${e.message}`); }
  }
  status(bad.length ? `排进去 ${list.length - bad.length} 家；没排进去的：${bad.join('；')}` : `${list.length} 家都排进去了，正在一家家发`, bad.length > 0);
  await render(false);
}

// ---------------------------------------------------------------- 定制简历

/** 拼法存进 storage，开简历页排版（页面自己压进一页、出 PDF） */
async function openResume(job, d) {
  await chrome.storage.local.set({ resumeDraft: { job: { title: job.title, company: job.company }, plan: d.plan, reasons: d.reasons, at: Date.now() } });
  await chrome.tabs.create({ url: chrome.runtime.getURL('src/resume/resume.html') });
}

// ---------------------------------------------------------------- 工具

$('btn-health').onclick = async () => {
  const out = $('health-out');
  out.textContent = '体检中…';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!/zhipin\.com/.test(tab?.url || '')) { out.textContent = '当前不是 BOSS直聘 页面'; return; }
    const res = await chrome.tabs.sendMessage(tab.id, { action: 'healthCheck' });
    const bad = res.results.filter((r) => !r.ok);
    out.textContent = [
      `页面类型：${res.pageKind}`,
      `${res.url}`,
      '',
      ...res.results.map((r) => `${r.ok ? '✓' : '✗'} ${r.field.padEnd(18)} ${r.ok ? `${r.count} 个  ← ${r.matched}` : `全部 ${r.candidates} 个候选都没命中`}`),
      '',
      bad.length ? `失效 ${bad.length} 项：${bad.map((b) => b.field).join(', ')} —— 把这段发给我` : '全部正常',
    ].join('\n');
  } catch (e) {
    out.textContent = `失败：${e.message}\n（页面可能需要刷新一次让内容脚本注入）`;
  }
};

$('btn-export').onclick = async () => {
  const rt = await getRuntime();
  const lines = [
    `投递报告  ${rt.stats.date}`,
    `评估 ${rt.stats.evaluated} 个 ｜ 已投 ${rt.stats.sent} 个 ｜ 筛掉 ${rt.stats.skipped} 个 ｜ 列表里 ${(rt.queue || []).length} 个`,
    '',
    '=== 已投 ===',
    ...(rt.done || []).filter((d) => !d.dryRun).map((d) =>
      `[${d.score}] ${d.title} @ ${d.company} ${d.salary}${d.chatSalary ? `（聊天页 ${d.chatSalary}）` : ''}  ${new Date(d.at).toLocaleString('zh-CN')}\n    ${d.greeting}`),
    '',
    '=== 筛选结果（还没投） ===',
    ...sorted(rt.queue || []).map((q) =>
      `[${q.status || '待审核'}｜${q.verdict || ''}｜${q.priority || ''}｜${q.match_score}] ${q.job.title} @ ${q.job.company} ${q.job.salary}\n    公司：${q.company_check || ''}\n    ${(q.reasons || []).join('；')}${q.error ? `\n    备注：${q.error}` : ''}`),
  ].join('\n');

  const url = URL.createObjectURL(new Blob([lines], { type: 'text/plain;charset=utf-8' }));
  await chrome.downloads.download({ url, filename: `boss-report-${rt.stats.date}.txt`, saveAs: true })
    .catch(() => window.open(url)); // 没有 downloads 权限就开新窗口
};

$('btn-clear-seen').onclick = async () => {
  if (!confirm('清空去重记录？这些岗位之后会重新参与筛选。')) return;
  await setRuntime({ seen: {} });
  status('已清空');
};

// 四个页签：今天 / 待审 / 网申 / 记录（查公司页不在导航上，从搜索框和卡片按钮进，左上角「返回」回原来那页）
export function showPanel(name) {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((x) => x.classList.toggle('active', x.id === `panel-${name}`));
  document.querySelector('main').scrollTop = 0;
}
let lastTab = 'today';
document.querySelectorAll('.tab').forEach((t) => {
  t.onclick = () => { lastTab = t.dataset.tab; showPanel(t.dataset.tab); };
});
document.querySelectorAll('[data-back]').forEach((b) => { b.onclick = () => showPanel(lastTab); });

// runtime 变了就刷新，这样跑的过程中界面是活的（列表只在真变了时重画）
chrome.storage.onChanged.addListener((changes, area) => {
  // senderBeat：发送器的心跳和收工信号，用来刷新按钮状态
  if (area === 'local' && (changes.runtime || changes.senderBeat)) render(false);
});

resetStale().catch(() => {}).finally(() => render());
initCampus();
initAutofill();
initCompany();
initArchive();
initToday();
