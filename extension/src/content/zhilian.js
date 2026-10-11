/**
 * 智联招聘页面执行体。只听侧边栏指令：读数据、报按钮坐标，不自己点。
 *
 * - 消息页（i.zhaopin.com/im）：重放页面刚调过的 getTalkList 接口，拿 HR 主动发来的会话
 *   （selfReply=0 = 你还没回过），里面有职位编号、公司、职位名、薪资、地址。
 * - 职位详情页（www.zhaopin.com/jobdetail/编号.htm）：读职位描述、工商信息，找「立即投递」。
 *   HR 发「想要一份你的简历」时，在详情页点立即投递就等于把简历给了他。
 *
 * 2026-09-27 按真实页面核对。
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const visible = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const text = (sel) => { const e = document.querySelector(sel); return e ? (e.innerText || '').trim() : ''; };

/** 当前可见弹窗的文字。页面常驻的空浮层（「暂无内容」之类）也会被选中，所以点投递前先记一份基线 */
function dialogTexts() {
  return [...document.querySelectorAll('[class*="dialog"], [class*="modal"], [role="dialog"], [class*="popup"], [class*="drawer"]')]
    .filter(visible).map((d) => squash(d.innerText).slice(0, 300)).filter((t) => t && !/^暂无内容$/.test(t));
}
let dialogBase = new Set();

function guardCheck() {
  const t = document.body?.innerText || '';
  const hidden = document.hidden;
  if (/正在验证连接安全性|请勾选下方复选框|滑动验证|安全验证/.test(t) && t.length < 800) return { blocked: true, kind: 'captcha', msg: '智联弹出了安全验证，已停机。去页面上手动过一下再继续', hidden };
  if (/请登录|扫码登录/.test(t) && t.length < 800) return { blocked: true, kind: 'login', msg: '智联没登录，先登录', hidden };
  return { blocked: false, hidden };
}

function lastTalkApi() {
  const urls = performance.getEntriesByType('resource').map((e) => e.name).filter((u) => /imapi\/imV2\/getTalkList/.test(u));
  return urls.pop() || null;
}

/** HR 主动发来、你还没回的会话 → 统一成岗位 */
async function scanInvites({ pages = 2 } = {}) {
  const g = guardCheck();
  if (g.blocked) return { error: g.msg, guard: g };
  if (!/i\.zhaopin\.com\/im/.test(location.href)) return { error: '请先打开智联的「消息」页（右上角消息），停在那里再点开始', jobs: [] };
  let api = lastTalkApi();
  for (let i = 0; i < 20 && !api; i++) { await sleep(500); api = lastTalkApi(); }
  if (!api) return { error: '没找到会话数据，刷新一下消息页再试', jobs: [] };
  const all = [];
  for (let p = 1; p <= pages; p++) {
    const u = new URL(api);
    u.searchParams.set('pageNo', String(p));
    const r = await fetch(u.toString(), { credentials: 'include' });
    const j = await r.json().catch(() => null);
    const list = j?.data || [];
    all.push(...list);
    if (list.length < 20) break;
  }
  const jobs = all
    .filter((s) => s.jobNumber && Number(s.selfReply) === 0 && !s.blocked && !s.inappropriateC)
    .map((s) => ({
      platform: 'zhilian',
      jobId: s.jobNumber,
      href: `https://www.zhaopin.com/jobdetail/${s.jobNumber}.htm`,
      title: s.jobTitle || '',
      company: s.companyName || '',
      salary: s.salary || '',
      city: s.address || '',
      tags: [],
      hr: s.staffName || '',
      invite: true,
      sessionId: s.sessionid || '',
      chatted: false,
    }));
  return { jobs, total: all.length };
}

/** 职位详情页 */
async function readDetail() {
  const g = guardCheck();
  if (g.blocked) return { error: g.msg, guard: g };
  for (let i = 0; i < 20 && !document.querySelector('.describtion-card__detail-content, h1'); i++) await sleep(500);
  if (!document.querySelector('h1')) return { error: '详情页没加载出来' };
  const info = squash(text('.summary-planes__info'));
  const applyBtn = [...document.querySelectorAll('.job-apply-button, .summary-planes__action button, button')].find((b) => visible(b) && /投递/.test(b.innerText));
  const label = applyBtn ? applyBtn.innerText.trim() : '';
  // 工作地点 / 工商信息 在正文里按小标题切
  const body = document.body.innerText;
  const cut = (head, next) => { const i = body.indexOf(head); if (i < 0) return ''; const rest = body.slice(i + head.length); const j = next.map((n) => rest.indexOf(n)).filter((x) => x > 0).sort((a, b) => a - b)[0]; return squash(rest.slice(0, j || 300)); };
  return {
    title: text('h1'),
    salary: squash(text('.summary-planes__salary')),
    city: info.split(' ').slice(0, 2).join(' '),
    tags: info.split(' ').slice(2),
    welfare: squash([...document.querySelectorAll('.job-features__value, .describtion-card__skills span, .highlights span')].map((e) => e.innerText).join('、')).slice(0, 200),
    jd: (text('.describtion-card__detail-content') || '').slice(0, 3000),
    company: squash(text('.company-info__name')),
    companyInfo: squash(text('.company-info__desc')),
    business: cut('工商信息', ['查看全部信息', '认证资质', '以担保']),
    address: cut('工作地点', ['公司信息', '查看地图']),
    hasChatBtn: Boolean(applyBtn),
    alreadyChatted: /已投递|已申请/.test(label),
    url: location.href,
  };
}

async function locateApply() {
  const g = guardCheck();
  if (g.blocked) return { found: false, error: g.msg, guard: g };
  let btn = null;
  for (let i = 0; i < 20 && !btn; i++) {
    btn = [...document.querySelectorAll('.job-apply-button, .summary-planes__action button, button, a')].find((b) => visible(b) && /立即投递|投递简历|申请职位|已投递/.test((b.innerText || '').trim()) && (b.innerText || '').trim().length < 8);
    if (!btn) await sleep(500);
  }
  if (!btn) return { found: false, error: '详情页上找不到「立即投递」' };
  const label = btn.innerText.trim();
  dialogBase = new Set(dialogTexts());
  btn.scrollIntoView({ block: 'center' });
  await sleep(400);
  const r = btn.getBoundingClientRect();
  return { found: true, label, applied: /已投递|已申请/.test(label), hidden: g.hidden, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
}

function locateText({ texts, dialogOnly, contains }) {
  const nodes = [...document.querySelectorAll('button, a, span, div, li, label')].filter((e) => {
    if (!visible(e)) return false;
    const t = (e.innerText || '').trim();
    if (!t || t.length > 30) return false;
    if (!texts.some((x) => (contains ? t.includes(x) : t === x))) return false;
    if ([...e.children].some((c) => texts.some((x) => ((c.innerText || '').trim() === x)))) return false;
    if (dialogOnly && !e.closest('[class*="dialog"], [class*="modal"], [class*="popup"], [role="dialog"], [class*="drawer"]')) return false;
    return true;
  });
  const el = nodes.pop();
  if (!el) return { found: false };
  const r = el.getBoundingClientRect();
  return { found: true, text: el.innerText.trim(), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
}

function applyState() {
  const dialogs = dialogTexts().filter((t) => !dialogBase.has(t));
  const toast = [...document.querySelectorAll('[class*="toast"], [class*="message"], [class*="tips"]')].filter(visible)
    .map((e) => squash(e.innerText)).filter((t) => t && t.length < 60 && !/^(消息\s*)?\d+$/.test(t));
  const btn = [...document.querySelectorAll('.job-apply-button, .summary-planes__action button, button')].find((b) => visible(b) && /投递/.test(b.innerText));
  return { dialogs, toast, success: /投递成功|申请成功|已投递/.test(dialogs.join(' ') + toast.join(' ') + (btn ? btn.innerText : '')) };
}

const HANDLERS = {
  ping: async () => ({ pong: true, url: location.href, platform: 'zhilian' }),
  guardCheck: async () => guardCheck(),
  scanInvites,
  readDetail,
  locateApply,
  locateText: async (p) => locateText(p),
  applyState: async () => applyState(),
};

if (!globalThis.__zhilianAgentLoaded) {
  globalThis.__zhilianAgentLoaded = true;
  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    const fn = HANDLERS[msg?.action];
    if (!fn) return false;
    Promise.resolve(fn(msg.payload || {})).then(sendResponse).catch((e) => sendResponse({ error: String(e?.message || e) }));
    return true;
  });
}
