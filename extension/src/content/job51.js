/**
 * 前程无忧（51job）页面执行体。只听侧边栏指令：读数据、报按钮坐标，不自己点。
 *
 * 搜索结果页（we.51job.com/pc/search）自己会调 /api/job/search-pc，返回里就带职位描述、公司、HR、
 * 薪资明文和「是否已投递」。这里直接重放页面刚调过的那个接口，不用一个个开详情页
 * （详情页 jobs.51job.com 容易弹滑块验证）。
 *
 * 2026-09-27 按真实页面核对：卡片 .joblist-item，卡片里 [sensorsdata] 带 jobId，投递按钮 button.btn.apply。
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const visible = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
const parseArr = (s) => { try { return Array.isArray(s) ? s : JSON.parse(s || '[]'); } catch { return []; } };

/** 当前可见弹窗的文字。页面常驻的空浮层（「暂无内容」之类）也会被选中，所以点投递前先记一份基线 */
function dialogTexts() {
  return [...document.querySelectorAll('[class*="dialog"], [class*="modal"], [role="dialog"], .el-message-box, [class*="popup"]')]
    .filter(visible).map((d) => (d.innerText || '').replace(/\s+/g, ' ').slice(0, 300)).filter((t) => t && !/^暂无内容$/.test(t));
}
let dialogBase = new Set();

function guardCheck() {
  const t = document.body?.innerText || '';
  const hidden = document.hidden;
  if (/访问验证|滑动验证|请按住滑块|安全验证/.test(t) && t.length < 600) return { blocked: true, kind: 'captcha', msg: '51job 弹出了滑块验证，已停机。去页面上手动拖一下再继续', hidden };
  if (/登录前程无忧|请先登录/.test(t) && !document.querySelector('.joblist-item')) return { blocked: true, kind: 'login', msg: '51job 没登录，先登录', hidden };
  return { blocked: false, hidden };
}

/** 页面刚调过的搜索接口地址（带着当前的关键词、城市、页码） */
function lastSearchApi() {
  const urls = performance.getEntriesByType('resource').map((e) => e.name).filter((u) => /\/api\/job\/search-pc/.test(u));
  return urls.pop() || null;
}

function normalize(it) {
  const tags = parseArr(it.jobTags);
  // 10/16 REA 逆向：搜索接口每条还带 jobWelfareCodeDataList（「周末双休」「五险一金」…），以前只读 jobTags（多半只有经验和学历），
  // 模型常常看不到双休。合进福利里一起给模型，并单独标出休息制度，不用再开详情页（详情页会弹滑块）
  const perks = (Array.isArray(it.jobWelfareCodeDataList) ? it.jobWelfareCodeDataList : []).map((w) => w.chineseTitle).filter(Boolean);
  const rest = perks.concat(tags).find((t) => /双休|单休|大小周|做六休一|轮休/.test(t)) || '';
  return {
    platform: '51job',
    jobId: '51job-' + it.jobId, // 加前缀，免得和 BOSS / 智联的编号撞车
    rawId: String(it.jobId),
    href: it.jobHref || '',
    listUrl: location.href,
    title: it.jobName || '',
    company: it.companyName || it.fullCompanyName || '',
    fullCompany: it.fullCompanyName || '',
    salary: it.provideSalaryString || '',
    city: it.jobAreaString || '',
    tags: [it.workYearString, it.degreeString].filter(Boolean),
    welfare: [...new Set(tags.filter((t) => t !== it.workYearString && t !== it.degreeString).concat(perks))].join('、'),
    rest,
    jd: it.jobDescribe || '',
    companyInfo: [it.companyTypeString, it.companySizeString, it.companyIndustryType1Str, it.companyIndustryType2Str].filter(Boolean).join(' · '),
    hr: [it.hrName, it.hrPosition, it.hrIsOnline === 'true' ? '在线' : ''].filter(Boolean).join(' '),
    term: it.termStr || '',
    chatted: String(it.isApply) === '1',
    issued: it.issueDateString || it.updateDateTime || '',
  };
}

async function scanList() {
  const g = guardCheck();
  if (g.blocked) return { error: g.msg, guard: g };
  if (!/we\.51job\.com\/pc\/search/.test(location.href)) return { error: '请先在 51job 搜索职位（选好城市），停在搜索结果页再点开始', jobs: [] };
  let api = lastSearchApi();
  for (let i = 0; i < 20 && !api; i++) { await sleep(500); api = lastSearchApi(); }
  if (!api) return { error: '没找到这一页的搜索数据，刷新一下搜索结果页再试', jobs: [] };
  const r = await fetch(api, { credentials: 'include' });
  const j = await r.json().catch(() => null);
  const items = j?.resultbody?.job?.items || [];
  // 分页条会显示几十页，但接口 totalCount 往往只有几十条，后面的页是空的 = 翻到头了
  if (!items.length && j?.resultbody?.job) return { jobs: [], end: true, total: 0 };
  if (!items.length) return { error: '这一页没有职位数据（或者接口改了）', jobs: [] };
  return { jobs: items.map(normalize), total: items.length };
}

/** 翻下一页：点分页里的「下一页」按钮，等搜索接口重新调用 */
async function nextPage() {
  const before = lastSearchApi();
  // 只认 el-pagination 的 button.btn-next；[class*="next"] 会误中「向后跳 5 页」的 btn-quicknext
  const btn = [...document.querySelectorAll('.el-pagination button.btn-next')].find((e) => visible(e) && !e.disabled && !/disabled/.test(e.className));
  if (!btn) return { ok: false, reason: '没有下一页了' };
  btn.click();
  for (let i = 0; i < 30; i++) {
    await sleep(400);
    const now = lastSearchApi();
    if (now && now !== before) { await sleep(1200); return { ok: true }; }
  }
  return { ok: false, reason: '点了下一页但没加载出新数据' };
}

const curPage = () => Number(document.querySelector('.el-pagination .number.active')?.innerText) || 1;

/**
 * 找「投递」按钮坐标。发送时开的是职位详情页（jobs.51job.com/…/编号.html），按钮 .apply-btn-new 的 id 就是职位编号。
 * 不回搜索页找卡片：51job 每次搜索排序都会变，重开一次第 2 页就是另一批岗位了（9/27 实测）。
 * 搜索页卡片那条路留着兜底（你停在搜索页手动触发时）。
 */
async function locateApply({ jobId }) {
  const g = guardCheck();
  if (g.blocked) return { found: false, error: g.msg, guard: g };
  const onDetail = /jobs\.51job\.com/.test(location.href);
  for (let i = 0; i < 20; i++) {
    let btn = null;
    if (onDetail) {
      btn = document.getElementById(String(jobId));
      if (!btn || !visible(btn)) btn = [...document.querySelectorAll('.apply-btn-new, .jobapply-wrapper, .op a, .op div')].find((b) => visible(b) && /^(立即投递|已投递|已申请|申请职位)$/.test((b.innerText || '').trim()));
    } else {
      const card = [...document.querySelectorAll('.joblist-item')].find((c) => {
        const s = c.querySelector('[sensorsdata]');
        try { return s && String(JSON.parse(s.getAttribute('sensorsdata')).jobId) === String(jobId); } catch { return false; }
      });
      if (card) btn = card.querySelector('button.apply, button.btn.apply') || [...card.querySelectorAll('button')].find((b) => /投递/.test(b.innerText));
    }
    if (btn) {
      const label = btn.innerText.trim();
      dialogBase = new Set(dialogTexts());
      btn.scrollIntoView({ block: 'center' });
      await sleep(400);
      const r = btn.getBoundingClientRect();
      return { found: true, label, applied: /已投|已申请/.test(label), hidden: g.hidden, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    }
    await sleep(500);
  }
  return { found: false, error: onDetail ? '详情页上找不到「立即投递」（可能职位已下线）' : '当前搜索页上找不到这个职位' };
}

/** 页面上可见、文字等于 texts 之一的元素（弹窗按钮、附件名等）；within 限定在弹窗里 */
function locateText({ texts, dialogOnly, contains }) {
  const nodes = [...document.querySelectorAll('button, a, span, div, li, label')].filter((e) => {
    if (!visible(e)) return false;
    const t = (e.innerText || '').trim();
    if (!t || t.length > 30) return false;
    const hit = texts.some((x) => (contains ? t.includes(x) : t === x));
    if (!hit) return false;
    if ([...e.children].some((c) => texts.some((x) => ((c.innerText || '').trim() === x)))) return false;
    if (dialogOnly && !e.closest('[class*="dialog"], [class*="modal"], [class*="popup"], [role="dialog"], .el-message-box')) return false;
    return true;
  });
  const el = nodes.pop();
  if (!el) return { found: false };
  const r = el.getBoundingClientRect();
  return { found: true, text: el.innerText.trim(), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
}

/** 投递之后页面在说什么：成功提示 / 弹窗里的按钮和选项 */
function applyState() {
  const dialogs = dialogTexts().filter((t) => !dialogBase.has(t));
  const toast = [...document.querySelectorAll('.el-message, [class*="toast"], [class*="message"]')].filter(visible)
    .map((e) => e.innerText.trim()).filter((t) => t && t.length < 60 && !/^(消息\s*)?\d+$/.test(t));
  const body = document.body.innerText;
  return { dialogs, toast, success: /投递成功|申请成功|已投递|已成功投递/.test(dialogs.join(' ') + toast.join(' ')), bodyHasApplied: /已投递/.test(body) };
}

const HANDLERS = {
  ping: async () => ({ pong: true, url: location.href, platform: '51job' }),
  guardCheck: async () => guardCheck(),
  scanList,
  nextPage,
  locateApply,
  locateText: async (p) => locateText(p),
  applyState: async () => applyState(),
};

if (!globalThis.__job51AgentLoaded) {
  globalThis.__job51AgentLoaded = true;
  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    const fn = HANDLERS[msg?.action];
    if (!fn) return false;
    Promise.resolve(fn(msg.payload || {})).then(sendResponse).catch((e) => sendResponse({ error: String(e?.message || e) }));
    return true;
  });
}
