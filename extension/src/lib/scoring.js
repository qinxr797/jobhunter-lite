/**
 * 本地硬规则初筛 —— 不调接口，零成本，先把明显不合适的岗位拦掉。
 * 只有通过初筛的岗位才会去访问详情页 + 调模型，这是控成本也是控风控的关键。
 *
 * 分两道：prescreen 在列表页跑（列表薪资是防爬字体读不出，只看名字/城市/标签），
 * detailScreen 在详情页读完后跑（详情页薪资是明文，这时候才卡薪资）。
 */

/** 从 "15-25K·13薪" / "15-25K" / "面议" 解析出 [下沿, 上沿]，单位 K；解析不出返回 null */
export function parseSalary(text) {
  if (!text) return null;
  const s = text.replace(/\s/g, '');
  // 日薪/时薪不参与比较
  if (/元\/(天|日|时|小时)|\/天|\/时/.test(s)) return null;
  // 51job「6千-1万」「1-1.5万」：前后单位不一样，前面没写单位的跟后面的
  const unit = (u) => (u === '万' ? 10 : 1);
  const mixed = s.match(/(\d+(?:\.\d+)?)([千Kk万])?-(\d+(?:\.\d+)?)([千Kk万])/);
  if (mixed) return [parseFloat(mixed[1]) * unit(mixed[2] || mixed[4]), parseFloat(mixed[3]) * unit(mixed[4])];
  // 智联「4000-6000元」「8000元以上」
  const yuan = s.match(/(\d{4,6})(?:-(\d{4,6}))?元/);
  if (yuan) return [yuan[1] / 1000, (yuan[2] || yuan[1]) / 1000];
  // 处理「8-10K」「15-25K·13薪」
  const kMatch = s.match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*[Kk千]/);
  if (kMatch) return [parseFloat(kMatch[1]), parseFloat(kMatch[2])];
  const singleK = s.match(/(\d+(?:\.\d+)?)\s*[Kk千]/);
  if (singleK) { const v = parseFloat(singleK[1]); return [v, v]; }
  // 「1-2万」
  const wan = s.match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*万/);
  if (wan) return [parseFloat(wan[1]) * 10, parseFloat(wan[2]) * 10];
  // 日薪/时薪不参与比较
  return null;
}

/** 从标签里解析岗位要求的工作年限下限，如「3-5年」→3、「经验不限」→0 */
export function parseYears(tags) {
  const joined = (tags || []).join(' ');
  if (/不限|应届|在校|实习/.test(joined)) return 0;
  // 「1年以内」「3年以下」说的是上限，对求职者没有门槛
  if (/年以内|年以下/.test(joined)) return 0;
  const range = joined.match(/(\d+)\s*-\s*(\d+)\s*年/);
  if (range) return parseInt(range[1], 10);
  const one = joined.match(/(\d+)\s*年/);
  if (one) return parseInt(one[1], 10);
  return null;
}

function keywordCheck(job, f) {
  // 不分大小写：岗位名常写成「ai产品经理」「Ai运营」
  const hay = `${job.title} ${job.company} ${(job.skills || []).join(' ')}`.toLowerCase();
  const has = (k) => k && hay.includes(String(k).toLowerCase());
  if (f.excludeKeywords?.length) {
    const hit = f.excludeKeywords.find(has);
    if (hit) return { pass: false, reason: `命中排除词「${hit}」` };
  }
  if (f.includeKeywords?.length) {
    const hit = f.includeKeywords.some(has);
    if (!hit) return { pass: false, reason: '不含任何必含关键词' };
  }
  return null;
}

function cityCheck(city, f) {
  if (f.cities?.length && city) {
    const ok = f.cities.some((c) => c && city.includes(c));
    if (!ok) return { pass: false, reason: `城市「${city}」不在范围内` };
  }
  return null;
}

function yearsCheck(tags, f) {
  if (f.maxYearsRequired > 0) {
    const need = parseYears(tags);
    if (need !== null && need > f.maxYearsRequired) {
      return { pass: false, reason: `要求 ${need} 年经验，超过设定的 ${f.maxYearsRequired} 年` };
    }
  }
  return null;
}

/**
 * 列表页初筛。返回 { pass:boolean, reason:string }
 * job: { title, company, salary, tags, skills, city, chatted }
 */
export function prescreen(job, config) {
  const f = config.filter;
  if (f.skipChatted && job.chatted) return { pass: false, reason: '已沟通过' };
  const bl = (config.blacklist || []).find((c) => c && String(job.company || '').includes(c));
  if (bl) return { pass: false, reason: `公司在你的黑名单里（${bl}）` };
  return keywordCheck(job, f) || cityCheck(job.city, f) || salaryCheck(job.salary, f) || yearsCheck(job.tags, f)
    || { pass: true, reason: '通过初筛' };
}

/** 详情页二筛：薪资明文、城市、经验标签都读到了，再卡一遍（还没花模型的钱） */
export function detailScreen(job, config) {
  const f = config.filter;
  return keywordCheck(job, f) || cityCheck(job.city, f) || salaryCheck(job.salary, f) || yearsCheck(job.tags, f) || activeCheck(job.hrActive)
    || { pass: true, reason: '通过' };
}

/**
 * HR 半年以上没上线的岗位不花模型、也不浪费每天 15 个招呼（参考 GitHub get_jobs / boss-helper 的活跃度过滤，9/28）。
 * 2～5 个月内活跃的只标出来（hrStale），不淘汰。
 */
function activeCheck(text) {
  const t = String(text || '');
  if (/半年|年前|一年/.test(t)) return { pass: false, reason: `HR ${t}，多半不看消息了` };
  return null;
}
export function hrStale(text) {
  return /[2-5]月内活跃|本月活跃/.test(String(text || '')) ? `HR ${text}，回复可能慢` : '';
}

function salaryCheck(text, f) {
  const sal = parseSalary(text);
  if (!sal) return null;
  // 上沿都够不着下限才淘汰
  if (f.salaryMin > 0 && sal[1] < f.salaryMin) {
    return { pass: false, reason: `薪资 ${text} 上沿低于 ${f.salaryMin}K` };
  }
  if (f.salaryFloorMin > 0 && sal[0] < f.salaryFloorMin) {
    return { pass: false, reason: `薪资 ${text} 下沿低于 ${f.salaryFloorMin}K` };
  }
  if (f.salaryMax > 0 && sal[0] > f.salaryMax) {
    return { pass: false, reason: `薪资 ${text} 高于上限 ${f.salaryMax}K` };
  }
  return null;
}

/**
 * 开场白本地复查。模型偶尔不听话，发出去就收不回来，所以发之前再用规则卡一遍：
 *  - 问底薪 / 休息 / 下班的问句 → 整句删掉（开场白只介绍自己，待遇等 HR 回了再问）
 *  - 出现禁用词 / 随时到岗 → 记为问题，这一条不自动发，转人工确认
 */
export function checkGreeting(text, config) {
  let out = String(text || '').trim();
  const problems = [];
  if (!out) return { text: out, problems: ['开场白是空的'] };

  const forbid = [...(config.greeting?.forbid || []), '随时到岗'];
  const hitForbid = forbid.filter((w) => w && out.includes(w));
  if (hitForbid.length) problems.push(`含禁用词：${[...new Set(hitForbid)].join('、')}`);

  // 开场白只介绍自己，底薪 / 休息 / 下班时间等 HR 回了再问 —— 模型要是还写了这类问句，整句删掉
  out = out.split(/(?<=[。！!？?])/).filter((s) => !(/[？?]/.test(s) && /底薪|薪资|工资|双休|单休|休息|下班|几点|加班/.test(s))).join('').trim();

  // 设置里填了作品集网址：开场第一句亮个人站，模型写的经历接在后面。
  // 注意：BOSS 曾把带网址的「个人优势」判成「内容可能包含敏感信息」卡审核，第一次发后去聊天页看一眼有没有原样送达。
  const site = config.library?.profile?.site?.link;
  let siteLen = 0;
  if (site) {
    const short = site.replace(/^https?:\/\//, '').replace(/\/$/, '');
    // 模型要是自己写了网址，去掉网址本身
    if (out.includes(short)) out = out.split(site).join('').split(short).join('').replace(/[:：]\s*(?=[，。！？,.!?])/g, '').replace(/\s{2,}/g, ' ');
    // 以前程序补的作品集句子（9/27 结尾版、9/29 第二句版）先拿掉，统一按开头重补
    out = out.replace(/[^。！!？?]*作品集网站[^。！!？?]*[。！!]?/g, '').trim();
    siteLen = 50;
    if (!/作品集|个人站/.test(out)) {
      let hi = '';
      out = out.replace(/^(您好|你好)[^，,。！!]*[，,！!]\s*/, (m) => { hi = m; return ''; });
      // 「简历里也有链接」：万一聊天里网址被吞，HR 也知道去简历里点
      const asExample = /^(?:我(?:自己)?(?:用\s*AI\s*编程工具)?做过一个|其中一个是)\s*/;
      if (asExample.test(out)) {
        out = out.replace(asExample, '其中一个是');
        out = `${hi}我自己有个人作品集网站，做过的项目截图和数据都在上面，网站是 ${short}，简历里也有链接。${out}`;
      } else {
        out = `${hi}我自己有个人作品集网站，做过的项目截图和数据都在上面，网站是 ${short}，简历里也有链接。${out}`;
      }
    }
  }

  const max = config.greeting?.maxChars || 170;
  if (out.length > max + 30 + siteLen) problems.push(`太长了（${out.length} 字，上限 ${max}）`);

  return { text: out, problems };
}

/**
 * 卷不卷的本地检查。模型会漏看福利标签，这里用字眼兜底。
 * 返回 { flags: [...], downgrade: bool }：downgrade=true 时「投」降成「等你定」
 */
export function workloadFlags(job) {
  const text = `${job.title || ''} ${job.jd || ''} ${job.welfare || ''}`;
  // 前面带「不 / 无 / 拒绝」的不算（「不需要加班」「无需倒班」）
  const hit = (w) => new RegExp(`(?<![不无零绝拒免])(?<!不用)(?<!无需)${w}`).test(text);
  const hard = ['单双休', '单休', '大小周', '996', '狼性', '常态加班', '经常加班', '需要加班', '接受加班', '适应加班', '晚班', '夜班', '倒班', '月休4天', '月休四天', '做六休一']
    .filter(hit);
  const soft = ['加班补助', '加班费', '加班餐', '抗压能力', '高强度', '结果导向', '弹性加班'].filter(hit);
  const flags = [];
  if (hard.length) flags.push(`可能卷：${hard.join('、')}`);
  if (soft.length) flags.push(`留意加班：${soft.join('、')}（面试问清实际几点下班）`);
  return { flags, downgrade: hard.length > 0 };
}

/** 技能重合度，给模型打分时当参考 */
export function skillOverlap(jobSkills, mySkills) {
  if (!jobSkills?.length || !mySkills?.length) return 0;
  const mine = mySkills.map((s) => s.toLowerCase());
  const hit = jobSkills.filter((s) =>
    mine.some((m) => m.includes(s.toLowerCase()) || s.toLowerCase().includes(m))
  );
  return Math.round((hit.length / jobSkills.length) * 100);
}

/**
 * 公司档次（上市或有名的企业，标准福利都在线的算大单位）。
 * 只看平台给的公司信息里的明文字眼，不猜：
 *   BOSS 详情页「已上市 · 10000人以上」、51job「已上市 1000-5000人」、智联「未融资 · 1000-9999人」
 * 人数是公司自己填的，会虚报（9/27 见过注册资本 100 万、自称 1000-9999 人的主播公会），
 * 所以没上市、不是国企的，注册资本不到 500 万就不认「大单位」。
 * 返回 { tier: '大单位' | '中型' | '小公司' | '看不出', why }
 */
export function companyTier(job) {
  const t = `${job.companyInfo || ''} ${job.business || ''}`;
  const listed = /已上市|上市公司/.test(t);
  const soe = /国企|国有|央企/.test(t);
  const foreign = /外资|合资|外商/.test(t);
  const m = t.match(/(\d+)\s*[-~至]\s*\d+\s*人|(\d+)\s*人以上|少于\s*(\d+)\s*人/);
  const low = m ? Number(m[1] || m[2] || 0) : null;
  const small = m && (m[3] || (low !== null && low < 100));
  const cap = t.match(/注册资本\s*([\d.]+)\s*(万|亿)/);
  const capWan = cap ? Number(cap[1]) * (cap[2] === '亿' ? 10000 : 1) : null;
  const capTooSmall = capWan !== null && capWan < 500;

  if (listed || soe) return { tier: '大单位', why: [listed && '上市', soe && '国企', foreign && '外资'].filter(Boolean).join('、') };
  if (low !== null && low >= 1000 && !capTooSmall) return { tier: '大单位', why: `${low}人以上${foreign ? '、外资' : ''}` };
  if (low !== null && low >= 1000 && capTooSmall) return { tier: '看不出', why: `自称${low}人以上但注册资本只有${capWan}万，对不上` };
  if (small) return { tier: '小公司', why: `${m[0].replace(/\s/g, '')}${foreign ? '（合资/外资也按人数算）' : ''}` };
  if (foreign || (low !== null && low >= 100)) return { tier: '中型', why: [foreign && '外资/合资', low !== null && `${low}人以上`].filter(Boolean).join('、') };
  if (small) return { tier: '小公司', why: m[0].replace(/\s/g, '') };
  return { tier: '看不出', why: '' };
}

/**
 * 招的是哪一届。简历里填了毕业时间才判：写明只招比你晚的届（校招、管培常见），
 * 有的公司接受「毕业两年内」，有的不接受 —— 不替你否决，标出来交给你定。
 * 返回提示文字，没问题返回空串
 */
export function cohortFlag(job, year) {
  if (!year) return '';
  const yy = year % 100;
  const t = `${job.title || ''} ${job.jd || ''}`;
  const other = [...t.matchAll(/(?:20)?(\d{2})\s*届/g)].find((m) => Number(m[1]) > yy && Number(m[1]) < yy + 4);
  if (!other) return '';
  if (new RegExp(`(20)?${yy}\\s*届|往届|不限届|毕业两年内|两年内毕业`).test(t)) return '';
  return `招的是 ${other[0].replace(/\s/g, '')}，你是 ${yy} 届 —— 照投的话，HR 问起如实说`;
}
