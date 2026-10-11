/**
 * 侧边栏「网申」页上半部分：填网申（v0.7.0 模块 B）。
 * 按钮在侧边栏，页面上只描边（求职方舟的悬浮按钮会挡页面）。
 */
import { getConfig } from '../lib/store.js';
import { fillPage, rememberPage, scrollToField, requestPagePermission } from '../lib/autofill-engine.js';
import { getDeepSeekUsage, getDeepSeekBalance, dsCost } from '../lib/llm.js';
import { getCampus } from '../lib/campus-source.js';
import { markApplied } from '../lib/campus.js';
import { recordChannel } from '../lib/company-archive.js';

// 常见网申系统的域名：在这些页面上「填网申」自动展开
const ATS = /mokahr.com|hotjob.cn|zhiye.com|jobs.feishu.cn|wjx.(cn|top)|iguopin.com|campus.51job.com|xiaoyuan.zhaopin.com|italent.cn|dayee.com|beisen|recruit|career|campus|zhaopin.[a-z-]+.com/i;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let busy = false;
let reportTab = null;

function status(t, err = false) { const el = $('af-status'); el.textContent = t; el.className = err ? 'status err' : 'status'; }

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

/** 当前标签是网申列表里哪家的投递页：按 applyUrl 的域名 + 路径前缀对 */
async function guessJob(tab) {
  if (!tab?.url || !/^https?:/.test(tab.url)) return;
  const c = await getCampus();
  let u;
  try { u = new URL(tab.url); } catch { return; }
  let best = null;
  for (const x of Object.values(c.items)) {
    try {
      const a = new URL(x.applyUrl);
      if (a.host !== u.host) continue;
      const score = commonPrefix(a.pathname, u.pathname);
      if (!best || score > best.score) best = { x, score };
    } catch { /* 投递链接不是网址 */ }
  }
  // 在网申页（投递链接对得上、或者是常见网申系统）就把「填网申」展开，省一次点击
  if (best || ATS.test(u.host + u.pathname)) $('af-details').open = true;
  if (best && !$('af-company').dataset.edited) {
    $('af-company').value = best.x.company;
    $('af-position').value = (best.x.ai?.matched_positions || [])[0] || '';
    $('af-company').dataset.campusId = best.x.id;
  } else if (!$('af-company').value) {
    $('af-company').value = (tab.title || '').split(/[-_|｜·]/)[0].trim().slice(0, 30);
  }
}
const commonPrefix = (a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return i; };

async function renderCost() {
  const u = await getDeepSeekUsage();
  $('ds-line').textContent = `今日 DeepSeek 花费约 ¥${u.today.cny.toFixed(3)}（${u.today.calls} 次，缓存命中 ${u.today.hit} / 未命中 ${u.today.miss} / 输出 ${u.today.out} tokens）`;
  try {
    const b = await getDeepSeekBalance(await getConfig());
    if (b) $('ds-line').textContent += ` ｜ 余额 ¥${b.total.toFixed(2)}`;
  } catch { /* 查不到余额不影响 */ }
}

async function run(fresh) {
  if (busy) return;
  const tab = await activeTab();
  try {
    // 要权限必须在点击手势里、第一件事就做
    await requestPagePermission(tab.id);
  } catch (e) { status(e.message, true); return; }
  busy = true;
  $('btn-af-fill').disabled = $('btn-af-refill').disabled = true;
  reportTab = tab.id;
  const before = await getDeepSeekUsage();
  try {
    const config = await getConfig();
    const report = await fillPage({
      tabId: tab.id, config, fresh,
      job: { company: $('af-company').value.trim(), position: $('af-position').value.trim(), campusId: $('af-company').dataset.campusId || '' },
      onProgress: (t) => status(t),
    });
    const after = await getDeepSeekUsage();
    report.cny = after.today.cny - before.today.cny;
    await chrome.storage.local.set({ afLast: report });
    status(`填完了（${report.stats.secs} 秒）。没提交 —— 检查一遍红黄的，再自己点提交`);
    renderReport(report);
  } catch (e) {
    status(e.message, true);
  } finally {
    busy = false;
    $('btn-af-fill').disabled = $('btn-af-refill').disabled = false;
    renderCost();
  }
}

export function renderReport(r) {
  if (!r) { $('af-report').innerHTML = ''; return; }
  const s = r.stats;
  const f = r.fields;
  const red = f.filter((x) => x.color === 'red');
  const yellow = f.filter((x) => x.color === 'yellow');
  const miss = f.filter((x) => x.status === '缺' && x.color !== 'red');
  const unk = f.filter((x) => x.status === '认不出' && x.color !== 'red');
  const li = (x, cls) => `<li class="${cls}" data-key="${esc(x.key)}"><b>${esc(x.sectionLabel ? x.sectionLabel + ' · ' : '')}${esc(x.label || x.field || '(无标签)')}</b>${x.required ? ' *' : ''} — ${esc(x.status)}${x.filled ? `：${esc(String(x.filled).slice(0, 40))}` : ''}<br><small>${esc([...(x.notes || []), x.check ? `核对：${x.check.problem}，${x.check.why}${x.check.suggest ? `（建议：${x.check.suggest}）` : ''}` : ''].filter(Boolean).join('；'))}</small></li>`;
  const calls = r.calls || [];
  const tok = calls.reduce((a, c) => ({ in: a.in + c.in, out: a.out + c.out, hit: a.hit + c.hit, chars: a.chars + c.chars }), { in: 0, out: 0, hit: 0, chars: 0 });
  const syn = r.synPairs || [];
  const cid = r.job?.campusId;
  $('af-report').innerHTML = `
    <div class="row wrap"><button id="btn-af-applied" class="primary" title="你在页面上点完提交后按这个，记进「已投」和公司档案">交完了，记已投</button><span class="hint">${esc(r.job?.company || '')}${cid ? '（网申列表里那条会一起标已投）' : ''}</span></div>
    <div class="af-cov">共 ${s.total} 个字段：已填 ${s.filled}（含页面原有 ${s.prefilled}、开放题起草 ${s.open}），缺 ${s.missing}（素材库没有），认不出 ${s.unknown}，填了没生效 ${s.failed}</div>
    ${syn.length ? `<div class="hint">近义栏目 ${syn.length} 组：${syn.map((g) => `${g.labels.join(' / ')} ${g.allFilled ? '✓都填了' : '✗有空的'}`).join('；')}</div>` : ''}
    ${r.warnings?.length ? `<div class="warn-box">${r.warnings.map(esc).join('<br>')}</div>` : ''}
    ${r.submits?.length ? `<div class="hint">页面上的「${r.submits.map(esc).join('」「')}」已描红，插件不点，你自己点。</div>` : ''}
    ${red.length ? `<div>🔴 要你处理（${red.length}）</div><ul class="af-list">${red.map((x) => li(x, 'red')).join('')}</ul>` : ''}
    ${yellow.length ? `<div>🟡 模型给的，看一眼（${yellow.length}）</div><ul class="af-list">${yellow.map((x) => li(x, 'yellow')).join('')}</ul>` : ''}
    ${miss.length ? `<details><summary>⚪ 素材库没有、非必填，空着（${miss.length}）</summary><ul class="af-list">${miss.map((x) => li(x, 'grey')).join('')}</ul></details>` : ''}
    ${unk.length ? `<details><summary>⚪ 认不出、非必填（${unk.length}）</summary><ul class="af-list">${unk.map((x) => li(x, 'grey')).join('')}</ul></details>` : ''}
    <details><summary>对照表：栏目 → 填的值 → 取自素材库哪条（${f.filter((x) => x.filled).length} 行）</summary>
      <table class="af-table">${f.filter((x) => x.filled).map((x) => `<tr class="${x.color}" data-key="${esc(x.key)}"><td>${esc(x.sectionLabel || '')}</td><td>${esc(x.label)}</td><td>${esc(String(x.filled).slice(0, 80))}</td><td>${esc(x.source || x.by)}</td></tr>`).join('')}</table>
    </details>
    <div class="hint">这一页调了 ${calls.length} 次模型（${calls.map((c) => `${c.task} ${(c.ms / 1000).toFixed(1)}s`).join('、') || '无'}），发出 ${tok.chars} 字，输入 ${tok.in} tokens（缓存命中 ${tok.hit}）、输出 ${tok.out}，约 ¥${(r.cny ?? dsCost({ in: tok.in, cacheRead: tok.hit, out: tok.out })).toFixed(4)}</div>`;
}

// ---------------------------------------------------------------- 网申待填（模块 C 第 3 条：HR 在聊天里甩来的网申链接）

const PLAT = { boss: 'BOSS', zhilian: '智联', other: '' };
const REPLY = '好的，已经按您发的链接投递完成了，麻烦您帮忙留意一下，有需要补充的材料随时跟我说～';

async function renderTodo() {
  const { afTodo = {} } = await chrome.storage.local.get('afTodo');
  const list = Object.values(afTodo).filter((x) => x.state !== '忽略').sort((a, b) => b.at - a.at);
  const box = $('af-todo');
  if (!list.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="hint">网申待填（HR 在聊天里发来的，${list.filter((x) => x.state === '待填').length} 条没处理）</div>` + list.map((x) => `
    <div class="job" data-todo="${esc(x.id)}">
      <h4>${esc(PLAT[x.platform] || '')} · ${esc(x.header || '没读到公司 / HR')}</h4>
      <div class="meta">${esc(x.kind)} · ${new Date(x.at).toLocaleString('zh-CN')} · ${esc(x.state)}</div>
      <div class="company-check">HR 原话：${esc(x.quote)}</div>
      ${x.state === '已填' ? `<textarea readonly>${esc(REPLY)}</textarea><div class="hint">回复草稿：复制后去聊天页你自己发（插件不在已有会话里代发）</div>` : ''}
      <div class="row wrap">
        ${x.link ? '<button data-tact="open" class="primary">打开链接</button>' : '<button data-tact="chat">回聊天页</button>'}
        ${x.state === '已填' ? '<button data-tact="copy">复制回复</button>' : '<button data-tact="done">填完了，起草回复</button>'}
        <button data-tact="ignore">不管它</button>
      </div>
    </div>`).join('');
}

async function onTodo(e) {
  const btn = e.target.closest('button[data-tact]');
  if (!btn) return;
  const id = btn.closest('[data-todo]').dataset.todo;
  const { afTodo = {} } = await chrome.storage.local.get('afTodo');
  const x = afTodo[id];
  if (!x) return;
  const act = btn.dataset.tact;
  if (act === 'open') { await chrome.tabs.create({ url: x.link, active: true }); status('打开了。登录后停在简历表单页，再点上面的「填这一页」'); }
  else if (act === 'chat') await chrome.tabs.create({ url: x.pageUrl, active: true });
  else if (act === 'done') afTodo[id] = { ...x, state: '已填', doneAt: Date.now() };
  else if (act === 'ignore') afTodo[id] = { ...x, state: '忽略' };
  else if (act === 'copy') { await navigator.clipboard.writeText(REPLY).catch(() => {}); status('回复已复制，去聊天页粘贴、你自己点发送'); }
  await chrome.storage.local.set({ afTodo });
  renderTodo();
}

export function initAutofill() {
  $('af-todo').addEventListener('click', onTodo);
  renderTodo();
  chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.afTodo) renderTodo(); });
  $('btn-af-fill').onclick = () => run(false);
  $('btn-af-refill').onclick = () => run(true);
  $('btn-af-remember').onclick = async () => {
    const tab = await activeTab();
    try {
      await requestPagePermission(tab.id);
      const saved = await rememberPage(tab.id);
      status(saved.length ? `记住了 ${saved.length} 项（只存本机）：${saved.join('、')}` : '没找到你手填的新内容（素材库里有的不用记）');
    } catch (e) { status(e.message, true); }
  };
  $('af-company').addEventListener('input', () => { $('af-company').dataset.edited = '1'; });
  $('af-report').addEventListener('click', async (e) => {
    if (e.target.id === 'btn-af-applied') {
      const { afLast } = await chrome.storage.local.get('afLast');
      const job = afLast?.job || {};
      try {
        if (job.campusId) await markApplied(job.campusId, { url: afLast.url });
        else if (job.company) await recordChannel(job.company, 'campus', { title: job.position || '' });
        else { status('不知道是哪家公司：上面「公司」那栏填一下再按', true); return; }
        e.target.disabled = true; e.target.textContent = '已记';
        status(`记好了：${job.company || ''} 记进「已投」和公司档案`);
      } catch (err) { status(err.message, true); }
      return;
    }
    const el = e.target.closest('[data-key]');
    if (!el || !reportTab) return;
    await chrome.tabs.update(reportTab, { active: true }).catch(() => {});
    scrollToField(reportTab, el.dataset.key).catch(() => status('那个字段不见了（页面可能刷新过）', true));
  });
  chrome.tabs.onActivated.addListener(async () => { $('af-company').dataset.edited = ''; $('af-company').dataset.campusId = ''; $('af-company').value = ''; $('af-position').value = ''; guessJob(await activeTab()); });
  chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.dsUsage) renderCost(); });
  activeTab().then(guessJob);
  chrome.storage.local.get('afLast').then(({ afLast }) => { if (afLast) renderReport(afLast); });
  renderCost();
}
