// 「找新岗位」的网申来源（10/16 22:00 用户：「你这个肯定是连着网申和猎聘一块扫啊」）
// 网申公告的拉取和模型初筛都是求职插件现成的（lib/campus-source.js 的 pullCampus、lib/campus.js 的 screenPending / visibleOf），
// 这里只在 9334 插件侧边栏页的上下文里调它导出的函数，插件文件一行不改；结果整成 /api/hunt 的 queue 条目写进 data\hunt-campus.json。
// 接口约定见 docs/api-contract.md「/api/hunt 多来源 › 网申」。
//
// 动插件存储（拉取 / 初筛会写 storage.campus）之前先整份导出备份到 boss-jobhunter\backups\。
// 「不投」「打开过」只记在 data\hunt-campus-state.json，不写插件存储（插件侧边栏里照样能看到，用户在那边点的「不投」这里也认）。
//
// 命令行：node campus-hunt.mjs --dry   只读插件存储，打印会进待审的条目，不拉、不筛、不写任何文件
//         node campus-hunt.mjs         跑一轮 pull()（今天成功拉过就不再拉，只把没筛的筛完）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, withTimeout, DATA } from './lib.mjs';
import { ensure as ensurePlugin, panelUrl } from './plugin-host.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(DATA, 'hunt-campus.json');
const STATE = path.join(DATA, 'hunt-campus-state.json');
const BACKUP_DIR = path.join(path.dirname(OUT), 'backups');
const PANEL = 'src/sidepanel/panel.html';
const MAX_PULLS = 2; // 插件 campus-source.js 的 MAX_PULLS_PER_DAY

const pad = (n) => String(n).padStart(2, '0');
const localIso = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const today = () => localIso().slice(0, 10);
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.writeFileSync(`${f}.tmp`, JSON.stringify(v, null, 1)); fs.renameSync(`${f}.tmp`, f); };
const bareId = (id) => String(id).replace(/^campus-/, '');

async function panel() {
  const h = await ensurePlugin();   // 插件跑在 watcher 自己拉起的后台浏览器里（plugin-host.mjs），端口和插件 id 运行时才知道
  if (!h.ok) throw Object.assign(new Error(h.why), { fix: h.fix });
  let c = await connect(h.port, PANEL).catch(() => null);
  if (!c) c = await connect(h.port, PANEL, panelUrl(h.extId), { keep: true }).catch(() => null);
  if (!c) throw Object.assign(new Error('连不上后台浏览器里的求职插件'), { fix: '关掉桌面助手再打开一次' });
  return c;
}

// 插件页里跑：读 storage.campus，用插件自己的 visibleOf / daysLeft 排好序取出来
const READ = `(async()=>{
  const m=await import(chrome.runtime.getURL('src/lib/campus.js'));
  const c=await m.getCampus();
  const vis=m.visibleOf(c).map(x=>({...x,left:m.daysLeft(x.deadline)}));
  const all=Object.values(c.items||{});
  const pend=m.pendingOf(c).length;
  const day=(ms)=>{const d=new Date(ms);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')};
  const t=day(Date.now());
  return {vis,total:all.length,pend,pullsToday:(c.pulls||[]).filter(p=>day(p.at)===t).length,okToday:!!(c.lastOk&&day(c.lastOk)===t),
    lastPull:(c.pulls||[])[0]||null,lastError:c.lastError||'',screening:m.isScreening()};
})()`;

async function backup(c) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const raw = await withTimeout(c.ev('chrome.storage.local.get(null).then(x=>JSON.stringify(x))'), 30000, '备份插件存储');
  if (!raw || raw.length < 10) throw new Error('插件存储备份没拿到内容，先不动它');
  const f = path.join(BACKUP_DIR, `plugin-storage-${localIso().replace(/[:T]/g, '').slice(0, 13)}-campus.json`);
  fs.writeFileSync(f, raw);
  return f;
}

/** 把插件的公告整成 /api/hunt 的 queue 条目 */
function toItem(x, st) {
  const ai = x.ai || {};
  const id = `campus-${x.id}`;
  const pos = (ai.matched_positions || []).length ? ai.matched_positions : (x.hits || []);
  const reasons = [ai.reason, ai.grade_risk && ai.grade_risk !== '无' && ai.grade_risk !== '看不出' ? `届别：${ai.grade_risk}` : '', ...(ai.veto || []).map((v) => `注意：${v}`)].filter(Boolean);
  return {
    jobId: id, source: 'campus', applyHow: 'campus-tab', platform: '网申',
    title: pos.join('、') || String(x.positions || '').slice(0, 40), company: x.company, fullCompany: x.company,
    companyInfo: [(x.typeTag || []).join('/'), x.industry].filter(Boolean).join(' · '),
    salary: '', city: x.locations || '', hr: '', href: x.noticeUrl || x.applyUrl || '',
    jd: [`批次：${x.batch || '—'}`, `截止：${x.deadline || '没写'}`, `地点：${x.locations || '—'}`, `招的岗位：${x.positions || '—'}`].join('\n'),
    tags: x.typeTag || [], invite: false, hrActive: '',
    score: '', verdict: ai.verdict || '', reasons, greeting: '', status: '待审核', error: '', check: '',
    tier: ai.company_tier || '', tierWhy: ai.priority || '',
    addedAt: x.firstSeen || 0, approvedAt: 0,
    deadline: x.deadline || null, daysLeft: Number.isFinite(x.left) ? x.left : null, applyUrl: x.applyUrl || x.noticeUrl || null,
    opened: Boolean(st.opened?.[String(x.id)]),
  };
}

function build(r, st) {
  const t = today();
  return r.vis
    .filter((x) => !st.dropped?.[String(x.id)])
    .filter((x) => !x.deadline || x.deadline >= t)
    .map((x) => toItem(x, st));
}

/**
 * 跑一轮：今天还没成功拉过、且配额没用完 → 备份后 pullCampus；有「待筛」的 → 备份后 screenPending；
 * 最后把「投 / 等你定」写进 hunt-campus.json。返回 { ok, found, listed, note, fix?, secs }
 */
export async function pull({ dry = false } = {}) {
  const t0 = Date.now();
  let c;
  try { c = await panel(); } catch (e) { return { ok: false, found: 0, listed: 0, note: e.message, fix: e.fix || '关掉桌面助手再打开一次' }; }
  const notes = [];
  try {
    let r = await withTimeout(c.ev(READ), 20000, '读网申公告');
    if (!r) throw new Error('插件页没返回网申数据');
    if (r.screening) return { ok: false, found: r.total, listed: 0, note: '插件侧边栏正在筛网申公告，等它筛完再扫', fix: null, secs: 0 };
    let backed = '';
    const needPull = !r.okToday && r.pullsToday < MAX_PULLS;
    if (!dry && needPull) {
      backed = await backup(c);
      const p = await withTimeout(c.ev(`(async()=>{const s=await import(chrome.runtime.getURL('src/lib/store.js'));const cfg=await s.getConfig();
        const m=await import(chrome.runtime.getURL('src/lib/campus-source.js'));return m.pullCampus({excludeKeywords:(cfg.filter&&cfg.filter.excludeKeywords)||[]});})()`), 60000, '拉网申公告');
      if (p?.ok) notes.push(`拉到 ${p.n} 条公告，新进 ${p.added} 条`);
      else notes.push(`没拉成：${p?.err || '插件没返回'}`);
      r = await withTimeout(c.ev(READ), 20000, '读网申公告');
    } else if (r.okToday) notes.push(`今天 ${r.lastPull ? new Date(r.lastPull.at).toTimeString().slice(0, 5) : ''} 已经拉过，不重复拉`);
    else if (r.pullsToday >= MAX_PULLS) notes.push(`今天已经拉过 ${MAX_PULLS} 次了，明天再拉`);

    if (!dry && r.pend > 0) {
      if (!backed) backed = await backup(c);
      const s = await withTimeout(c.ev(`(async()=>{const s=await import(chrome.runtime.getURL('src/lib/store.js'));const cfg=await s.getConfig();
        const m=await import(chrome.runtime.getURL('src/lib/campus.js'));return m.screenPending(cfg,()=>{},300);})()`), 15 * 60000, '模型初筛网申公告');
      notes.push(s?.error ? `初筛停了：${s.error}` : `新筛 ${s?.done || 0} 条（建议投 ${s?.go || 0}、等你定 ${s?.ask || 0}）`);
      r = await withTimeout(c.ev(READ), 20000, '读网申公告');
    } else if (dry && r.pend > 0) notes.push(`还有 ${r.pend} 条没筛`);

    const st = readJson(STATE, { dropped: {}, opened: {} });
    const items = build(r, st);
    if (!dry) writeJson(OUT, { at: localIso(), items });
    const failed = r.lastError && !r.okToday;
    return {
      ok: !failed, found: r.total, listed: items.length,
      note: notes.join('；'), fix: failed ? '求职方舟的网申接口可能变了或者连不上，明天会自动再拉；急的话重开桌面助手试试' : null,
      secs: Math.round((Date.now() - t0) / 1000), backup: backed || null, items: dry ? items : undefined,
    };
  } catch (e) {
    return { ok: false, found: 0, listed: 0, note: `网申没扫成：${e.message}`, fix: '过几分钟再点一次；还不行重开桌面助手', secs: Math.round((Date.now() - t0) / 1000) };
  } finally { await c.close(); }
}

/** 待审条目（hunt.mjs read() 合进 queue）：去掉不投的、已截止的，打开过的带 opened */
export function list() {
  const f = readJson(OUT, { items: [] });
  const st = readJson(STATE, { dropped: {}, opened: {} });
  const t = today();
  return (f.items || [])
    .filter((x) => !st.dropped?.[bareId(x.jobId)])
    .filter((x) => !x.deadline || x.deadline >= t)
    .map((x) => ({ ...x, opened: Boolean(st.opened?.[bareId(x.jobId)]) }));
}

function mark(kind, id) {
  const st = readJson(STATE, { dropped: {}, opened: {} });
  (st[kind] ||= {})[bareId(id)] = localIso();
  writeJson(STATE, st);
  return { ok: true };
}
/** 不投：以后不再出现在待审 */
export const drop = (id) => mark('dropped', id);
/** 在网申标签里打开过（「投」网申 = 打开投递链接，用户自己填） */
export const markOpened = (id) => mark('opened', id);
/** 撤销不投（前端 5 秒撤销用） */
export function undrop(id) {
  const st = readJson(STATE, { dropped: {}, opened: {} });
  delete st.dropped?.[bareId(id)];
  writeJson(STATE, st);
  return { ok: true };
}
/** 来源芯片用：{ n, ok, note } */
export function source() {
  const f = readJson(OUT, null);
  if (!f) return { n: 0, ok: true, note: '还没扫过网申' };
  return { n: list().length, ok: true, note: `${f.at.slice(11, 16)} 扫的` };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dry = process.argv.includes('--dry');
  const r = await pull({ dry });
  const { items, ...rest } = r;
  console.log(JSON.stringify(rest, null, 1));
  if (items) {
    console.log(`会进待审 ${items.length} 条，前 8 条：`);
    for (const x of items.slice(0, 8)) console.log(`  [${x.verdict}] ${x.company} · ${x.title} · 截止 ${x.deadline || '没写'}${x.daysLeft != null ? `（还剩 ${x.daysLeft} 天）` : ''} · ${x.tier}`);
    const by = {}; for (const x of items) by[x.verdict] = (by[x.verdict] || 0) + 1;
    console.log('按结论：', JSON.stringify(by));
  }
  process.exit(0);
}
