/** chrome.storage 封装 + 默认配置 */
import { buildLibrary } from './library.js';

/**
 * 找工作标准的模板：给模型看的，设置页可以改；改了以后每个岗位的判断都会跟着变。
 * 带【】的地方换成你自己的情况，不需要的段落直接删。
 */
export const DEFAULT_CRITERIA = `【一句话介绍自己：比如 2026 届市场营销本科应届生 / 做了 2 年新媒体运营，想换到品牌方】。宁可少投几家，也不要被坑。
最看重的：【比如 对口经历、双休准点、离家近、工资】（按重要程度排）。

## 工作地点
岗位必须在设置里填的求职城市上班。外派、驻外、长期出差、其他城市一律 verdict=不投。
【可选：通勤要求，比如 住在 XX 区，单程 1 小时以内；拿不准的给「等你定」并在 reason 写估的距离】

## 优先顺序（写进 priority）
1. 首选：【最想去的方向，比如 快消品牌的市场岗、外企】
2. 对口：【专业或经历对口的岗位，比如 电商运营、新媒体运营、内容运营】
3. 能干：【不完全对口但能干的正经白领岗，比如 行政、人事、采购、商务助理、数据、文员】
都不是的写「不相关」。match_score 参考：首选 85 以上，对口 70–84，能干 55–69；reasons 里写清属于哪一档。

## 一票否决（命中任一条：verdict=不投，并把命中的条目写进 veto）
- 实际干的是电话销售、地推、课程销售或引流到私域卖课、保险、招商加盟、签约主播
- 名不副实：岗位名写「运营」「助理」，JD 里实际是销售、客服、主播助理
- 收费或培训贷信号：自费培训、分期、「包学包会」、特意强调「不收取任何费用」、「月入过万上不封顶」
- 单休；或者写明无责底薪很低、主要靠提成
- 卷：JD 写常态加班、「狼性」「996」「抗压能力强」「高强度」这类
- 要求的工作年限明显超过我的经验
- 工作地不在求职城市

## 公司档次（写进 company_tier）
- 大单位：上市、国企 / 央企、外资、全国有名的品牌，或者人数 1000 人以上且注册资本对得上
- 中型：100～999 人的正规公司
- 小公司：100 人以下
- 看不出：信息不够
公司名你认得出是上市公司或知名品牌的，即使平台信息没写也算大单位。同样条件下大单位排前面。

## 休息和薪资
- 双休、准点下班优先；大小周、JD 没写休息制度 → 等你定
- 要有五险；薪资区间下沿明显偏低的多半是低底薪靠提成，谨慎

## 拿不准的一律 verdict=等你定
公司信息查不到或自相矛盾、JD 太短看不出实际干什么、薪资结构说不清、HR 很久没活跃，都不要硬给「投」。
注册资本低本身说明不了问题（很多是集团子公司），单凭这一条最多判「等你定」。

## 开场白
- 只用简历上的真实经历，第一句就对准这个岗位最需要的那条
- 只介绍自己、亮最对口的经历，不问底薪、休息、下班时间；结尾可以问一句跟岗位业务相关的问题，也可以不问
- 不写「可随时到岗」`;

export const DEFAULTS = {
  // --- 接口（默认 DeepSeek，OpenAI 兼容）---
  provider: 'openai',
  apiBase: 'https://api.deepseek.com',
  apiKey: '',
  model: 'deepseek-flash',
  effort: 'medium',       // low/medium/high，越高判断越准也越慢越贵

  // --- 按任务单独配模型（可选）：没填 key 的任务走上面那组 ---
  models: {
    screen: { provider: 'openai', apiBase: '', apiKey: '', model: '' },
    autofill: { provider: 'openai', apiBase: '', apiKey: '', model: '' },
  },

  // --- 求职城市的搜索代码：一般按城市名自动查，查不到的在设置页手填 ---
  cityCode: { boss: '', job51: '' },

  // --- 网申自动填：附件上传用的本机文件（可选）---
  autofill: {
    files: {
      dir: '',      // 放简历 PDF 的文件夹
      photo: '',    // 证件照路径
    },
  },

  // --- 找工作标准（给模型看）---
  criteria: DEFAULT_CRITERIA,

  // --- 主简历（设置页粘贴后解析出来的）---
  resume: {
    name: '',
    title: '',            // 目标岗位
    years: 0,             // 工作年限
    city: '',
    education: '',        // 本科 / 硕士 ...
    school: '',
    major: '',
    degree: '',
    eduStart: '',         // 入学年月 2022-09
    graduation: '',       // 毕业年月 2026-06
    phone: '',
    email: '',
    gender: '',
    age: '',
    political: '',
    site: '',             // 作品集 / 个人主页网址（没有就空着）
    salary: '',           // 期望薪资
    summary: '',          // 个人概述
    skills: [],
    experiences: [],      // [{company, role, period, bullets:[...]}]
    projects: [],         // [{name, role, period, stack, bullets:[...]}]
    highlights: [],       // 可复用的亮点句，定制时优先挑选
    rawText: '',          // 原始简历全文，兜底给模型看
  },

  // --- 简历变体：已经传到 BOSS 的几份附件简历 ---
  // 工具按岗位类型告诉你该发哪一份
  variants: [],

  // --- 硬性筛选（本地跑，不花钱）---
  filter: {
    salaryMin: 0,           // 薪资区间上沿低于它就淘汰(K)；0=不限
    salaryFloorMin: 0,      // 薪资区间下沿低于它就淘汰(K)；0=不限
    salaryMax: 0,           // 0=不限
    cities: [],             // 求职城市，第一个用来开搜索页；空=不限
    excludeKeywords: [      // 岗位名/公司名命中就淘汰（别放单独的「主播」—— 会误杀「直播运营（非主播）」）
      '外包', '驻场', '劳务派遣', '中介', '电话销售', '电销', '地推', '保险',
      '语音主播', '娱乐主播', '签约主播', '主播经纪', '公会', '陪玩', '课程顾问', '招商',
      '外派', '驻外',
    ],
    includeKeywords: [],    // 非空时，岗位名必须命中其一
    maxYearsRequired: 0,    // 岗位要求年限上限；0=不限
    skipChatted: true,      // 跳过已沟通过的
  },

  // --- 进筛选列表的门槛（不自动投，列表里你按「投」才发）---
  thresholds: {
    askMe: 45,        // 「投」且匹配分 >= 45 进列表；「等你定」都进；「不投」都丢
  },

  // --- 节奏与配额（防风控）---
  pace: {
    dailyLimit: 15,         // 每天最多打招呼数
    minDelayMs: 25000,      // 打完一个招呼后的间隔下限
    maxDelayMs: 70000,      // 上限（实际取区间内随机）
    batchSize: 8,           // 连续发几个后强制长休息
    longRestMs: 600000,     // 长休息 10 分钟
    stopOnCaptcha: true,    // 出现验证码立即停机
  },

  // --- 开场白 ---
  greeting: {
    maxChars: 85,          // 开场白正文上限（作品集那句不算）
    tone: '简洁直接，第一句就摆最对口的经历和数字，别做铺垫。只介绍自己，不问底薪、休息、下班时间。',
    mustInclude: [],
    forbid: ['贵公司', '久仰', '本人认为自己非常适合', '希望给我一个机会', '期待您的回复', '可随时到岗', '随时到岗'],
  },
};

// 运行态（队列、日志、统计）单独存，避免和配置互相覆盖
export const RUNTIME_DEFAULTS = {
  queue: [],          // 待确认队列 [{job, match_score, verdict, reasons, greeting, variant_id}]
  done: [],           // 今日已发 [{jobId, title, company, at, score}]
  seen: {},           // jobId -> timestamp，去重用
  stats: { date: '', sent: 0, skipped: 0, evaluated: 0 },
  logs: [],           // 运行日志，最多留 300 条
  paused: false,
  lastError: '',
  seenCleanV052: true,   // 旧版的一次性迁移，新装的不需要
};

export async function getConfig() {
  const got = await chrome.storage.local.get('config');
  const { library: _old, presetVersion: _pv, ...stored } = got.config || {};
  const c = deepMerge(structuredClone(DEFAULTS), stored);
  // 素材库由简历现算（定制简历 PDF、网申填表用），不单独存
  c.library = c.resume?.name ? buildLibrary(c.resume, c) : null;
  return c;
}

/** 第一次用还缺什么：[{ key, text }]，空数组 = 能用了 */
export function setupMissing(c) {
  const miss = [];
  if (!c.apiKey) miss.push({ key: 'apiKey', text: '填 DeepSeek 的 API Key' });
  if (!(c.filter?.cities || []).length) miss.push({ key: 'city', text: '填求职城市' });
  if (!c.resume?.name) miss.push({ key: 'resume', text: '粘贴简历并解析' });
  return miss;
}

export async function setConfig(patch) {
  const cur = await getConfig();
  const { library: _lib, ...next } = deepMerge(cur, patch);
  await chrome.storage.local.set({ config: next });
  return getConfig();
}

export async function getRuntime() {
  const got = await chrome.storage.local.get('runtime');
  const rt = deepMerge(structuredClone(RUNTIME_DEFAULTS), got.runtime || {});
  // 跨天自动重置当日统计（按本地日期，不按 UTC —— 不然北京时间早上 8 点前算成前一天）
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (rt.stats.date !== today) {
    rt.stats = { date: today, sent: 0, skipped: 0, evaluated: 0 };
    rt.done = [];
    await chrome.storage.local.set({ runtime: rt });
  }
  return rt;
}

let rtLock = Promise.resolve();

/**
 * 顶层浅合并：runtime 的每个字段（queue/done/seen/stats/logs）都是独立整块写入的。
 * 这里不能用 deepMerge —— 那样 setRuntime({ seen: {} }) 会变成「什么也没改」，清不掉去重记录。
 * 所有写入排成一队：BOSS 和 51job 同时在筛、发送器同时在写日志时，先读后写会互相覆盖（丢进列表的岗位 / 已发的又回到队列）。
 * patch 可以是函数 (rt) => 要改的字段：在队里拿到最新的 runtime 再算，读改写不会被别人插队。函数里别再调 setRuntime。
 */
export function setRuntime(patch) {
  const job = rtLock.then(async () => {
    const cur = await getRuntime();
    const p = typeof patch === 'function' ? patch(cur) : patch;
    if (!p) return cur;
    const next = { ...cur, ...p };
    await chrome.storage.local.set({ runtime: next });
    return next;
  });
  rtLock = job.catch(() => {});
  return job;
}

/** 数组直接替换，对象递归合并 */
function deepMerge(base, patch) {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(patch) || typeof patch !== 'object') return patch;
  const out = Array.isArray(base) ? {} : { ...(base || {}) };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(out[k] || {}, v) : v;
  }
  return out;
}
