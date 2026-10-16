/**
 * 查公司（v0.8.0，2026-09-28 你要求）：你输入单位名字，插件去搜，告诉他这家公司咋样。
 *
 * 数据从哪来（9/28 实测）：
 *   - 百度搜索：真浏览器里不登录就能出结果（工商卡片摘要、新闻、看准 / 知乎 / 职友集的员工评价摘要）。
 *     node 直接请求会被百度安全验证拦，所以在你自己的 Chrome 里后台开标签读页面（跟他自己搜一样，只读）。
 *   - 企查查：不登录只给登录页。你在这个 Chrome 登过企查查，就顺带读搜索结果第一家（法人、注册资本、成立日期、状态、标签）；没登录就跳过、说一声。
 *   - 插件自己已有的：公司档案（哪些渠道投过）、网申公告的公司性质、筛选列表里 BOSS / 51job / 智联详情页读到的工商信息。
 *   - 必应中文公司名会乱匹配，不用。
 * 总结用 DeepSeek（快，一次几秒、一分钱上下）；只许用搜到的内容，每条事实写出处，查不到就写查不到。
 */
import { callJson, forTask } from './llm.js';
import { getArchive, findEntry, CHANNEL_NAMES, sameCompany } from './company-archive.js';
import { getRuntime } from './store.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 页面里跑的：读百度结果（标题 + 摘要 + 来源网址） */
export function readBaidu() {
  const t = (e) => (e?.innerText || '').replace(/\s+/g, ' ').trim();
  if (/wappass|安全验证/.test(location.href + document.title)) return { captcha: true };
  const boxes = [...document.querySelectorAll('#content_left > div')].filter((d) => d.querySelector('h3') && t(d).length > 20);
  return {
    results: boxes.slice(0, 10).map((d) => ({
      title: t(d.querySelector('h3')).slice(0, 80),
      text: t(d).replace(t(d.querySelector('h3')), '').slice(0, 320),
      url: d.getAttribute('mu') || d.querySelector('h3 a')?.href || '',
    })),
  };
}

/** 页面里跑的：读企查查搜索结果第一家 */
function readQcc() {
  const t = (e) => (e?.innerText || '').replace(/\s+/g, ' ').trim();
  if (/weblogin|login/.test(location.href)) return { login: true };
  if (/405|验证/.test(document.title)) return { blocked: true };
  const first = document.querySelector('.maininfo, .search-result tr, [class*="search-list"] [class*="item"], table.ntable tr');
  const box = first?.closest('tr, [class*="item"]') || first;
  return { text: t(box).slice(0, 600), url: box?.querySelector('a[href*="firm"], a[href*="company"]')?.href || location.href };
}

/** 后台开一个标签、等加载完、在页面里跑 fn（可带参数）、关标签 */
export async function readTab(url, fn, wait = 2500, args = []) {
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    for (let i = 0; i < 40; i++) {
      const t = await chrome.tabs.get(tab.id).catch(() => null);
      if (!t) throw new Error('标签被关了');
      if (t.status === 'complete') break;
      await sleep(400);
    }
    await sleep(wait);
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: fn, args });
    return r?.result || {};
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

const QUERIES = (n) => [
  { key: 'basic', q: `${n}`, why: '基本情况' },
  { key: 'biz', q: `${n} 注册资本 参保人数 成立时间`, why: '工商信息' },
  { key: 'review', q: `${n} 怎么样 加班 员工评价`, why: '员工风评' },
  { key: 'risk', q: `${n} 劳动仲裁 欠薪 裁员 被执行`, why: '风险' },
];

/** 插件自己已有的这家公司的信息 */
async function ownData(name) {
  const lines = [];
  const archive = await getArchive();
  const hit = findEntry(archive, name);
  if (hit) lines.push(`【投递记录】已在 ${Object.keys(hit[1].ch || {}).map((c) => CHANNEL_NAMES[c] || c).join('、')} 投过`);
  const { campus } = await chrome.storage.local.get('campus');
  for (const x of Object.values(campus?.items || {})) {
    if (!sameCompany(x.company, name)) continue;
    lines.push(`【网申公告】${x.company}｜性质 ${(x.typeTag || []).join('/') || '没写'}｜行业 ${x.industry || '没写'}｜${x.batch}｜岗位 ${x.positions.slice(0, 120)}｜地点 ${x.locations.slice(0, 60)}｜截止 ${x.deadline}`);
    break;
  }
  const rt = await getRuntime();
  for (const q of rt.queue || []) {
    if (!sameCompany(q.job.company, name)) continue;
    const j = q.job;
    lines.push(`【招聘平台详情页】${j.company}｜${j.companyInfo || ''}｜工商：${j.business || '没读到'}｜在招：${j.title} ${j.salary || ''}｜福利：${j.welfare || ''}`);
    break;
  }
  return lines;
}

const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    full_name: { type: 'string' },
    tier: { type: 'string', enum: ['大单位', '中型', '小公司', '看不出'] },
    verdict: { type: 'string', enum: ['值得投', '可以投但留个心', '谨慎', '别投', '信息太少'] },
    one_line: { type: 'string' },
    facts: { type: 'array', items: { type: 'object', properties: { k: { type: 'string' }, v: { type: 'string' }, src: { type: 'string' } }, required: ['k', 'v', 'src'] } },
    workload: { type: 'object', properties: { level: { type: 'string', enum: ['不卷', '一般', '卷', '看不出'] }, evidence: { type: 'string' }, src: { type: 'string' } }, required: ['level', 'evidence'] },
    good: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    hefei: { type: 'string' },
    todo: { type: 'array', items: { type: 'string' } },
  },
  required: ['full_name', 'tier', 'verdict', 'one_line', 'facts', 'workload', 'good', 'risks', 'hefei', 'todo'],
};

function reportPrompt(name, config, material) {
  const city = (config.filter?.cities || [])[0] || '';
  return `任务：一个求职者想知道「${name}」这家公司怎么样、值不值得投。下面是他的求职标准，和插件刚从网上搜到的材料（百度搜索结果摘要、企查查、插件自己的投递记录）。
只能用下面材料里的内容下结论，材料里没有的一律写「没查到」，不许凭印象编注册资本、人数、评价。每条事实的 src 写它出自哪条材料（写网址或「百度-员工风评第3条」这种）。
同名公司很多时（比如一个集团下面好几家子公司），优先说在${city || '他求职城市'}的那家；分不清就在 todo 里提醒他核对全称。

# 他的求职标准（重点看：公司档次、卷不卷、岗位在不在${city || '他的求职城市'}、有没有坑）
${config.criteria || ''}

# 搜到的材料
${material}

# 输出
- full_name：你认为材料里对应的公司全称（没把握就写「不确定」）
- tier：按求职标准的「公司档次」判断（上市 / 国企 / 外资 / 知名品牌 / 1000 人以上 = 大单位）
- verdict：值得投 / 可以投但留个心 / 谨慎 / 别投 / 信息太少
- one_line：一句大白话结论，像朋友跟他说话
- facts：工商和规模类的事实（成立时间、注册资本、参保人数、是否上市、经营状态、主营业务、${city || '求职城市'}有没有分支），查不到的不要列
- workload：加班 / 双休情况，level 不卷 / 一般 / 卷 / 看不出，evidence 摘原话要点
- good：好的地方，每条一句，带出处
- risks：风险（欠薪、仲裁、被执行、裁员、培训贷、拉主播、名不副实），每条一句，带出处；没查到就空数组
- hefei：在${city || '他的求职城市'}有没有办公地 / 岗位，材料里怎么说
- todo：他自己还该去核对什么（比如「去企查查看参保人数」），最多 3 条
输出 json。`;
}

/**
 * 查一家。onProgress(text) 报进度。返回 { name, at, report, sources:{...}, calls }
 */
export async function checkCompany(name, config, onProgress = () => {}) {
  name = String(name || '').trim();
  if (!name) throw new Error('先输入公司名');
  const sources = { baidu: {}, qcc: null, own: [] };
  const notes = [];
  const qs = QUERIES(name);
  for (let i = 0; i < qs.length; i++) {
    onProgress(`百度搜「${qs[i].q}」（${i + 1}/${qs.length}）…`);
    const r = await readTab(`https://www.baidu.com/s?wd=${encodeURIComponent(qs[i].q)}`, readBaidu).catch((e) => ({ err: e.message }));
    if (r.captcha) {
      notes.push('百度弹了安全验证，后面几次没搜成 —— 在 Chrome 里随便搜一次百度、滑一下验证，再点「查」');
      break;
    }
    sources.baidu[qs[i].key] = r.results || [];
    await sleep(800 + Math.random() * 800);   // 别连珠炮，像人在搜
  }
  onProgress('看企查查（你登着才有）…');
  const q = await readTab(`https://www.qcc.com/web/search?key=${encodeURIComponent(name)}`, readQcc, 3000).catch((e) => ({ err: e.message }));
  if (q.login) notes.push('企查查没登录，跳过了。在这个 Chrome 里登一下企查查，下次能多看法人、注册资本、参保人数');
  else if (q.blocked) notes.push('企查查把这次访问拦了，跳过');
  else if (q.text) sources.qcc = q;
  sources.own = await ownData(name);

  const got = Object.values(sources.baidu).flat().length;
  if (!got && !sources.qcc && !sources.own.length) throw new Error(notes.join('；') || '什么都没搜到，换个叫法试试（全称 / 品牌名）');

  const material = [
    ...sources.own,
    sources.qcc ? `【企查查搜索第一家】${sources.qcc.text}（${sources.qcc.url}）` : '',
    ...qs.map((x) => (sources.baidu[x.key] || []).length
      ? `【百度-${x.why}】搜「${x.q}」\n${sources.baidu[x.key].map((r, i) => `${i + 1}. ${r.title}｜${r.text}｜${r.url}`).join('\n')}` : ''),
  ].filter(Boolean).join('\n\n');

  onProgress(`整理成结论（DeepSeek，材料 ${material.length} 字）…`);
  const t0 = Date.now();
  let usage = null;
  const report = await callJson(forTask(config, 'autofill'), {
    user: reportPrompt(name, config, material.slice(0, 14000)), schema: REPORT_SCHEMA, maxTokens: 2500, task: 'company',
    onUsage: (u) => { usage = u; },
  });
  delete report._usage;
  const rec = { name, at: Date.now(), report, notes, sources: { baiduCount: got, qcc: Boolean(sources.qcc), own: sources.own }, links: Object.values(sources.baidu).flat().slice(0, 12).map((r) => ({ title: r.title, url: r.url })), ms: Date.now() - t0, usage };
  const { companyChecks = [] } = await chrome.storage.local.get('companyChecks');
  await chrome.storage.local.set({ companyChecks: [rec, ...companyChecks.filter((c) => c.name !== name)].slice(0, 30) });
  return rec;
}

export async function checkHistory() {
  const { companyChecks = [] } = await chrome.storage.local.get('companyChecks');
  return companyChecks;
}
