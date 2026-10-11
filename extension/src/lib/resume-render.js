/**
 * 按岗位从简历素材库（resume-kit/blocks.json，经 preset.js 带进插件）拼一页简历。
 * 纯函数、不碰 chrome.*，node 里也能直接跑。
 *
 * 模型只给「拼法」（基于哪一版、每段经历用哪种讲法、谁排前面、左栏放哪些技能），
 * 这里逐项核对拼法里的 id / 讲法是否真在素材库里，文字一律取素材库原句 —— 模型没机会往简历里写新事实。
 * 版式照 resume-kit/build.mjs（你自己那版）：左蓝栏 + 右主体，「时间｜机构｜职位」三栏对齐。
 */

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** 中文和数字之间不留空格（「提升 40%」→「提升40%」），和 build.mjs 同一规则 */
const CJK = '\\u4e00-\\u9fff\\u3000-\\u303f\\uff01-\\uff5d';
export const human = (s) => String(s)
  .replace(new RegExp(`([${CJK}])[ \\u00a0]+(?=[0-9])`, 'g'), '$1')
  .replace(new RegExp(`([0-9%])[ \\u00a0]+(?=[${CJK}])`, 'g'), '$1');

const bodySections = (lib) => lib.sections.filter((s) => !s.inSidebar);
const bodyItems = (lib) => bodySections(lib).flatMap((s) => s.items);

/** 这条经历有哪几种写法 */
export function modesOf(it) {
  return ['full', 'brief', 'hide', ...Object.keys(it.angles || {})].filter((m) => m !== 'brief' || it.brief);
}

/** 给模型看的素材清单：每条经历的 id、可选写法、每种写法的原文 */
export function libraryForModel(lib) {
  const out = [];
  const P = lib.profile;
  out.push(`姓名：${P.name}｜${P.facts.filter((f) => !/@|^\d{11}$/.test(f)).join('｜')}`);
  out.push(`求职意向：${Object.values(lib.intent.targetByVariant).join(' / ')}｜城市 ${lib.intent.city}｜期望薪资 ${lib.intent.salary}`);
  out.push(`教育：${lib.education.time} ${lib.education.org} ${lib.education.role}；${lib.education.lines.map((l) => l.text ?? l).join('；')}`);
  out.push('\n【左栏技能（label：内容）】');
  for (const s of P.skills) out.push(`- ${s.label}：${s.text}`);
  for (const sec of lib.sections) {
    out.push(`\n【${sec.title}】${sec.inSidebar ? '（放左栏，固定不变）' : ''}`);
    for (const it of sec.items) {
      out.push(`- id=${it.id}｜${it.time}｜${it.org}｜${it.role}${sec.inSidebar ? '' : `｜可选写法：${modesOf(it).join(' / ')}${it.defaultMode ? `（默认 ${it.defaultMode}）` : ''}`}`);
      out.push(`  full：${it.lines.map((l) => (l.label ? `${l.label}：` : '') + l.text).join(' ')}`);
      for (const [a, lines] of Object.entries(it.angles || {})) out.push(`  ${a}：${lines.map((l) => (l.label ? `${l.label}：` : '') + l.text).join(' ')}`);
      if (it.brief) out.push(`  brief：${it.brief}`);
    }
  }
  out.push(`\n【现成的几版】${Object.entries(lib.variants).map(([n, v]) => `${n}（${(v.sectionOrder || []).join('在前、')}在后）`).join('；')}`);
  return out.join('\n');
}

/**
 * 把模型给的拼法核对成可用的方案。模型写歪的项（不存在的 id、没有的写法）直接丢掉、用基础版的。
 * 返回 { base, target, v }，v 的结构同 blocks.json 的 variants。
 */
/** 模型给的字段形状不一定规矩：数组 / 逗号分隔的字符串 / 对象都可能 */
const list = (x) => (Array.isArray(x) ? x : typeof x === 'string' ? x.split(/[,，、\s]+/) : x && typeof x === 'object' ? Object.values(x) : []).map((y) => (typeof y === 'string' ? y.trim() : y)).filter(Boolean);
function itemPairs(x) {
  if (Array.isArray(x)) return x.map((p) => (Array.isArray(p) ? { id: p[0], mode: p[1] } : p)).filter((p) => p && typeof p === 'object');
  if (x && typeof x === 'object') return Object.entries(x).map(([id, m]) => ({ id, mode: typeof m === 'string' ? m : m?.mode }));
  return [];
}

export function buildPlan(lib, spec = {}) {
  spec = spec || {};
  const base = lib.variants[spec.base] ? spec.base : '通用';
  const bv = lib.variants[base];
  const v = { sectionOrder: [...(bv.sectionOrder || bodySections(lib).map((s) => s.title))], order: { ...(bv.order || {}) }, items: { ...(bv.items || {}) }, skills: [...(bv.skills || lib.profile.skills.map((s) => s.label))] };

  const titles = bodySections(lib).map((s) => s.title);
  const so = list(spec.section_order).filter((t) => titles.includes(t));
  if (so.length) v.sectionOrder = [...new Set([...so, ...titles])];

  const byId = new Map(bodyItems(lib).map((it) => [it.id, it]));
  const order = list(spec.order);
  if (order.length) {
    for (const sec of bodySections(lib)) {
      const want = order.filter((id) => sec.items.some((it) => it.id === id));
      if (want.length) v.order[sec.title] = want;
    }
  }
  for (const { id, mode } of itemPairs(spec.items)) {
    const it = byId.get(id);
    if (it && modesOf(it).includes(mode)) v.items[id] = mode;
  }
  const labels = lib.profile.skills.map((s) => s.label);
  const sk = [...new Set(list(spec.skills).filter((l) => labels.includes(l)))];
  if (sk.length >= 3) v.skills = sk.slice(0, 5);

  let target = String(spec.target || '').replace(/\s+/g, ' ').trim();
  if (!target || target.length > 30) target = lib.intent.targetByVariant[base] || lib.intent.targetByVariant['通用'];
  // 期望岗位只许换叫法，不许借机塞经历或数字
  if (/\d{2,}|经验|精通/.test(target)) target = lib.intent.targetByVariant[base];
  return { base, target, v };
}

function ordered(sec, v) {
  const want = (v.order || {})[sec.title] || [];
  const rank = (it) => { const i = want.indexOf(it.id); return i < 0 ? 999 : i; };
  return sec.items.map((it, i) => ({ it, i })).sort((a, b) => rank(a.it) - rank(b.it) || a.i - b.i).map(({ it }) => it);
}

const modeFor = (it, v) => (v.items || {})[it.id] || it.defaultMode || 'full';

function linesFor(it, v) {
  const mode = modeFor(it, v);
  if (mode === 'hide') return null;
  if (mode === 'brief') return [{ label: '', text: it.brief || it.lines[0].text }];
  if (mode !== 'full' && it.angles?.[mode]) return it.angles[mode];
  return it.lines;
}

/** 右栏实际显示的条目，按显示顺序 */
function visibleItems(lib, v) {
  const out = [];
  for (const title of v.sectionOrder) {
    const sec = bodySections(lib).find((s) => s.title === title);
    if (sec) for (const it of ordered(sec, v)) if (modeFor(it, v) !== 'hide') out.push(it);
  }
  return out;
}

/**
 * 超出一页时压一档：从最后面（最不相关）的条目开始，先把展开写的改成一句话，都是一句话了再藏掉最后一条。
 * 最前面两条不动。返回改了哪条（null = 已经压不动了）。
 */
export function shrinkOnce(lib, plan) {
  const vis = visibleItems(lib, plan.v);
  for (let i = vis.length - 1; i >= 2; i--) {
    const it = vis[i];
    if (modeFor(it, plan.v) !== 'brief' && it.brief) { plan.v.items[it.id] = 'brief'; return `${it.org} 改成一句话`; }
  }
  for (let i = vis.length - 1; i >= 2; i--) {
    const it = vis[i];
    plan.v.items[it.id] = 'hide'; return `去掉 ${it.org}`;
  }
  return null;
}

/** 整页 HTML（放进 .page 里）。photoUrl 由调用方给（扩展里是 chrome.runtime.getURL） */
export function resumeHtml(lib, plan, photoUrl) {
  const { base, target, v } = plan;
  const P = lib.profile;
  const skills = v.skills.map((l) => P.skills.find((s) => s.label === l)).filter(Boolean);

  const side = [
    photoUrl ? `<img class="photo" src="${esc(photoUrl)}" alt="">` : '<div class="photo-gap"></div>',
    `<div class="name">${esc(P.name)}</div>`,
    `<ul class="facts">${P.facts.map((f) => `<li>${esc(f)}</li>`).join('')}${P.site ? `<li><a href="${esc(P.site.link)}">${esc(P.site.text)}</a></li>` : ''}</ul>`,
    `<div class="side-title">${esc(P.skillsTitle)}</div>`,
    ...skills.map((s) => `<p class="skill"><b>${esc(s.label)}：</b>${esc(human((s.textByVariant || {})[base] || s.text))}</p>`),
  ];
  for (const sec of lib.sections.filter((s) => s.inSidebar)) {
    side.push(`<div class="side-title">${esc(sec.sidebarTitle || sec.title)}</div>`);
    for (const it of sec.items.slice(0, sec.maxItems || 3)) {
      side.push(`<p class="side-item"><b>${esc(it.role)}</b><span>${esc(it.time)}</span></p>`);
      for (const ln of it.lines) side.push(`<p class="side-text">${esc(human(ln.text))}</p>`);
    }
  }

  const I = lib.intent;
  const E = lib.education;
  const head = (time, org, role) => `<div class="ihead"><span>${esc(time)}</span><span>${esc(org)}</span><span>${esc(role)}</span></div>`;
  const line = (ln) => `<p class="iline">${ln.label ? `- ${esc(ln.label)}：` : ''}${esc(human(ln.text ?? ln))}</p>`;
  const thesisShown = visibleItems(lib, v).some((it) => /毕业论文/.test(it.org));
  // 作品集放右栏最顶上（2026-09-27 你：个人站放简历最优先的位置），和 build.mjs 一致
  const S = P.site;
  const main = [
    S ? `<p class="site"><b>个人作品集：</b><a href="${esc(S.link)}">${esc(S.link.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</a>${S.pitch ? `<span>${esc(human(S.pitch))}</span>` : ''}</p>` : '',
    '<h2>求职意向</h2>',
    `<div class="intent3"><span>期望岗位：${esc(target)}</span><span>期望城市：${esc(I.city)}</span><span>期望薪资：${esc(I.salary)}</span></div>`,
    I.onboard ? `<div class="intent"><span>到岗时间：${esc(I.onboard)}</span></div>` : '',
    '<h2>教育背景</h2>',
    head(E.time, E.org, E.role),
    // 毕业论文已经单列成项目时，教育背景里那行就不重复了
    ...E.lines.filter((l) => !(l.hideIn || []).includes(base) && !(thesisShown && /毕业论文/.test(l.text ?? l))).map(line),
  ];
  for (const title of v.sectionOrder) {
    const sec = bodySections(lib).find((s) => s.title === title);
    if (!sec) continue;
    const rows = ordered(sec, v).map((it) => ({ it, lines: linesFor(it, v) })).filter((x) => x.lines);
    if (!rows.length) continue;
    main.push(`<h2>${esc(sec.title)}</h2>`);
    for (const { it, lines } of rows) main.push(head(it.time, it.org, it.role), ...lines.map(line));
  }
  return `<aside class="side">${side.join('')}</aside><main class="main">${main.join('')}</main>`;
}

/** 当前方案一句话说明（给你看拼了什么） */
export function describePlan(lib, plan) {
  const vis = visibleItems(lib, plan.v).map((it) => {
    const m = modeFor(it, plan.v);
    return `${it.org}${m === 'brief' ? '（一句话）' : m === 'full' ? '' : `（${m}角度）`}`;
  });
  return `基于「${plan.base}」版；期望岗位写「${plan.target}」；顺序：${vis.join(' → ')}；左栏技能：${plan.v.skills.join('、')}`;
}
