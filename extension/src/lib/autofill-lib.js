/**
 * 网申自动填 —— 纯函数部分（node 里也能跑，方便离线测）：
 *   factsFrom(library)       素材库 → 填表用的事实表（每条都有可核对的路径，如 experiences[1].company）
 *   localRule(field, facts)  确定的基础字段本地直接出值，不等模型、不交给模型
 *   SYNONYMS / synKey        近义栏目表（你 3 月的第二个问题：意思相近的两个栏目只填一个）
 *   checkFormat              本地格式校验（第三个问题：内容对不上框）
 *   normLabel                简历外字段记忆的归一化 label
 *   SENSITIVE                身份证号、紧急联系人电话这类不发给模型
 */

export const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
export const normLabel = (s) => String(s || '').replace(/[\s*＊:：（）()【】\[\]、，,。.?？!！\-_/]/g, '').replace(/^(请输入|请选择|请填写)/, '').toLowerCase();

/** 「2025-06 ～ 2025-09」→ { start:'2025-06', end:'2025-09' }；「至今」保留 */
function splitTime(t) {
  const [a, b] = String(t || '').split(/\s*[～~—–至-]{1,2}\s*(?=\d{4}|至今|今)/);
  return { start: (a || '').trim(), end: (b || '').trim() || '' };
}

const lineText = (ln) => (ln.label ? `${ln.label}：${ln.text}` : ln.text);

/** 素材库（blocks.json，经 preset.js 带进插件）→ 填表事实表 */
export function factsFrom(lib, summary = '') {
  const P = lib.profile;
  const phone = P.facts.find((f) => /^1\d{10}$/.test(f)) || '';
  const email = P.facts.find((f) => /@/.test(f)) || '';
  const gender = P.facts.find((f) => /^[男女]$/.test(f)) || '';
  const political = P.facts.find((f) => /团员|党员|群众/.test(f)) || '';
  const age = P.facts.find((f) => /岁/.test(f)) || '';
  const sec = (title) => lib.sections.find((s) => s.title === title)?.items || [];
  const skill = (label) => P.skills.find((s) => s.label === label)?.text || '';
  const edu = lib.education;
  const rank = (edu.lines || []).map((l) => l.text ?? l).find((t) => /排名|前\s*\d+%/.test(t)) || '';
  const thesis = (edu.lines || []).map((l) => l.text ?? l).find((t) => /论文/.test(t)) || '';

  const item = (it) => {
    const { start, end } = splitTime(it.time);
    const byLabel = Object.fromEntries((it.lines || []).map((l) => [l.label || '内容', l.text]));
    return {
      id: it.id, org: it.org, role: it.role, start, end, time: it.time,
      content: (it.lines || []).map(lineText).join('\n'),
      // 「工作内容 / 主要职责 / 工作描述」这类栏目各自能取的原句
      duty: byLabel['工作内容'] || byLabel['工作背景'] || byLabel['我的分工'] || byLabel['项目背景'] || byLabel['研究内容'] || byLabel['内容'] || '',
      result: byLabel['最终结果'] || byLabel['解决思路'] || '',
      brief: it.brief || '',
    };
  };

  const certText = skill('专业证书').replace(/。$/, '');
  const langText = skill('语言能力');
  return {
    basic: {
      name: P.name, gender, phone, email, political, age, site: P.site?.link || '',
      identity: edu.identity || '',
    },
    intent: {
      city: lib.intent.city, salary: lib.intent.salary,
      positions: [...new Set(Object.values(lib.intent.targetByVariant).flatMap((t) => t.split(/\s*\/\s*/)))],
    },
    education: [{ school: edu.org, major: String(edu.role || '').replace(/（.*?）|\(.*?\)/g, '').trim(), degree: edu.degree || '', start: edu.start || '', graduation: edu.graduation || '', ranking: rank, thesis }],
    experiences: sec('工作经验').map(item),
    projects: sec('项目经历').map(item),
    campus: sec('校园经历').map(item),
    skills: P.skills.filter((s) => !/证书|语言/.test(s.label)).map((s) => `${s.label}：${s.text}`),
    certificates: certText ? certText.split(/[、，,]/).map((s) => s.trim()).filter(Boolean) : [],
    languages: langText,
    english: /六级|CET-?6/i.test(langText) ? '英语六级（CET-6）' : /四级|CET-?4/i.test(langText) ? '英语四级（CET-4）' : '',
    self_evaluation: summary || '',
  };
}

/** 给模型看的事实表（素材库精简版）。每次调用一字不差，放 system 最前面吃 DeepSeek 缓存 */
export function factsForModel(facts) {
  return JSON.stringify(facts, null, 1);
}

// ---------------------------------------------------------------- 近义栏目

/** 常见近义组：同组的栏目都要填（短字段填一样的值，长文本各写各的） */
export const SYNONYMS = [
  { key: 'phone', re: /^(手机|手机号|手机号码|联系电话|移动电话|联系方式|电话|电话号码|联系手机)$/ },
  { key: 'email', re: /^(邮箱|电子邮箱|电子邮件|邮件地址|email|e-?mail|常用邮箱|联系邮箱)$/i },
  { key: 'city', re: /^(期望城市|意向城市|意向工作地点|期望工作地点|期望工作地|工作地点|意向工作城市|期望工作城市|目标城市|意向地点|期望地点)$/ },
  { key: 'self', re: /^(自我评价|个人优势|个人简介|自我介绍|自我描述|个人评价|个人总结|优势亮点)$/, long: true },
  { key: 'duty', re: /^(工作内容|主要职责|工作描述|职责描述|工作职责|实习内容|实习描述|经历描述|描述|职责|主要工作)$/, long: true },
  { key: 'grad', re: /^(毕业时间|毕业年月|预计毕业时间|毕业日期|毕业年份)$/ },
  { key: 'name', re: /^(姓名|真实姓名|名字|中文名|中文姓名)$/ },
  { key: 'school', re: /^(学校|学校名称|毕业院校|毕业学校|院校|院校名称)$/ },
  { key: 'major', re: /^(专业|专业名称|所学专业|主修专业)$/ },
  { key: 'degree', re: /^(学历|最高学历|学历层次|学位|最高学位|培养层次)$/ },
];
export function synKey(label) {
  const l = norm(label).replace(/[*＊:：\s]/g, '');
  return SYNONYMS.find((g) => g.re.test(l))?.key || '';
}

// ---------------------------------------------------------------- 本地规则（确定的基础字段）

const SECTION_KIND = [
  ['edu', /教育|学历|学业/],
  ['intern', /实习|工作|实践|经历/],
  ['project', /项目/],
  ['campus', /校园|在校|社团|学生干部/],
  ['intent', /意向|期望/],
  ['basic', /基本|个人信息|基础信息|联系/],
  ['family', /家庭/],
  ['self', /评价|优势|简介/],
];
export function sectionKind(section) {
  const s = String(section || '');
  if (/项目/.test(s)) return 'project';
  if (/意向|期望/.test(s)) return 'intent';   // 「意向工作城市」别被「工作」认成实习经历
  return SECTION_KIND.find(([, re]) => re.test(s))?.[0] || '';
}

/**
 * 能本地定下来的字段直接出值。返回 { value, source } 或 null（交给模型）。
 * 只管「素材库里写死、不需要理解」的：姓名、性别、手机、邮箱、学校、专业、学历、毕业时间、期望城市、期望薪资、政治面貌。
 */
export function localRule(f, facts) {
  const l = norm(f.label).replace(/[*＊:：\s]/g, '');
  const sk = sectionKind(f.section);
  const B = facts.basic;
  const E = facts.education[0];
  const inEduOk = !sk || sk === 'edu' || sk === 'basic';
  const r = (value, source) => ({ value, source });
  // 教育分块只有一条学历，第 2 组起的教育经历素材库没有
  if (sk === 'edu' && f.index > 1) return null;
  // 家庭成员分块里的「姓名 / 电话」不是本人的
  if (sk === 'family' || /紧急|家庭|父|母|配偶|推荐人|联系人姓名/.test(l)) return null;
  const key = synKey(l);
  if (key === 'name' && (!sk || sk === 'basic')) return r(B.name, 'basic.name');
  if (key === 'phone' && sk !== 'intern' && sk !== 'project') return r(B.phone, 'basic.phone');
  if (key === 'email') return r(B.email, 'basic.email');
  if (/^性别$/.test(l)) return r(B.gender, 'basic.gender');
  if (/^政治面貌$/.test(l) && B.political) return r(B.political, 'basic.political');
  if (key === 'school' && inEduOk) return r(E.school, 'education[0].school');
  if (key === 'major' && inEduOk && !/类别|门类|大类/.test(l)) return r(E.major, 'education[0].major');
  if (key === 'degree' && inEduOk) return r('本科', 'education[0].degree');
  if (key === 'grad' && inEduOk) return r(E.graduation, 'education[0].graduation');
  if ((/^(结束时间|毕业时间|截止时间|离校时间)$/.test(l) || /^(时间|在校时间)$/.test(l)) && sk === 'edu') return r(E.graduation, 'education[0].graduation');
  if (key === 'city' && (sk !== 'intern' && sk !== 'project')) return r(facts.intent.city, 'intent.city');
  if (/^(期望薪资|期望月薪|薪资要求|期望薪酬|期望待遇)$/.test(l)) return r(facts.intent.salary, 'intent.salary');
  if (/^(个人主页|作品集|作品链接|作品展示|个人网站|个人链接|博客|其他链接|相关链接|附加链接|网址)/.test(l)) return r(B.site, 'basic.site');
  if (/^(入学时间|入学年月|入学日期|开始时间|起始时间)$/.test(l) && (sk === 'edu' || /入学/.test(l))) return r(E.start, 'education[0].start');
  if (sk === 'edu' && /(就读|在校|学习|教育)?时间/.test(l) && /开始|起/.test(l)) {
    if (/-年$/.test(l)) return r(E.start.slice(0, 4), 'education[0].start');
    if (/-月$/.test(l)) return r(String(Number(E.start.slice(5, 7))).padStart(2, '0'), 'education[0].start');
    return r(E.start, 'education[0].start');
  }
  if (sk === 'edu' && /(就读|在校|学习|教育)?时间/.test(l) && /结束|毕业|至/.test(l)) {
    if (/-年$/.test(l)) return r(E.graduation.slice(0, 4), 'education[0].graduation');
    if (/-月$/.test(l)) return r(E.graduation.slice(5, 7), 'education[0].graduation');
    return r(E.graduation, 'education[0].graduation');
  }
  return null;
}

// ---------------------------------------------------------------- 格式校验

const isDateLike = (s) => /^\d{4}[-./年]\d{1,2}/.test(String(s || '')) || /^至今$/.test(String(s || ''));
/**
 * 本地格式校验。返回问题描述（字符串）或 ''。
 * 电话 11 位、邮箱格式、日期是日期且落在对应经历时间范围内、学校专业跟素材库一致、下拉值必须在选项里。
 */
export function checkFormat(f, value, facts, source = '') {
  const v = String(value ?? '');
  const l = norm(f.label).replace(/[*＊:：\s]/g, '');
  const key = synKey(l);
  if (!v) return '';
  if (key === 'phone' && !/^1\d{10}$/.test(v.replace(/[\s-]/g, ''))) return `电话不是 11 位手机号：${v}`;
  if (key === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return `邮箱格式不对：${v}`;
  const part = /-(年|月|日)$/.test(l) && /^\d{1,4}$/.test(v);   // 日期拆成年、月两个下拉的（真 Moka）
  if ((f.kind === 'date' || /时间|日期|年月/.test(l)) && !part && !/时长|期间|多久|工作时间要求/.test(l) && !isDateLike(v)) return `这是日期栏，填的不是日期：${v.slice(0, 20)}`;
  if (key === 'school' && v !== facts.education[0].school) return `学校和素材库不一致：${v}`;
  if (key === 'major' && !/类别|门类|大类/.test(l) && !v.includes(facts.education[0].major)) return `专业和素材库不一致：${v}`;
  if (f.options?.length && (f.kind === 'select' || f.kind === 'radio' || f.kind === 'checkbox')) {
    const parts = f.kind === 'checkbox' ? v.split(/[、,，]/) : [v];
    const bad = parts.find((p) => !f.options.some((o) => o === p.trim() || o.includes(p.trim())));
    if (bad) return `选项里没有「${bad}」`;
  }
  // 日期要落在它那段经历的时间范围里
  const m = /^(experiences|projects|campus)\[(\d+)\]\.(start|end)$/.exec(source);
  if (m && isDateLike(v)) {
    const it = facts[m[1]]?.[Number(m[2])];
    const want = it?.[m[3]];
    if (want && !/至今/.test(want) && !digits(v).startsWith(digits(want).slice(0, 6))) return `时间对不上那段经历（素材库是 ${want}）`;
  }
  if (f.maxLength && v.length > f.maxLength) return `超过字数限制 ${f.maxLength}`;
  return '';
}
const digits = (s) => String(s || '').replace(/\D/g, '');

/** source 路径 → 素材库里第几条（0 起），比如 experiences[1].company → { list:'experiences', i:1, key:'company' } */
export function parseSource(s) {
  const m = /^(experiences|projects|campus|education)\[(\d+)\](?:\.(\w+))?/.exec(String(s || '').trim());
  return m ? { list: m[1], i: Number(m[2]), key: m[3] || '' } : null;
}
/** 分块 → 该取素材库哪张表 */
export function listOfSection(section) {
  const k = sectionKind(section);
  return { intern: 'experiences', project: 'projects', campus: 'campus', edu: 'education' }[k] || '';
}

// ---------------------------------------------------------------- 敏感字段（只本地替换，不发给模型）

export const SENSITIVE = /身份证|证件号|护照|紧急联系|家庭住址|家庭地址|银行卡|户口|户籍地址|父亲电话|母亲电话|家属电话|联系人电话|联系人手机/;

/** 选项文字本地匹配：完全相同 > 包含 > 近义（本科/大学本科/学士）；对不上返回 -1 */
export function matchOption(options, target) {
  const t = norm(target);
  if (!t) return -1;
  let i = options.findIndex((o) => norm(o) === t);
  if (i >= 0) return i;
  // 年月下拉：「09」和「9」「9月」是一个意思
  if (/^\d{1,4}$/.test(t)) { i = options.findIndex((o) => /^\d{1,4}\s*[年月]?$/.test(norm(o)) && Number(norm(o).replace(/\D/g, '')) === Number(t)); if (i >= 0) return i; }
  const ALIAS = [
    [/^本科$/, /^(本科|大学本科|全日制本科|本科\/学士|学士|统招本科)$/],
    [/^男$/, /^男(性)?$/], [/^女$/, /^女(性)?$/],
    [/^共青团员$/, /^(共青团员|团员)$/],
    [/^合肥$/, /^合肥(市)?$/],
  ];
  for (const [a, b] of ALIAS) if (a.test(t)) { i = options.findIndex((o) => b.test(norm(o))); if (i >= 0) return i; }
  const hits = options.map((o, k) => [k, norm(o)]).filter(([, o]) => o && (o.includes(t) || (t.includes(o) && o.length >= 2)));
  if (hits.length === 1) return hits[0][0];
  return -1;
}
