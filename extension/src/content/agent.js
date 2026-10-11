/**
 * 注入到 zhipin.com 所有页面的执行体。
 * 自己不做决策，只听侧边栏的指令干活：抓数据、报告按钮位置、核对聊天对象。
 *
 * 真正的点击和打字不在这里做：content script 的 element.click() 是「合成事件」，
 * BOSS 可能不认。侧边栏拿到坐标后用 chrome.debugger 发真实鼠标 / 键盘事件，
 * 和 2026-09-24 手动跑通的那套（纯 CDP，不 Runtime.enable）是同一个做法。
 *
 * 所有 DOM 选择都走 lib/selectors.js 的候选列表 + 文案兜底，BOSS 改版时改那个文件即可。
 */

let S = null; // selectors 模块，懒加载

async function sel() {
  if (!S) S = await import(chrome.runtime.getURL('src/lib/selectors.js'));
  return S;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const squash = (s) => String(s || '').replace(/[-]/g, '').replace(/\s+/g, ' ').trim();

/** 等某个条件成立，超时返回 null */
async function waitFor(fn, timeout = 8000, step = 250) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(step);
  }
  return null;
}

const visible = (el) => {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
};

/** 滚进视野后返回元素中心坐标（视口坐标，CDP 点击直接用） */
async function centerOf(el) {
  el.scrollIntoView({ block: 'center', inline: 'center' });
  await sleep(350);
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
}

// ---------------------------------------------------------------- 风控检查

async function guardCheck() {
  const s = await sel();
  const captchaEl = s.pick(document, s.SELECTORS.guard.captcha);
  const captchaText = s.pageHasText(s.TEXT_HINTS.captcha);
  const limitText = s.pageHasText(s.TEXT_HINTS.limit) || /今日沟通.{0,6}上限/.test(document.body?.innerText || '');
  const loginEl = s.pick(document, s.SELECTORS.guard.loginWall);

  // 窗口最小化 / 被完全挡住时页面进后台，BOSS 的弹窗不渲染，点了也白点
  const hidden = document.hidden;

  if ((captchaEl && visible(captchaEl)) || captchaText) return { blocked: true, kind: 'captcha', msg: '页面出现安全验证，已停机', hidden };
  if (limitText) return { blocked: true, kind: 'limit', msg: '平台提示沟通次数受限，已停机', hidden };
  if (loginEl && visible(loginEl) && !location.pathname.startsWith('/web/geek')) {
    return { blocked: true, kind: 'login', msg: '检测到登录页，请先登录 BOSS直聘', hidden };
  }
  return { blocked: false, hidden };
}

// ---------------------------------------------------------------- 列表页

async function scanList() {
  const s = await sel();
  const guard = await guardCheck();
  if (guard.blocked) return { error: guard.msg, guard };

  // 列表是懒加载的，先等卡片出现
  const ok = await waitFor(() => s.pickAll(document, s.SELECTORS.list.card).length > 0, 10000);
  if (!ok) {
    // 9/28 实测：BOSS 登录掉了时页面照样打开，只写「尝试登录查看全部职位」，别让你以为是插件坏了
    if (/尝试登录|登录\/注册|立即登录/.test(document.body?.innerText || '')) return { error: 'BOSS 没登录（页面写着「尝试登录查看全部职位」）—— 在这个 Chrome 里登录 BOSS 再点', jobs: [] };
    return { error: '没找到岗位卡片 —— 确认当前是岗位列表页（/web/geek/jobs）；如果是，跑一次「选择器体检」', jobs: [] };
  }

  const cards = s.pickAll(document, s.SELECTORS.list.card);
  const jobs = [];

  for (const card of cards) {
    const linkEl = s.pick(card, s.SELECTORS.list.link);
    const href = linkEl?.href || '';
    if (!href || !/job_detail/.test(href)) continue;

    // 岗位 id 在 URL 路径里；securityId 之类的参数每次都变，不能拿来去重
    const idMatch = href.match(/job_detail\/([^.?/]+)/);
    const jobId = idMatch ? idMatch[1] : href.split('?')[0];

    const chattedEl = s.pick(card, s.SELECTORS.list.alreadyChatted);
    const chattedByText = s.TEXT_HINTS.chatted.some((t) => (card.innerText || '').includes(t));
    const loc = s.textOf(card, s.SELECTORS.list.location); // 「合肥·蜀山区·明珠广场」

    jobs.push({
      jobId,
      href: href.split('?')[0],
      title: s.textOf(card, s.SELECTORS.list.title),
      // 列表薪资是防爬字体，这里基本只剩「-K」，真实薪资进详情页再读
      salary: s.textOf(card, s.SELECTORS.list.salary),
      company: s.textOf(card, s.SELECTORS.list.company),
      tags: s.textsOf(card, s.SELECTORS.list.jobTags),
      skills: [],
      city: loc,
      chatted: Boolean(chattedEl) || chattedByText,
    });
  }

  return { jobs, total: cards.length };
}

/**
 * 加载更多。新版列表页是「滚到底自动加载」，没有页码；老版有「下一页」按钮，两种都试。
 * 返回 { ok, added }
 */
async function nextPage() {
  const s = await sel();
  const count = () => s.pickAll(document, s.SELECTORS.list.card).length;
  const before = count();

  const btn = s.pickByText(document, ['下一页'], 'a,button');
  if (btn && visible(btn) && !btn.classList.contains('disabled')) {
    const firstBefore = s.pickAll(document, s.SELECTORS.list.card)[0]?.innerText || '';
    btn.click();
    const changed = await waitFor(() => (s.pickAll(document, s.SELECTORS.list.card)[0]?.innerText || '') !== firstBefore, 10000);
    return { ok: Boolean(changed), added: changed ? count() : 0, reason: changed ? '' : '点了下一页但内容没变' };
  }

  // 滚动加载：分几步滚到底，像人一样
  for (let i = 0; i < 4; i++) {
    window.scrollBy({ top: Math.round(window.innerHeight * (0.6 + Math.random() * 0.3)), behavior: 'smooth' });
    await sleep(500 + Math.random() * 400);
  }
  const last = s.pickAll(document, s.SELECTORS.list.card).pop();
  last?.scrollIntoView({ block: 'end' });
  window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });

  const grew = await waitFor(() => count() > before, 10000);
  if (!grew) return { ok: false, added: 0, reason: '滚到底没有加载出新岗位（可能到头了）' };
  return { ok: true, added: count() - before };
}

// ---------------------------------------------------------------- 详情页

async function readDetail() {
  const s = await sel();
  const guard = await guardCheck();
  if (guard.blocked) return { error: guard.msg, guard };

  const ok = await waitFor(() => s.pick(document, s.SELECTORS.detail.jd) || s.pick(document, s.SELECTORS.detail.title), 10000);
  if (!ok) return { error: '详情页没加载出内容' };
  // 工商信息、公司信息在页面下半截，稍等一下
  await waitFor(() => s.pick(document, s.SELECTORS.detail.business), 2500);

  const chatBtn = pickChatBtn(s);
  const chatBtnText = chatBtn ? (chatBtn.innerText || '').trim() : '';

  // 公司名：侧栏公司链接（第一个 a 是 logo 没有字，按 title 属性兜底）
  let company = s.textOf(document, s.SELECTORS.detail.company);
  if (!company) company = document.querySelector('.sider-company .company-info a[title]')?.getAttribute('title') || '';

  const experience = s.textOf(document, s.SELECTORS.detail.experience);
  const degree = s.textOf(document, s.SELECTORS.detail.degree);

  return {
    title: s.textOf(document, s.SELECTORS.detail.title),
    salary: s.textOf(document, s.SELECTORS.detail.salary),
    company,
    city: s.textOf(document, s.SELECTORS.detail.city),
    address: s.textOf(document, s.SELECTORS.detail.address),
    tags: [experience, degree].filter(Boolean),
    welfare: [...new Set(s.textsOf(document, s.SELECTORS.detail.welfare))].join('、'),
    jd: s.textOf(document, s.SELECTORS.detail.jd),
    companyInfo: squash(s.textOf(document, s.SELECTORS.detail.companyInfo)).replace(/^公司基本信息\s*/, '').replace(/\s*查看全部职位$/, ''),
    business: squash(s.textOf(document, s.SELECTORS.detail.business)).replace(/\s*查看全部$/, ''),
    hr: squash(s.textOf(document, s.SELECTORS.detail.hr)),
    // HR 多久没上线（9/28 真页面核对：.boss-active-time 写「刚刚活跃 / 本周活跃 / 半年前活跃」）
    hrActive: squash(document.querySelector('.boss-active-time, [class*="active-time"]')?.innerText || ''),
    hasChatBtn: Boolean(chatBtn),
    // 按钮写着「继续沟通」说明之前聊过了
    alreadyChatted: s.TEXT_HINTS.chatted.some((t) => chatBtnText.includes(t)),
    url: location.href,
  };
}

function pickChatBtn(s) {
  const all = s.pickAll(document, s.SELECTORS.detail.chatBtn).filter(visible);
  return all[0] || s.pickByText(document, s.TEXT_HINTS.chatBtn, 'a,button');
}

// ---------------------------------------------------------------- 按钮定位（给侧边栏做真实点击用）

/**
 * what:
 *   chatBtn       详情页「立即沟通」
 *   continueChat  点完立即沟通后弹窗「已向BOSS发送消息」里的「继续沟通」
 *   sendBtn       聊天页可用状态的「发送」
 *   formDialog    有没有弹出要填附加信息 / 问卷的框
 */
async function locate({ what }) {
  const s = await sel();
  const guard = await guardCheck();
  if (guard.blocked) return { found: false, error: guard.msg, guard };

  if (what === 'chatBtn') {
    const btn = pickChatBtn(s);
    if (!btn) return { found: false, error: '找不到「立即沟通」按钮', hidden: guard.hidden };
    const label = (btn.innerText || '').trim();
    const chatted = s.TEXT_HINTS.chatted.some((t) => label.includes(t));
    return { found: true, chatted, label, redirect: btn.getAttribute('redirect-url') || '', hidden: guard.hidden, ...(await centerOf(btn)) };
  }

  if (what === 'continueChat') {
    const cands = [...document.querySelectorAll('a, button, span, div')].filter((x) =>
      x.children.length <= 1 && visible(x) && s.TEXT_HINTS.continueChat.includes((x.innerText || '').trim()));
    // 优先弹窗里的那个（详情页的按钮点完也会变成「继续沟通」，不能点它）
    const inDialog = cands.filter((x) => x.closest('[class*="dialog"], [class*="popup"], [class*="modal"], [class*="layer"], [class*="greet"]'));
    const el = inDialog.pop() || cands.filter((x) => !x.closest('.btn-startchat, .op-btn-chat, .job-banner')).pop();
    if (!el) return { found: false, hidden: guard.hidden };
    const r = el.getBoundingClientRect(); // 弹窗是 fixed 定位，不用滚
    return { found: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }

  if (what === 'sendBtn') {
    const btn = s.pick(document, s.SELECTORS.chat.sendBtn);
    if (!btn || !visible(btn) || /disabled/.test(btn.className)) return { found: false };
    const r = btn.getBoundingClientRect();
    return { found: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }

  // v1.0.2（9/29 实测）：BOSS 点完「立即沟通」弹的是小聊天框 .startchat-dialog：
  // 顶部 HR 名字 + 「公司·职务」，已发的默认招呼，下面 textarea + 「发送」（没字时带 disable）
  if (what === 'startDialog' || what === 'startDialogSend') {
    const box = [...document.querySelectorAll('.startchat-dialog')].find(visible);
    if (!box) return { found: false };
    const el = what === 'startDialog' ? box.querySelector('textarea') : box.querySelector('.send-message');
    if (!el || !visible(el)) return { found: false };
    const r = el.getBoundingClientRect();
    return {
      found: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
      header: squash(box.querySelector('.dialog-title')?.innerText || ''),
      disabled: /disable/.test(el.className),
      inputText: box.querySelector('textarea')?.value || '',
      messages: [...box.querySelectorAll('.message-item')].map((m) => squash(m.innerText)),
    };
  }

  if (what === 'formDialog') {
    // body 在弹框时会带 dialog-open 类、JD 里常有「填写」二字 —— 只看真弹框，排除 body 和上面的小聊天框
    const box = [...document.querySelectorAll('[class*="dialog"], [class*="popup"], [class*="modal"]')]
      .find((e) => e !== document.body && e !== document.documentElement && !e.closest('.startchat-dialog') && !e.querySelector('.startchat-dialog')
        && visible(e) && e.offsetHeight < window.innerHeight * 0.95 && /填写|问卷|附加信息|请回答|完善信息/.test(e.innerText || ''));
    return { found: Boolean(box), text: box ? squash(box.innerText).slice(0, 200) : '' };
  }

  return { found: false, error: `未知目标 ${what}` };
}

// ---------------------------------------------------------------- 聊天页

/** 聊天窗口顶部（HR 名字 / 公司 / 岗位 / 薪资）。左边会话列表里的条目要排除掉 */
function chatHeader(s) {
  const els = s.pickAll(document, s.SELECTORS.chat.currentJob)
    .filter((e) => visible(e) && !e.closest('li'));
  return els.map((e) => squash(e.innerText)).filter(Boolean).join(' | ');
}

/**
 * 核对当前聊天窗口是不是预期的那家公司 / 岗位，顺便报输入框里还剩什么。
 * 发错人比漏发严重得多：header 读不到就当对不上。
 */
async function chatState({ expectTitle, expectCompany } = {}) {
  const s = await sel();
  const header = chatHeader(s);
  const norm = (x) => String(x || '').replace(/[\s·、（）()【】[\]|｜]/g, '');
  const h = norm(header);
  const match = Boolean(h) && (
    (expectCompany && h.includes(norm(expectCompany))) ||
    (expectTitle && h.includes(norm(expectTitle)))
  );
  const input = s.pick(document, s.SELECTORS.chat.input);
  return {
    path: location.pathname,
    header,
    match,
    hasInput: Boolean(input),
    inputText: input ? (input.value ?? input.innerText ?? '').trim() : '',
    salary: (header.match(/\d+(?:\.\d+)?-\d+(?:\.\d+)?[Kk][^ |]*/) || [''])[0],
  };
}

/** 聚焦输入框并全选里面的内容（有草稿的话，接下来的输入会整段替换掉） */
async function focusInput() {
  const s = await sel();
  const input = await waitFor(() => s.pick(document, s.SELECTORS.chat.input), 10000);
  if (!input) return { ok: false, error: '聊天输入框没找到' };
  input.focus();
  if (input.isContentEditable) {
    const r = document.createRange();
    r.selectNodeContents(input);
    const sel2 = getSelection();
    sel2.removeAllRanges();
    sel2.addRange(r);
  } else if (input.select) {
    input.select();
  }
  return { ok: true };
}

// ---------------------------------------------------------------- 选择器体检

async function healthCheck() {
  const s = await sel();
  const path = location.pathname;
  const kind = /job_detail/.test(path) ? 'detail' : /chat/.test(path) ? 'chat' : 'list';

  const group = s.SELECTORS[kind];
  const results = [];

  for (const [key, candidates] of Object.entries(group)) {
    if (!Array.isArray(candidates) || typeof candidates[0] !== 'string') continue;
    if (key === 'chatBtnChattedText') continue;

    let hitSel = null;
    let count = 0;
    for (const c of candidates) {
      try {
        const els = document.querySelectorAll(c);
        if (els.length) { hitSel = c; count = els.length; break; }
      } catch { /* 无效选择器 */ }
    }
    results.push({ field: key, ok: Boolean(hitSel), matched: hitSel, count, candidates: candidates.length });
  }

  return { pageKind: kind, url: location.href, results };
}

// ---------------------------------------------------------------- 消息路由

const HANDLERS = {
  ping: async () => ({ pong: true, url: location.href }),
  guardCheck,
  scanList,
  nextPage,
  readDetail,
  locate,
  chatState,
  focusInput,
  healthCheck,
};

// 侧边栏找不到内容脚本时会手动再注入一次，防止重复注册监听
if (!globalThis.__bossAgentLoaded) {
  globalThis.__bossAgentLoaded = true;
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const fn = HANDLERS[msg?.action];
    if (!fn) return false;
    Promise.resolve(fn(msg.payload || {}))
      .then(sendResponse)
      .catch((e) => sendResponse({ error: String(e?.message || e) }));
    return true; // 异步响应
  });
}
