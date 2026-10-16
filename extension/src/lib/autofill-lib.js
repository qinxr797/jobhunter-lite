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
  const byName = fieldNameRule(f, facts);
  if (byName) return byName;
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
  // 起止日期连在一个框里的（antd RangePicker / element daterange）：教育分块直接给「入学 ~ 毕业」
  if (f.range && sk === 'edu' && /时间|日期|年月|在校|就读/.test(l)) return r(`${E.start} ~ ${E.graduation}`, 'education[0].start');
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
  // 一题多格（页面脚本 scan 起的名：「手机-区号 / 手机-号码」「期望城市-省 / 市」「身份证-证件类型」「期望薪资-下限 / 上限」）
  const bk = splitBlank(l);
  if (bk) {
    const bkey = synKey(bk.base);
    if (bkey === 'phone' || /手机|电话/.test(bk.base)) {
      if (bk.part === '区号') return r('+86', 'basic.phone');      // 区号下拉 / 区号框：国内号一律 +86
      if (bk.part === '号码') return r(B.phone, 'basic.phone');
    }
    // 证件类型不是敏感信息（敏感的是号码），本地直接选身份证；号码那格交给本机记忆
    if (bk.part === '证件类型') return r('身份证', 'basic.idType');
    if (bkey === 'city' && sk !== 'intern' && sk !== 'project') {
      if (bk.part === '省') { const p = provinceOf(facts.intent.city); if (p) return r(p, 'intent.city'); }
      if (bk.part === '市') return r(facts.intent.city, 'intent.city');
    }
    if (/期望薪资|期望月薪|期望年薪|薪资要求|期望薪酬/.test(bk.base) && (bk.part === '下限' || bk.part === '上限')) {
      const sp = salaryParts(facts.intent.salary, f.placeholder);
      if (sp) return r(bk.part === '下限' ? sp[0] : sp[1], 'intent.salary');
    }
  }
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

/**
 * 按字段机器名出值（飞书招聘 / 字节社招这类 ud-formily 表单，字段带 data-form-field-name）。
 * 机器名来自 Tabbit 浏览器内置的字节简历配方（10/16 拆的）。认不出返回 null，接着走中文标签那套。
 * 经历类（公司 / 职位）只在框是空的时候填：网站解析简历回填的那组未必和素材库同一段，只改公司会拼出一条四不像。
 */
const sk0 = (f) => sectionKind(f.section);
const FIELD_NAMES = {
  name: (F, f) => (sk0(f) === 'project' ? (f.value ? null : listItem(F, f, 'projects')?.org) : !sk0(f) || sk0(f) === 'basic' ? F.basic.name : null),
  mobile: (F, f) => (f.kind === 'text' && (!sk0(f) || sk0(f) === 'basic') ? F.basic.phone : null),     // 同名的区号下拉不填
  email: (F, f) => (!sk0(f) || sk0(f) === 'basic' ? F.basic.email : null),
  preferred_city_list: (F) => F.intent.city,
  school: (F, f) => (f.index > 1 ? null : F.education[0].school),
  field_of_study: (F, f) => (f.index > 1 ? null : F.education[0].major),
  degree: (F, f) => (f.index > 1 ? null : F.education[0].degree || null),
  company: (F, f) => (f.value || sk0(f) !== 'intern' ? null : listItem(F, f, 'experiences')?.org),
  title: (F, f) => (f.value || sk0(f) !== 'intern' ? null : listItem(F, f, 'experiences')?.role),
  role: (F, f) => (f.value || sk0(f) !== 'project' ? null : listItem(F, f, 'projects')?.role),
  self_evaluation: (F) => F.self_evaluation || null,
};
const FIELD_SOURCE = { name: 'basic.name', mobile: 'basic.phone', email: 'basic.email', preferred_city_list: 'intent.city', school: 'education[0].school', field_of_study: 'education[0].major', degree: 'education[0].degree', self_evaluation: 'self_evaluation' };
function listItem(F, f, list) { return F[list]?.[Math.max(0, (f.index || 1) - 1)]; }
function fieldNameRule(f, facts) {
  const fn = f.fieldName;
  if (!fn || !Object.hasOwn(FIELD_NAMES, fn) || f.kind === 'file') return null;
  const value = FIELD_NAMES[fn](facts, f);
  if (!value) return null;
  const i = Math.max(0, (f.index || 1) - 1);
  const source = FIELD_SOURCE[fn] && !(fn === 'name' && sectionKind(f.section) === 'project')
    ? FIELD_SOURCE[fn]
    : `${fn === 'company' || fn === 'title' ? 'experiences' : 'projects'}[${i}].${fn === 'company' || fn === 'name' ? 'org' : 'role'}`;
  return { value, source };
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
  ];
  for (const [a, b] of ALIAS) if (a.test(t)) { i = options.findIndex((o) => b.test(norm(o))); if (i >= 0) return i; }
  // 省份 / 民族 / 国家 / 年份 / 月份 / 数字区间这类大列表：按列表类型本地对（「杭州」→ 省份列表里的「浙江省」，「2022-09」→ 月份列表里的「9月」）
  const kind = listKind(options);
  if (kind) { i = matchBigList(options, t, kind); if (i >= 0) return i; }
  const hits = options.map((o, k) => [k, norm(o)]).filter(([, o]) => o && (o.includes(t) || (t.includes(o) && o.length >= 2)));
  if (hits.length === 1) return hits[0][0];
  return -1;
}

// ---------------------------------------------------------------- 大列表本地识别（思路参考求职方舟 k.ro，表和判定是自己写的）
// 几十上百项的下拉（省份、56 个民族、国家、年份…）送模型又贵又容易挑歪，这些列表的对应关系是死的，本地就能定

const PROVINCES = ['北京', '天津', '上海', '重庆', '河北', '山西', '辽宁', '吉林', '黑龙江', '江苏', '浙江', '安徽', '福建', '江西', '山东', '河南', '湖北', '湖南', '广东', '海南', '四川', '贵州', '云南', '陕西', '甘肃', '青海', '台湾', '内蒙古', '广西', '西藏', '宁夏', '新疆', '香港', '澳门'];
const ETHNICS = ['汉', '蒙古', '回', '藏', '维吾尔', '苗', '彝', '壮', '布依', '朝鲜', '满', '侗', '瑶', '白', '土家', '哈尼', '哈萨克', '傣', '黎', '傈僳', '佤', '畲', '高山', '拉祜', '水', '东乡', '纳西', '景颇', '柯尔克孜', '土', '达斡尔', '仫佬', '羌', '布朗', '撒拉', '毛南', '仡佬', '锡伯', '阿昌', '普米', '塔吉克', '怒', '乌孜别克', '俄罗斯', '鄂温克', '德昂', '保安', '裕固', '京', '塔塔尔', '独龙', '鄂伦春', '赫哲', '门巴', '珞巴', '基诺'];
const COUNTRIES = ['中国', '美国', '日本', '韩国', '英国', '法国', '德国', '意大利', '西班牙', '葡萄牙', '荷兰', '比利时', '瑞士', '瑞典', '挪威', '丹麦', '芬兰', '冰岛', '爱尔兰', '奥地利', '波兰', '捷克', '匈牙利', '希腊', '土耳其', '俄罗斯', '乌克兰', '加拿大', '墨西哥', '巴西', '阿根廷', '智利', '秘鲁', '哥伦比亚', '澳大利亚', '新西兰', '印度', '巴基斯坦', '孟加拉', '斯里兰卡', '尼泊尔', '泰国', '越南', '老挝', '柬埔寨', '缅甸', '马来西亚', '新加坡', '印度尼西亚', '菲律宾', '蒙古', '哈萨克斯坦', '伊朗', '伊拉克', '沙特阿拉伯', '阿联酋', '以色列', '埃及', '南非', '尼日利亚', '肯尼亚', '埃塞俄比亚', '摩洛哥', '阿尔及利亚'];
// 城市 → 省：省会 / 直辖市 + 少数地市（外省普通地级市交给模型认）。省份列表里填城市时用
const CITY_PROVINCE = {
  合肥: '安徽', 芜湖: '安徽', 蚌埠: '安徽', 淮南: '安徽', 马鞍山: '安徽', 淮北: '安徽', 铜陵: '安徽', 安庆: '安徽', 黄山: '安徽', 滁州: '安徽', 阜阳: '安徽', 宿州: '安徽', 六安: '安徽', 亳州: '安徽', 池州: '安徽', 宣城: '安徽',
  北京: '北京', 天津: '天津', 上海: '上海', 重庆: '重庆', 石家庄: '河北', 太原: '山西', 呼和浩特: '内蒙古', 沈阳: '辽宁', 大连: '辽宁', 长春: '吉林', 哈尔滨: '黑龙江',
  南京: '江苏', 苏州: '江苏', 无锡: '江苏', 杭州: '浙江', 宁波: '浙江', 福州: '福建', 厦门: '福建', 南昌: '江西', 济南: '山东', 青岛: '山东', 郑州: '河南', 武汉: '湖北', 长沙: '湖南',
  广州: '广东', 深圳: '广东', 南宁: '广西', 海口: '海南', 成都: '四川', 贵阳: '贵州', 昆明: '云南', 拉萨: '西藏', 西安: '陕西', 兰州: '甘肃', 西宁: '青海', 银川: '宁夏', 乌鲁木齐: '新疆', 台北: '台湾',
};
const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 };
export const LIST_NAME = { province: '省份', ethnic: '民族', country: '国家', year: '年份', month: '月份', range: '数字区间' };

const provBase = (s) => norm(s).replace(/(省|市|特别行政区|壮族自治区|回族自治区|维吾尔自治区|自治区)$/, '');
const ethBase = (s) => norm(s).replace(/族$/, '');
const yearNum = (s) => { const m = /^((?:19|20)\d{2})\s*年?\s*(届)?$/.exec(norm(s)); return m ? Number(m[1]) : 0; };
const monthNum = (s) => {
  const t = norm(s);
  let m = /^(0?[1-9]|1[0-2])\s*月?$/.exec(t);
  if (m) return Number(m[1]);
  m = /^(十[一二]?|[一二三四五六七八九])月$/.exec(t);
  return m ? CN_NUM[m[1]] : 0;
};

/** 城市 / 带省名的地址 → 省（「浙江省杭州市」「杭州」都给「浙江」）；认不出返回 '' */
export function provinceOf(city) {
  const t = norm(city).replace(/市$/, '');
  if (CITY_PROVINCE[t]) return CITY_PROVINCE[t];
  return PROVINCES.find((p) => t.startsWith(p)) || '';
}

/** 认选项是不是省份 / 民族 / 国家 / 年份 / 月份 / 数字区间这类大列表，认不出返回 '' */
export function listKind(options) {
  const opts = (options || []).map(norm).filter((o) => o && !/^[-\s]*请选择/.test(o));
  if (opts.length < 8) return '';
  const count = (names, base) => names.filter((n) => opts.some((o) => base(o) === n || o.startsWith(n))).length;
  if (opts.length >= 30 && count(PROVINCES, provBase) >= 28) return 'province';
  if (opts.length >= 30 && count(ETHNICS, ethBase) >= 30) return 'ethnic';
  if (opts.length >= 30 && COUNTRIES.filter((n) => opts.some((o) => o.includes(n))).length >= 25) return 'country';
  const years = opts.map(yearNum).filter(Boolean);
  if (years.length >= 8 && years.length >= opts.length * 0.8) return 'year';
  if (opts.length <= 14 && new Set(opts.map(monthNum).filter(Boolean)).size === 12) return 'month';
  // 连续的数字（1~31 日、身高、年龄…），跨度 ≥ 10 才算
  const nums = opts.map((o) => (/^\d{1,4}\s*(日|号|岁|cm|kg)?$/i.test(o) ? parseInt(o, 10) : NaN)).filter((n) => !Number.isNaN(n));
  if (nums.length >= 10 && nums.length >= opts.length * 0.8) {
    const s = [...nums].sort((a, b) => a - b);
    if (s.every((n, k) => k === 0 || n === s[k - 1] + 1) && s[s.length - 1] - s[0] >= 10) return 'range';
  }
  return '';
}

/** 大列表里按类型找目标那一项，找不到返回 -1 */
export function matchBigList(options, target, kind) {
  const t = norm(target);
  const find = (pred) => options.findIndex((o) => norm(o) && pred(norm(o)));
  if (kind === 'province') {
    const p = provinceOf(t);
    return p ? find((o) => provBase(o) === p) : -1;
  }
  if (kind === 'ethnic') { const e = ethBase(t); return e ? find((o) => ethBase(o) === e) : -1; }
  if (kind === 'country') {
    // 区号（+86）：选项一般是「中国大陆 +86」
    if (/^\+?\d{1,4}$/.test(t)) { const code = t.replace(/^\+/, ''); return find((o) => new RegExp(`\\+${code}(?!\\d)`).test(o)); }
    if (/^(中国|中华人民共和国|中国大陆|china)$/i.test(t)) {
      const i = find((o) => o === '中国');
      return i >= 0 ? i : find((o) => /^(中国大陆|中国（大陆）|中国\(大陆\)|中华人民共和国|中国内地|china)$/i.test(o));
    }
    return find((o) => o === t || o.replace(/[（(].*$/, '') === t);
  }
  if (kind === 'year') {
    const y = /((?:19|20)\d{2})/.exec(t)?.[1];
    return y ? find((o) => yearNum(o) === Number(y)) : -1;
  }
  if (kind === 'month') {
    const m = /^(?:19|20)\d{2}\s*[-./年]\s*(\d{1,2})/.exec(t)?.[1] || (monthNum(t) ? String(monthNum(t)) : '');
    return m ? find((o) => monthNum(o) === Number(m)) : -1;
  }
  if (kind === 'range') {
    // 日子列表（1~31）里给的是完整日期：取「日」
    const d = /^(?:19|20)\d{2}[-./年]\d{1,2}[-./月](\d{1,2})/.exec(t)?.[1];
    const n = d || (/^\d{1,4}\s*(日|号|岁|cm|kg|厘米|公斤)?$/i.test(t) ? String(parseInt(t, 10)) : '');
    return n ? find((o) => parseInt(o, 10) === Number(n) && /^\d/.test(o)) : -1;
  }
  return -1;
}

// ---------------------------------------------------------------- 一题多格（思路参考求职方舟 k.F）

const BLANK_PART = [
  [/^(省|省份|省\/直辖市|省市|省\/市)$/, '省'], [/^(市|城市|地级市)$/, '市'], [/^(区|区县|区\/县|县)$/, '区'],
  [/^(区号|国家|国家区号|国际区号)$/, '区号'], [/^(号码|手机号码|电话号码)$/, '号码'],
  [/^(证件类型)$/, '证件类型'], [/^(证件号码|身份证号码|号码)$/, '证件号码'],
  [/^(下限|最低|最低薪资)$/, '下限'], [/^(上限|最高|最高薪资)$/, '上限'],
];
/** 「籍贯-省」→ { base:'籍贯', part:'省' }；不是一题多格的名字返回 null */
export function splitBlank(label) {
  const m = /^(.+?)-([^-]+)$/.exec(norm(label).replace(/[*＊:：\s]/g, ''));
  if (!m) return null;
  const hit = BLANK_PART.find(([re]) => re.test(m[2]));
  return hit ? { base: m[1], part: hit[1] } : null;
}

/** 「5-8K」→ 下限、上限。框的提示里写了 K / 千就按 K 给数，否则换算成元 */
function salaryParts(s, ph = '') {
  const m = /(\d+(?:\.\d+)?)\s*([kK千万])?\s*[-~～至到]\s*(\d+(?:\.\d+)?)\s*([kK千万])?/.exec(String(s || ''));
  if (!m) return null;
  const unit = m[4] || m[2] || '';
  const mul = /[kK千]/.test(unit) ? 1000 : unit === '万' ? 10000 : 1;
  if (mul === 1000 && /k|千/i.test(ph)) return [m[1], m[3]];
  return [String(Math.round(Number(m[1]) * mul)), String(Math.round(Number(m[3]) * mul))];
}

// ---------------------------------------------------------------- 填之前的值后处理（思路参考求职方舟 k.P）

/**
 * 往框里写之前把值收拾成框要的样子：
 *   手机号前的 +86 / 0086 去掉（区号那格除外）；身高体重去掉 cm / kg；框要到「日」而值只有 YYYY-MM 的补 -01
 */
export function tidyValue(f, value) {
  let v = String(value ?? '');
  const l = norm(f.label).replace(/[*＊:：\s]/g, '');
  const bk = splitBlank(l);
  if ((synKey(l) === 'phone' || /手机|电话/.test(bk?.base || l)) && bk?.part !== '区号') {
    const m = /^(?:\+|00)?86(1\d{10})$/.exec(v.replace(/[\s-]/g, ''));
    if (m) v = m[1];
  }
  if (/身高|体重/.test(l)) v = v.replace(/\s*(cm|厘米|公分|kg|千克|公斤)\s*$/i, '').trim();
  // placeholder 只认明确写了日的格式（「YYYY-MM-DD」「年-月-日」），「请选择日期」不算
  const wantDay = f.inputType === 'date' || /yyyy[-/.年]?mm[-/.月]?dd|年-月-日|年月日|\d{4}-\d{2}-\d{2}/i.test(f.placeholder || '');
  if (wantDay && /^\d{4}-\d{2}$/.test(v) && (f.kind === 'date' || /时间|日期|年月|生日/.test(l))) v = `${v}-01`;
  return v;
}
