/**
 * 设置页解析出来的简历（config.resume）→ 简历素材库（定制简历 PDF、网申填表、给模型看的都用这个格式）。
 * 每段经历只有一种讲法（full），brief 取第一条要点；纯函数，node 里也能跑。
 */

const short = (u) => String(u || '').replace(/^https?:\/\//, '').replace(/\/$/, '');

/** 技能：「数据分析：Excel、SQL」这种拆成 label + text；没有冒号的短技能合成一条「技能」 */
function skillsOf(list) {
  const out = [];
  const loose = [];
  for (const t of list || []) {
    const s = String(t || '').trim();
    if (!s) continue;
    const m = /^([^：:]{1,10})[：:]\s*(.+)$/.exec(s);
    if (m) out.push({ label: m[1].trim(), text: m[2].trim(), tags: [], weight: 5 });
    else loose.push(s.replace(/[。；;]$/, ''));
  }
  if (loose.length) out.push({ label: '技能', text: loose.join('、'), tags: [], weight: 5 });
  // label 重复时加序号，免得定制简历时选不到
  const seen = {};
  for (const s of out) { seen[s.label] = (seen[s.label] || 0) + 1; if (seen[s.label] > 1) s.label += seen[s.label]; }
  return out;
}

function itemsOf(arr, prefix, orgKey) {
  return (arr || []).map((e, i) => {
    const bullets = (e.bullets || []).map((b) => String(b || '').trim()).filter(Boolean);
    return {
      id: `${prefix}${i}`,
      time: e.period || '',
      org: e[orgKey] || '',
      role: e.role || '',
      lines: bullets.length ? bullets.map((text) => ({ label: '', text })) : [{ label: '', text: e.role || e[orgKey] || '' }],
      ...(bullets[0] ? { brief: bullets[0] } : {}),
    };
  });
}

/** 毕业年月 → 「2026 届」；读不出返回 '' */
export function cohortOf(graduation) {
  const m = /(20\d{2})/.exec(String(graduation || ''));
  return m ? Number(m[1]) : 0;
}

export function buildLibrary(r, config = {}) {
  const skills = skillsOf(r.skills);
  const exp = itemsOf(r.experiences, 'j', 'company');
  const proj = itemsOf(r.projects, 'p', 'name');
  const year = cohortOf(r.graduation);
  const identity = year ? `${year} 届毕业生` : '';
  return {
    version: 'lite',
    profile: {
      name: r.name || '',
      photo: '',
      site: r.site ? { text: `作品集 ${short(r.site)}`, link: /^https?:/i.test(r.site) ? r.site : `https://${r.site}`, pitch: '' } : null,
      facts: [r.age, r.gender, identity, r.phone, r.email, r.political].map((x) => String(x || '').trim()).filter(Boolean),
      skillsTitle: '技 能 特 长',
      skills,
    },
    intent: {
      city: (config.filter?.cities || [])[0] || r.city || '',
      salary: r.salary || '面议',
      onboard: '',
      targetByVariant: { 通用: r.title || '' },
    },
    education: {
      time: r.graduation ? `${r.graduation} 毕业` : '',
      org: r.school || '',
      role: r.major ? `${r.major}${r.degree ? `（${r.degree}）` : ''}` : (r.degree || ''),
      lines: [],
      start: r.eduStart || '',
      graduation: r.graduation || '',
      degree: r.degree || '',
      identity,
    },
    sections: [
      { title: '工作经验', items: exp },
      { title: '项目经历', items: proj },
    ],
    variants: {
      通用: {
        sectionOrder: exp.length ? ['工作经验', '项目经历'] : ['项目经历', '工作经验'],
        skills: skills.map((s) => s.label).slice(0, 5),
        items: {},
      },
    },
  };
}
