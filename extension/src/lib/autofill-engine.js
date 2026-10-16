/**
 * 网申自动填 —— 调度（v0.7.0 模块 B，跑在侧边栏里）。
 *
 * 一次「填这一页」：
 *   注入 autofill.js（所有帧）→ 扫字段 → 素材库条数比页面组数多就点「添加」补齐 → 重扫
 *   → 本地规则填确定的（姓名手机邮箱学校专业学历毕业时间…）→ 本机记忆填简历外字段（身份证这类不发模型）
 *   → 剩下的按分块一块一块送 DeepSeek 认字段出值（少了哪个 ref 单独再问；取错了哪条经历驳回重问）
 *   → 近义栏目补齐 → 本地格式校验 → 填（原生 setter → 不生效再 debugger 真打字）→ 回读
 *   → 下拉：本地比对选项文字，对不上才问模型；级联一层一层点
 *   → 开放题逐题起草（标黄）→ 等 1 秒重扫，新冒出来的框接着填（最多 3 轮）
 *   → 对照表送模型逐行核对（判不对的标黄，不自动改）→ 上色 → 覆盖率报告
 * 永远不点提交。模型走 config.models.autofill（DeepSeek deepseek-flash）。
 */
import { callJson, forTask } from './llm.js';
import { factsFrom, factsForModel, localRule, synKey, SYNONYMS, checkFormat, parseSource, listOfSection, sectionKind, SENSITIVE, matchOption, normLabel, norm } from './autofill-lib.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 页面通信

async function frameIds(tabId) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null);
  return (frames || [{ frameId: 0, url: '' }]).filter((f) => /^https?:/.test(f.url || 'http:'));
}

async function inject(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['src/content/autofill.js'] });
  } catch (e) {
    // 有的子帧没授权会整体报错：退回只注入顶层
    await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content/autofill.js'] });
  }
}

function ask(tabId, frameId, action, payload = {}, timeout = 15000) {
  let timer;
  return Promise.race([
    chrome.tabs.sendMessage(tabId, { jfz: true, action, payload }, { frameId }),
    new Promise((_, bad) => { timer = setTimeout(() => bad(new Error(`页面 ${timeout / 1000} 秒没回应（${action}）`)), timeout); }),
  ]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------- debugger（原生 setter 不生效时真打字、传附件）

const dbgTabs = new Set();
async function dbgAttach(tabId) {
  if (dbgTabs.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, '1.3');
  dbgTabs.add(tabId);
  await sleep(600);
}
async function dbgDetach(tabId) {
  if (!dbgTabs.has(tabId)) return;
  dbgTabs.delete(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {});
}
chrome.debugger.onDetach.addListener((src) => dbgTabs.delete(src.tabId));
const dsend = (tabId, m, p = {}) => chrome.debugger.sendCommand({ tabId }, m, p);

// ---------------------------------------------------------------- 模型

function systemFor(facts) {
  // 素材库放最前面、每次一字不差 —— DeepSeek 的上下文缓存按前缀命中，后面的调用输入便宜 50 倍
  return `你在帮求职者填企业招聘官网的网申表单。下面是他的简历素材库（JSON），这是唯一可用的事实来源；路径写法如 experiences[1].company 表示 experiences 数组第 2 条的 company。

# 素材库
${factsForModel(facts)}

# 所有任务都要守的规矩
- 只能用素材库里有的事实，不编经历、不编数字、不编公司信息。素材库没有的就说没有。
- 学历、入学时间、毕业时间以素材库 education[0] 的 degree / start / graduation 为准，素材库没写的就是没有，不要猜。
- 不写「可随时到岗」、不谈薪资之外的待遇要求。
- 团队项目里团队的成果不能写成他一个人的。`;
}

const MAP_SCHEMA = {
  type: 'object',
  properties: { items: { type: 'array', items: { type: 'object', properties: {
    ref: { type: 'string' }, field: { type: 'string' }, value: { type: ['string', 'null'] }, status: { type: 'string' },
    source: { type: 'string' }, similar_to: { type: ['string', 'array'] },
  }, required: ['ref', 'field', 'value', 'status', 'source'] } } },
  required: ['items'],
};

function mapPrompt(fields, job, note = '') {
  const list = fields.map((f) => ({
    ref: f.key, label: f.label || '(没认出标签)', kind: f.kind, required: f.required, section: f.sectionLabel,
    ...(f.options?.length ? { options: f.options } : {}), ...(f.placeholder ? { placeholder: f.placeholder } : {}),
    ...(f.maxLength ? { maxLength: f.maxLength } : {}), ...(f.context ? { context: f.context } : {}),
  }));
  return `任务：为网申表单的每个字段给出要填的值。
公司：${job.company || '(没写)'}，岗位：${job.position || '(没写)'}

规则：
- 只能用素材库里有的事实。素材库里没有的（身份证号、家庭成员、紧急联系人、GPA、户口所在地、期望到岗时间等）value 给 null、status=「缺」，不要编。
- 学历、入学时间、毕业时间取素材库 education[0] 的 degree / start / graduation；素材库没有的 value=null、status=「缺」。
- 下拉/单选字段：value 必须是 options 里原样存在的一项，挑最贴切的；没有贴切的给 null、status=「缺」。没给 options 的下拉，value 写想选的文字。
- 日期按字段要求的格式（看 placeholder），只知道年月的写 YYYY-MM；「至今」照写「至今」。
- 同类多条（教育、实习、项目）按 section 里的「#序号」对应素材库里的第几条：「#1」是第 1 条（下标 0）。实习/工作经历用 experiences，项目用 projects，校园/社团用 campus。
- 描述类文本框取素材库原句，不改写事实、不加数字，超过 maxLength 就删句子，不要截半句。栏目问什么取什么：「工作内容 / 主要职责 / 职责描述」问的是做了什么，取 duty（没有就取 brief）；「工作成果 / 业绩」才取 result；「项目描述 / 经历描述」没细分的取 content。
- 开放题（为什么选择我们、职业规划、自我评价、个人优势、优缺点、你的特长等需要成段作答的）不在这里写，value=null、status=「开放题」。
- 每个 ref 都必须出现在输出里，一个都不能少；输出条数必须等于输入的字段数（${list.length} 个）。
- 意思相近的两个栏目都要填，不许合并、不许只填一个：比如「手机」和「联系电话」都填同一个号；「工作内容」和「主要职责」这类长文本两个都写：一个用 duty 原句；另一个用 brief 里说「做什么」的分句（从开头截到第一个成果数字之前，原字不改），别复制同一段，也别把成果数字当职责填。
- 按分块和序号取内容：section 是「实习经历 #2」的，只能用 experiences 里的第 2 条（experiences[1]）；同一个 section 里的公司名、职位、起止时间、描述，必须出自同一条经历。source 写成「experiences[1].company」这种能核对的路径。
- 先想清楚这个栏目问的是什么，再挑值：职位框填职位、公司框填公司、描述框填这段经历的描述，不要填错类型。
- 期望城市：素材库 intent.city。期望薪资：素材库 intent.salary。
- 字段 label 看不懂的，结合 section 和 context（周围的精简 HTML）判断；实在认不出是什么字段的 status=「认不出」，不要猜着填。
${note ? `\n特别注意：${note}\n` : ''}
字段清单：
${JSON.stringify(list)}

输出前自己核对一遍：条数对不对、近义栏目是不是都有值、同组内容是不是出自同一条经历。
输出 json：{"items": [{"ref": "...", "field": "你认出的字段含义，如 实习经历2-公司名称", "value": "...或 null", "status": "填|缺|开放题|认不出", "source": "取自素材库哪一条（如 experiences[1].company），缺的写缺什么", "similar_to": "和它意思相近的其他 ref，没有就空字符串"}]}`;
}

const PICK_SCHEMA = { type: 'object', properties: { pick: { type: ['integer', 'null'] }, reason: { type: 'string' } }, required: ['pick'] };
function pickPrompt(label, target, parents, options) {
  return `任务：在招聘网站的下拉框里选一项。
字段：${label}
想填的内容：${target}
已经选过的上级：${parents.length ? parents.join(' > ') + ' > ' : '（没有）'}
候选项（编号: 文字）：
${options.map((o, i) => `${i}: ${o}`).join('\n')}

规则：
- 选意思最贴近的一项，优先完全相同，其次是上级类目（比如专业没有「电子商务」就选「电子商务类」「管理学」「工商管理类」里最贴近的；城市先选省再选市）。
- 学历、毕业届别按想填的内容选，没有完全一样的就选最贴近的一项。
- 都不沾边就回 null，不要硬选。
输出 json：{"pick": 编号或 null, "reason": "一句话"}`;
}

const ANSWER_SCHEMA = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
// 这些开放题结尾会补一句作品集网址（withSite），给模型的字数要先扣掉那句
const SITE_LABEL = /评价|优势|介绍|简介|为什么|选择|亮点|补充|特长|自己|匹配|胜任/;
function answerPrompt(q, job, maxLen0, avoid = '') {
  const maxLen = SITE_LABEL.test(q) && maxLen0 >= 80 ? maxLen0 - 45 : maxLen0;
  return `任务：替求职者起草网申表单里的开放题回答。回答会先给他本人改，再由他提交。

题目：${q}
字数限制：${maxLen} 字以内
公司：${job.company || '(没写)'}，岗位：${job.position || '(没写)'}${job.notice ? `，公告要点：${job.notice}` : ''}

要求：
- 第一句直接回答问题，别客套。用第一人称，口语化但不油，像应届生本人写的，不要金句、不要排比、不要「赋能」「抓手」这类词。
- 事实只用素材库里的：经历、数字、工具都照原样，不夸大、不编新事，个人项目要说清是个人做的、借助 AI 工具完成。
- 挑一到两段跟这个岗位最对口的经历展开讲，别把简历全复述一遍。自我评价 / 个人优势类可以参考素材库 self_evaluation，但要改成连贯的段落，不要列表。不要自己写网址：程序会在结尾补一句作品集网址（他的个人作品集站是加分项）。
- 不要假设这家公司有什么业务、制度（比如「贵公司的跨境业务」「轮岗机制」），除非上面公告要点里写了。
- 「为什么选择我们」要落到这家公司的具体业务（公告里有的）；没给公司业务信息时，从这家公司的名气 / 行业和这个岗位要做的事切入，说他的哪段经历能直接用上，不编公司信息，也不要写「没查到贵公司信息」这种话。
- 职业规划类：写在这个岗位上前两三年想做成什么，不提考研考公。
- 不写「可随时到岗」，不谈薪资。
- 严格不超过 ${maxLen} 字。
${avoid ? `- 同一张表上另一个意思相近的栏目已经写了下面这段，这一栏换个侧重，不要重复它的句子：\n${avoid}\n` : ''}
输出 json：{"answer": "回答正文"}`;
}

const VERIFY_SCHEMA = { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: {
  ref: { type: 'string' }, problem: { type: 'string' }, why: { type: 'string' }, suggest: { type: ['string', 'null'] },
}, required: ['ref', 'problem', 'why'] } } }, required: ['items'] };
function verifyPrompt(rows, job = {}) {
  return `任务：下面是一张网申表单的填写对照表，每行是：ref | 所在分块 | 栏目名 | 填进去的值 | 取自素材库哪条。
逐行判断「这个值是不是在回答这个栏目」，对照素材库核对。
这张表是投「${job.company || '(没写公司)'}」的「${job.position || '(没写岗位)'}」岗位，回答里提到这个公司名和岗位名是正常的，不算编造；但说这家公司有什么具体业务、制度（素材库和这里都没有的）算编造。
开放题（为什么选择我们、自我评价等）是模型起草给求职者改的，只查事实有没有编、有没有答非所问。

重点查三类错：
- 串位：值属于另一段经历（比如实习经历 #1 里填的是素材库第 2 段的公司或时间）；
- 类型错：公司名填进职位、日期填进描述、描述写的不是这个栏目问的东西；
- 漏近义：两个意思相近的栏目，一个有值、另一个空着。

${rows.join('\n')}

只列有问题的行，输出 json：{"items": [{"ref": "...", "problem": "串位|类型错|漏近义|其他", "why": "一句话", "suggest": "建议改成什么，拿不准就写 null"}]}
全部没问题就输出 {"items": []}。`;
}

// ---------------------------------------------------------------- 主流程

/**
 * opts: { tabId, job:{company, position, notice}, config, onProgress(text), fresh(重新识别，不用缓存) }
 * 返回 report：{ fields:[...], stats, calls:[...], rounds, submits, warnings }
 */
export async function fillPage(opts) {
  // 中途出错也要把 debugger 断开，不然「正在调试此浏览器」的提示条一直挂着（9/28 审查）
  try { return await fillPageInner(opts); } finally { await dbgDetach(opts.tabId).catch(() => {}); }
}

async function fillPageInner(opts) {
  const { tabId, config } = opts;
  const job = opts.job || {};
  const say = (t) => opts.onProgress?.(t);
  const mcfg = forTask(config, 'autofill');
  const facts = factsFrom(config.library, config.resume?.summary || '');
  const system = systemFor(facts);
  const calls = [];
  const model = async (task, user, schema, maxTokens = 3000) => {
    const t0 = Date.now();
    let usage = null;
    try {
      return await callJson(mcfg, { system, user, schema, maxTokens, task, onUsage: (u) => { usage = u; } });
    } finally {
      calls.push({ task, ms: Date.now() - t0, chars: (system.length + user.length), in: usage?.in || 0, out: usage?.out || 0, hit: usage?.cacheRead || 0 });
    }
  };
  const { afMemory = {} } = await chrome.storage.local.get('afMemory');
  const cacheKey = await pageKey(tabId);
  const { afCache = {} } = await chrome.storage.local.get('afCache');
  const cached = opts.fresh ? {} : (afCache[cacheKey] || {});
  const newCache = {};

  await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  say('注入页面脚本…');
  await inject(tabId);
  const frames = await frameIds(tabId);

  const all = new Map();       // key -> field record
  const warnings = [];
  let submits = [];
  const t0 = Date.now();

  let gates = [];
  async function scanAll() {
    const out = [];
    submits = [];
    gates = [];
    const adds = [];
    for (const fr of frames) {
      let res;
      try { res = await ask(tabId, fr.frameId, 'scan'); } catch { continue; }
      if (!res?.fields) continue;
      if (res.gate) gates.push(res.gate);
      submits.push(...(res.submits || []));
      for (const a of res.adds || []) adds.push({ ...a, frameId: fr.frameId });
      for (const f of res.fields) {
        const key = `${fr.frameId}:${f.ref}`;
        out.push({ ...f, key, frameId: fr.frameId, sectionLabel: f.section ? `${f.section}${f.groups > 1 || listOfSection(f.section) ? ` #${f.index}` : ''}` : '' });
      }
    }
    return { fields: out, adds };
  }

  // ---- 0. 扫一遍，素材库条数比页面组数多的分块点「添加」补齐（第 13 条 a：几段经历就几组）
  say('扫字段…');
  let { fields, adds } = await scanAll();
  // 页面被挡住了就别填（10/16 照 Tabbit 字节简历配方加的）：验证码、访问太频繁直接停；登录框只在几乎扫不到字段时才算挡住（页头的登录入口不算）
  const gate = gates.find((g) => g.code === 'captcha' || g.code === 'rate') || (fields.length < 3 && gates.find((g) => g.code === 'login'));
  if (gate) {
    const why = { captcha: '页面弹出了验证码 / 滑块，你先过一下', rate: '网站说操作太频繁，歇几分钟', login: '这一页要先登录' }[gate.code];
    throw new Error(`${why}，弄完再点「填这一页」${gate.msg ? `（页面上写着：${gate.msg.slice(0, 40)}）` : ''}`);
  }
  if (!fields.length) throw new Error('这一页没扫到能填的框。要是表单在弹窗 / 下一步里，打开后再点「填这一页」');

  // 先传附件：Moka 这类网站传了简历会自动解析、回填表单（9/28 真 Moka 实测：解析把入学时间也写成了 2026-06），
  // 所以先传、等它回填完，再按素材库把能确定的改回来；解析回填的、素材库没有的标黄让你核对
  const initial = new Map(fields.map((f) => [f.key, f.value]));
  const files = fields.filter((f) => f.kind === 'file');
  if (files.length) {
    for (const f of files) {
      const r = { ...f, status: '', value: f.value, filled: '', source: '', by: '', notes: [] };
      all.set(f.key, r);
      await handleFile(r);
    }
    if (files.some((f) => all.get(f.key).status === '已填')) {
      say('传了简历，等网站自动解析回填（8 秒）…');
      await sleep(8000);
      ({ fields, adds } = await scanAll());
    }
  }
  const parsedByPage = (f) => f.value && initial.has(f.key) && norm(initial.get(f.key)) !== norm(f.value);
  const gaveUp = new Set();
  /** 素材库有几段，页面就要有几组：不够就点「添加」，每点一次重扫（项目区这种要先选「有」才冒出来的，下一轮再补） */
  async function expandGroups() {
    for (let click = 0; click < 10; click++) {
      const need = groupsNeeded(fields, facts).filter((n) => n.have < n.want && !gaveUp.has(n.kind));
      const todo = need.find((n) => adds.some((a) => sectionKind(a.section) === n.kind || sectionKind(a.text) === n.kind));
      if (!todo) {
        return;
      }
      const btn = adds.find((a) => sectionKind(a.section) === todo.kind) || adds.find((a) => sectionKind(a.text) === todo.kind);
      say(`${todo.section}：素材库有 ${todo.want} 段、页面只有 ${todo.have} 组，点「${btn.text}」加一组…`);
      await ask(tabId, btn.frameId, 'clickAdd', { ref: btn.ref });
      await sleep(900);
      ({ fields, adds } = await scanAll());
      const after = groupsNeeded(fields, facts).find((n) => n.kind === todo.kind)?.have || 0;
      if (after <= todo.have) {
        gaveUp.add(todo.kind);
        warnings.push(`${todo.section}：点了「${btn.text}」没多出一组框（可能是弹窗式添加），还差 ${todo.want - todo.have} 段没加，你手动加一下再点「填这一页」`);
      }
    }
  }

  // ---- 多轮：补组 → 填 → 等 1 秒重扫 → 新冒出来的接着填（第 13 条 a）
  let rounds = 0;
  for (; rounds < 3; rounds++) {
    await expandGroups();
    const fresh = fields.filter((f) => !all.has(f.key));
    if (!fresh.length) break;
    if (rounds > 0) say(`第 ${rounds + 1} 轮：填完又冒出 ${fresh.length} 个新框，接着填…`);
    for (const f of fresh) all.set(f.key, { ...f, status: '', value: f.value, filled: '', source: '', by: '', notes: [] });
    await processFields(fresh);
    await sleep(1000);
    ({ fields, adds } = await scanAll());
  }
  // 组数最后核对一遍（第 13 条 a：填完核对条数）
  for (const n of groupsNeeded(fields, facts)) {
    if (n.have < n.want && !gaveUp.has(n.kind)) warnings.push(`${n.section}：素材库有 ${n.want} 段，页面上只有 ${n.have} 组（没找到「添加」按钮），差的 ${n.want - n.have} 段没填`);
  }

  // ---- 近义栏目最后兜一遍（第 13 条 b）：同一分块同一组里同义的，有空着的就补
  await fixSynonyms();

  // ---- 对照表送模型逐行核对（第 13 条 c）
  const table = [...all.values()].filter((r) => r.filled && r.kind !== 'file');
  if (table.length) {
    say(`逐行核对 ${table.length} 个已填字段（栏目 ↔ 值 ↔ 出处）…`);
    try {
      const rows = table.filter((r) => !r.sensitive).map((r) => `${r.key} | ${r.sectionLabel || '-'} | ${r.label || r.field || '?'} | ${String(r.filled).slice(0, 600).replace(/\n/g, ' ')} | ${r.source || r.by}`);
      const v = await model('verify', verifyPrompt(rows, job), VERIFY_SCHEMA, 2000);
      for (const it of v.items || []) {
        const r = all.get(String(it.ref));
        if (!r) continue;
        r.check = { problem: it.problem, why: it.why, suggest: it.suggest || null };
        if (r.color !== 'red') r.color = r.by === 'page' && r.color === 'yellow' ? 'red' : 'yellow';
      }
    } catch (e) { warnings.push(`逐行核对没跑成：${e.message}`); }
  }

  // ---- 网站自己的红字：回读值对得上不等于网站收了，必填没填 / 格式不对的原话读回来标红（10/16 照 Tabbit 字节简历配方加的）
  await sleep(300);
  await collectSiteErrors();

  // ---- 上色、清理
  await paintAll();
  await dbgDetach(tabId);
  await chrome.storage.local.set({ afCache: { ...trimCache(afCache), [cacheKey]: { ...cached, ...newCache, at: Date.now() } } });

  const list = [...all.values()];
  const n = (st) => list.filter((r) => r.status === st).length;
  const stats = {
    total: list.length,
    filled: list.filter((r) => ['已填', '已有值', '开放题已起草'].includes(r.status)).length,
    missing: n('缺'), unknown: n('认不出'), failed: n('没生效'),
    open: n('开放题已起草'), prefilled: n('已有值'), files: list.filter((r) => r.kind === 'file').length,
    secs: Math.round((Date.now() - t0) / 1000), rounds: rounds + 0,
  };
  const report = { at: Date.now(), url: cacheKey, job, fields: list, stats, calls, submits: [...new Set(submits)], warnings, synPairs: synonymPairs(list) };
  await chrome.storage.local.set({ afLast: report });
  return report;

  // ================================================================ 内部

  async function processFields(batch) {
    const toModel = [];
    for (const f of batch) {
      const r = all.get(f.key);
      if (f.kind === 'file') { await handleFile(r); continue; }
      if (f.value && f.kind !== 'radio' && f.kind !== 'checkbox' && !/^请选择/.test(f.value)) {
        // 页面自己带了值（你之前填过 / 网站从在线简历或上传的简历解析回填的）
        // 手机号前面的「+86」区号下拉不算手机号
        const rule0 = /^\+\d{1,4}$/.test(norm(f.value)) ? null : localRule(f, facts);
        if (rule0 && !norm(f.value).includes(norm(rule0.value)) && !norm(rule0.value).includes(norm(f.value))) {
          // 素材库写死的（姓名、学校、毕业时间…）跟页面上的不一样：按素材库改
          r.source = rule0.source; r.by = 'rule'; r.notes.push(`页面上原来是「${f.value}」，按素材库改了`);
          await put(r, rule0.value); continue;
        }
        r.sensitive = isSensitive(f);
        r.status = '已有值'; r.filled = f.value; r.by = 'page';
        r.source = rule0 ? rule0.source : '';
        r.color = parsedByPage(f) && !rule0 ? 'yellow' : 'green';
        if (parsedByPage(f) && !rule0) r.notes.push('网站解析你的简历自动填的，素材库里没这一项，核对一下');
        // 入学时间 / 出生日期：素材库里没有，页面上却有值 —— 不管是网站解析简历填的、还是网站从在线简历带出来的，都标红让你核对（9/28 真 Moka：按年龄猜了个 2003-09）
        const memHit = afMemory[`${sectionKind(f.section)}:${normLabel(f.label)}`] || afMemory[`:${normLabel(f.label)}`];
        const confirmedByBoss = memHit && norm(memHit.value) === norm(f.value);   // 你自己填过、按「记住」存过的，不再标红
        if (!rule0 && !confirmedByBoss && /入学|开始|起始|出生/.test(f.label) && sectionKind(f.section) !== 'intern' && sectionKind(f.section) !== 'project') {
          r.color = 'red';
          r.notes.push(/出生/.test(f.label) ? '出生日期是网站自己带出来的（Moka 会按年龄猜），素材库没有，你改成真实的' : '入学时间是网站自己带出来的（解析简历时常写错），核对一下，应该是 2022 年');
        }
        continue;
      }
      if (f.value && (f.kind === 'radio' || f.kind === 'checkbox')) { r.sensitive = isSensitive(f); r.status = '已有值'; r.filled = f.value; r.by = 'page'; r.color = 'green'; continue; }
      const rule = localRule(f, facts);
      if (rule) { r.source = rule.source; r.by = 'rule'; await put(r, rule.value); continue; }
      const mem = afMemory[`${sectionKind(f.section)}:${normLabel(f.label)}`] || afMemory[`:${normLabel(f.label)}`];
      if (mem && f.label) { r.source = '本机记忆'; r.by = 'memory'; r.sensitive = isSensitive(f); await put(r, mem.value); continue; }
      if (/同意|协议|隐私|承诺|声明|授权|知情/.test(f.label + ' ' + (f.options || []).join(' ')) && (f.kind === 'checkbox' || f.kind === 'radio')) { r.status = '缺'; r.color = f.required ? 'red' : 'none'; r.notes.push('同意条款 / 承诺类勾选，插件不替你勾'); continue; }
      if (/调剂|调配|外派|出差|驻外|异地|轮岗|加班/.test(f.label)) { r.status = '缺'; r.color = f.required ? 'red' : 'none'; r.notes.push('态度类问题（会影响工作地点 / 岗位），插件不替你表态，你自己选'); continue; }
      if (isSensitive(f)) { r.status = '缺'; r.sensitive = true; r.color = f.required ? 'red' : 'none'; r.notes.push('素材库没有（敏感信息不发给模型）。你手填一次，再按「记住这页我填的」，下次自动填'); continue; }
      toModel.push(f);
    }
    if (!toModel.length) return;

    // 按分块切开，一块一块送（第 13 条 c：不把整页几十个字段一次扔过去，减少串位）
    const chunks = new Map();
    for (const f of toModel) {
      const k = `${f.frameId}|${f.section || '(未分块)'}`;
      if (!chunks.has(k)) chunks.set(k, []);
      chunks.get(k).push(f);
    }
    // 各块的模型调用一起发（最多 3 个同时），往页面上填还是一个一个来（下拉弹层同一时间只能开一个）—— 9/28 为了快
    const chunkList = [...chunks.values()];
    say(`认字段 + 出值：${chunkList.length} 块一起问（${chunkList.map((c) => c[0].section || '未分块').join('、')}）…`);
    // 第一块先单独问：把素材库那段 system 提示写进 DeepSeek 缓存，后面几块一起发就都能命中缓存（便宜 50 倍）
    const mapped = chunkList.length ? [await mapChunk(chunkList[0]), ...(await pool(chunkList.slice(1), (c) => mapChunk(c), 3))] : [];
    for (let ci = 0; ci < chunkList.length; ci++) {
      const chunk = chunkList[ci];
      const res = mapped[ci];
      say(`往页面上填：${chunk[0].section || '未分块字段'}（第 ${ci + 1}/${chunkList.length} 块）…`);
      for (const f of chunk) {
        const r = all.get(f.key);
        const m = res.get(f.key);
        if (!m) { r.status = '认不出'; r.color = f.required ? 'red' : 'none'; r.notes.push('模型问了两次都没给结果'); continue; }
        r.field = m.field; r.source = m.source || ''; r.similar = m.similar_to;
        const st = String(m.status || '');
        if (/开放/.test(st)) { r.status = '开放题'; continue; }
        if (/认不出/.test(st)) { r.status = '认不出'; r.color = f.required ? 'red' : 'none'; r.notes.push('模型也认不出这是什么栏目'); continue; }
        if (m.value == null || m.value === '' || /缺/.test(st)) { r.status = '缺'; r.color = f.required ? 'red' : 'none'; r.notes.push(`素材库没有：${m.source || m.field || ''}`.trim()); continue; }
        r.by = 'model';
        if (synKey(f.label) === 'duty' && /\.brief$/.test(m.source || '')) {
          const d = dutyPart(m.value);
          if (d && d.length >= 8) { m.value = d; r.notes.push('职责栏：brief 截到成果数字之前'); }
        }
        await put(r, String(m.value));
      }
    }

    // 开放题逐题起草（第 11 条），填完标黄
    const opens = batch.map((f) => all.get(f.key)).filter((r) => r.status === '开放题');
    // 没有近义栏目的开放题先一起起草好（快），有近义的按顺序来，后写的要避开先写的那段
    const solo = opens.filter((r) => !synKey(r.label));
    if (solo.length > 1) {
      say(`起草 ${solo.length} 道开放题（一起问）…`);
      const drafts = await pool(solo, (r) => model('open', answerPrompt(r.label, job, r.maxLength || 300, ''), ANSWER_SCHEMA, 1200).catch((e) => ({ err: e.message })), 3);
      solo.forEach((r, i) => { r.draft = drafts[i]; });
    }
    for (const r of opens) {
      say(`起草开放题：${r.label}…`);
      const max = r.maxLength || (/自我评价|个人优势|简介|介绍/.test(r.label) ? 200 : 300);
      const sib = [...all.values()].find((o) => o !== r && o.filled && synKey(o.label) && synKey(o.label) === synKey(r.label) && sameGroup(o, r));
      try {
        const a = r.draft && !r.draft.err ? r.draft : await model('open', answerPrompt(r.label, job, max, sib ? String(sib.filled).slice(0, 400) : ''), ANSWER_SCHEMA, 1200);
        const text = withSite(String(a.answer || ''), max, r.label, facts);
        r.source = '模型按素材库起草'; r.by = 'model-open';
        await put(r, text);
        if (r.status === '已填') { r.status = '开放题已起草'; r.color = 'yellow'; r.notes.push('模型起草的，你改一改再交'); }
      } catch (e) { r.status = '缺'; r.color = r.required ? 'red' : 'none'; r.notes.push(`起草失败：${e.message}`); }
    }
  }

  /** 一块字段送模型；少了的 ref 单独再问；取错经历条目的驳回重问 */
  async function mapChunk(chunk) {
    const out = new Map();
    const ck = (f) => `${f.section}|${f.index}|${f.label}|${f.kind}|${(f.options || []).join(',')}`;
    const fromCache = chunk.filter((f) => cached[ck(f)]);
    for (const f of fromCache) out.set(f.key, { ...cached[ck(f)], ref: f.key });
    let ask1 = chunk.filter((f) => !cached[ck(f)]);
    let note = '';
    for (let attempt = 0; attempt < 3 && ask1.length; attempt++) {
      let items = [];
      try {
        const d = await model('map', mapPrompt(ask1, job, note), MAP_SCHEMA, Math.min(8000, 600 + ask1.length * 220));
        items = Array.isArray(d.items) ? d.items : [];
      } catch (e) {
        warnings.push(`认字段调用失败（${ask1[0].section || '未分块'}）：${e.message}`);
        if (/402|余额/.test(e.message)) break;
        continue;
      }
      const byRef = new Map(items.map((m) => [String(m.ref), m]));
      const wrong = [];
      for (const f of ask1) {
        const m = byRef.get(f.key);
        if (!m) continue;
        // 分组锚定：「实习经历 #2」只能取 experiences[1]
        const want = listOfSection(f.section);
        const src = parseSource(m.source);
        if (want && want !== 'education' && m.value != null && !/开放|缺|认不出/.test(m.status || '') && src && src.list === want && src.i !== f.index - 1) {
          wrong.push(`${f.key}（${f.sectionLabel}「${f.label}」取成了 ${m.source}，应该取 ${want}[${f.index - 1}]）`);
          continue;
        }
        const bad = m.value != null ? checkFormat(f, m.value, facts, m.source) : '';
        if (bad && /选项里没有/.test(bad) && f.options?.length) {
          const i = matchOption(f.options, m.value);
          if (i >= 0) { m.value = f.options[i]; } else { wrong.push(`${f.key}（${bad}，options 里挑一个原样的）`); continue; }
        } else if (bad && !/超过字数/.test(bad)) { wrong.push(`${f.key}（${bad}）`); continue; }
        out.set(f.key, m);
        newCache[ck(f)] = { field: m.field, value: m.value, status: m.status, source: m.source, similar_to: m.similar_to };
      }
      const missing = ask1.filter((f) => !out.has(f.key));
      note = [
        missing.length - wrong.length > 0 ? `上次漏了这些 ref，这次必须给：${missing.filter((f) => !wrong.some((w) => w.startsWith(`${f.key}（`))).map((f) => f.key).join('、')}` : '',
        wrong.length ? `上次这些取错了，重新按规则给：${wrong.join('；')}` : '',
      ].filter(Boolean).join('\n');
      if (missing.length && attempt < 2) say(`有 ${missing.length} 个字段模型漏了或取错了，单独再问一次…`);
      ask1 = missing;
    }
    return out;
  }

  /** 按字段类型填一个值，回读核对；r.status 置为 已填 / 没生效 */
  async function put(r, value) {
    if (value == null || value === '') { r.status = '缺'; return; }
    const bad = checkFormat(r, value, facts, r.source);
    if (bad && !/超过字数/.test(bad) && !(r.options?.length && matchOption(r.options, value) >= 0)) {
      r.status = '没生效'; r.color = 'red'; r.notes.push(`值没过格式校验，没填：${bad}`); r.tried = value; return;
    }
    let ok = false;
    let got = '';
    try {
      if (r.kind === 'select') {
        const opts = r.options || [];
        let i = matchOption(opts, value);
        if (i < 0 && opts.length) i = await modelPick(r, value, [], opts);
        if (i >= 0) { const s = await ask(tabId, r.frameId, 'selectNative', { ref: r.ref, text: opts[i] }); ok = s.ok; got = s.got || ''; if (norm(opts[i]) !== norm(value)) r.picked = true; }
      } else if (r.kind === 'radio' || r.kind === 'checkbox') {
        const opts = r.options || [];
        const parts = r.kind === 'checkbox' ? String(value).split(/[、,，]/) : [value];
        const picks = [];
        for (const p of parts) {
          let i = matchOption(opts, p);
          if (i < 0 && opts.length) { i = await modelPick(r, p, [], opts); if (i >= 0) r.picked = true; }
          if (i >= 0) picks.push(opts[i]);
        }
        if (picks.length) { const s = await ask(tabId, r.frameId, 'clickRadio', { ref: r.ref, text: picks.join('、') }); ok = s.ok; got = s.got || ''; }
      } else if (r.kind === 'fake-select' || r.kind === 'cascader') {
        ({ ok, got } = await fillDropdown(r, value));
        if (!ok && /^请输入|^输入/.test(r.placeholder || '')) {
          const s = await ask(tabId, r.frameId, 'fillText', { ref: r.ref, value });
          ok = s.ok; got = s.got || got;
          if (ok) r.notes.push('联想框里没有现成选项，直接写进去了');
        }
      } else if (r.kind === 'date') {
        const v = dateFormat(value, r.placeholder);
        let s = await ask(tabId, r.frameId, 'typeDate', { ref: r.ref, value: v });
        if (!s.ok && r.frameId === 0 && !s.readonly) s = await typeWithDebugger(r, v, true);
        ok = s.ok; got = s.got || '';
        if (!ok && s.readonly) r.notes.push('日期框不让直接输入，你点一下选');
      } else {
        const s = await ask(tabId, r.frameId, 'fillText', { ref: r.ref, value });
        ok = s.ok; got = s.got || '';
        if (!ok && r.frameId === 0) { const s2 = await typeWithDebugger(r, value); ok = s2.ok; got = s2.got || got; }
        if (s.truncated) r.notes.push(`超过 ${r.maxLength} 字被截断，你看一下`);
      }
    } catch (e) { r.notes.push(`填的时候出错：${e.message}`); }
    if (!ok) {
      // 回读一次：有的组件回读有延迟
      await sleep(300);
      const rb = await ask(tabId, r.frameId, 'readBack', { ref: r.ref }).catch(() => ({}));
      if (rb.value && (norm(rb.value) === norm(value) || norm(rb.value).includes(norm(value)) || norm(value).includes(norm(rb.value)))) { ok = true; got = rb.value; }
    }
    r.filled = ok ? (got || value) : '';
    r.tried = value;
    if (ok) {
      r.status = '已填';
      r.color = r.picked || r.by === 'model-open' ? 'yellow' : r.by === 'model' && /描述|内容|职责|介绍|评价/.test(r.label) ? 'yellow' : 'green';
      if (r.picked) r.notes.push(`模型挑的选项：${got}（想填的是 ${value}）`);
    } else {
      r.status = '没生效'; r.color = 'red';
      r.notes.push(`想填「${String(value).slice(0, 40)}」，填完回读是「${String(got || '').slice(0, 40) || '空'}」`);
    }
  }

  /** 假下拉 / 级联：点开读选项，本地能对上就点，对不上才问模型；级联一层一层来，每层最多问一次 */
  async function fillDropdown(r, value) {
    const segs = String(value).split(/\s*[>/／]\s*/).filter(Boolean);
    let st = await ask(tabId, r.frameId, 'openSelect', { ref: r.ref });
    if (st.ok && (!st.open || !(st.menus || []).some((m) => m.length)) && r.frameId === 0) {
      // 事件点不开（有的组件只认真实鼠标）：debugger 真点一下
      try { await dbgAttach(tabId); await dclick(st.x, st.y); await sleep(500); st = { ...st, ...(await ask(tabId, r.frameId, 'readOpts')) }; } catch { /* 忽略 */ }
    }
    if (!st.open || !(st.menus || []).some((m) => m.length)) {
      // 可能是带搜索、要先打字的下拉
      st = await ask(tabId, r.frameId, 'openSelect', { ref: r.ref, search: segs[segs.length - 1] });
    }
    if (!st.open) { await ask(tabId, r.frameId, 'closePopups'); return { ok: false, got: '' }; }
    const parents = [];
    for (let level = 0; level < 5; level++) {
      const menu = st.menus[st.menus.length - 1] || [];
      if (!menu.length) break;
      const texts = menu.map((o) => o.t);
      const target = segs[Math.min(level, segs.length - 1)];
      let i = matchOption(texts, target);
      if (i < 0 && segs.length > 1) for (const s of segs) { i = matchOption(texts, s); if (i >= 0) break; }
      if (i < 0) { i = await modelPick(r, value, parents, texts); if (i >= 0) r.picked = true; }
      if (i < 0) break;
      parents.push(texts[i]);
      const col = st.menus.length - 1;
      st = await ask(tabId, r.frameId, 'pickOpt', { col, i: menu[i].i });
      if (!st.ok || !st.open) break;
      // 级联：点完多出一列就接着选；没多出列说明选完了
      if ((st.menus || []).length <= col + 1) break;
    }
    await ask(tabId, r.frameId, 'closePopups');
    await sleep(250);
    const rb = await ask(tabId, r.frameId, 'readBack', { ref: r.ref });
    const got = rb.value || '';
    const last = parents[parents.length - 1] || '';
    return { ok: !!got && (!!last && (got.includes(last) || last.includes(got))), got };
  }

  async function modelPick(r, target, parents, options) {
    if (r.sensitive) { r.notes.push('敏感信息不发给模型，选项对不上，你自己选'); return -1; }
    try {
      const d = await model('pick', pickPrompt(r.label || r.field || '', target, parents, options.slice(0, 200)), PICK_SCHEMA, 200);
      const n = d.pick == null ? -1 : Number(d.pick);
      return Number.isInteger(n) && n >= 0 && n < options.length ? n : -1;
    } catch { return -1; }
  }

  async function typeWithDebugger(r, value, isDate = false) {
    try {
      await dbgAttach(tabId);
      const f = await ask(tabId, r.frameId, 'focusFor', { ref: r.ref });
      if (!f.ok) return { ok: false };
      await dclick(f.x, f.y);
      await sleep(120);
      await dsend(tabId, 'Input.insertText', { text: value });
      await sleep(200);
      // 日期框不发回车：页面上绑了回车提交的表单会被提交（9/28 审查），靠 closePopups 失焦提交
      await ask(tabId, r.frameId, 'closePopups');
      await sleep(250);
      const rb = await ask(tabId, r.frameId, 'readBack', { ref: r.ref });
      const got = rb.value || '';
      return { ok: isDate ? got.replace(/\D/g, '').startsWith(value.replace(/\D/g, '').slice(0, 6)) : norm(got) === norm(value), got };
    } catch (e) { return { ok: false, got: '', err: e.message }; }
  }
  async function dclick(x, y) {
    await dsend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await dsend(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await dsend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  /** 附件：简历 PDF / 照片，用 debugger 的 DOM.setFileInputFiles（第 8 条）。认不出是传什么的就不传 */
  async function handleFile(r) {
    const l = `${r.label} ${r.section}`;
    const files = config.autofill?.files || {};
    let path = '';
    let what = '';
    if (/照片|头像|证件照|免冠/.test(l)) { path = files.photo; what = '照片'; }
    else if (/简历|附件|cv|resume/i.test(l)) { path = await resumePdf(job, files); what = '简历 PDF'; }
    if (!path) { r.status = '缺'; r.color = r.required ? 'red' : 'none'; r.notes.push(what ? `设置页没填${what}路径，你自己传` : '认不出这个上传框要传什么，你自己传'); return; }
    if (r.accept && !/pdf|\*\/\*|application/i.test(r.accept) && /\.pdf$/i.test(path)) { r.status = '缺'; r.color = 'red'; r.notes.push('这个框只收图片'); return; }
    try {
      await dbgAttach(tabId);
      const { root } = await dsend(tabId, 'DOM.getDocument', { depth: -1, pierce: true });
      const nodeId = await findNode(root, r.ref);
      if (!nodeId) throw new Error('debugger 找不到这个上传框（可能在跨域 iframe 里）');
      await dsend(tabId, 'DOM.setFileInputFiles', { nodeId, files: [path] });
      r.status = '已填'; r.filled = path.split(/[\\/]/).pop(); r.by = 'file'; r.source = what; r.color = 'yellow';
      r.notes.push(`传了${what}：${r.filled}，看一眼页面上传成功没有`);
    } catch (e) { r.status = '没生效'; r.color = 'red'; r.notes.push(`上传没成：${e.message}`); }
  }
  async function findNode(root, ref) {
    // 顶层文档和同进程 iframe 的文档都查一遍
    const docs = [];
    const walk = (n) => { if (n.nodeName === '#document') docs.push(n.nodeId); (n.children || []).forEach(walk); if (n.contentDocument) walk(n.contentDocument); (n.shadowRoots || []).forEach(walk); };
    walk(root);
    for (const d of docs) {
      const { nodeId } = await dsend(tabId, 'DOM.querySelector', { nodeId: d, selector: `[data-jfz-ref="${ref}"]` }).catch(() => ({}));
      if (nodeId) return nodeId;
    }
    return 0;
  }

  async function fixSynonyms() {
    const groups = new Map();
    for (const r of all.values()) {
      const k = synKey(r.label);
      if (!k) continue;
      const g = `${r.frameId}|${sectionKind(r.section) || 'basic'}|${r.index}|${k}`;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(r);
    }
    // 模型给的 similar_to 也并进来，但它判「缺」的不跟着补（9/28 实测：入学时间被当成毕业时间的近义补成了 2026-06）
    for (const r of all.values()) {
      for (const s of [].concat(r.similar || []).flatMap((x) => String(x).split(/[,，、\s]+/)).filter(Boolean)) {
        const o = all.get(s);
        if (o && o !== r && o.status !== '缺' && r.status !== '缺' && o.kind !== 'date' && r.kind !== 'date') groups.set(`sim|${[r.key, o.key].sort().join('|')}`, [r, o]);
      }
    }
    for (const [gk, g] of groups) {
      if (g.length < 2) continue;
      const done = g.filter((r) => r.filled);
      const empty = g.filter((r) => !r.filled && r.kind !== 'file' && r.status !== '缺' && r.status !== '没生效');
      // 近义表里的（手机/联系电话…）模型判「缺」也照补：值本来就是同一个；模型自己说的近义不补缺
      const emptyMissing = gk.startsWith('sim|') ? [] : g.filter((r) => !r.filled && r.status === '缺' && !r.sensitive);
      if (!done.length) continue;
      // 近义长文本两栏写成了一模一样的：第二栏换成这段经历 brief 里说「做什么」的那半句（第 13 条 b：各写各的）
      const isLong = SYNONYMS.find((s) => s.key === synKey(g[0].label))?.long;
      if (isLong && done.length >= 2) {
        for (const r of done.slice(1)) {
          if (norm(r.filled) !== norm(done[0].filled)) continue;
          const src = parseSource(r.source);
          const it = src && facts[src.list]?.[src.i];
          const alt = it ? (dutyPart(it.brief) || it.brief) : '';
          if (alt && norm(alt) !== norm(done[0].filled)) { r.notes.push('和近义栏目写重了，换成 brief 原句'); r.source = `${src.list}[${src.i}].brief`; await put(r, alt); }
        }
      }
      for (const r of [...empty, ...emptyMissing]) {
        const long = SYNONYMS.find((s) => s.key === synKey(r.label))?.long || r.kind === 'textarea';
        if (!long) { r.source = done[0].source || `同 ${done[0].label}`; r.by = 'synonym'; r.notes.push(`近义栏目，照「${done[0].label}」填同一个值`); await put(r, done[0].filled); continue; }
        say(`近义栏目「${r.label}」还空着，另写一段…`);
        try {
          const a = await model('open', answerPrompt(r.label, job, r.maxLength || 200, String(done[0].filled).slice(0, 400)), ANSWER_SCHEMA, 1000);
          r.source = `模型按素材库起草（和「${done[0].label}」换个侧重）`; r.by = 'model-open';
          await put(r, withSite(String(a.answer || ''), r.maxLength || 200, r.label, facts));
          if (r.status === '已填') { r.status = '开放题已起草'; r.color = 'yellow'; }
        } catch (e) { r.notes.push(`近义栏目补写失败：${e.message}`); }
      }
    }
  }

  async function collectSiteErrors() {
    let n = 0;
    for (const fr of frames) {
      let res;
      try { res = await ask(tabId, fr.frameId, 'siteErrors'); } catch { continue; }
      for (const it of res?.list || []) {
        const r = all.get(`${fr.frameId}:${it.ref}`);
        if (!r) continue;
        r.color = 'red';
        r.siteError = it.msg;
        r.notes.push(`网站提示：${it.msg}`);
        n++;
      }
    }
    if (n) warnings.push(`网站自己标了 ${n} 处红字（必填没填 / 格式不对），已标红，下面列表和鼠标悬停都能看到原话`);
  }

  async function paintAll() {
    const byFrame = new Map();
    for (const r of all.values()) {
      const color = r.color || (r.status === '已填' || r.status === '已有值' ? 'green' : r.required ? 'red' : 'none');
      r.color = color;
      if (!byFrame.has(r.frameId)) byFrame.set(r.frameId, []);
      byFrame.get(r.frameId).push({ ref: r.ref, color, note: [r.status, ...(r.notes || []), r.check?.why].filter(Boolean).join('；') });
    }
    for (const [fid, list] of byFrame) await ask(tabId, fid, 'paint', { list }).catch(() => {});
  }
}

// ---------------------------------------------------------------- 小工具

function sameGroup(a, b) { return a.frameId === b.frameId && sectionKind(a.section) === sectionKind(b.section) && a.index === b.index; }
function trimTo(s, max) {
  s = String(s || '').trim();
  if (s.length <= max) return s;
  // 按句子删，不截半句
  const parts = s.split(/(?<=[。！？!?；;])/);
  let out = '';
  for (const p of parts) { if ((out + p).length > max) break; out += p; }
  // 删到分号、逗号结尾的，改成句号收尾
  return (out || s.slice(0, max)).replace(/[；;，,、]\s*$/, '。');
}

/** brief 截到第一个成果分句之前（「主要职责」这类栏目只要做什么，不要成果数字） */
export function dutyPart(s) {
  const RESULT = /\d+(\.\d+)?\s*(%|万|倍|单|条|名|元|分钟)|提升|增长|突破|达到|降低|好评|做到/;
  const parts = String(s || '').replace(/[。．.]\s*$/, '').split(/[，,；;]/);
  const keep = [];
  for (const p of parts) { if (RESULT.test(p)) break; keep.push(p.trim()); }
  return keep.length ? keep.join('，') + '。' : '';
}
function dateFormat(v, ph = '') {
  const m = /^(\d{4})[-./年](\d{1,2})(?:[-./月](\d{1,2}))?/.exec(String(v));
  if (!m) return String(v);
  const y = m[1]; const mo = m[2].padStart(2, '0'); const d = (m[3] || '01').padStart(2, '0');
  if (/日|DD|dd|年-月-日|yyyy-mm-dd/i.test(ph)) return `${y}-${mo}-${d}`;
  if (/\//.test(ph)) return `${y}/${mo}`;
  return `${y}-${mo}`;
}

/** 素材库每类几条 vs 页面每个分块几组 */
function groupsNeeded(fields, facts) {
  const want = { intern: facts.experiences.length, project: facts.projects.length };
  const out = [];
  for (const kind of Object.keys(want)) {
    const fs = fields.filter((f) => sectionKind(f.section) === kind && !['file', 'radio', 'checkbox'].includes(f.kind));
    if (fs.length < 2) continue;
    const have = Math.max(...fs.map((f) => f.groups || 1), new Set(fs.map((f) => f.index)).size);
    out.push({ kind, section: fs[0].section, have, want: want[kind] });
  }
  return out;
}

/** 近义栏目统计：页面上有几对、是不是每对都填了（验收用） */
function synonymPairs(list) {
  const groups = new Map();
  for (const r of list) {
    const k = synKey(r.label);
    if (!k) continue;
    const g = `${r.frameId}|${sectionKind(r.section) || 'basic'}|${r.index}|${k}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }
  return [...groups.values()].filter((g) => g.length >= 2).map((g) => ({ labels: g.map((r) => `${r.sectionLabel ? r.sectionLabel + '·' : ''}${r.label}`), allFilled: g.every((r) => r.filled), same: new Set(g.map((r) => r.filled)).size === 1 }));
}

async function pageKey(tabId) {
  const t = await chrome.tabs.get(tabId);
  try { const u = new URL(t.url); return `${u.origin}${u.pathname}`; } catch { return t.url || ''; }
}
function trimCache(c) {
  const e = Object.entries(c).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, 40);
  return Object.fromEntries(e);
}

// ---------------------------------------------------------------- 你手填的记住（第 10 条）

/** 「记住这页我填的」：上次报告里素材库没有 / 认不出 / 没生效、现在页面上有值的字段，按归一化 label 存本机 */
export async function rememberPage(tabId) {
  await inject(tabId);
  const frames = await frameIds(tabId);
  const { afLast } = await chrome.storage.local.get('afLast');
  const byLabel = new Map((afLast?.fields || []).map((r) => [`${sectionKind(r.section)}:${normLabel(r.label)}`, r]));
  const { afMemory = {} } = await chrome.storage.local.get('afMemory');
  const saved = [];
  for (const fr of frames) {
    let got;
    try { got = await ask(tabId, fr.frameId, 'harvest'); } catch { continue; }
    for (const f of got || []) {
      if (!f.label) continue;
      const k = `${sectionKind(f.section)}:${normLabel(f.label)}`;
      const prev = byLabel.get(k);
      // 插件按素材库填的不存（改素材库才是正路），只存你自己补的
      if (prev && ['已填', '开放题已起草'].includes(prev.status) && prev.by !== 'memory' && norm(prev.filled) === norm(f.value)) continue;
      if (prev && prev.by && prev.by !== 'memory' && prev.status === '已填') continue;
      if (/^(姓名|手机|邮箱|学校|专业|学历)$/.test(f.label)) continue;
      afMemory[k] = { label: f.label, section: f.section, value: f.value, sensitive: SENSITIVE.test(f.label), at: Date.now() };
      saved.push(`${f.label}${SENSITIVE.test(f.label) ? '（敏感，只存本机）' : ''}`);
    }
  }
  await chrome.storage.local.set({ afMemory });
  return saved;
}

export async function scrollToField(tabId, key) {
  const [fid, ref] = String(key).split(':');
  return ask(tabId, Number(fid), 'scrollTo', { ref });
}

/** 你点「填这一页」时先要这个网站（含 iframe）的权限 —— 必须在点击的手势里调 */
export async function requestPagePermission(tabId) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => []);
  const origins = [...new Set((frames || []).map((f) => { try { const u = new URL(f.url); return /^https?:$/.test(u.protocol) ? `${u.origin}/*` : ''; } catch { return ''; } }).filter(Boolean))];
  if (!origins.length) throw new Error('这个页面不是网页（chrome:// 或扩展页），没法填');
  if (await chrome.permissions.contains({ origins })) return true;
  const ok = await chrome.permissions.request({ origins });
  if (!ok) throw new Error('没给这个网站的权限，填不了。再点一次「填这一页」，弹窗里点「允许」');
  return true;
}

/**
 * 网申要传的简历 PDF：「下载/求职简历」里有这家公司的定制版就用它（定制简历功能存的），
 * 没有就用设置页填的「简历 PDF 路径」。
 */
async function resumePdf(job, files) {
  const company = String(job.company || '').trim();
  if (company) {
    const esc = company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const hits = await chrome.downloads.search({ filenameRegex: `求职简历.*${esc}.*\\.pdf$`, exists: true, orderBy: ['-startTime'], limit: 1 }).catch(() => []);
    if (hits?.[0]?.filename) return hits[0].filename;
  }
  return /\.pdf$/i.test(files.dir || '') ? files.dir : '';
}

/** 敏感字段：身份证、紧急联系人、家庭住址这类，以及家庭成员分块里的所有栏目。值只在本地填，不进任何发给模型的内容 */
function isSensitive(f) {
  return SENSITIVE.test(f.label || '') || sectionKind(f.section) === 'family';
}

/** 并发跑，最多 n 个同时，结果按原顺序返回 */
async function pool(items, fn, n) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

/**
 * 开放题结尾补一句作品集网址（设置里填了作品集才补）。
 * 网申表单不是 BOSS 聊天，放外链没事；自我评价 / 个人优势 / 自我介绍 / 为什么选我们 / 补充说明这类都补。
 * 字数不够就先按句子删正文，给这句腾地方；实在太短（< 80 字）的栏目不补。
 */
function withSite(text, max, label, facts) {
  const site = facts.basic.site;
  const line = `做过的项目思路、截图和成果都整理在个人作品集里：${site}`;
  let t = String(text || '').replace(/https?:\/\/\S+/g, '').trim();
  if (!site || max < 80 || !SITE_LABEL.test(label || '') || t.includes(site)) return trimTo(t, max);
  t = trimTo(t, max - line.length - 1).replace(/[，,；;]\s*$/, '。');
  if (!/[。！？!?]$/.test(t)) t += '。';
  return t + line;
}
