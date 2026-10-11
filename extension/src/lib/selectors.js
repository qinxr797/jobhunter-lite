/**
 * BOSS直聘 DOM 选择器集中配置。
 *
 * 页面改版时只需要改这个文件，其他逻辑不用动。
 * 每一项都是「候选数组」，按顺序尝试，命中第一个就用；全都不中才算失效。
 * 侧边栏的「选择器体检」会在当前页面跑一遍，报告哪些失效了。
 *
 * v0.2.0：第一个候选都是 2026-09-24 在真实页面上核对过的，后面的是旧猜测，留作兜底。
 */

export const SELECTORS = {
  // ---- 岗位列表页（/web/geek/jobs）----
  list: {
    card: ['.job-card-wrap', 'li.job-card-wrapper', '.job-card-box', 'ul.job-list-box > li'],
    // 以下相对 card 查找
    title: ['a.job-name', '.job-name', '[class*="jobName"]'],
    // 列表页薪资是防爬字体（私有区字符），读不出数字；真实薪资在详情页读
    salary: ['.job-salary', '.salary', '[class*="salary"]'],
    company: ['.boss-name', '.company-name', '[class*="companyName"]'],
    location: ['.company-location', '.job-area', '[class*="location"]'],
    // 经验 / 学历 标签（「在校/应届」「本科」）
    jobTags: ['.tag-list li', '.job-info ul li'],
    link: ['a.job-name', 'a[href*="/job_detail/"]'],
    alreadyChatted: ['.job-status', '[class*="chatted"]'],
  },

  // ---- 职位详情页（/job_detail/xxx.html）----
  detail: {
    title: ['.job-banner h1', 'h1', '.name h1'],
    // 详情页薪资是明文（「6-8K」），打招呼之前就能按薪资过滤
    salary: ['.job-banner .salary', 'span.salary', '.salary'],
    city: ['a.text-city', '.text-city'],
    experience: ['.text-experiece', '[class*="text-experi"]'],
    degree: ['.text-degree'],
    welfare: ['.job-banner .job-tags span', '.tag-all span'],
    jd: ['.job-sec-text', '.job-detail-section .text', '.job-sec .text'],
    // 侧栏公司链接；第一个 a 是 logo 没有字，所以用 ka 属性挑第二个
    company: ['.sider-company .company-info a[ka^="job-detail-company_"]', '.sider-company .company-info a:last-child'],
    // 公司基本信息（融资 / 规模 / 行业）
    companyInfo: ['.sider-company', '.company-info'],
    // 工商信息（全称 / 法人 / 成立日期 / 企业类型 / 经营状态 / 注册资金）——查公司靠它
    business: ['.business-info-box', '[class*="business-info"]'],
    address: ['.location-address', '.job-location'],
    // 招聘者：「王女士 刚刚活跃 安徽亚声威格 · 招聘者」—— 活跃时间能看出岗位是不是僵尸岗
    hr: ['.job-boss-info'],
    chatBtn: ['a.btn-startchat', '.btn-startchat', 'a[class*="startchat"]', '.op-btn-chat'],
    chatBtnChattedText: ['继续沟通', '继续聊'],
  },

  // ---- 聊天页（/web/geek/chat）----
  chat: {
    input: ['#chat-input', '.chat-input', 'div[contenteditable="true"]', 'textarea.input-area'],
    sendBtn: ['.btn-send', 'button[class*="send"]'],
    // 聊天窗口顶部：HR 名字 / 公司 / 岗位 / 薪资。用它核对没发错人
    currentJob: ['[class*="base-info"]', '.chat-header', '.title-box .name'],
    messageItem: ['[class*="message-item"]', '.chat-message li', '.im-list li'],
    limitHint: ['.dialog-container', '.boss-dialog', '[class*="limit"]'],
  },

  // ---- 全局风控信号 ----
  guard: {
    captcha: ['.geetest_panel', '#captcha', '.verify-wrap', '[class*="captcha"]', '.nc_wrapper'],
    loginWall: ['.sign-form', '.login-card', '.btn-login'],
  },
};

/** 文案关键词，比 class 名稳定得多，作为兜底 */
export const TEXT_HINTS = {
  chatBtn: ['立即沟通', '立刻沟通', '继续沟通'],
  chatted: ['继续沟通', '继续聊', '已沟通'],
  // 点「立即沟通」后弹窗「已向BOSS发送消息」里的按钮，点它才进聊天页
  continueChat: ['继续沟通'],
  send: ['发送'],
  limit: ['今日沟通人数已达上限', '沟通人数已达上限', '沟通已达上限', '操作过于频繁', '请求过于频繁', '访问过于频繁'],
  captcha: ['请完成安全验证', '安全验证', '滑动验证', '请完成验证'],
};

/** 在 root 下按候选顺序找第一个命中的元素 */
export function pick(root, candidates) {
  for (const sel of candidates) {
    try {
      const el = root.querySelector(sel);
      if (el) return el;
    } catch { /* 无效选择器，跳过 */ }
  }
  return null;
}

/** 找全部（第一个有结果的候选胜出，不做并集，避免重复） */
export function pickAll(root, candidates) {
  for (const sel of candidates) {
    try {
      const els = root.querySelectorAll(sel);
      if (els.length) return Array.from(els);
    } catch { /* ignore */ }
  }
  return [];
}

/** 按可见文本找元素（class 名变了也能找到） */
export function pickByText(root, texts, tagFilter = 'a,button,div,span') {
  const nodes = root.querySelectorAll(tagFilter);
  for (const node of nodes) {
    const t = (node.textContent || '').trim();
    if (t.length > 20) continue; // 按钮文案不会很长，排除大段容器
    if (texts.some((x) => t === x || t.includes(x))) return node;
  }
  return null;
}

/** 页面上是否存在任一文案 */
export function pageHasText(texts) {
  const body = document.body?.innerText || '';
  return texts.some((t) => body.includes(t));
}

/** 去掉防爬字体用的私有区字符，免得污染文本 */
const clean = (s) => (s || '').replace(/[\ue000-\uf8ff]/g, '').trim();

export function textOf(root, candidates) {
  const el = pick(root, candidates);
  return el ? clean(el.innerText || el.textContent) : '';
}

export function textsOf(root, candidates) {
  return pickAll(root, candidates)
    .map((el) => clean(el.innerText || el.textContent))
    .filter(Boolean);
}
