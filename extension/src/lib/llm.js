/**
 * 模型调用层。
 *
 * 两种接口都支持：
 *   provider='openai'     OpenAI 兼容 /v1/chat/completions（默认 DeepSeek）
 *   provider='anthropic'  Claude 官方 /v1/messages
 *
 * 三个能力：
 *   evaluateJob(job)   —— 按求职标准下结论（投 / 等你定 / 不投）+ 匹配分 + 开场白 + 推荐哪份附件简历
 *   tailorResume(job)  —— 生成针对该岗位重排的简历内容
 *   parseResumeText    —— 设置页把简历全文拆成结构化数据
 */
import Anthropic from '../../vendor/anthropic.mjs';
import { libraryForModel, buildPlan, describePlan } from './resume-render.js';
import { cohortOf } from './library.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 把结构化简历渲染成给模型看的文本 */
export function renderResume(r) {
  const lines = [];
  lines.push(`姓名：${r.name || '(未填)'}`);
  lines.push(`目标岗位：${r.title || '(未填)'}`);
  lines.push(`工作年限：${r.years || 0} 年 ｜ 城市：${r.city || '(未填)'} ｜ 学历：${r.education || '(未填)'}`);
  if (r.summary) lines.push(`\n【个人概述】\n${r.summary}`);
  if (r.skills?.length) lines.push(`\n【技能】\n${r.skills.join('、')}`);
  if (r.experiences?.length) {
    lines.push('\n【工作经历】');
    for (const e of r.experiences) {
      lines.push(`- ${e.company || ''} ｜ ${e.role || ''} ｜ ${e.period || ''}`);
      for (const b of e.bullets || []) lines.push(`  · ${b}`);
    }
  }
  if (r.projects?.length) {
    lines.push('\n【项目经历】');
    for (const p of r.projects) {
      lines.push(`- ${p.name || ''} ｜ ${p.role || ''} ｜ ${p.period || ''} ｜ ${p.stack || ''}`);
      for (const b of p.bullets || []) lines.push(`  · ${b}`);
    }
  }
  if (r.highlights?.length) {
    lines.push('\n【可复用亮点】');
    for (const h of r.highlights) lines.push(`- ${h}`);
  }
  // 解析好的结构化内容够用时不再附原文，省一半 tokens
  if (r.rawText && !r.experiences?.length && !r.projects?.length) lines.push(`\n【简历原文（兜底，以上结构化内容优先）】\n${r.rawText}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- 通用调用

function normalizeBase(base) {
  let b = String(base || '').trim();
  if (!b) return '';
  if (!/^https?:\/\//i.test(b)) b = 'https://' + b;
  return b.replace(/\/+$/, '').replace(/\/(chat\/completions|messages)$/i, '');
}

function chatUrl(base) {
  const b = normalizeBase(base);
  return /\/v1$/i.test(b) ? `${b}/chat/completions` : `${b}/v1/chat/completions`;
}

// ---------------------------------------------------------------- 按任务选模型 + DeepSeek 记账（v0.7.0）

const isDeepSeek = (c) => /deepseek\.com/i.test(c.apiBase || '');
const res402 = (e) => /HTTP 402/.test(e?.message || '');   // DeepSeek 余额不足，重试没用

/**
 * 按任务取模型配置：config.models.screen / autofill 单独填了 key 就用它，没填就用设置页顶上那组。
 */
export function forTask(config, task) {
  const m = config.models?.[task];
  if (!m || !m.apiKey) return config;
  // 只覆盖填了的字段，空的接口地址 / 模型沿用顶上那组
  return { ...config, ...Object.fromEntries(Object.entries(m).filter(([, v]) => v)) };
}

/**
 * DeepSeek deepseek-flash 官方价（元 / 百万 tokens，api-docs.deepseek.com/zh-cn/quick_start/pricing，2026-09-28 查）：
 *   高峰（北京时间周一至周五 9-12 点、14-18 点，不含法定节假日）：缓存命中 0.04 / 未命中 2 / 输出 8
 *   其余时段减半：0.02 / 1 / 4
 * 法定节假日插件认不出来，按高峰算，只会多估不会少估。
 */
const DS_PRICE = { peak: { hit: 0.04, miss: 2, out: 8 }, off: { hit: 0.02, miss: 1, out: 4 } };
export function dsIsPeak(ms = Date.now()) {
  const bj = new Date(ms + 8 * 3600e3);          // 转北京时间，用 UTC 读法取字段
  const wd = bj.getUTCDay();
  const h = bj.getUTCHours();
  return wd >= 1 && wd <= 5 && ((h >= 9 && h < 12) || (h >= 14 && h < 18));
}
export function dsCost(u, ms = Date.now()) {
  const p = dsIsPeak(ms) ? DS_PRICE.peak : DS_PRICE.off;
  const miss = u.cacheMiss || Math.max(0, (u.in || 0) - (u.cacheRead || 0));
  return ((u.cacheRead || 0) * p.hit + miss * p.miss + (u.out || 0) * p.out) / 1e6;
}
const bjDay = (ms = Date.now()) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);

/** 每次 DeepSeek 调用记一笔：按北京时间的日期累计，缓存命中和未命中分开记 */
async function recordDeepSeek(u) {
  const { dsUsage = {} } = await chrome.storage.local.get('dsUsage');
  const d = bjDay();
  const cny = dsCost(u);
  const add = (o = {}) => ({
    calls: (o.calls || 0) + 1, hit: (o.hit || 0) + (u.cacheRead || 0),
    miss: (o.miss || 0) + (u.cacheMiss || Math.max(0, u.in - (u.cacheRead || 0))),
    out: (o.out || 0) + (u.out || 0), cny: (o.cny || 0) + cny,
  });
  const next = { ...dsUsage, [d]: add(dsUsage[d]), total: add(dsUsage.total) };
  // 只留最近 30 天的明细
  for (const k of Object.keys(next)) if (k !== 'total' && k < bjDay(Date.now() - 30 * 864e5)) delete next[k];
  await chrome.storage.local.set({ dsUsage: next });
}
export async function getDeepSeekUsage() {
  const { dsUsage = {} } = await chrome.storage.local.get('dsUsage');
  return { today: dsUsage[bjDay()] || { calls: 0, hit: 0, miss: 0, out: 0, cny: 0 }, total: dsUsage.total || { calls: 0, cny: 0 } };
}
/** DeepSeek 官方的查余额接口 GET /user/balance（9/28 实测能用） */
export async function getDeepSeekBalance(config) {
  const c = forTask(config, 'autofill');
  if (!isDeepSeek(c)) return null;
  const res = await fetch(`${normalizeBase(c.apiBase)}/user/balance`, { headers: { authorization: `Bearer ${c.apiKey}` } });
  if (!res.ok) throw new Error(`查余额 HTTP ${res.status}`);
  const j = await res.json();
  const b = (j.balance_infos || []).find((x) => x.currency === 'CNY') || (j.balance_infos || [])[0];
  return b ? { total: Number(b.total_balance), currency: b.currency, available: j.is_available } : null;
}

/** 从模型输出里抠 JSON（容忍 ```json 围栏和前后废话） */
export function parseJsonLoose(text) {
  if (!text) throw new Error('模型返回了空内容');
  let s = String(text).trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();
  try { return JSON.parse(s); } catch { /* 继续 */ }
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(s.slice(a, b + 1));
  throw new Error('模型输出里没有 JSON');
}

/** 按 schema 的 required 检查字段，缺了就算这次没答好 */
function missingFields(data, schema) {
  return (schema.required || []).filter((k) => !(k in (data || {})));
}

/** 用 schema 生成一段「只输出 JSON」的说明，给不支持结构化输出的接口用 */
function schemaHint(schema) {
  return `\n\n# 输出格式\n只输出一个 JSON 对象，不要任何解释、不要 markdown 围栏。字段定义（JSON Schema）：\n${JSON.stringify(schema)}`;
}

/**
 * 调模型拿一个 JSON 对象。
 * opts: { system, user, schema, maxTokens, effort, cacheSystem }
 */
export async function callJson(config, opts) {
  if (!config.apiKey) throw new Error('还没填 API Key，去「设置」页填一下');
  const provider = config.provider || 'openai';

  if (provider === 'anthropic') {
    const client = new Anthropic({ apiKey: config.apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
    const res = await client.messages.create({
      model: config.model || 'claude-opus-5-5',
      max_tokens: opts.maxTokens || 4000,
      ...(opts.system
        ? { system: [{ type: 'text', text: opts.system, ...(opts.cacheSystem ? { cache_control: { type: 'ephemeral' } } : {}) }] }
        : {}),
      messages: [{ role: 'user', content: opts.user }],
      output_config: {
        format: { type: 'json_schema', schema: opts.schema },
        effort: opts.effort || config.effort || 'medium',
      },
    });
    if (res.stop_reason === 'refusal') throw new Error('模型拒绝了这次请求');
    if (res.stop_reason === 'max_tokens') throw new Error('输出被 max_tokens 截断，JSON 不完整');
    const text = res.content.find((b) => b.type === 'text')?.text;
    const data = JSON.parse(text || '');
    data._usage = { in: res.usage.input_tokens, out: res.usage.output_tokens, cacheRead: res.usage.cache_read_input_tokens || 0 };
    return data;
  }

  // OpenAI 兼容：没有强制结构化输出，靠提示 + 宽松解析 + 缺字段重试
  const ds = isDeepSeek(config);
  // DeepSeek（v0.7.0）：不发 reasoning_effort（它会打开思考模式、输出 tokens 翻几倍），显式关掉思考；
  // 用官方的 JSON 输出 response_format=json_object（要求提示里出现 json 字样，schemaHint 里有）。
  // system 提示一字不差放最前面，后面几次调用能命中 DeepSeek 的上下文缓存（便宜 50 倍）；所以 schemaHint 放到 user 里，
  // 不同任务共用同一段 system 前缀。
  const body = ds
    ? {
      model: config.model || 'deepseek-flash',
      max_tokens: opts.maxTokens || 4000,
      temperature: opts.temperature ?? 0.2,
      thinking: { type: 'disabled' },
      response_format: { type: 'json_object' },
      messages: [
        ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
        { role: 'user', content: opts.user + schemaHint(opts.schema) },
      ],
    }
    : {
      model: config.model || 'deepseek-flash',
      max_tokens: opts.maxTokens || 4000,
      temperature: 0.3,
      ...(/^(o\d|gpt-5)/i.test(config.model || '') ? { reasoning_effort: opts.effort || config.effort || 'medium' } : {}),
      messages: [
        ...(opts.system ? [{ role: 'system', content: opts.system + schemaHint(opts.schema) }] : []),
        { role: 'user', content: opts.system ? opts.user : opts.user + schemaHint(opts.schema) },
      ],
    };

  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(3000 * attempt);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ds ? 120000 : 240000);
    const t0 = Date.now();
    try {
      const res = await fetch(chatUrl(config.apiBase || 'https://api.deepseek.com'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const raw = await res.text();
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}：${raw.slice(0, 300)}`);
        // 鉴权 / 余额问题重试也没用
        if (res.status === 401 || res.status === 403) { err.fatal = true; throw err; }
        throw err;
      }
      const json = JSON.parse(raw);
      // 花了钱就记账，哪怕后面 JSON 解析失败要重试
      const u = json.usage || {};
      const usage = {
        in: u.prompt_tokens || 0, out: u.completion_tokens || 0,
        cacheRead: u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0,
        cacheMiss: u.prompt_cache_miss_tokens ?? 0,
        ms: Date.now() - t0, chars: JSON.stringify(body.messages).length, task: opts.task || '',
      };
      if (ds) await recordDeepSeek(usage).catch(() => {});
      opts.onUsage?.(usage);
      const msg = json.choices?.[0]?.message || {};
      const text = typeof msg.content === 'string' ? msg.content : (msg.content || []).map((c) => c.text || '').join('');
      if (json.choices?.[0]?.finish_reason === 'length') throw new Error('输出被 max_tokens 截断，JSON 不完整');
      const data = parseJsonLoose(text);
      const miss = missingFields(data, opts.schema);
      if (miss.length) throw new Error(`模型漏了字段：${miss.join('、')}`);
      data._usage = usage;
      return data;
    } catch (e) {
      lastErr = e.name === 'AbortError' ? new Error(`模型 ${ds ? 2 : 4} 分钟没回，超时`) : e;
      if (res402(e)) break;
      if (e.fatal) break;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/** 设置页「测试连接」用：发一句最短的话看通不通 */
export async function testConnection(config) {
  const data = await callJson(config, {
    user: '回复 {"ok": true}',
    schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
    maxTokens: 2000,
    effort: 'low',
  });
  return data;
}

// ---------------------------------------------------------------- 岗位评估

/** 基本情况：求职城市、届别、学历，从设置里来，别写死在提示里 */
export function basics(config) {
  const r = config.resume || {};
  const city = (config.filter?.cities || []).join('、');
  const year = cohortOf(r.graduation);
  return [
    `求职城市：${city || '不限'}`,
    year ? `毕业：${r.graduation}（${year} 届）` : '',
    r.degree || r.education ? `学历：${r.degree || r.education}${r.school ? `，${r.school}` : ''}${r.major ? ` ${r.major}` : ''}` : '',
    `工作年限：${r.years || 0} 年`,
  ].filter(Boolean).join('\n');
}

function systemPrompt(config) {
  const g = config.greeting;
  const variants = config.variants?.length
    ? config.variants
        .map((v) => `  - id=${v.id}｜${v.label}｜适用关键词：${(v.keywords || []).join('、')}｜${v.note || ''}`)
        .join('\n')
    : '  （还没配置简历变体，variant_id 一律返回空字符串）';

  return `你在替一位求职者在招聘平台（BOSS直聘 / 前程无忧 / 智联招聘）上筛岗位。他本人把找工作的标准写在下面了，你要站在他的立场判断「这家该不该投」，并为要投的岗位写打招呼开场白。宁可漏投，不能让他被坑。

# 他的基本情况
${basics(config)}

# 他的找工作标准（逐条照做，和下面其他要求冲突时以这里为准）
${config.criteria || ''}

# 他的简历
${renderResume(config.resume)}

# 已经传到招聘平台的附件简历
${variants}

# 你要输出的字段

1. verdict：「投」「等你定」「不投」三选一。
   - 命中任何一票否决 → 不投
   - 信息不够判断、公司信息对不上、JD 空泛看不出实际干什么 → 等你定
   - 方向对、公司看着正常、没有红旗 → 投
2. priority：「首选」「对口」「能干」「不相关」四选一，按找工作标准里的优先顺序判断（标准里没写优先顺序的：和简历最对口的给「对口」，沾边能干的给「能干」）。
3. veto：命中的一票否决条目，照着标准里的说法写，没有就空数组。
4. company_check：一句话说公司看起来怎么样，要用上给你的工商信息和公司基本信息（成立时间、注册资本、自称规模、融资阶段是否自洽；跨境初创按初创标准看）。
5. match_score（0-100）：这份简历投这个岗位拿到面试的可能性。只看匹配度，不看公司好坏（公司好坏体现在 verdict 里）：
   - 90-100：岗位要的核心能力简历几乎全覆盖，应届/经验要求也对得上
   - 75-89：核心项覆盖大半，有 1-2 项缺口但不致命
   - 60-74：沾边，能投但明显不是最优解
   - 40-59：跨度较大，投了大概率不回
   - 0-39：基本不相关
   不要给人情分。
6. reasons：3 条以内，为什么这么判。先说匹配上的，再说缺口或风险。要具体，不要写「比较匹配」这种废话。
7. greeting：打招呼开场白（verdict 为「不投」时写空字符串）。硬性要求：
   - 控制在 ${Math.min(g.maxChars, 150)} 字以内，一共 2～3 句
   - 像真人在 BOSS 上打字：口语、短句，不要书面语，不要写「这与岗位需求匹配」「非常契合」这类总结句
   - 语气：${g.tone}
   - 第一句必须是简历里**真实存在**的、和这个岗位最对口的那条经历，有数字就带上数字，开头就点名是什么经历，不要没头没尾的插入语开场
   - 只能用简历里有的事实，缺口不提，**绝对不许编造**简历里没有的经历、项目、数字或技能
   - 按求职标准「开场白」一节的规矩写；标准里没写的，默认不写可随时到岗、不问底薪休息下班时间
${config.library?.profile?.site ? '   - 不要写作品集网址，也不用提作品集，程序会在最前面自动补一句「我自己有个人作品集网站…网站是 xxx」\n' : ''}${g.mustInclude?.length ? `   - 必须自然带上：${g.mustInclude.join('、')}\n` : ''}${g.forbid?.length ? `   - 禁止出现这些词：${g.forbid.join('、')}\n` : ''}8. variant_id：从附件简历里挑最合适的一份，返回它的 id；没有合适的返回空字符串。
9. red_flags：岗位本身的风险信号（疑似名不副实、薪资结构说不清、同岗位海招、HR 很久没活跃等），没有就空数组。
10. company_tier：「大单位」「中型」「小公司」「看不出」四选一，按求职标准「公司档次」一节判断；你认得出的上市公司、知名品牌即使信息没写也算大单位，认不出就按给你的人数、融资、工商信息判断，别猜。`;
}

const EVAL_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['投', '等你定', '不投'] },
    priority: { type: 'string', enum: ['首选', '对口', '能干', '不相关'] },
    veto: { type: 'array', items: { type: 'string' } },
    company_check: { type: 'string' },
    match_score: { type: 'integer', minimum: 0, maximum: 100 },
    reasons: { type: 'array', items: { type: 'string' }, maxItems: 3 },
    greeting: { type: 'string' },
    variant_id: { type: 'string' },
    red_flags: { type: 'array', items: { type: 'string' }, maxItems: 4 },
    company_tier: { type: 'string', enum: ['大单位', '中型', '小公司', '看不出'] },
  },
  required: ['verdict', 'priority', 'veto', 'company_check', 'match_score', 'reasons', 'greeting', 'variant_id', 'red_flags', 'company_tier'],
  additionalProperties: false,
};

export function jobToText(job) {
  const plat = { boss: 'BOSS直聘', '51job': '前程无忧', zhilian: '智联招聘' }[job.platform || 'boss'];
  return [
    `平台：${plat}${job.invite ? '（HR 主动发来招呼、想要简历）' : ''}`,
    `岗位：${job.title}`,
    `公司：${job.company}`,
    `薪资：${job.salary || '(没读到)'}`,
    job.city ? `城市：${job.city}` : '',
    job.address ? `工作地址：${job.address}` : '',
    job.tags?.length ? `要求：${job.tags.join(' / ')}` : '',
    job.welfare ? `福利标签：${job.welfare}` : '',
    job.companyInfo ? `公司基本信息：${job.companyInfo}` : '',
    job.business ? `工商信息：${job.business}` : '',
    job.hr ? `招聘者：${job.hr}` : '',
    '',
    '职位描述：',
    job.jd || '(没抓到 JD 正文，只能依据上面的信息判断，verdict 最多给「等你定」)',
  ]
    .filter(Boolean)
    .join('\n');
}

/** 模型偶尔会把枚举写歪，这里兜底规整一下 */
function normalizeEval(d) {
  const v = String(d.verdict || '');
  d.verdict = /不投/.test(v) ? '不投' : /等|定|待/.test(v) ? '等你定' : /投/.test(v) ? '投' : '等你定';
  d.veto = Array.isArray(d.veto) ? d.veto.filter(Boolean) : [];
  if (d.veto.length) d.verdict = '不投';
  d.reasons = Array.isArray(d.reasons) ? d.reasons.slice(0, 3) : [];
  d.red_flags = Array.isArray(d.red_flags) ? d.red_flags : [];
  d.match_score = Math.max(0, Math.min(100, Math.round(Number(d.match_score) || 0)));
  d.greeting = String(d.greeting || '');
  d.variant_id = String(d.variant_id || '');
  d.company_tier = ['大单位', '中型', '小公司', '看不出'].find((t) => String(d.company_tier || '').includes(t.slice(0, 2))) || '看不出';
  return d;
}

export async function evaluateJob(job, config) {
  const data = await callJson(forTask(config, 'screen'), {
    system: systemPrompt(config),
    cacheSystem: true,
    user: jobToText(job),
    schema: EVAL_SCHEMA,
    maxTokens: 6000,
  });
  return normalizeEval(data);
}

// ---------------------------------------------------------------- 定制简历

const TAILOR_SCHEMA = {
  type: 'object',
  properties: {
    base: { type: 'string' },
    target: { type: 'string' },
    section_order: { type: 'array', items: { type: 'string' } },
    order: { type: 'array', items: { type: 'string' } },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, mode: { type: 'string' } },
        required: ['id', 'mode'],
        additionalProperties: false,
      },
    },
    skills: { type: 'array', items: { type: 'string' } },
    reasons: { type: 'array', items: { type: 'string' }, maxItems: 4 },
  },
  required: ['base', 'target', 'section_order', 'order', 'items', 'skills', 'reasons'],
  additionalProperties: false,
};

/**
 * 针对某个岗位从素材库拼一份简历。模型只给拼法（用哪版打底、每段经历用哪种讲法、谁排前面、左栏放哪些技能），
 * 文字全部取素材库原句，由 resume-render.js 核对并排版 —— 模型写不进任何新事实。
 * 返回 { plan, spec, reasons, summary }
 */
export async function tailorResume(job, config) {
  const lib = config.library;
  if (!lib) throw new Error('还没有简历：去「设置」粘贴简历并解析、保存');
  const instruction = `现在针对这个岗位，从素材库里拼一份最对口的一页简历。你只决定「怎么拼」，不写任何简历正文。

- base：用哪一版打底，从 ${Object.keys(lib.variants).join(' / ')} 里选
- target：简历上「期望岗位」一栏怎么写，贴着这个岗位的叫法，不超过 15 个字，不许写经验年限或数字
- section_order：「工作经验」「项目经历」谁在前，和这个岗位最对口的那段经历所在的板块放前面
- order：经历 id 按和这个岗位的相关度从高到低排（两个板块的 id 都写进来）
- items：每条经历用哪种写法，id 和写法都必须是素材库里列出来的。最对口的 1～2 条用对口的角度或 full 展开讲，沾边的用 brief 一句带过，完全无关的 hide。至少保留 4 条
- skills：左栏放哪几项技能（写 label），3～5 项，最对口的放前面
- reasons：2～4 条，说明这么拼的理由，对着 JD 的哪条要求；这是给求职者本人看的，用经历名字称呼，不写 id，也不写 full / brief 这类代号`;

  const spec = await callJson(forTask(config, 'screen'), {
    system: systemPrompt(config),
    cacheSystem: true,
    user: `${jobToText(job)}

# 素材库（id 和写法只能从这里挑）
${libraryForModel(lib)}

---
${instruction}`,
    schema: TAILOR_SCHEMA,
    maxTokens: 4000,
    effort: config.provider === 'anthropic' ? 'high' : 'medium',
  });
  const plan = buildPlan(lib, spec);
  // 理由里模型爱写 j0 / p1 这种 id，换成经历名字给人看
  const names = Object.fromEntries(lib.sections.flatMap((s) => s.items).map((it) => [it.id, `「${it.org}」`]));
  const human = (r) => String(r).replace(/\b[jp]\d+\b/g, (id) => names[id] || id).replace(/\s*(用\s*)?\b(full|brief)\b\s*/g, '');
  return { spec, plan, reasons: Array.isArray(spec.reasons) ? spec.reasons.slice(0, 4).map(human) : [], summary: describePlan(lib, plan) };
}

// ---------------------------------------------------------------- 简历解析

const PARSE_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    title: { type: 'string' },
    years: { type: 'integer' },
    city: { type: 'string' },
    education: { type: 'string' },
    school: { type: 'string' },
    major: { type: 'string' },
    degree: { type: 'string' },
    eduStart: { type: 'string' },
    graduation: { type: 'string' },
    phone: { type: 'string' },
    email: { type: 'string' },
    gender: { type: 'string' },
    age: { type: 'string' },
    political: { type: 'string' },
    site: { type: 'string' },
    salary: { type: 'string' },
    summary: { type: 'string' },
    skills: { type: 'array', items: { type: 'string' } },
    experiences: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          company: { type: 'string' },
          role: { type: 'string' },
          period: { type: 'string' },
          bullets: { type: 'array', items: { type: 'string' } },
        },
        required: ['company', 'role', 'period', 'bullets'],
        additionalProperties: false,
      },
    },
    projects: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          role: { type: 'string' },
          period: { type: 'string' },
          stack: { type: 'string' },
          bullets: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'role', 'period', 'stack', 'bullets'],
        additionalProperties: false,
      },
    },
    highlights: { type: 'array', items: { type: 'string' } },
  },
  required: ['name', 'title', 'years', 'city', 'education', 'school', 'major', 'degree', 'eduStart', 'graduation', 'phone', 'email', 'gender', 'age', 'political', 'site', 'salary', 'summary', 'skills', 'experiences', 'projects', 'highlights'],
  additionalProperties: false,
};

/** 把用户粘贴的简历全文解析成结构化数据（设置页用一次） */
export async function parseResumeText(rawText, config) {
  const prompt = `把下面这份简历解析成结构化数据。严格照抄原文事实，不要润色、不要补充、不要推断任何简历里没写的东西。
读不出来的字段留空字符串或空数组。years 是工作年限的整数（实习不算），读不出就填 0。
- title：简历上写的求职意向 / 期望岗位；没写就留空
- school / major / degree：最高学历的学校、专业、学历（本科 / 硕士 / 大专…）；education 写成「学历 · 学校 · 专业」一行
- eduStart / graduation：最高学历的入学、毕业年月，写成 YYYY-MM（只有年份就写 YYYY）
- phone / email / gender / age / political（政治面貌）/ site（作品集或个人主页网址）/ salary（期望薪资）：照抄，没写就空
- skills：每条一项，有分类的写成「分类：内容」
- experiences 放工作和实习经历；projects 放项目、校园、社团经历（社团的 name 写社团名，role 写职务）
- highlights 从简历里挑 5-8 条最有说服力的成果句（原文摘录或最小改写），优先带数字的。

简历原文：
${rawText}`;

  const data = await callJson(config, { user: prompt, schema: PARSE_SCHEMA, maxTokens: 8000 });
  delete data._usage;
  return { ...data, rawText };
}

// ---------------------------------------------------------------- 校招公告初筛

const CAMPUS_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: ['integer', 'string'] },
          matched_positions: { type: 'array', items: { type: 'string' } },
          fit: { type: 'string', enum: ['对口', '沾边', '不对口'] },
          verdict: { type: 'string', enum: ['投', '等你定', '不投'] },
          priority: { type: 'string', enum: ['首选', '对口', '能干', '不相关'] },
          company_tier: { type: 'string', enum: ['大单位', '中型', '小公司', '看不出'] },
          grade_risk: { type: 'string', enum: ['无', '届别对不上，需看公告', '看不出'] },
          reason: { type: 'string' },
          veto: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'matched_positions', 'fit', 'verdict', 'priority', 'company_tier', 'grade_risk', 'reason', 'veto'],
      },
    },
  },
  required: ['items'],
};

function campusSystem(config) {
  const city = (config.filter?.cities || [])[0] || '';
  const year = cohortOf(config.resume?.graduation);
  return `你在帮一个求职者筛校园招聘公告。下面是他的基本情况、求职标准和简历，然后是 N 条公告。
公告只有公司、岗位串、地点、公司性质、行业、批次、截止日期，没有详细 JD，所以只能按这些判断，拿不准就给「等你定」，不要脑补 JD。

# 他的基本情况
${basics(config)}

# 他的求职标准
${config.criteria || ''}

# 他的简历
${renderResume(config.resume)}

# 补充规则（校招专用，和上面冲突时以这里为准）
## 先挑岗位（matched_positions + fit）
岗位串里常一次列十几个岗位，只挑出他按专业和简历能投的，原样抄进 matched_positions。能投的方向按他的简历、目标岗位和求职标准判断，**不限公司行业**；综合管培生这种笼统岗位一般也能投。「XX类 / XX专业」写的是招哪个专业，要和他的专业对得上才算。
fit：matched_positions 里有明确对口的写「对口」；只有管培生 / 运营这种笼统岗位写「沾边」；一个能投的都没有写「不对口」，matched_positions 给空数组。
reason 必须和 fit 一致：fit=不对口时 reason 说为什么不对口；fit=对口/沾边时 reason 说对口在哪。
## 再下结论
- fit=不对口 → verdict=不投。
- ${year ? `他是 ${year} 届。批次写的届别和他对不上的（比如写「${year + 1}届」），除非公告明确接收往届或择业期内未就业毕业生，否则 grade_risk=「届别对不上，需看公告」；届别不影响 verdict，风险单独标在 grade_risk 里；对得上或「不限届别」的写「无」。` : '他的毕业年份没填，grade_risk 一律写「看不出」。'}
- ${city ? `工作地点必须能在${city}：locations 含${city}的正常判断；只写「全国」的给「等你定」并在 reason 写「需确认${city}有没有岗」；不含${city}也不含全国的不投。` : '他没限定城市，地点不影响结论。'}
- 公司性质是国企/央企/外企/上市/合资，或你认得出是上市公司 / 知名品牌的，company_tier=大单位。

对每条公告输出一个对象，全部放进 items 数组，字段：
{"id": 公告id, "matched_positions": ["..."], "fit": "对口|沾边|不对口", "verdict": "投|等你定|不投", "priority": "首选|对口|能干|不相关",
 "company_tier": "大单位|中型|小公司|看不出", "grade_risk": "无|届别对不上，需看公告|看不出", "reason": "一句话，说清为什么", "veto": ["命中的一票否决条目，没有就空数组"]}
每条公告都必须有一个对象，不许漏。`;
}

const campusLine = (x) => JSON.stringify({
  id: x.id, company: x.company, positions: x.positions.slice(0, 400), locations: x.locations.slice(0, 120),
  typeTag: x.typeTag, industry: x.industry, batch: x.batch, deadline: x.deadline,
});

/** 一批 10～20 条公告送一次模型。返回 [{id, verdict, ...}]，漏掉的 id 不在里面（调用方下次再送） */
export async function screenCampus(items, config) {
  const data = await callJson(forTask(config, 'screen'), {
    system: campusSystem(config),
    cacheSystem: true,
    user: `下面是 ${items.length} 条公告（每行一条 JSON）：\n${items.map(campusLine).join('\n')}`,
    schema: CAMPUS_SCHEMA,
    maxTokens: 6000,
    effort: 'low',
    task: 'campus',
  });
  const arr = Array.isArray(data.items) ? data.items : [];
  const valid = new Set(items.map((x) => String(x.id)));
  return arr.filter((r) => r && valid.has(String(r.id))).map((r) => {
    const v = String(r.verdict || '');
    const veto = Array.isArray(r.veto) ? r.veto.filter(Boolean) : [];
    const matched = (Array.isArray(r.matched_positions) ? r.matched_positions : []).map(String).filter(Boolean).slice(0, 8);
    const fit = /不对口/.test(r.fit || '') || !matched.length ? '不对口' : /沾边/.test(r.fit || '') ? '沾边' : '对口';
    return {
      id: String(r.id),
      fit,
      // 岗位一个都不对口就是不投，模型结论写歪了也按这个来（实测模型会写「不匹配」却给「等你定」）
      verdict: fit === '不对口' || veto.length || /不投/.test(v) ? '不投' : /等|定|待/.test(v) ? '等你定' : /投/.test(v) ? '投' : '等你定',
      priority: fit === '不对口' ? '不相关' : ['首选', '对口', '能干', '不相关'].find((p) => String(r.priority || '').includes(p.slice(0, 2))) || '能干',
      company_tier: ['大单位', '中型', '小公司', '看不出'].find((t) => String(r.company_tier || '').includes(t.slice(0, 2))) || '看不出',
      matched_positions: matched,
      grade_risk: /对不上|只招|届/.test(r.grade_risk || '') ? '届别对不上，需看公告' : /无/.test(r.grade_risk || '') ? '无' : '看不出',
      reason: String(r.reason || ''),
      veto,
    };
  });
}

// ---------------------------------------------------------------- 网申后给 HR 的消息

const FOLLOWUP_SCHEMA = { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] };

/**
 * 已经在官网网申过这家公司，现在在 BOSS 上找到了这家公司的 HR，起草第一条消息。
 * 结果还要过 checkGreeting（有作品集就在最前面补一句、查禁用词），再进审核列表，你按「投」才发。
 */
export async function followupMessage(job, followup, config) {
  const lib = config.library;
  const user = `你在替求职者给招聘平台上的 HR 发第一条消息。他已经在这家公司的官网网申投过了，现在在 BOSS 上找到了这家公司的 HR。

公司：${followup.company}　官网网申投的岗位：${followup.position || '(没记岗位名)'}　投递日期：${followup.date}
平台上这个 HR 在招的岗位：${job.title}
JD 要点：${String(job.jd || '').slice(0, 800)}
素材库：
${lib ? libraryForModel(lib) : renderResume(config.resume)}

要求：
- 4 句以内，自信、得体、自然、流畅（像一个靠谱的求职者在正常沟通；不开玩笑、不用比喻和自嘲、不用表情符号；事实只能来自素材库）。
- 第一句说清已经在官网投了哪个岗位（平台上的岗位和网申岗位不一样的，就说对这个岗位也感兴趣）。
- 第二句挑一条跟岗位最对口的真实经历，只能用素材库里的原句意思，不夸大。
- 不要写网址${lib?.profile?.site ? '，也不要提作品集，程序会在最前面自动补一句「我自己有个人作品集网站…」' : ''}。
- 不问底薪、休息、下班时间，待遇等 HR 回了再问。
- 不写「可随时到岗」。
- 求职标准里对开场白的其他要求也要遵守：
${config.criteria || ''}
- 不要用这些词：${(config.greeting?.forbid || []).join("、")}（称呼公司直接用公司名）。
- 写成一段话，不要换行。
输出 json：{"message": "消息正文"}`;
  const d = await callJson(forTask(config, 'screen'), { user, schema: FOLLOWUP_SCHEMA, maxTokens: 1500, effort: 'low', task: 'followup' });
  // 模型偶尔还是会留一句「我的作品集：」空壳、或者分成几行：去掉空壳、并成一段
  return String(d.message || '').replace(/[^。！？\n]*作品集[:：]?\s*(?=\n|$)/g, '').replace(/\s*\n+\s*/g, '').trim();
}
