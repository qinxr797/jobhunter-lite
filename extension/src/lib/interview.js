/**
 * 面试备战包（照 Tabbit「面经大师」「秋招求职助手」补上）。
 *
 * 约到面试后，一键出一份能打印的复习资料：
 *   - 这家公司是干什么的（百度搜到的业务 / 产品 / 近况，带出处），复用「查公司」的工商和风评结论
 *   - 面经：百度搜「公司 + 岗位 + 面试 / 面经」的摘要（看准、牛客、知乎、职友集），没搜到就说没搜到
 *   - 岗位要什么：JD 拆成 3~5 条
 *   - 1 分钟 / 30 秒自我介绍、可能被问的题 + 答题思路、反问清单、去之前要准备的
 * 规矩：自我介绍和答题思路只许用简历里的真经历和原数字，不编、不改数；没细节的地方标「这里要你自己补」；
 * 反问不先问待遇（前期不问，HR 主动提再说）。
 * 小红书要登录、牛客搜索页是脚本渲染还常弹验证，都不直接读，只走百度摘要。
 */
import { callJson, forTask } from './llm.js';
import { readTab, readBaidu, checkCompany, checkHistory } from './company-check.js';
import { factsFrom } from './autofill-lib.js';
import { getRuntime } from './store.js';
import { sameCompany } from './company-archive.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEY = 'interviewPacks';

/** 插件里存过的这家公司的 JD（待审队列 / 投过的） */
async function jdOf(company, title) {
  const rt = await getRuntime();
  const pool = [...(rt.queue || []).map((q) => q.job), ...(rt.done || [])];
  const hits = pool.filter((j) => j && sameCompany(j.company, company));
  const hit = hits.find((j) => title && j.title && (j.title === title || j.title.includes(title) || title.includes(j.title))) || hits[0];
  return hit?.description || hit?.jd || hit?.detail || '';
}

const SCHEMA = {
  type: 'object',
  properties: {
    company_brief: {
      type: 'object',
      properties: { what: { type: 'string' }, products: { type: 'string' }, scale: { type: 'string' }, recent: { type: 'string' }, src: { type: 'array', items: { type: 'string' } } },
      required: ['what', 'products', 'scale', 'recent', 'src'],
    },
    role_focus: { type: 'array', items: { type: 'string' } },
    mianjing: { type: 'array', items: { type: 'object', properties: { point: { type: 'string' }, src: { type: 'string' } }, required: ['point', 'src'] } },
    self_intro_60s: { type: 'string' },
    self_intro_30s: { type: 'string' },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          q: { type: 'string' }, type: { type: 'string', enum: ['公司业务', '岗位能力', '简历深挖', '行为题', '稳定性'] },
          why: { type: 'string' }, outline: { type: 'array', items: { type: 'string' } }, fill_in: { type: 'string' }, avoid: { type: 'string' },
        },
        required: ['q', 'type', 'why', 'outline'],
      },
    },
    ask_back: { type: 'array', items: { type: 'string' } },
    verify_on_site: { type: 'array', items: { type: 'string' } },
    prep_todo: { type: 'array', items: { type: 'string' } },
  },
  required: ['company_brief', 'role_focus', 'mianjing', 'self_intro_60s', 'self_intro_30s', 'questions', 'ask_back', 'verify_on_site', 'prep_todo'],
};

function packPrompt({ company, title, jd, facts, check, material }) {
  return `任务：求职者明天要去「${company}」面「${title || '（岗位没写）'}」。给他出一份面试备战资料。

# 他的简历素材库（唯一能用的经历和数字来源）
${JSON.stringify({ basic: facts.basic, education: facts.education, experiences: facts.experiences, projects: facts.projects, campus: facts.campus, skills: facts.skills, certificates: facts.certificates, english: facts.english }, null, 1)}

# 岗位 JD
${jd || '（插件里没存这个岗位的 JD，按岗位名称和公司业务推断，推断的要说是推断）'}

# 插件「查公司」的结论
${check || '（没查过）'}

# 刚从网上搜到的材料（百度结果摘要，每条带网址）
${material || '（什么都没搜到）'}

# 规矩（必须遵守）
1. 自我介绍和答题思路只许用素材库里的经历、公司名、数字，一个数字都不许改、不许编；素材库没写的细节，在 fill_in 里写「这里要你自己补：……」
2. 公司介绍、面经只许用「搜到的材料」和「查公司结论」，每条 src 写出处网址或「查公司」；没搜到就写「没查到」，面经没有就给空数组，不许编面试题说是面经
3. 他的背景看上面的简历素材库，求职城市是 ${facts.intent.city || '（没写）'}；自我介绍只讲和这个岗位相关的
4. 反问清单问工作内容、团队、培训、考核这类，不先问薪资待遇（对方提了再聊）
5. verify_on_site：结合查公司结论和材料，面试时要顺口问清或观察的（加班、双休、试用期、社保从哪天交这类），每条一句；措辞要自然，不像审问

# 输出
- company_brief：what 一句话说清干什么；products 主要产品/业务；scale 规模（上市/人数/成立时间，查到的）；recent 近况；src 出处列表
- role_focus：这个岗位最看重的 3~5 条能力，每条一句
- mianjing：搜到的面经要点（流程、问过的题、面试官风格），每条带 src
- self_intro_60s：1 分钟口语版（250 字左右），开头一句点题对上这个岗位，挑 2 段最对口的经历，结尾落到为什么想来这家
- self_intro_30s：30 秒版（120 字左右）
- questions：10~12 道最可能被问的题，覆盖公司业务、岗位能力、简历深挖（每段经历至少一道）、行为题、稳定性（为什么选这家、能干多久）；outline 是答题要点 3~5 条，引用具体哪段经历；avoid 是这题容易踩的坑
- ask_back：3~4 个反问
- prep_todo：去之前要准备的 3~5 件事（具体到看哪个产品、带什么）
输出 json。`;
}

/**
 * 出一份备战包。job：{ company, title, jd? }。onProgress(text)。
 */
export async function buildPack(job, config, onProgress = () => {}) {
  const company = String(job.company || '').trim();
  const title = String(job.title || '').trim();
  if (!company) throw new Error('先写公司名');
  if (!config.library) throw new Error('先去「设置」把简历填上，备战包要按你的经历写');
  const jd = String(job.jd || '').trim() || await jdOf(company, title);

  // 查公司：7 天内查过就用，没查过顺手查一遍
  let check = (await checkHistory()).find((c) => sameCompany(c.name, company) && Date.now() - c.at < 7 * 86400e3);
  if (!check) {
    onProgress('先查一遍这家公司（工商、风评）…');
    check = await checkCompany(company, config, (t) => onProgress(`查公司：${t}`)).catch(() => null);
  }
  const R = check?.report;
  const checkText = R ? `${R.full_name}｜${R.tier}｜${R.verdict}：${R.one_line}\n事实：${R.facts.map((f) => `${f.k} ${f.v}`).join('；')}\n加班：${R.workload.level} ${R.workload.evidence}\n好的：${R.good.join('；')}\n风险：${R.risks.join('；') || '没查到'}` : '';

  const qs = [
    { key: 'biz', q: `${company} 主营业务 产品`, why: '业务' },
    { key: 'news', q: `${company} 最新消息`, why: '近况' },
    { key: 'mj', q: `${company} ${title} 面试`, why: '面经' },
    { key: 'mj2', q: `${company} 面试经验 问了什么`, why: '面经' },
  ];
  const got = {};
  const notes = [];
  if (!check) notes.push('查公司没查成（百度或企查查拦了），公司风险这块是空的');
  for (let i = 0; i < qs.length; i++) {
    onProgress(`百度搜「${qs[i].q}」（${i + 1}/${qs.length}）…`);
    const r = await readTab(`https://www.baidu.com/s?wd=${encodeURIComponent(qs[i].q)}`, readBaidu).catch(() => ({}));
    if (r.captcha) { onProgress('百度弹了安全验证，后面的没搜'); notes.push('百度弹了安全验证，公司业务和面经没搜到（在浏览器里随便搜一次百度、过一下验证，再出一份）'); break; }
    got[qs[i].key] = r.results || [];
    await sleep(700 + Math.random() * 700);
  }
  const material = qs.map((x) => (got[x.key] || []).length
    ? `【${x.why}】搜「${x.q}」\n${got[x.key].map((r, i) => `${i + 1}. ${r.title}｜${r.text}｜${r.url}`).join('\n')}` : '').filter(Boolean).join('\n\n');

  onProgress(`DeepSeek 写备战包（半分钟左右）…`);
  const facts = factsFrom(config.library, config.resume?.summary || '');
  const t0 = Date.now();
  let usage = null;
  const pack = await callJson(forTask(config, 'autofill'), {
    user: packPrompt({ company, title, jd: jd.slice(0, 4000), facts, check: checkText, material: material.slice(0, 12000) }).replace('求职者明天要去', '求职者要去'),
    schema: SCHEMA, maxTokens: 7000, task: 'interview', temperature: 0.4, onUsage: (u) => { usage = u; },
  });
  delete pack._usage;
  const rec = { id: `iv${Date.now()}`, at: Date.now(), company, title, hasJd: Boolean(jd), notes, check: R ? { tier: R.tier, verdict: R.verdict, one_line: R.one_line, risks: R.risks, workload: R.workload } : null, pack, links: Object.values(got).flat().slice(0, 16).map((r) => ({ title: r.title, url: r.url })), ms: Date.now() - t0, usage };
  const { [KEY]: list = [] } = await chrome.storage.local.get(KEY);
  await chrome.storage.local.set({ [KEY]: [rec, ...list.filter((x) => !(x.company === company && x.title === title))].slice(0, 20) });
  return rec;
}

export async function packHistory() {
  const { [KEY]: list = [] } = await chrome.storage.local.get(KEY);
  return list;
}
