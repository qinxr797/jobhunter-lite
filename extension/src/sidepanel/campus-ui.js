/**
 * 侧边栏「网申」标签页（v0.7.0 模块 A）：校招网申公告列表。
 * 数据：campus-source.js 拉 + 本地初筛；campus.js 用模型（9/28 起 DeepSeek）批量初筛；你点「去投递」自己投，投完按「已投」。
 */
import { getConfig } from '../lib/store.js';
import { getCampus, pullCampus, screenPending, isScreening, stopScreening, pendingOf, visibleOf, appliedOf, daysLeft, markApplied, dropCampus } from '../lib/campus.js';
import { pullsToday, MAX_PULLS_PER_DAY, autoPull, setCampus } from '../lib/campus-source.js';
import { run, isRunning } from '../lib/orchestrator.js';
import { openCompany } from './company-ui.js';
import { getArchive, appliedElsewhere, backfillFromDone } from '../lib/company-archive.js';
import { getRuntime } from '../lib/store.js';
import { cityCodes } from '../lib/cities.js';
import { cohortOf } from '../lib/library.js';

let city = '';   // 求职城市，卡片上显示「有 XX」用

let archive = {};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hm = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

function status(t, err = false) { const el = $('campus-status'); el.textContent = t; el.className = err ? 'status err' : 'status'; }

// 列表筛选条（per-viewer 的小偏好，记在 localStorage，读不到就用默认）
let filter = 'all';
let query = '';
let shown = [];
try { filter = localStorage.getItem('campusFilter') || 'all'; } catch { /* 隐私模式等读不到就算了 */ }
function filtered(vis) {
  const q = query.trim();
  return vis.filter((x) => {
    const ai = x.ai || {};
    if (filter === 'go' && ai.verdict !== '投') return false;
    if (filter === 'big' && ai.company_tier !== '大单位') return false;
    if (filter === 'soon' && !((daysLeft(x.deadline) ?? 99) <= 7)) return false;
    if (filter === 'hefei' && !x.hefei) return false;
    if (q && !`${x.company} ${x.positions} ${(ai.matched_positions || []).join(' ')} ${x.industry}`.includes(q)) return false;
    return true;
  });
}

let lastJson = '';
export async function renderCampus(force = false) {
  const c = await getCampus();
  city = ((await getConfig()).filter?.cities || [])[0] || '';
  const json = JSON.stringify([c.items, c.lastError, c.pulls?.[0]]);
  const vis = visibleOf(c);
  $('badge-campus').textContent = String(vis.length);
  $('badge-campus').toggleAttribute('data-zero', !vis.length);
  if (!force && json === lastJson) { syncButtons(c); return; }
  lastJson = json;

  // 拉取失败要大声说（第三方未公开接口，随时可能变）
  const err = $('campus-err');
  err.hidden = !c.lastError;
  err.textContent = c.lastError ? `${c.lastError}${/格式变了/.test(c.lastError) ? ' —— 求职方舟改了接口，把这句发给做插件的人' : ''}` : '';

  const all = Object.values(c.items);
  const p = c.pulls?.[0];
  const n = (st) => all.filter((x) => x.state === st).length;
  $('campus-src').innerHTML = [
    `网申源：求职方舟「27届秋招网申公告汇总表」${c.lastOk ? `，上次拉取 ${hm(c.lastOk)}` : '，还没拉过'}${p?.ok ? `（拉到 ${p.n} 条，新进 ${p.added} 条）` : ''}`,
    `本地存着 ${all.length} 条（求职城市或全国大单位、方向对口、没截止）：待模型筛 ${pendingOf(c).length} ｜ 投/等你定 ${vis.length} ｜ 模型判不投 ${all.filter((x) => x.ai?.verdict === '不投' && x.state === '已筛').length} ｜ 已投 ${n('已投')} ｜ 你不投 ${n('不投')}`,
  ].map((l) => `<div>${esc(l)}</div>`).join('');
  syncButtons(c);

  const box = $('campus-list');
  const applied = appliedOf(c);
  archive = await getArchive();

  // 今天该看的：快截止的建议投、今天新进的、HR 发来的待填链接
  const soonGo = vis.filter((x) => x.ai?.verdict === '投' && (daysLeft(x.deadline) ?? 99) <= 3);
  const fresh = vis.filter((x) => x.screenedAt && Date.now() - x.screenedAt < 864e5 && x.firstSeen && Date.now() - x.firstSeen < 864e5);
  const { afTodo = {} } = await chrome.storage.local.get('afTodo');
  const todo = Object.values(afTodo).filter((t) => t.state === '待填').length;
  $('campus-today').innerHTML = `今天：${soonGo.length ? `<b>${soonGo.length} 家建议投 3 天内截止</b>（${soonGo.slice(0, 4).map((x) => esc(x.company)).join('、')}${soonGo.length > 4 ? '…' : ''}）` : '没有 3 天内截止的建议投'}
    ｜ 24 小时内新进 ${fresh.length} 家 ｜ 建议投共 ${vis.filter((x) => x.ai?.verdict === '投').length} 家${todo ? ` ｜ <b>HR 发来待填链接 ${todo} 条</b>（在上面「填网申」下面）` : ''}`;

  shown = filtered(vis);
  $('campus-count').textContent = `筛出 ${shown.length} / ${vis.length} 家`;
  if (!vis.length) {
    box.innerHTML = `<p class="empty">${all.length ? '筛过的公告里还没有能投的。' : '还没拉到公告。'}<br>点「拉取公告」再点「模型初筛」。</p>`;
  } else if (!shown.length) {
    box.innerHTML = '<p class="empty">这个筛选条件下没有，换一个试试。</p>';
  } else {
    box.innerHTML = shown.map(card).join('');
  }
  if (applied.length) {
    // 网申投完，去 BOSS 找这家公司的 HR 补一句
    box.innerHTML += `<details class="applied" open><summary>已网申 ${applied.length} 家</summary>${applied.map((x) =>
      `<div class="log-line" data-cid="${esc(x.id)}"><time>${hm(x.appliedAt)}</time><span>${esc(x.company)} · ${esc((x.ai?.matched_positions || []).join('、'))}${x.followup ? ` · <small>${esc(x.followup)}</small>` : ''}</span>
        <button data-cact="followup" title="开 BOSS 搜这家公司（求职城市），只看不点；找到在招岗位就起草「已在官网投了」的消息，进「待审」等你按投">去 BOSS 找 HR</button></div>`).join('')}</details>`;
  }
}

function syncButtons(c) {
  const busy = isScreening();
  const left = pendingOf(c).length;
  $('btn-campus-screen').disabled = busy || !left;
  $('btn-campus-screen').textContent = busy ? '初筛中…' : `模型初筛（${left} 条待筛）`;
  $('btn-campus-stop').hidden = !busy;
  const used = pullsToday(c);
  $('btn-campus-pull').disabled = used >= MAX_PULLS_PER_DAY;
  $('btn-campus-pull').textContent = used >= MAX_PULLS_PER_DAY ? '今天拉满 2 次了（每天自动拉 1 次）' : `拉取公告（今天还能拉 ${MAX_PULLS_PER_DAY - used} 次）`;
}

function card(x) {
  const ai = x.ai || {};
  const dl = daysLeft(x.deadline);
  const soon = dl !== null && dl <= 7;
  const tierCls = { 大单位: 'tier-big', 中型: 'tier-mid', 小公司: 'tier-small' }[ai.company_tier] || '';
  const vCls = ai.verdict === '投' ? 'go' : 'ask';
  // 紧凑卡片（v1.0）：公司 + 截止一行、性质批次一行、对口岗位一行、理由一行、按钮一行
  const where = String(x.locations || '');
  const elsewhere = appliedElsewhere(archive, x.company, 'campus');
  return `<div class="job campus-card" data-cid="${esc(x.id)}">
    <div class="cc-top">${ai.company_tier && ai.company_tier !== '看不出' ? `<span class="tier ${tierCls}">${esc(ai.company_tier)}</span>` : ''}<span class="verdict ${vCls}">${ai.verdict === '投' ? '建议投' : esc(ai.verdict)}</span><b>${esc(x.company)}</b>
      <span class="dl ${soon ? 'soon' : ''}">${dl === null ? '截止没写' : dl < 0 ? '已截止' : dl === 0 ? '今天截止' : `${dl} 天后截止`}</span></div>
    <div class="cc-meta">${(x.typeTag || []).map(esc).join('/') || '性质没写'} · ${esc(x.industry || '行业没写')} · ${esc(x.batch)} · ${x.hefei && city ? `有${esc(city)}` : esc(where.slice(0, 16))}${ai.grade_risk && ai.grade_risk !== '无' ? ' <span class="chip warn">写的招 27 届</span>' : ''}${x.referralCode ? ` <span class="chip muted" title="内推码">内推 ${esc(x.referralCode)}</span>` : ''}${elsewhere ? ` <span class="chip muted">${esc(elsewhere)}</span>` : ''}</div>
    <div class="cc-pos">对口：<b>${esc((ai.matched_positions || []).join('、') || '—')}</b></div>
    ${ai.reason ? `<div class="cc-why">${esc(ai.reason)}</div>` : ''}
    <div class="row wrap">
      ${x.applyUrl ? `<button class="primary sm" data-cact="apply">去投递</button>` : ''}
      ${x.noticeUrl ? `<button class="sm" data-cact="notice">看公告</button>` : ''}
      <button class="sm" data-cact="applied">已投</button>
      <button class="sm" data-cact="drop">不投</button>
      <button class="sm ghost" data-cact="company">查公司</button>
    </div>
  </div>`;
}

async function onClick(e) {
  const btn = e.target.closest('button[data-cact]');
  if (!btn) return;
  const id = btn.closest('[data-cid]').dataset.cid;
  const c = await getCampus();
  const x = c.items[id];
  if (!x) return;
  try {
    const act = btn.dataset.cact;
    if (act === 'notice') chrome.tabs.create({ url: x.noticeUrl });
    else if (act === 'apply') chrome.tabs.create({ url: x.applyUrl });
    else if (act === 'applied') { await markApplied(id); status(`已记进「已投」：${x.company}`); }
    else if (act === 'drop') { await dropCampus(id); status(`不投：${x.company}，以后不再出现`); }
    else if (act === 'followup') await followup(x);
    else if (act === 'company') { openCompany(x.company); return; }
  } catch (err) { status(err.message, true); }
  await renderCampus(true);
}

/** 开 BOSS 在求职城市搜这家公司 → 走现有筛选流程（只看不点）→ 找到的岗位起草「已网申」消息进审核列表，你按「投」才发 */
async function followup(x) {
  if (isRunning()) { status('有平台正在筛，等它筛完再点', true); return; }
  const kw = x.company.replace(/(股份)?有限(责任)?公司|集团/g, '');
  const cc = cityCodes(await getConfig());
  const url = `https://www.zhipin.com/web/geek/jobs?${cc.boss ? `city=${cc.boss}&` : ''}query=${encodeURIComponent(kw)}`;
  status(`开 BOSS 搜「${kw}」${cc.name ? `（${cc.name}）` : ''}…`);
  const tab = await chrome.tabs.create({ url, active: true });
  for (let i = 0; i < 40; i++) {
    const t = await chrome.tabs.get(tab.id).catch(() => null);
    if (!t || t.status === 'complete') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  await new Promise((r) => setTimeout(r, 3000));
  const d = new Date(x.appliedAt || Date.now());
  try {
    const r = await run({ tabId: tab.id, pages: 1, maxJobs: 5,
      followup: { company: x.company, position: (x.ai?.matched_positions || [])[0] || '', date: `${d.getMonth() + 1}月${d.getDate()}日`, campusId: x.id } });
    const note = r?.listed ? `BOSS 找到 ${r.listed} 个岗位，消息已起草进「待审」` : 'BOSS 没搜到这家在招的对口岗位';
    const c = await getCampus();
    await setCampus({ items: { ...c.items, [String(x.id)]: { ...c.items[String(x.id)], followup: note } } });
    status(`${x.company}：${note}${r?.listed ? '，你按「投」才发' : ''}`);
  } catch (e) { status(e.message, true); }
  await renderCampus(true);
}

async function doScreen() {
  const config = await getConfig();
  try {
    const t0 = Date.now();
    const st = await screenPending(config, (t) => status(t));
    const secs = st.secs.length ? `，每批 ${st.secs.join('/')} 秒` : '';
    status(`${st.error ? `初筛停了：${st.error}。` : ''}这轮筛了 ${st.done} 条（${st.batches} 批${secs}，共 ${Math.round((Date.now() - t0) / 1000)} 秒）：建议投 ${st.go}、等你定 ${st.ask}、不投 ${st.no}${st.failed ? `，模型漏判 ${st.failed} 条放进了等你定` : ''}`, Boolean(st.error));
  } catch (e) { status(e.message, true); }
  await renderCampus(true);
}

async function doPull(auto) {
  const config = await getConfig();
  status('拉取网申公告中…');
  const city = (config.filter?.cities || [])[0] || '';
  const r = auto ? await autoPull(config.filter?.excludeKeywords || [], city) : await pullCampus({ excludeKeywords: config.filter?.excludeKeywords || [], city });
  if (!r) { status(''); return null; }
  if (r.ok) status(`拉到 ${r.n} 条公告（最近 ${r.days} 天），本地初筛新进 ${r.added} 条`);
  else status(r.err, true);
  await renderCampus(true);
  return r;
}

function initFilters() {
  const chips = $('campus-chips');
  const sync = () => chips.querySelectorAll('button[data-f]').forEach((b) => b.classList.toggle('on', b.dataset.f === filter));
  sync();
  chips.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-f]');
    if (!b) return;
    filter = b.dataset.f;
    try { localStorage.setItem('campusFilter', filter); } catch { /* 存不了就算了 */ }
    sync();
    renderCampus(true);
  });
  let t = null;
  $('campus-q').addEventListener('input', () => { query = $('campus-q').value; clearTimeout(t); t = setTimeout(() => renderCampus(true), 250); });
  // 批量打开：当前筛出来的、有投递链接的，最多 8 个
  $('btn-campus-open').onclick = async () => {
    const list = shown.filter((x) => x.applyUrl).slice(0, 8);
    if (!list.length) { status('当前筛选下没有带投递链接的', true); return; }
    if (!confirm(`开 ${list.length} 个投递页（${list.map((x) => x.company).join('、')}）？\n开完你挨个登录，在表单页点「填这一页」，检查后自己提交；投完回来按「已投」。`)) return;
    for (const x of list) await chrome.tabs.create({ url: x.applyUrl, active: false });
    status(`开了 ${list.length} 个投递页。填完一家回这里按那家的「已投」`);
  };
}

export function initCampus() {
  initFilters();
  getRuntime().then((rt) => backfillFromDone(rt.done)).catch(() => {});
  $('panel-campus').addEventListener('click', onClick);
  $('btn-campus-pull').onclick = async () => { const r = await doPull(false); if (r?.ok && r.added) doScreen(); };
  $('btn-campus-screen').onclick = doScreen;
  $('btn-campus-stop').onclick = () => { stopScreening(); status('手上这一批筛完就停'); };
  chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.campus) renderCampus(false); });
  // 打开侧边栏：今天还没拉过就拉一次（定时任务可能还没轮到）；有待筛的就在后台筛掉（DeepSeek）
  renderCampus(true).then(async () => {
    // 网申公告是应届校招的：简历里填了近两年毕业、也填了 key 才自动拉和自动筛
    const config = await getConfig();
    if (!config.apiKey || cohortOf(config.resume?.graduation) < new Date().getFullYear() - 1) return;
    await doPull(true).catch(() => {});
    const c = await getCampus();
    if (pendingOf(c).length && !isScreening()) doScreen();
  });
}
