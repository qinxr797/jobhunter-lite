// 投递表（10/16 晚，用户：「我刚自己用海投工具投了 11 家，扭头就找不到了」）
// 所有渠道、所有人投的汇成一张表：data\tracker.db（node:sqlite，Node 24 自带，不用装东西）
//   apps   投递：一家一个岗位一条（主键见 place）
//   events 事件：投出去、阶段变化、HR 说话、盯梢回了什么、用户手动改（时间线）
//   tasks  待办：tracker-rules.mjs 算出来的，用户点「完成 / 稍后」的状态存这里
// 表结构和去重键照 JobSync（有岗位 ID 用 ID，否则 平台+公司去后缀+岗位）；阶段 / 结局 / 事件三层照 job-ops
// 接口形状以 docs/api-contract.md 为准
// 来源（每 5 分钟增量合并，inbox.mjs 里调 sync）：
//   ① 插件 done（海投投出去的）② 插件 queue（排队 / 发送中 / 失败）③ 平台进度（插件 readProgress 的缓存：51job 我的申请、智联求职反馈）
//   ④ 盯梢会话（BOSS / 智联 / 猎聘）⑤ 代投 xlsx（applied.json）⑥ data\applied-log.jsonl（以后代投、网申「我交了」都追加这里）
//   另外：插件「回顾」行、代投脚本结果 tools\autopilot\out\night*.json
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, appendFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { DATA } from './lib.mjs';
import { stripPlace } from './config.mjs';
import { RANK, PRE, STAGE_NAME, OUTCOME_NAME, stageFromText, stageFromConv, autoOutcome, computeTasks, cleanTitle, blockedHit } from './tracker-rules.mjs';

export const DB_FILE = process.env.TRACKER_DB || path.join(DATA, 'tracker.db');      // 试跑时用环境变量指到别处
export const APPLIED_LOG = process.env.TRACKER_LOG || path.join(DATA, 'applied-log.jsonl');
const OUT_DIR = path.join(DATA, '..', '..', 'autopilot', 'out');
const bj = (t = Date.now()) => new Date(t + 8 * 3600e3).toISOString().slice(0, 19);
const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const readLines = (f) => { try { return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };

/**
 * 记一条投递（助手 代投完、网申点「我交了」都调这个）。只追加文件，下一轮 sync 才进表，所以随便哪个进程调都安全
 * rec：{ platform: 'BOSS'|'智联'|'51job'|'猎聘'|'网申', company, title, url?, jobId?, salary?, city?, by?: 'claude'|'me', note?, at? }
 */
export function appendApplied(rec) {
  if (!rec?.company) throw new Error('appendApplied 要公司名');
  const line = { at: rec.at || bj(), by: rec.by || 'claude', ...rec };
  appendFileSync(APPLIED_LOG, JSON.stringify(line) + '\n');
  return line;
}

// ---------- 规范化 ----------
const PLAT = [
  [/boss/i, 'boss', 'BOSS'], [/智联|zhilian|^zl$/i, 'zl', '智联'], [/51/, '51', '51job'], [/猎聘|liepin|^lp$/i, 'lp', '猎聘'], [/网申|campus/i, 'campus', '网申'],
];
export function plat(s = '') { for (const [re, code, label] of PLAT) if (re.test(String(s))) return { code, label }; return { code: 'other', label: String(s) || '其他' }; }
const BY = (s = '') => (/^(me|你)$/i.test(s) ? 'me' : /plugin|插件/i.test(s) ? 'plugin' : /claude/i.test(s) ? 'claude' : /hr/i.test(s) ? 'hr' : '');
export function coNorm(s = '') {
  let x = String(s).replace(/[（(【\[][^）)】\]]*[）)】\]]/g, '').replace(/[\s·・,，.。、\-—_/]/g, '');
  for (let i = 0; i < 3; i++) x = x.replace(/(股份有限公司|有限责任公司|集团有限公司|集团股份|有限公司|股份公司|集团|分公司|公司|股份)$/, '');
  const y = stripPlace(x);
  return (y.length >= 2 ? y : x).toLowerCase();
}
export const titleNorm = (s = '') => String(s).replace(/[（(【\[][^）)】\]]*[）)】\]]/g, '').replace(/[\s·・,，.。、\-—_/|｜]/g, '').replace(/(急聘|急招|双休|五险一金)+$/, '').toLowerCase();
const idFromUrl = (code, url = '') => {
  const u = String(url);
  const m = code === 'boss' ? /job_detail\/([\w-]+?)\.html/.exec(u) : code === 'zl' ? /(CC\w+?J\w+?)\.htm/.exec(u) : code === '51' ? /\/(\d{6,})\.html/.exec(u) : code === 'lp' ? /\/job\/(\d+)\.s?html/.exec(u) : null;
  return m ? m[1] : '';
};
// 同一家：相等；短的 ≥3 字且包含；短的 ≥2 字且是开头（「昕徽」≈「昕徽进出口」）；简称是全称的「跳字缩写」且头两个字一样（「芯碁微装」≈「芯碁微电子装备」）
function sameCo(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (s.length >= 3 && l.includes(s)) return true;
  if (s.length >= 2 && l.startsWith(s)) return true;
  if (s.length >= 3 && l.startsWith(s.slice(0, 2))) { let i = 0; for (const ch of l) if (ch === s[i]) i++; return i === s.length; }
  return false;
}

// ---------- 数据库 ----------
let db = null;
export function open() {
  if (db) return db;
  db = new DatabaseSync(DB_FILE);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS apps (id INTEGER PRIMARY KEY, key TEXT UNIQUE, alt TEXT, platform TEXT, co_norm TEXT, stage TEXT, outcome TEXT,
      applied_at TEXT, updated_at TEXT, data TEXT);
    CREATE INDEX IF NOT EXISTS apps_alt ON apps(alt);
    CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, app_id INTEGER, at TEXT, type TEXT, from_s TEXT, to_s TEXT, who TEXT, source TEXT, text TEXT,
      UNIQUE(app_id, type, at, text));
    CREATE INDEX IF NOT EXISTS events_app ON events(app_id);
    CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY, rkey TEXT UNIQUE, app_id INTEGER, type TEXT, grp TEXT, text TEXT, detail TEXT, due TEXT,
      status TEXT, until TEXT, sig TEXT, created_at TEXT, done_at TEXT, data TEXT);`);
  return db;
}

// ---------- 读各个来源 → 统一的「观察」----------
// obs：{ src, platform, jobId, pluginJobId, company, title, url, salary, city, at（投出去的时间）, by, stage, stageAt, outcome, why, extra }
function fromPlugin(hunt) {
  const out = [];
  if (!hunt?.ok) return out;
  for (const d of hunt.done || []) {
    if (d.dryRun || !d.company) continue;
    out.push({ src: 'plugin-done', platform: d.platform || 'boss', jobId: String(d.jobId || '').replace(/^51job-/, ''), pluginJobId: d.jobId, company: d.company, title: d.title,
      url: d.href, salary: d.salary, at: bj(d.at), by: 'plugin', stage: 'applied', stageAt: bj(d.at), extra: { greeting: d.greeting || '' } });
  }
  for (const q of hunt.queue || []) {
    const stage = { 排队: 'queued', 发送中: 'sending', 失败: 'failed' }[q.status];
    if (!stage) continue;
    const t = q.approvedAt || q.addedAt;
    if (q.applyHow === 'campus-tab') continue;                       // 网申只有「打开过」，不算投递（交了在网申面板点「我交了」）
    const lpq = ['liepin', 'desk-boss', 'desk-zhilian'].includes(q.applyHow);   // 猎聘 / HR Desk 里扫的 BOSS、智联：hr-watch 自己的发送队列，jobId 去掉前缀才和链接里的对得上
    out.push({ src: lpq ? `${q.applyHow}-queue` : 'plugin-queue', platform: q.platform || 'boss', jobId: String(q.jobId || '').replace(/^51job-|^liepin-|^boss-|^zl-/, ''), pluginJobId: q.jobId, company: q.company, fullCompany: q.fullCompany,
      title: q.title, url: q.href, salary: q.salary, city: q.city, at: t ? bj(t) : '', by: lpq ? 'me' : 'plugin', stage, stageAt: t ? bj(t) : '', queue: true,
      extra: { error: q.error || '', hr: q.hr || '', size: q.companyInfo || '', greeting: q.greeting || '' } });
  }
  // 平台进度：插件 readProgress 的缓存（插件每次回顾 / 30 分钟读一次，这里只读缓存，不去开平台页）
  const pp = hunt.progress;
  for (const [key, label] of [['job51', '51job'], ['zhilian', '智联']]) {
    const ivs = key === 'zhilian' ? pp?.zhilian?.interviews || [] : [];
    for (const it of pp?.[key]?.items || []) {
      const iv = ivs.find((x) => (x.jobId && x.jobId === it.jobId) || (x.company === it.company && x.title === it.title));
      const st = iv ? (/拒绝|取消/.test(iv.state) ? '面试取消' : '邀面试') : it.status;
      const s = (iv && /拒绝|取消/.test(iv.state)) ? { stage: 'closed', outcome: 'rejected', why: `面试邀请：${iv.state}` } : stageFromText(st) || { stage: 'applied' };
      const at = String(it.appliedAt || '').replace(' ', 'T');
      out.push({ src: 'platform', platform: label, jobId: key === 'zhilian' ? '' : it.jobId || '', company: it.company, title: it.title, url: it.href, salary: it.salary, city: it.city,
        at: /^\d{4}-\d\d-\d\d/.test(at) ? (at + 'T00:00:00'.slice(at.length - 10)).slice(0, 19) : '', stage: s.stage, outcome: s.outcome, why: s.why, stageAt: pp.at ? bj(pp.at) : '',
        extra: { platformState: st, ...(iv?.begin ? { interviewAt: bj(iv.begin), interviewWay: iv.way || '' } : {}) } });
    }
  }
  // 插件「回顾」：今天以前投过的每家现在什么状态（BOSS 按聊天列表、51job/智联按平台进度）
  for (const r of hunt.review?.rows || []) {
    const s = stageFromText(`${r.state} ${r.last || ''}`);
    out.push({ src: 'review', platform: r.channel || r.platform, company: r.company, title: r.title, url: r.href, salary: r.salary, at: r.at ? bj(r.at) : '',
      stage: s?.stage || 'applied', outcome: s?.outcome, why: s?.why, stageAt: hunt.review.at ? bj(hunt.review.at) : '', extra: { reviewState: r.state } });
  }
  return out;
}

function fromXlsx() {
  return readJson(path.join(DATA, 'applied.json'), []).filter((r) => r.title || !/\d+\s*家/.test(r.company)).map((r) => {   // 「51job 7 家（云南白药、洽洽…）」这种汇总行不算
    const hm = /(\d{1,2}):(\d{2})/.exec(r.when || '');
    const s = stageFromText(r.status);
    const hrFirst = /HR 主动/.test(r.platform);
    return { src: 'xlsx', platform: hrFirst ? 'BOSS' : r.platform, company: r.company, title: r.title, salary: r.salary, city: r.city,
      url: /^https?:/.test(r.link) ? r.link : '', at: `${r.day}T${hm ? hm[1].padStart(2, '0') + ':' + hm[2] : '12:00'}:00`,
      by: hrFirst ? 'hr' : r.sheet === '之前投过的回顾' ? '' : 'claude',
      stage: s?.stage && RANK[s.stage] <= RANK.replied ? s.stage : 'applied', stageAt: `${r.file_day}T21:00:00`,
      extra: { size: r.size, rest: r.rest, addr: r.addr, commute: r.commute, bg: r.bg, status: r.status } };
  });
}

function fromNight() {
  const out = [];
  let files = [];
  try { files = readdirSync(OUT_DIR).filter((f) => /^night\d{4}_.*\.json$/.test(f)); } catch { return out; }
  for (const f of files) {
    const day = `2026-${f.slice(5, 7)}-${f.slice(7, 9)}`;
    const d = readJson(path.join(OUT_DIR, f), []);
    const rows = Array.isArray(d) ? d : d.boss || [];               // night1016_boss.json：{ boss: 投了的, wait: 等你定的 }
    for (const r of rows) {
      if (!/已投/.test(r['状态'] || '') || !r['公司全称']) continue;
      out.push({ src: 'night', platform: r['平台'], company: r['公司全称'], title: r['岗位'], salary: r['薪资'], url: r['链接'] || '', at: `${day}T21:00:00`, by: 'claude',
        stage: 'applied', stageAt: `${day}T21:00:00`, extra: { size: r['规模参保'], rest: r['休息'], addr: r['地址'], commute: r['通勤'], bg: r['背调'] || r['背调一句话'], hr: r['HR'], greeting: r['开场白'] || r['开场白原文'] || '' } });
    }
  }
  return out;
}

function fromLog() {
  return readLines(APPLIED_LOG).map((r) => ({ src: r.src || 'log', platform: r.platform, jobId: r.jobId || '', company: r.company, title: r.title || '', url: r.url || '',
    salary: r.salary || '', city: r.city || '', at: String(r.at || '').slice(0, 19), by: BY(r.by) || 'claude', stage: 'applied', stageAt: String(r.at || '').slice(0, 19),
    extra: r.note ? { note: r.note } : {} }));
}

// ---------- 合并 ----------
let syncing = null, lastSync = '', lastErr = '';
export const syncInfo = () => ({ at: lastSync, err: lastErr });
/** model = inbox.mjs 的 buildModel()，hunt = hunt.read() 的结果（读不到插件就传 null，插件那几个来源这轮跳过，不会把队列里的判成「撤了」） */
export function sync(model, hunt) {
  if (syncing) return syncing;
  syncing = Promise.resolve().then(() => syncNow(model, hunt)).catch((e) => { lastErr = e.message; throw e; }).finally(() => { syncing = null; });
  return syncing;
}

// 10/16 21:29 插件 storage 被清空（重装）：data	racker-freeze-plugin 存在时完全不读插件来源，库里插件来的条目保持原状，
// 不会因为插件队列 / done 里没了就判「不投了」。插件数据恢复好以后删掉这个文件
export const FREEZE_FILE = path.join(DATA, 'tracker-freeze-plugin');
function syncNow(model, hunt) {
  if (existsSync(FREEZE_FILE)) hunt = null;
  const d = open();
  const now = bj();
  const apps = new Map();                  // key → app（内存里合并完一次写回）
  const byAlt = new Map();                 // alt → [app]（同一岗位隔几天再投一次是两条）
  const addAlt = (alt, a) => { const l = byAlt.get(alt) || []; if (!l.includes(a)) l.push(a); byAlt.set(alt, l); };
  // 主键里带了脏岗位名的旧行（「9/24 手动打招呼」当成了岗位名）：删掉重建，这些行全是从来源算出来的
  for (const r of d.prepare("SELECT id FROM apps WHERE key LIKE '%手动打招呼%'").all()) {
    d.prepare('DELETE FROM events WHERE app_id=?').run(r.id); d.prepare('UPDATE tasks SET app_id=NULL WHERE app_id=?').run(r.id); d.prepare('DELETE FROM apps WHERE id=?').run(r.id);
  }
  for (const r of d.prepare('SELECT * FROM apps').all()) {
    const a = { ...JSON.parse(r.data), id: r.id, key: r.key, prevStage: r.stage, prevOutcome: r.outcome, obs: [] };
    a.title = cleanTitle(a.title);                                     // 「9/24 手动打招呼」这种是插件档案的备注，不是岗位名
    apps.set(a.key, a);
    addAlt(r.alt, a);
  }
  const near = (a, at) => !at || !(a.appliedAt || a.queuedAt) || Math.abs(Date.parse(at) - Date.parse(a.appliedAt || a.queuedAt)) <= 2 * 864e5;
  const hasPlugin = !!hunt?.ok;
  const queueSeen = new Set();

  const place = (o) => {
    const p = plat(o.platform);
    o.title = cleanTitle(o.title || '');
    const cn = coNorm(o.company), tn = titleNorm(o.title);
    if (!cn) return null;
    const jobId = o.jobId || idFromUrl(p.code, o.url);
    const idKey = jobId ? `${p.code}:${jobId}` : '';
    const alt = `${p.code}|${cn}|${tn}`;
    // 10/16 队长定：同一岗位（同一个岗位 ID）又投一次合成一条，保留最早的投递时间，时间线记一笔「又投了一次」，不算今天新投。
    // 没有岗位 ID 的才按时间分：隔 2 天以上的同公司同岗位算两条
    const sameId = idKey ? [...apps.values()].filter((x) => x.pid === p.code && x.jobId === jobId).sort((x, y) => ((x.appliedAt || '9') < (y.appliedAt || '9') ? -1 : 1)) : [];
    let fuzzy = [];
    if (!byAlt.has(alt) && tn) fuzzy = [...apps.values()].filter((x) => x.pid === p.code && x.titleNorm === tn && sameCo(x.coNorm, cn));   // 简称 / 全称（「本地美科制冷」≈「本地美科制冷技术有限公司」）
    const cands = [...new Set([...(idKey ? [...apps.values()].filter((x) => x.key === idKey || x.key.startsWith(idKey + '#')) : []), ...(byAlt.get(alt) || []), ...fuzzy])]
      .filter((x) => !idKey || !x.jobId || x.jobId === jobId);
    const dist = (x) => Math.abs(Date.parse(x.appliedAt || x.queuedAt || 0) - Date.parse(o.at || 0));
    let a = sameId[0] || (o.at ? cands.filter((x) => near(x, o.at)).sort((x, y) => dist(x) - dist(y))[0] : cands.sort((x, y) => ((y.appliedAt || '') > (x.appliedAt || '') ? 1 : -1))[0]);
    // 没岗位名的（盯梢会话、HR 主动、插件档案里的老记录）按公司挂：同一天的优先，否则最近一条
    if (!a && !tn) {
      const same = [...apps.values()].filter((x) => x.pid === p.code && sameCo(x.coNorm, cn));
      a = same.find((x) => o.at && (x.appliedAt || '').slice(0, 10) === o.at.slice(0, 10)) || same.sort((x, y) => (x.appliedAt < y.appliedAt ? 1 : -1))[0];
    }
    if (!a) {
      let key = idKey || alt;
      if (apps.has(key)) key = `${key}#${(o.at || now).slice(0, 10)}`;
      a = { key, pid: p.code, platform: p.label, jobId: '', pluginJobId: '', company: o.company, fullCompany: '', coNorm: cn, title: o.title || '', titleNorm: tn,
        city: '', salary: '', url: '', appliedAt: '', by: '', autoStage: '', manualStage: '', stageAt: {}, outcome: null, why: '', manualOutcome: '', convKey: null,
        sources: [], extra: {}, created: now, obs: [], isNew: true };
      apps.set(a.key, a);
    }
    addAlt(alt, a);
    a.obs.push(o);
    if (jobId && !a.jobId) a.jobId = jobId;
    if (o.pluginJobId) a.pluginJobId = o.pluginJobId;
    for (const k of ['city', 'salary', 'url', 'title']) if (!a[k] && o[k]) a[k] = k === 'title' ? cleanTitle(String(o[k])) : String(o[k]);
    const full = [o.fullCompany, o.company].filter(Boolean).sort((x, y) => y.length - x.length)[0];
    if (full && full.length > (a.fullCompany || a.company).length && sameCo(coNorm(full), a.coNorm)) a.fullCompany = full;   // 全称比简称好
    if (o.queue) a.queuedAt = o.at || a.queuedAt || '';
    else if (o.at && !PRE.has(o.stage) && (!a.appliedAt || o.at < a.appliedAt)) a.appliedAt = o.at;
    if (o.by && (!a.by || (a.by === 'hr' && o.by !== 'hr' && false))) a.by = o.by;
    if (!a.sources.includes(o.src)) a.sources.push(o.src);
    for (const [k, v] of Object.entries(o.extra || {})) if (v) a.extra[k] = v;
    return a;
  };
  // 顺序 = 「谁投的」的优先级：代投记录 > 插件 > 其余
  for (const o of [...fromLog(), ...fromNight(), ...fromPlugin(hunt), ...fromXlsx()]) { const a = place(o); if (a && o.queue) queueSeen.add(a.key); }

  // 同一个岗位 ID 被拆成了几条（以前的规则按「隔 2 天算新的」拆过，库里有 key 带 #日期 的）→ 并回一条，留最早投的那条的时间
  const drops = [];
  const byId = new Map();
  for (const a of apps.values()) if (a.jobId) { const k = `${a.pid}:${a.jobId}`; byId.set(k, [...(byId.get(k) || []), a]); }
  for (const [k, list] of byId) {
    if (list.length < 2) continue;
    list.sort((x, y) => (x.key === k ? -1 : y.key === k ? 1 : 0) || ((x.appliedAt || '9') < (y.appliedAt || '9') ? -1 : 1));
    const base = list[0];
    for (const o of list.slice(1)) {
      base.obs.push(...o.obs);
      for (const f of ['city', 'salary', 'url', 'pluginJobId', 'convKey']) if (!base[f] && o[f]) base[f] = o[f];
      if (o.appliedAt && (!base.appliedAt || o.appliedAt < base.appliedAt)) base.appliedAt = o.appliedAt;
      if (o.queuedAt && (!base.queuedAt || o.queuedAt > base.queuedAt)) base.queuedAt = o.queuedAt;
      if (!base.by || (base.by === 'plugin' && o.by && o.by !== 'plugin' && o.appliedAt === base.appliedAt)) base.by = o.by || base.by;
      for (const [sk, sv] of Object.entries(o.stageAt || {})) if (!base.stageAt[sk] || sv < base.stageAt[sk]) base.stageAt[sk] = sv;
      for (const src of o.sources) if (!base.sources.includes(src)) base.sources.push(src);
      base.extra = { ...o.extra, ...base.extra };
      if (o.manualStage && !base.manualStage) base.manualStage = o.manualStage;
      if (o.manualOutcome && !base.manualOutcome) base.manualOutcome = o.manualOutcome;
      if (o.conv && !base.conv) base.conv = o.conv;
      if (queueSeen.has(o.key)) queueSeen.add(base.key);
      apps.delete(o.key);
      if (o.id) drops.push([o.id, base]);
    }
    // 「谁投的」= 最早那次是谁投的
    const firstObs = base.obs.filter((x) => x.at && x.by && !PRE.has(x.stage)).sort((x, y) => (x.at < y.at ? -1 : 1))[0];
    if (firstObs) base.by = firstObs.by;
  }

  // 盯梢会话 → 挂到投递上（同平台 + 公司对得上，优先岗位名对得上、再取最近一条）；对不上、但我们跟 HR 说过话的，自己算一条投递
  for (const c of model?.convs || []) {
    const p = plat(c.platform);
    const cn = coNorm(c.company);
    if (!cn) continue;
    const tn = titleNorm(c.title);
    let a = [...apps.values()].filter((x) => x.pid === p.code && sameCo(x.coNorm, cn))
      .sort((x, y) => (tn ? (y.titleNorm === tn) - (x.titleNorm === tn) : 0) || (x.appliedAt < y.appliedAt ? 1 : -1))[0];
    const ev = stageFromConv(c, !!a);
    if (!a && !ev) continue;                                           // HR 主动找来、用户还没回：不算投递
    const outreach = (c.events || []).some((e) => e.outreach);
    if (!a) a = place({ src: 'conv', platform: c.platform, company: c.company, title: c.title, at: (c.events?.[0]?.at || c.lastAt || '').slice(0, 19), by: outreach ? 'hr' : '' });
    if (!a) continue;
    if (!a.sources.includes('conv')) a.sources.push('conv');
    a.convKey = c.key;
    a.conv = c;
    if (ev) a.obs.push({ src: 'conv', ...ev, stageAt: ev.at });
  }

  // 阶段 = 所有证据里最靠后的；每个阶段记首次到达时间（offerPilot）
  for (const a of apps.values()) {
    let best = a.obs.length ? '' : a.autoStage;
    let outcome = null, why = '';
    for (const o of a.obs) {
      if (!o.stage) continue;
      if (!best || RANK[o.stage] > RANK[best] || (PRE.has(best) && o.queue)) best = o.stage;     // 队列里的状态以插件最新为准（发送中 → 没投成）
      if (o.stageAt && (!a.stageAt[o.stage] || o.stageAt < a.stageAt[o.stage])) a.stageAt[o.stage] = o.stageAt;
      if (o.outcome && !outcome) { outcome = o.outcome; why = o.why || ''; }
    }
    // 插件队列里的：从队列里拿掉、又没投出去（不在 done 里）= 不投了
    if (hasPlugin && PRE.has(best || a.autoStage) && !queueSeen.has(a.key) && a.sources.some((x) => /-queue$/.test(x))) { outcome = 'withdrawn'; why = '从插件队列里拿掉了，没投'; }
    if (best) a.autoStage = best;
    if (!a.autoStage) a.autoStage = 'applied';
    if (!a.stageAt[a.autoStage]) a.stageAt[a.autoStage] = a.appliedAt || now;
    // 用户手动改的阶段优先；自动证据比手动的更靠后了（比如他标了「已投」、后来 HR 约面）就跟着自动走
    if (a.manualStage && a.manualStage !== 'closed' && RANK[a.autoStage] > RANK[a.manualStage]) a.manualStage = '';
    a.stage = a.manualStage || a.autoStage;
    const block = blockedHit(a.company) || blockedHit(a.fullCompany);
    if (a.manualOutcome) a.outcome = a.manualOutcome;
    else if (block) { a.outcome = 'declined'; a.why = `雷岗黑名单（data\\blocked.txt：${block}）`; }
    else if (outcome) { a.outcome = outcome; a.why = why; }
    else { a.outcome = null; a.why = ''; const o = autoOutcome(a, now); if (o) { a.outcome = o.outcome; a.why = o.why; } }
  }

  // 写回 + 事件
  const upApp = d.prepare(`INSERT INTO apps (key, alt, platform, co_norm, stage, outcome, applied_at, updated_at, data) VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET alt=excluded.alt, platform=excluded.platform, co_norm=excluded.co_norm, stage=excluded.stage, outcome=excluded.outcome,
    applied_at=excluded.applied_at, updated_at=excluded.updated_at, data=excluded.data`);
  const getId = d.prepare('SELECT id FROM apps WHERE key=?');
  const addEv = d.prepare('INSERT OR IGNORE INTO events (app_id, at, type, from_s, to_s, who, source, text) VALUES (?,?,?,?,?,?,?,?)');
  d.exec('BEGIN');
  try {
    for (const a of apps.values()) {
      const { obs, conv, isNew, prevStage, prevOutcome, id, ...keep } = a;
      const shown = a.outcome ? 'closed' : a.stage;
      upApp.run(a.key, `${a.pid}|${a.coNorm}|${a.titleNorm}`, a.pid, a.coNorm, shown, a.outcome || '', a.appliedAt || '', now, JSON.stringify(keep));
      const aid = id || getId.get(a.key).id;
      a.id = aid;
      if (isNew) {
        const first = PRE.has(a.autoStage) ? '排进插件发送队列' : { plugin: '插件投出', claude: '助手 代投', me: '你投的', hr: 'HR 主动找来，你回了' }[a.by] || '投了';
        addEv.run(aid, a.appliedAt || a.queuedAt || now, PRE.has(a.autoStage) ? 'queued' : 'applied', '', PRE.has(a.autoStage) ? 'queued' : 'applied', a.by || '', a.sources[0] || '', first);
      }
      if (!isNew && prevStage && prevStage !== shown) {
        const at = a.stageAt[a.stage] && a.stageAt[a.stage] > (a.appliedAt || '') && a.stageAt[a.stage] <= now ? a.stageAt[a.stage] : now;
        addEv.run(aid, at, 'stage', prevStage, shown, '', 'auto', a.outcome ? `${OUTCOME_NAME[a.outcome] || a.outcome}：${a.why}` : `${STAGE_NAME[prevStage] || prevStage} → ${STAGE_NAME[shown]}`);
      }
      // 同一岗位又投了一次（插件去重漏了 / 没投成再投）：时间线记一笔
      for (const o of obs) {
        if (!['plugin-done', 'log', 'night'].includes(o.src) || !o.at || !a.appliedAt || Math.abs(Date.parse(o.at) - Date.parse(a.appliedAt)) <= 2 * 864e5) continue;
        addEv.run(aid, o.at, 'reapply', '', '', o.by || '', o.src, o.src === 'plugin-done' ? '插件又投了一次（去重漏了）' : '同一岗位又投了一次');
      }
      if (conv) {
        for (const e of conv.events || []) {
          const t = { reply: e.sent === false ? `想回没发出去：${e.reply || ''}` : `盯梢自动回了：${e.reply || ''}`, send_resume: `盯梢发了简历${e.resume ? '（' + e.resume + '）' : ''}`,
            escalate: `推给你：${e.tell || e.why || e.kind || ''}`, claude: e.tell }[e.action];
          if (e.hr) addEv.run(aid, e.at, 'hr', '', '', 'hr', 'conv', `HR：${String(e.hr).split(' / ').pop()}`.slice(0, 240));
          if (t) addEv.run(aid, e.at, 'msg', '', '', e.action === 'claude' ? 'claude' : 'watch', 'conv', t.slice(0, 240));
        }
      }
    }
    // 被并掉的旧行：事件、待办挪到留下的那条，再删掉
    for (const [oldId, base] of drops) {
      d.prepare('UPDATE OR IGNORE events SET app_id=? WHERE app_id=?').run(base.id, oldId);
      d.prepare('DELETE FROM events WHERE app_id=?').run(oldId);
      d.prepare('UPDATE tasks SET app_id=? WHERE app_id=?').run(base.id, oldId);
      d.prepare('DELETE FROM apps WHERE id=?').run(oldId);
      // 「投了」只留最早那条，后来那次由上面的「又投了一次」说
      d.prepare("DELETE FROM events WHERE app_id=? AND type='applied' AND at > (SELECT MIN(at) FROM events WHERE app_id=? AND type='applied')").run(base.id, base.id);
    }
    d.exec('COMMIT');
  } catch (e) { d.exec('ROLLBACK'); throw e; }

  // 待办
  const list = [...apps.values()].map((a) => ({ ...a, stage: a.outcome ? 'closed' : a.stage }));
  const tasks = computeTasks({ apps: list, convs: model?.convs || [], hunt: hasPlugin ? hunt : null, now });
  const keyToId = new Map(list.map((a) => [a.key, a.id]));
  const old = new Map(d.prepare('SELECT * FROM tasks').all().map((t) => [t.rkey, t]));
  const upTask = d.prepare(`INSERT INTO tasks (rkey, app_id, type, grp, text, detail, due, status, until, sig, created_at, done_at, data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(rkey) DO UPDATE SET app_id=excluded.app_id, type=excluded.type, grp=excluded.grp, text=excluded.text, detail=excluded.detail, due=excluded.due,
    status=excluded.status, until=excluded.until, sig=excluded.sig, done_at=excluded.done_at, data=excluded.data`);
  const gone = d.prepare("UPDATE tasks SET status='gone', done_at=? WHERE rkey=?");
  const live = new Set();
  d.exec('BEGIN');
  try {
    for (const t of tasks) {
      live.add(t.rkey);
      const o = old.get(t.rkey);
      let status = o?.status || 'todo', until = o?.until || '', doneAt = o?.done_at || '';
      // 做完以后内容又变了（HR 又说了新话、又多了待审）→ 重新弹出来；自动消失的条件又成立了也回来；「稍后」到点回来（读的时候算）
      if (o && status === 'done' && o.sig !== t.sig) { status = 'todo'; doneAt = ''; }
      if (status === 'gone') { status = 'todo'; doneAt = ''; }
      const data = { convKey: t.convKey || null, platform: t.platform || '', company: t.company || '', title: t.title || '', action: t.action, href: t.href || '', count: t.count || 0, fold: !!t.fold };
      upTask.run(t.rkey, keyToId.get(t.appKey) || null, t.type, t.group, t.text, t.detail || '', t.due, status, until, t.sig || '', o?.created_at || now, doneAt, JSON.stringify(data));
    }
    // 条件不成立了（HR 在别处回过、用户在收件箱标了已处理、插件里投了）→ 自动消失
    for (const [rkey, o] of old) if (!live.has(rkey) && (o.status === 'todo' || o.status === 'later')) gone.run(now, rkey);
    d.exec('COMMIT');
  } catch (e) { d.exec('ROLLBACK'); throw e; }
  lastSync = now; lastErr = '';
  return { apps: apps.size, tasks: tasks.length };
}

// ---------- 给页面读（形状照 api-contract.md）----------
const shortTime = (s) => (s ? `${+s.slice(5, 7)}/${+s.slice(8, 10)} ${s.slice(11, 16)}` : '');
function liveTasks() {
  const now = bj();
  return open().prepare("SELECT * FROM tasks WHERE status IN ('todo','later') ORDER BY due").all()
    .filter((t) => t.status === 'todo' || (t.until && t.until <= now))
    .map((t) => ({ ...t, data: JSON.parse(t.data || '{}') }));
}
function shapeApp(r, lastEv, task) {
  const a = JSON.parse(r.data);
  const nextText = task ? task.text
    : r.outcome ? `${OUTCOME_NAME[r.outcome] || r.outcome}${a.why ? '：' + a.why : ''}`
    : { queued: '排队等插件发', sending: '插件正在发', failed: '去平台确认投没投出去', applied: '等 HR 看', viewed: '等 HR 回', replied: '去消息看 HR 说了什么', interview: '面试你自己接', offer: '你定去不去' }[r.stage] || '';
  return {
    id: r.id, key: r.key, platform: a.platform, pid: a.pid, company: a.company, fullCompany: a.fullCompany || a.company, title: a.title, city: a.city || '', salary: a.salary || '',
    url: a.url || '', appliedAt: PRE.has(r.stage) ? null : a.appliedAt || null, by: a.by || null, stage: r.stage, outcome: r.outcome || null,
    stageAt: a.stageAt?.[r.outcome ? a.stage : r.stage] || a.appliedAt || null,
    lastEvent: lastEv ? `${shortTime(lastEv.at)} ${lastEv.text}`.trim() : '',
    next: { text: nextText, due: task ? task.due.slice(0, 10) : null },
    convKey: a.convKey || null, jobId: a.pluginJobId || null, bg: a.extra?.bg || '',
    // 出错能看懂、能恢复（设计原则 ⑨）：没投成的给人话原因 + 一个能点的修法
    problem: r.stage === 'failed' && !r.outcome ? { text: a.extra?.error || '插件没投成，原因没记下来', fix: { label: '去平台确认', href: a.url || '' }, alt: a.pluginJobId ? { label: '再投一次', api: '/api/hunt/approve', jobId: a.pluginJobId } : null } : null,
    // 下面几个契约外、抽屉里用得上
    queuedAt: a.queuedAt || null, why: a.why || '', sources: a.sources || [], extra: a.extra || {}, manualStage: a.manualStage || null,
  };
}
const VIEWS = {
  active: (x) => !x.outcome && x.stage !== 'closed',
  today: (x, day) => (x.appliedAt || x.queuedAt || '').startsWith(day),
  replied: (x) => !x.outcome && RANK[x.stage] >= RANK.replied && x.stage !== 'closed',
  interview: (x) => !x.outcome && (x.stage === 'interview' || x.stage === 'offer'),
  closed: (x) => !!x.outcome || x.stage === 'closed',
  all: () => true,
};
export function listApps({ view = 'active', platform = '', by = '', stage = '', q = '' } = {}) {
  const d = open();
  const day = bj().slice(0, 10);
  const last = new Map();
  for (const e of d.prepare("SELECT app_id, at, text FROM events WHERE type != 'hr' ORDER BY at, id").all()) last.set(e.app_id, e);
  const tasks = new Map();
  for (const t of liveTasks()) if (t.app_id && !tasks.has(t.app_id)) tasks.set(t.app_id, t);
  const all = d.prepare('SELECT * FROM apps').all().map((r) => shapeApp(r, last.get(r.id), tasks.get(r.id)));
  all.sort((x, y) => ((y.appliedAt || y.queuedAt || '') > (x.appliedAt || x.queuedAt || '') ? 1 : -1));
  const counts = Object.fromEntries(Object.entries(VIEWS).map(([k, f]) => [k, all.filter((x) => f(x, day)).length]));
  const set = (s) => new Set(String(s).split(',').filter(Boolean));
  const P = set(platform), B = set(by), S = set(stage);
  const words = String(q).trim().toLowerCase().split(/\s+/).filter(Boolean);
  const items = all.filter((x) => (VIEWS[view] || VIEWS.active)(x, day) && (!P.size || P.has(x.pid)) && (!B.size || B.has(x.by || '')) && (!S.size || S.has(x.stage))
    && words.every((w) => `${x.company} ${x.fullCompany} ${x.title} ${x.platform} ${x.city}`.toLowerCase().includes(w)));
  return { now: bj(), counts, items, sync: syncInfo() };
}
export function appDetail(id) {
  const d = open();
  const r = d.prepare('SELECT * FROM apps WHERE id=?').get(id);
  if (!r) return null;
  const events = d.prepare('SELECT at, type, from_s "from", to_s "to", who "by", source, text FROM events WHERE app_id=? ORDER BY at, id').all(id);
  const task = liveTasks().find((t) => t.app_id === id);
  return { ...shapeApp(r, [...events].reverse().find((e) => e.type !== 'hr'), task), events,
    tasks: d.prepare('SELECT id, type, text, detail, due, status, until FROM tasks WHERE app_id=? ORDER BY due').all(id) };
}

/** 今天页：你接 → 要回 → 逾期 → 今天；没到期的不显示；空组不返回 + 一行今日战报 */
export function today(model) {
  const now = bj(), day = now.slice(0, 10);
  const groups = { you: [], reply: [], overdue: [], today: [] };
  for (const t of liveTasks()) {
    const due = t.due.slice(0, 10);
    const D = t.data;
    const href = D.action === 'conv' && D.convKey ? `/?c=${encodeURIComponent(D.convKey)}` : D.action === 'hunt' ? '/hunt' : D.action === 'hunt-campus' ? '/hunt?src=campus' : D.action === 'url' ? D.href || '' : t.app_id ? `/apps?id=${t.app_id}` : '';
    const label = { conv: t.grp === 'reply' ? '回复' : '去消息', hunt: '去找岗位', 'hunt-campus': '去看网申', url: '去平台' }[D.action] || '看看';
    const item = { id: t.id, trackerId: t.app_id || null, type: t.type, title: D.company ? `${D.company} · ${t.text}` : t.text, detail: t.detail, platform: D.platform || '',
      due, overdue: due < day, overdueDays: due < day ? Math.round((Date.parse(day) - Date.parse(due)) / 864e5) : 0, convKey: D.convKey || null,
      action: href ? { label, href } : null, jobTitle: D.title || '', folded: !!D.fold };
    if (t.grp === 'you') groups.you.push(item);
    else if (t.grp === 'reply') groups.reply.push(item);
    else if (due < day) groups.overdue.push(item);
    else if (due === day) groups.today.push(item);
  }
  groups.overdue.sort((x, y) => x.folded - y.folded);               // 折叠的（放久了的约面）沉到逾期组底部
  const NAMES = { you: '你接', reply: '要回', overdue: '逾期', today: '今天' };
  const d = open();
  const applied = d.prepare("SELECT data FROM apps WHERE substr(applied_at,1,10)=? AND stage NOT IN ('queued','sending','failed')").all(day).map((r) => JSON.parse(r.data));
  const s = model?.stats || {};
  const st = model?.status || {};
  const shown = Object.entries(groups).filter(([, v]) => v.length).map(([id, items]) => ({ id, name: NAMES[id], items }));
  return {
    date: day,
    // 角标 = 今天页「还剩 N 件」：四组加起来（今天页只会再减掉用户刚点了完成 / 稍后、还在 5 秒撤销里的那几条）
    count: shown.reduce((n, g) => n + g.items.length, 0),
    groups: shown,
    report: { applied: applied.length, byMe: applied.filter((a) => a.by === 'me' || a.by === 'plugin').length, byClaude: applied.filter((a) => a.by === 'claude').length,
      hrNew: s.hr || 0, autoReplied: s.auto || 0, pushed: s.escalate || 0,
      tasksDone: d.prepare("SELECT COUNT(*) n FROM tasks WHERE status='done' AND substr(done_at,1,10)=?").get(day).n },
    watch: watchInfo(st),
    sync: syncInfo(),
  };
}

/** 盯梢状态条：几个平台、各自实时还是定时、下一轮几点；坏了给人话原因 + 修法 */
export function watchInfo(st = {}) {
  const P = [['boss', 'BOSS', 'p_boss', 'live_boss'], ['zl', '智联', 'p_zl', 'live_zl'], ['51', '51job', 'p_51'], ['lp', '猎聘', 'p_lp', 'live_lp']];
  const fixOf = (name, note = '') => (/登录|扫码/.test(note) ? `在 HR Desk「更多 › ${name}」里扫码重新登录` : /验证|滑块/.test(note) ? `在 HR Desk「更多 › ${name}」里过一下验证`
    : `看看 HR Desk「更多 › ${name}」页面还开着没有；不行就重启 HR Desk`);
  const platforms = P.filter(([, , k]) => st[k]).map(([id, name, k, lk]) => {
    const ok = !!st[k].ok;
    const live = !!(lk && st[lk]?.ok && /实时/.test(st[lk].note || ''));
    const note = (ok && live ? '实时' : st[k].note) || '';
    return { id, name, ok, live, note, at: st[k].at || '', fix: ok ? null : fixOf(name, note) };
  });
  return { alive: !!st.alive, paused: !!st.paused, next: st.next || '', doing: st.doing || '', lastDone: st.lastDone || '', platforms,
    fix: !st.alive ? '盯梢没在跑：点状态条上的「开盯梢」，或双击桌面「HR盯梢」' : st.paused ? '盯梢暂停着（data\pause 文件），点「继续」' : null };
}

/** 待办：done 完成 / snooze 稍后（默认明早 9 点）/ open 撤销。返回改了的那几条（inbox 拿 convKey 顺手把会话也标掉） */
export function setTask(id, status, until) {
  const d = open(), now = bj();
  const next9 = `${new Date(Date.now() + 8 * 3600e3 + 864e5).toISOString().slice(0, 10)}T09:00:00`;
  const t = d.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  if (!t) return null;
  const st = d.prepare('UPDATE tasks SET status=?, until=?, done_at=? WHERE id=?');
  if (status === 'done') st.run('done', '', now, id);
  else if (status === 'snooze') st.run('later', until ? String(until).slice(0, 19) : next9, '', id);
  else st.run('todo', '', '', id);
  if (t.app_id && status === 'done') d.prepare('INSERT OR IGNORE INTO events (app_id, at, type, from_s, to_s, who, source, text) VALUES (?,?,?,?,?,?,?,?)').run(t.app_id, now, 'task', '', '', 'me', 'manual', `办完了：${t.text}`);
  return { ...t, data: JSON.parse(t.data || '{}') };
}

/** 用户手动改阶段 / 结局（stage 为空 = 交回自动；outcome 传 null = 撤销结局） */
export function setStage(id, stage, outcome) {
  const d = open(), now = bj();
  const r = d.prepare('SELECT * FROM apps WHERE id=?').get(id);
  if (!r) return null;
  if (stage && !(stage in RANK)) throw new Error(`没有这个阶段：${stage}`);
  if (outcome && !(outcome in OUTCOME_NAME)) throw new Error(`没有这个结局：${outcome}`);
  const a = JSON.parse(r.data);
  if (stage !== undefined) a.manualStage = stage === 'closed' && !outcome ? 'closed' : stage || '';
  if (outcome !== undefined) a.manualOutcome = outcome || '';
  a.stage = a.manualStage || a.autoStage;
  if (a.manualOutcome) a.outcome = a.manualOutcome;
  else if (outcome !== undefined || stage) { a.outcome = null; a.why = ''; }
  const shown = a.outcome ? 'closed' : a.stage;
  d.prepare('UPDATE apps SET stage=?, outcome=?, updated_at=?, data=? WHERE id=?').run(shown, a.outcome || '', now, JSON.stringify(a), id);
  d.prepare('INSERT OR IGNORE INTO events (app_id, at, type, from_s, to_s, who, source, text) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, now, 'stage', r.stage, shown, 'me', 'manual', a.outcome ? `你标了：${OUTCOME_NAME[a.outcome]}` : `你改成：${STAGE_NAME[shown]}`);
  return { ok: true };
}
