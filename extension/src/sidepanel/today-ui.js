/**
 * 「今天」首页（v0.9.0，2026-09-28 你：易用性没做出来、BOSS 等网站被边缘化了）。
 *
 * 打开侧边栏第一眼看到的就是今天要干什么：
 *   - 一键「筛今天的岗位」：几个关键词 × BOSS / 51job 自动开搜索页、筛、关页，再加智联 HR 邀请 —— 不用自己一个个开搜索页点筛选
 *   - 待你处理：筛选结果建议投 / 等你定（按平台）、网申快截止、HR 发来的网申链接，点一下跳过去
 *   - 今日进度：BOSS 已打招呼 x/15、各渠道今天投了几家
 * 筛选全程只看不点，发送照旧要你在「待审」里按「投」（或者「建议投的一键全投」）。
 */
import { getConfig, getRuntime } from '../lib/store.js';
import { cityCodes } from '../lib/cities.js';
import { run, requestStop, isRunning, PLATFORM_NAMES } from '../lib/orchestrator.js';
import { getCampus } from '../lib/campus-source.js';
import { visibleOf, daysLeft } from '../lib/campus.js';
import { refreshInbox } from '../lib/hr-inbox.js';
import { getReview, reviewedToday, reviewCsv, dropCompany } from '../lib/review.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEFAULT_DAILY = {
  keywords: [],       // 空的时候按简历里的目标岗位填
  boss: true, job51: true, zhilian: true,
  bigOnly: false,     // 勾上才只搜 BOSS 500 人以上、51job 上市/国企/外资/合资
  perKeyword: 8,      // 每个关键词最多细看几个（BOSS 要开详情页，这个数决定花多久）
};

export async function getDaily() {
  const { daily } = await chrome.storage.local.get('daily');
  const d = { ...DEFAULT_DAILY, ...(daily || {}) };
  if (!daily?.keywords) {
    const { config } = await chrome.storage.local.get('config');
    d.keywords = String(config?.resume?.title || '').split(/[,，、/／|\s]+/).map((x) => x.trim()).filter((x) => x.length >= 2).slice(0, 5);
  }
  return d;
}
async function setDaily(patch) {
  const d = { ...(await getDaily()), ...patch };
  await chrome.storage.local.set({ daily: d });
  return d;
}

// 城市代码按设置里的求职城市查（lib/cities.js）；查不到就不带城市参数，网站按你账号默认城市搜
export const URLS = {
  boss: (kw, big, cc = {}) => `https://www.zhipin.com/web/geek/jobs?${cc.boss ? `city=${cc.boss}&` : ''}${big ? 'scale=304,305,306&' : ''}query=${encodeURIComponent(kw)}`,
  '51job': (kw, big, cc = {}) => `https://we.51job.com/pc/search?keyword=${encodeURIComponent(kw)}&searchType=2${cc.job51 ? `&jobArea=${cc.job51}` : ''}${big ? '&companyType=10,04,01,02,03' : ''}`,
  zhilian: () => 'https://i.zhaopin.com/im',
};

function status(t, err = false) { const el = $('today-status'); el.textContent = t; el.className = err ? 'status err' : 'status'; }

let stopAll = false;
let busy = false;

/** 开一个后台可见的标签（BOSS / 智联要前台才渲染），等加载完，跑一轮筛选，关掉 */
async function runOn(url, label, perKeyword) {
  const tab = await chrome.tabs.create({ url, active: true });
  try {
    for (let i = 0; i < 40; i++) {
      const t = await chrome.tabs.get(tab.id).catch(() => null);
      if (!t) throw new Error('标签被关掉了');
      if (t.status === 'complete') break;
      await sleep(500);
    }
    await sleep(3000);
    const r = await run({ tabId: tab.id, pages: 1, maxJobs: perKeyword });
    return r || { listed: 0 };
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function runToday() {
  if (busy) return;
  if (isRunning()) { status('已经有筛选在跑了，等它跑完', true); return; }
  const d = await getDaily();
  const config = await getConfig();
  const cc = cityCodes(config);
  if (!config.apiKey) { status('还没填 API Key，点右上角「设置」先填', true); return; }
  if (!d.keywords.length) { status('先在下面「筛什么」里填几个搜索关键词', true); document.querySelector('#panel-today details.opts')?.setAttribute('open', ''); return; }
  const jobs = [];
  for (const kw of d.keywords) {
    if (d.boss) jobs.push({ plat: 'boss', kw, url: URLS.boss(kw, d.bigOnly, cc) });
    if (d.job51) jobs.push({ plat: '51job', kw, url: URLS['51job'](kw, d.bigOnly, cc) });
  }
  if (d.zhilian) jobs.push({ plat: 'zhilian', kw: 'HR 邀请', url: URLS.zhilian() });
  if (!jobs.length) { status('关键词和平台都没选', true); return; }
  busy = true; stopAll = false;
  $('btn-today-run').disabled = true; $('btn-today-stop').hidden = false;
  // 第二天投之前，先把之前投过的回顾一遍（读 BOSS 聊天列表，不点开会话）
  if (d.boss && !reviewedToday(await getReview())) {
    status('先回顾之前投过的：读 BOSS 聊天列表…');
    try { await refreshInbox(await getConfig()); } catch (e) { status(`回顾没读成（${e.message}），接着筛`, true); await sleep(1500); }
    renderReview(); renderInbox();
  }
  const t0 = Date.now();
  let listed = 0;
  const errs = [];
  try {
  for (let i = 0; i < jobs.length && !stopAll; i++) {
    const j = jobs[i];
    status(`第 ${i + 1}/${jobs.length} 轮：${PLATFORM_NAMES[j.plat]}「${j.kw}」… 已用 ${Math.round((Date.now() - t0) / 60000)} 分钟，新进列表 ${listed} 家`);
    try {
      const r = await runOn(j.url, `${j.plat}-${j.kw}`, d.perKeyword);
      listed += r.listed || 0;
    } catch (e) {
      errs.push(`${PLATFORM_NAMES[j.plat]}「${j.kw}」：${e.message}`);
      if (/验证|登录|captcha|安全/.test(e.message)) { errs.push('碰到验证 / 没登录，先停下，去页面上处理一下再点'); break; }
    }
    await renderToday();
  }
  } finally {
    busy = false;
    $('btn-today-run').disabled = false; $('btn-today-stop').hidden = true;
  }
  status(`${stopAll ? '停了' : '跑完了'}：${Math.round((Date.now() - t0) / 60000)} 分钟，新进列表 ${listed} 家。去「待审」审${errs.length ? `；没跑成的：${errs.join('；')}` : ''}`, errs.length > 0);
  await renderToday();
}

export async function renderToday() {
  const [rt, c, d, { afTodo = {} }] = await Promise.all([getRuntime(), getCampus(), getDaily(), chrome.storage.local.get('afTodo')]);
  const config = await getConfig();
  const q = (rt.queue || []).filter((x) => (x.status || '待审核') === '待审核');
  const byPlat = (v) => ['boss', '51job', 'zhilian'].map((p) => [p, q.filter((x) => (x.job.platform || 'boss') === p && x.verdict === v).length]).filter(([, n]) => n);
  const go = byPlat('投');
  const ask = byPlat('等你定');
  const vis = visibleOf(c);
  const soon = vis.filter((x) => x.ai?.verdict === '投' && (daysLeft(x.deadline) ?? 99) <= 3);
  const campusGo = vis.filter((x) => x.ai?.verdict === '投').length;
  const todo = Object.values(afTodo).filter((t) => t.state === '待填').length;
  const done = (rt.done || []).filter((x) => !x.dryRun);
  const cnt = (p) => done.filter((x) => (x.platform || 'boss') === p).length;
  const fmt = (arr) => arr.map(([p, n]) => `${PLATFORM_NAMES[p]} ${n}`).join('、');

  // 顶上四个数：点哪个跳哪（参考 boss-helper 统计行 + Jobright 的一眼状态）
  const { hrInbox } = await chrome.storage.local.get('hrInbox');
  const hrGood = (hrInbox?.items || []).filter((x) => x.ai && x.ai.worth !== '别理' && x.ai.kind !== '拒绝').length;
  const goN = q.filter((x) => x.verdict === '投').length;
  const stat = (n, label, sub, go, hot) => `<button class="stat ${hot ? 'hot' : ''}" data-go="${go}"><b>${n}</b><span>${label}</span>${sub ? `<small>${sub}</small>` : ''}</button>`;
  $('today-todo').innerHTML = [
    stat(goN, '建议投', `${q.length - goN} 个等你定${go.length ? ' · ' + fmt(go) : ''}`, 'queue', goN > 0),
    stat(rt.stats.sent + cnt('51job') + cnt('zhilian') + cnt('campus'), '今天已投', `BOSS ${rt.stats.sent}/${config.pace.dailyLimit} · 51job ${cnt('51job')} · 智联 ${cnt('zhilian')} · 网申 ${cnt('campus')}`, 'records', false),
    stat(hrInbox ? hrGood : '—', 'HR 值得跟', hrInbox ? `共 ${hrInbox.waitingMe} 条等你回` : '点下面「看 BOSS 新消息」', 'inbox', hrGood > 0),
    stat(campusGo, '网申建议投', soon.length ? `<em>${soon.length} 家 3 天内截止</em>` : (todo ? `${todo} 条 HR 发的链接` : '没有快截止的'), 'campus', soon.length > 0 || todo > 0),
  ].join('');
  $('today-progress').textContent = '';
  if (!document.activeElement || document.activeElement.id !== 'today-kw') $('today-kw').value = d.keywords.join('，');
  $('today-boss').checked = d.boss; $('today-51').checked = d.job51; $('today-zl').checked = d.zhilian; $('today-big').checked = d.bigOnly;
  $('today-per').value = d.perKeyword;
  const rounds = d.keywords.length * ((d.boss ? 1 : 0) + (d.job51 ? 1 : 0)) + (d.zhilian ? 1 : 0);
  const mins = Math.round(d.keywords.length * (d.boss ? d.perKeyword * 12 + 20 : 0) / 60 + d.keywords.length * (d.job51 ? 0.5 : 0) + (d.zhilian ? 2 : 0));
  $('today-est').textContent = `共 ${rounds} 轮，预计 ${Math.max(1, mins)} 分钟左右（筛过的岗位不会重复看）`;
}

export function initToday() {
  initInbox();
  initReview();
  $('btn-today-run').onclick = runToday;
  $('btn-today-stop').onclick = () => { stopAll = true; requestStop(); status('手上这一轮跑完就停…'); };
  $('today-todo').addEventListener('click', (e) => {
    const r = e.target.closest('[data-go]');
    if (!r) return;
    if (r.dataset.go === 'inbox') { $('inbox-list').scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    document.querySelector(`.tab[data-tab="${r.dataset.go}"]`)?.click();
  });
  const save = async () => {
    await setDaily({
      keywords: $('today-kw').value.split(/[,，、\s]+/).map((x) => x.trim()).filter(Boolean),
      boss: $('today-boss').checked, job51: $('today-51').checked, zhilian: $('today-zl').checked, bigOnly: $('today-big').checked,
      perKeyword: Math.max(1, Math.min(30, parseInt($('today-per').value, 10) || 8)),
    });
    renderToday();
  };
  for (const id of ['today-kw', 'today-boss', 'today-51', 'today-zl', 'today-big', 'today-per']) $(id).addEventListener('change', save);
  chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && (ch.runtime || ch.campus || ch.afTodo || ch.hrInbox)) renderToday(); });
  renderToday();
}

// ---------------------------------------------------------------- HR 消息（BOSS 聊天列表，只读）


const KIND_CLS = { 约面试: 'k-面试', 要简历: 'k-简历', 问问题: 'k-问题', 拒绝: 'k-拒绝' };
const ORDER = { 约面试: 0, 要简历: 1, 问问题: 2, 主动邀约: 3, 拒绝: 8, '系统/无关': 9 };

async function renderInbox() {
  const { hrInbox } = await chrome.storage.local.get('hrInbox');
  if (!hrInbox) { $('inbox-list').innerHTML = '<p class="hint">点「看新消息」读一下 BOSS 聊天列表（不会点开会话，HR 那边看不到已读）。</p>'; return; }
  const items = [...hrInbox.items].sort((a, b) => ((a.ai?.worth === '别理') - (b.ai?.worth === '别理')) || (ORDER[a.ai?.kind] ?? 5) - (ORDER[b.ai?.kind] ?? 5));
  const good = items.filter((x) => x.ai && x.ai.worth !== '别理' && x.ai.kind !== '拒绝');
  const rest = items.filter((x) => !good.includes(x));
  const row = (x) => `<div class="ib ${good.includes(x) ? '' : 'dim'}">
    <div class="top"><span class="kind ${KIND_CLS[x.ai?.kind] || ''}">${esc(x.ai?.kind || '?')}</span><b>${esc(x.company)}</b><span>${esc(x.name)}${x.unread ? ` · ${x.unread} 条未读` : ''}</span><time>${esc(x.time)}</time></div>
    <div class="msg">「${esc(x.last.slice(0, 80))}」</div>
    ${x.ai?.next ? `<div class="next"><b>下一步</b>　${esc(x.ai.next)}</div>` : ''}
    ${x.ai?.reply ? `<textarea readonly>${esc(x.ai.reply)}</textarea><div class="row"><button data-copy="${esc(x.ai.reply)}">复制回复</button><button data-openchat>去聊天页</button></div>` : ''}
  </div>`;
  $('inbox-list').innerHTML = (good.length ? good.map(row).join('') : '<p class="hint">没有值得跟的新消息。</p>')
    + (rest.length ? `<details><summary class="hint">拒绝 / 不对口 / 可疑的 ${rest.length} 条（已记进公司档案）</summary>${rest.map(row).join('')}</details>` : '');
  $('inbox-status').textContent = `${new Date(hrInbox.at).toLocaleString('zh-CN')} 读的：${hrInbox.total} 个会话，${hrInbox.waitingMe} 个是 HR 最后说话，值得跟 ${good.length} 个`;
}

export function initInbox() {
  $('btn-inbox').onclick = async () => {
    $('btn-inbox').disabled = true;
    $('inbox-status').textContent = '在后台读 BOSS 聊天列表、让 DeepSeek 分类…（10 秒左右）';
    try { await refreshInbox(await getConfig()); } catch (e) { $('inbox-status').textContent = e.message; }
    $('btn-inbox').disabled = false;
    renderInbox();
  };
  $('inbox-list').addEventListener('click', async (e) => {
    const c = e.target.closest('[data-copy]');
    if (c) { await navigator.clipboard.writeText(c.dataset.copy).catch(() => {}); c.textContent = '已复制'; return; }
    if (e.target.closest('[data-openchat]')) chrome.tabs.create({ url: 'https://www.zhipin.com/web/geek/chat', active: true });
  });
  renderInbox();
}

// ---------------------------------------------------------------- 投过的回顾（v1.0.9）

const GROUPS = [[0, '要你接'], [1, 'HR 回了'], [2, '可以跟一句'], [3, '在等'], [4, '没动静'], [5, '婉拒'], [6, '51job / 智联 / 网申']];

async function renderReview() {
  const rv = await getReview();
  if (!rv) { $('review-list').innerHTML = '<p class="hint">点「回顾」看之前投过的每一家现在什么状态（读 BOSS 聊天列表，不点开会话）。每天第一次点「筛今天的岗位」也会先自动回顾一遍。</p>'; $('review-status').textContent = ''; return; }
  const date = (t) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()}`; };
  const row = (r) => `<div class="rv ${r.level >= 5 ? 'dim' : ''}">
    <span class="st st-${r.level}">${esc(r.state)}</span><b title="${esc(r.company)}">${esc(r.company)}</b><time>${date(r.at)} · ${r.days} 天</time>
    <div class="sub">${esc(r.channel)} · ${esc(r.title)}${r.salary ? ' · ' + esc(r.salary) : ''}${r.last ? ' ｜「' + esc(r.last.replace(/^\[(送达|已读|未读)\]\s*/, '').slice(0, 40)) + '」' : ''}</div>
    <div class="nx">${esc(r.next)}${r.level < 5 ? ` <button class="sm ghost" data-drop="${esc(r.company)}" data-plat="${esc(r.platform)}" title="这家不跟了，以后回顾里不再提醒">放掉</button>` : ''}</div>
  </div>`;
  const html = GROUPS.map(([lv, name]) => {
    const rs = rv.rows.filter((r) => r.level === lv);
    if (!rs.length) return '';
    const body = rs.map(row).join('');
    return lv >= 5 ? `<details><summary class="rv-group">${name} ${rs.length}</summary>${body}</details>` : `<div class="rv-group">${name} ${rs.length}</div>${body}`;
  }).join('');
  $('review-list').innerHTML = html || '<p class="hint">今天以前还没投过。</p>';
  const n = (lv) => rv.rows.filter((r) => r.level === lv).length;
  $('review-status').textContent = `${new Date(rv.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · 之前投了 ${rv.rows.length} 家${n(0) ? `，${n(0)} 家提到面试` : ''}${n(1) ? `，${n(1)} 家 HR 回了` : ''}`;
}

function initReview() {
  $('btn-review').onclick = async () => {
    $('btn-review').disabled = true;
    $('review-status').textContent = '在后台读 BOSS 聊天列表…（10 秒左右）';
    try { await refreshInbox(await getConfig()); } catch (e) { $('review-status').textContent = e.message; }
    $('btn-review').disabled = false;
    renderReview(); renderInbox();
  };
  $('btn-review-csv').onclick = async () => {
    const rv = await getReview();
    if (!rv) { $('review-status').textContent = '先点「回顾」'; return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([reviewCsv(rv)], { type: 'text/csv;charset=utf-8' }));
    const d = new Date(rv.at);
    a.download = `投过的回顾-${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  $('review-list').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-drop]');
    if (b) { b.disabled = true; await dropCompany(b.dataset.drop, b.dataset.plat); }
  });
  chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.review) renderReview(); });
  renderReview();
}
