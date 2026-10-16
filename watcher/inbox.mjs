// HR 收件箱（10/16 大升级）：把盯梢读到的 BOSS / 智联 / 51job 消息、它怎么判断的、回了什么，汇成一个网页；用户也能在这里手动回
// 用户 10/16：「你怎么回复的、有什么消息，都是你在干，我一点进度和内容都不知道」
// 界面照 Folo（github.com/RSSNext/Folo）的三栏；会话状态 / AI 起草人来发 / 快捷键照 Chatwoot；「HR 多久没回、该跟进」照 hi-job
// 用法：node inbox.mjs        打开 http://127.0.0.1:8790
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, watch, statSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { HERE, DATA, STORE, log, lock, unlock, lockHolder, saveConv, recordSent, sleep } from './lib.mjs';
import * as boss from './boss.mjs';
import * as zl from './zhaopin.mjs';
import * as lp from './liepin.mjs';
import { draft } from './draft.mjs';
import { findApplied, pickVariant } from './brain.mjs';
import { cfg, variants, missing, configError } from './config.mjs';
import { status as pluginStatus } from './plugin-host.mjs';
import * as hunt from './hunt.mjs';
import * as tracker from './tracker.mjs';
const VARIANTS = { find: (f) => variants().find(f), map: (f) => variants().map(f) };

const PORT = cfg().ports.inbox;
const UI = path.join(HERE, 'ui');
const LABEL = { boss: 'BOSS', zl: '智联', 51: '51job' };
const PID = { BOSS: 'boss', 智联: 'zl', '51job': '51', 猎聘: 'lp' };
const MOD = { boss: { mod: boss, open: boss.openBoss }, zl: { mod: zl, open: zl.openZhaopin }, lp: { mod: lp, open: lp.openLiepin } };
const F = (n) => path.join(DATA, n);
const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const readLines = (f) => { try { return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const bjNow = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19);
const keyOf = (pid, o) => (pid === '51' ? `51|${o.company}|${o.title}` : `${pid}|${o.name}|${o.company}|${o.title}`);

// 列表上的时间：「14:14」「昨天」「昨天 18:04」「星期二」「10月14日」「10-14」→ 2026-10-14T14:14:00 这种，排序用
// 10/16 修：以前按「今天」算。盯梢晚上 10 点收工，第二天早上第一轮之前，列表快照里昨天的「14:14」会被当成今天的 14:14，
// BOSS 登录掉了没人重读列表时更是一直错。现在按快照自己那天（ref = list-*.json 的 at）来算
function listTime(s = '', ref = bjNow()) {
  const day = ref.slice(0, 10);
  const back = (n) => new Date(Date.parse(`${day}T00:00:00Z`) - n * 864e5).toISOString().slice(0, 10);
  const hm = s.match(/(\d{1,2}):(\d{2})\s*$/);
  const t = hm ? `T${hm[1].padStart(2, '0')}:${hm[2]}:00` : 'T12:00:00';
  let m;
  if (/^\s*\d{1,2}:\d{2}\s*$/.test(s)) return day + t;
  if (/昨天/.test(s)) return back(1) + t;
  if (/前天/.test(s)) return back(2) + t;
  if ((m = s.match(/(?:星期|周)([一二三四五六日天])/))) {
    const w = '日一二三四五六'.indexOf(m[1] === '天' ? '日' : m[1]);
    const cur = new Date(`${day}T00:00:00Z`).getUTCDay();
    return back((cur - w + 7) % 7 || 7) + t;                  // 同一个星期几只会是上周那天（今天的只显示时间）
  }
  if ((m = s.match(/(?:(\d{4})[年/-])?(\d{1,2})[月/-](\d{1,2})/))) {
    const y = m[1] || day.slice(0, 4);
    let d = `${y}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    if (!m[1] && d > day) d = `${+y - 1}${d.slice(4)}`;       // 1 月看到「12月30日」是去年的
    return d + t;
  }
  return '';
}

// 平台在消息前面加的时间标签（「15:58 」「星期六 15:58 」「09-28 09:06 」），同一句话隔天再读标签会变，比较时去掉
const TIME_TAG = /^(?:(?:昨天|前天|星期[一二三四五六日天]|周[一二三四五六日天]|\d{1,2}月\d{1,2}日|\d{4}-\d{1,2}-\d{1,2}|\d{1,2}-\d{1,2})\s*)?\d{1,2}:\d{2}\s+/;
const norm = (t = '') => String(t).split(' / ').map((s) => s.trim().replace(TIME_TAG, '')).join(' / ');
// 盯梢日志里有的句子自带表情（「⚠️ BOSS 登录掉了」），界面上不出表情，图标由前端按 icon 名画
const noEmoji = (s = '') => String(s).replace(/^[\p{Extended_Pictographic}️‍\s]+/u, '');

// icon 是前端图标名（ui\index.html 里的 #i-xxx），tone 决定颜色：bad 红 / warn 黄 / ok 绿 / 空 = 灰
function humanize(o) {
  if (o.manual === true) return { at: o.at, icon: 'hand', tone: o.sent ? 'ok' : 'bad', text: `你在收件箱回了 ${o.company || o.name}：${o.sent ? '「' + noEmoji(o.text) + '」' : '没发出去（' + (o.err || '') + '）'}`, key: o.key };
  if (typeof o.manual === 'string') {                         // 别的 助手 会话手动补回时记的一笔（没有原文）
    const pid = PID[o.platform];
    return { at: o.at, icon: 'bot', text: `${o.platform} · ${o.company || o.name}：助手 ${o.manual}`, key: pid ? keyOf(pid, o) : '' };
  }
  if (o.round !== undefined) return { at: o.at, icon: 'refresh', round: true, events: o.events || 0, text: `第 ${o.round} 轮扫完${o.events ? `，处理了 ${o.events} 条` : '，没有新消息'}${o.deferred ? `；你在桌面 2，BOSS 有 ${o.deferred} 条等你切走` : ''}` };
  if (o.skip) return { at: o.at, icon: 'pause', text: noEmoji(o.skip) };
  if (o.notice) return { at: o.at, icon: 'alert', tone: 'warn', text: noEmoji(o.notice) };
  if (o.err && !o.name && !o.company) return { at: o.at, icon: 'alert', tone: 'warn', text: `${o.platform || ''} ${o.err}`.trim() };
  if (!o.platform) return null;
  const who = `${o.platform} · ${o.company || o.name}`;
  const pid = PID[o.platform];
  const key = o.key || (pid ? keyOf(pid, o) : '');
  if (o.err && !o.action) return { at: o.at, icon: 'alert', tone: 'warn', text: `${who}：${o.err}`, key };
  const t = {
    reply: o.sent === false ? ['alert', 'bad', `想回 ${who} 但没发出去${o.err ? '：' + o.err : ''}`] : ['bot', 'acc', `自动回了 ${who}`],
    send_resume: ['file', 'acc', `给 ${who} 发了简历${o.resume ? '（' + o.resume + '）' : ''}`],
    escalate: ['alert', 'bad', `${who} 推给你了：${o.why || o.tell || o.kind || ''}${o.err ? `（本来要发的没发出去：${o.err}）` : ''}`],
    ignore: ['mute', '', `${who} 没回：${o.tell || o.kind || ''}`],
  }[o.action];
  return t ? { at: o.at, icon: t[0], tone: t[1], text: t[2], key } : null;
}

function buildModel() {
  const convs = new Map();
  const get = (key, meta) => {
    let c = convs.get(key);
    if (!c) { c = { key, ...meta, events: [], sends: [], msgs: null }; convs.set(key, c); }
    for (const k of ['company', 'title', 'name']) if (!c[k] && meta[k]) c[k] = meta[k];
    return c;
  };
  const activity = [];
  for (const o of readLines(F('log.jsonl'))) {
    const h = humanize(o);
    if (h) activity.push(h);
    if (o.manual === true) continue;
    const pid = PID[o.platform];
    if (typeof o.manual === 'string' && pid) {
      const pref = `${pid}|${o.name}|${o.company}|`;            // 这种记录常常没带岗位，挂到同一 HR 同一公司的会话上
      get([...convs.keys()].reverse().find((k) => k.startsWith(pref)) || keyOf(pid, o), { pid, platform: o.platform, name: o.name || '', company: o.company || '', title: o.title || '' }).events.push({ at: o.at, action: 'claude', tell: `助手 ${o.manual}` });
      continue;
    }
    if (!pid || !(o.name || o.company) || !(o.action || o.err)) continue;
    const key = o.key || keyOf(pid, o);
    get(key, { pid, platform: o.platform, name: o.name || '', company: o.company || '', title: o.title || '' }).events.push({
      at: o.at, kind: o.kind, action: o.action, tell: o.tell, why: o.why, reply: o.reply, sent: o.sent, resume: o.resume, err: o.err,
      hr: o.hrFresh || o.hr, worth: o.worth, outreach: o.outreach, goodUnit: o.goodUnit, unitWhy: o.unitWhy, askInterview: o.askInterview,
    });
  }
  for (const pid of ['boss', 'zl']) {
    const L = readJson(F(`list-${pid}.json`), null);
    if (!L) continue;
    for (const it of L.items || []) {
      if (!it.name) continue;
      const c = get(keyOf(pid, it), { pid, platform: LABEL[pid], name: it.name, company: it.company, title: it.title });
      c.list = { last: it.last, time: it.time, unread: it.unread, fromMe: it.fromMe, at: listTime(it.time, L.at || bjNow()), snapAt: L.at || '' };
    }
  }
  for (const f of readdirSync(STORE)) {
    const s = readJson(path.join(STORE, f), null);
    if (!s?.key) continue;
    const c = get(s.key, { pid: s.pid, platform: s.platform, name: s.name, company: s.company, title: s.title });
    c.msgs = s.msgs; c.snapAt = s.at; c.job = s.job; c.cards = s.cards || null;
  }
  for (const s of readLines(F('sent.jsonl'))) { const c = convs.get(s.key); if (c) c.sends.push(s); }
  const user = readJson(F('inbox-state.json'), {});
  const mine = new Set(readJson(F('manual-only.json'), []));
  const now = bjNow();

  const out = [];
  for (const c of convs.values()) {
    const ev = c.events;
    const lastEv = ev[ev.length - 1];
    const lastManual = c.sends.filter((s) => s.by === 'manual').pop();
    const u = user[c.key] || {};
    // 标过「已处理 / 稍后」以后，只有 HR 真说了新话才翻出来。盯梢把同一句再判一遍（智联消息前的时间标签隔天会变，
    // 列表上的「最后一句」跟着变，盯梢当成新消息）不算，不然用户刚清掉的又冒回「要你处理」
    const hrAtMark = u.at ? norm(ev.filter((e) => e.hr && e.at <= u.at).pop()?.hr || '') : '';
    const newerHr = !!u.at && ev.some((e) => e.hr && e.at > u.at && norm(e.hr) !== hrAtMark);
    // 聊天记录：有快照就用快照（最准）；没有就拿盯梢日志拼（10/16 之前的老会话只有日志）
    let thread;
    if (c.msgs) {
      // 快照只有最近 14 条；我们发的话靠原文对上是谁发的
      const autoTexts = new Set([...ev.filter((e) => e.sent !== false && e.reply).map((e) => e.reply), ...c.sends.filter((s) => s.by === 'auto').map((s) => s.text)]);
      const manTexts = new Set(c.sends.filter((s) => s.by === 'manual').map((s) => s.text));
      const claudeTexts = new Set(c.sends.filter((s) => s.by === 'claude').map((s) => s.text));   // 别的 助手 会话手动代回时记的
      thread = c.msgs.map((m) => ({ me: m.me, text: m.text, by: m.me ? (m.by || (manTexts.has(m.text) ? 'manual' : autoTexts.has(m.text) ? 'auto' : claudeTexts.has(m.text) ? 'claude' : 'me')) : 'hr' }));
    } else {
      thread = [];
      const items = [...ev.map((e) => ({ at: e.at, e })), ...c.sends.map((s) => ({ at: s.at, s }))].sort((a, b) => (a.at < b.at ? -1 : 1));
      for (const x of items) {
        if (x.s) { thread.push({ me: true, text: x.s.text, by: x.s.by, at: x.at }); continue; }
        for (const t of String(x.e.hr || '').split(' / ').map((s) => s.trim()).filter(Boolean)) {
          // 同一句 HR 的话每次判断都会带上（hrFresh 是「我们上次说完以后 HR 说的全部」），去重时忽略前面的时间标签，
          // 不然「15:58 签到成功」和「星期六 15:58 签到成功」会出现两遍
          if (thread.some((m) => !m.me && norm(m.text) === norm(t))) continue;
          thread.push({ me: false, text: t, by: 'hr', at: x.at });
        }
        if (x.e.reply && x.e.sent && !c.sends.some((s) => s.text === x.e.reply)) thread.push({ me: true, text: x.e.reply, by: 'auto', at: x.at });
      }
      // 盯梢从没点开过的会话（比如插件发了开场白、HR 还没回）：至少把列表上看到的最后一句放上，不然右边一片空白
      if (!thread.length && c.list?.last) {
        thread.push({ me: !!c.list.fromMe, text: c.list.last.replace(/^\[(送达|已读|未读|新招呼|索要简历)\]\s*/, ''), by: c.list.fromMe ? 'me' : 'hr', at: c.list.at, fromList: true });
      }
    }
    const lastThread = thread[thread.length - 1];
    const waiting = c.list ? c.list.fromMe : !!lastThread?.me;
    const lastAt = [lastEv?.at, c.sends[c.sends.length - 1]?.at, c.list?.at].filter(Boolean).sort().pop() || '';
    // 推给用户以后，消息列表（比推送更晚读的那份）显示最后一句已经是我们说的 = 他在手机 / 平台上自己回过了，不再挂「要你处理」
    const repliedElsewhere = lastEv?.action === 'escalate' && !!c.list?.fromMe && !!c.list.snapAt && c.list.snapAt > lastEv.at;
    const needs = lastEv?.action === 'escalate' && !(lastManual && lastManual.at > lastEv.at) && !repliedElsewhere;
    const look = lastEv?.outreach && lastEv?.worth === '值得看' && lastEv?.action === 'ignore';
    let status;
    if (u.pass) status = 'pass';
    else if (u.status === 'done' && !newerHr) status = 'done';
    else if (u.status === 'snooze' && u.until > now && !newerHr) status = 'snoozed';
    else if (needs) status = 'need';
    else if (look) status = 'look';
    else if (waiting) status = 'waiting';
    else if (lastEv?.action === 'ignore') status = 'quiet';
    else status = 'other';
    const goodUnit = [...ev].reverse().find((e) => e.goodUnit)?.goodUnit || '';
    out.push({
      // BOSS 列表上的「title」其实是 HR 的职位（HR / 招聘者），真岗位名要点开会话才有（c.job）
      key: c.key, pid: c.pid, platform: c.platform, name: c.name, company: c.company, title: (c.job || (c.pid === 'boss' ? '' : c.title) || '').replace(/\s*查看职位\s*$/, ''), hrRole: c.pid === 'boss' ? c.title : '',
      status, lastAt, repliedElsewhere, preview: lastThread?.text || c.list?.last || lastEv?.hr || '', previewMe: !!lastThread?.me,
      unread: c.list?.unread || 0, listTime: c.list?.time || '', waiting, waitSince: waiting ? lastAt : '',
      auto: ev.some((e) => (e.action === 'reply' || e.action === 'send_resume') && e.sent !== false) || c.sends.some((s) => s.by === 'auto'),
      manual: c.sends.some((s) => s.by === 'manual'), mine: mine.has(c.key), user: u,
      goodUnit, unitWhy: [...ev].reverse().find((e) => e.unitWhy)?.unitWhy || '',
      last: lastEv ? { kind: lastEv.kind, action: lastEv.action, why: lastEv.why, tell: lastEv.tell, at: lastEv.at, worth: lastEv.worth } : null,
      events: ev.slice(-30), thread, snapAt: c.snapAt || '', cards: c.cards,
      variant: c.pid === 'boss' ? pickVariant(c.job || c.title || '').id : '',
    });
  }
  out.sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));

  const today = now.slice(0, 10);
  const todayEv = [...convs.values()].flatMap((c) => c.events).filter((e) => e.at?.startsWith(today));
  const todaySends = readLines(F('sent.jsonl')).filter((s) => s.at.startsWith(today));
  const stats = {
    hr: todayEv.filter((e) => e.hr).length,
    auto: todayEv.filter((e) => (e.action === 'reply' || e.action === 'send_resume') && e.sent !== false).length,
    resume: todayEv.filter((e) => e.action === 'send_resume' && /已发/.test(e.resume || '')).length,
    escalate: todayEv.filter((e) => e.action === 'escalate').length,
    manual: todaySends.filter((s) => s.by === 'manual').length,
  };
  const status = watchStatus();
  return { convs: out, activity: activity.slice(-300).reverse(), stats, status, watch: tracker.watchInfo(status), jobs: jobs.slice(-20), now };
}

function watchStatus() {
  const s = readJson(F('status.json'), {});
  const pid = Number(readJson(F('watch.pid'), 0)) || Number((existsSync(F('watch.pid')) && readFileSync(F('watch.pid'), 'utf8')) || 0);
  let alive = false;
  try { if (pid) { process.kill(pid, 0); alive = true; } } catch {}
  return { ...s, alive, pid, paused: existsSync(F('pause')), lock: lockHolder(), manualOnly: readJson(F('manual-only.json'), []) };
}

// ---------- 手动操作排队：一次只做一件，跟盯梢抢同一把锁 ----------
const jobs = [];
let jobSeq = 0, working = false;
function enqueue(job) { job.id = ++jobSeq; job.state = 'queued'; job.at = bjNow(); jobs.push(job); if (jobs.length > 50) jobs.shift(); broadcast(); pump(); return job; }
async function pump() {
  if (working) return;
  const job = jobs.find((j) => j.state === 'queued');
  if (!job) return;
  working = true;
  try { await runJob(job); } catch (e) { job.state = 'fail'; job.msg = e.message; }
  working = false; broadcast(); pump();
}
const upd = (job, state, msg) => { job.state = state; job.msg = msg; broadcast(); };

async function runJob(job) {
  const m = buildModel().convs.find((c) => c.key === job.key);
  if (!m) return upd(job, 'fail', '找不到这个会话');
  if (m.pid === '51') return upd(job, 'fail', '51job 网页上聊不了天，要在 51job APP 里回');
  const P = MOD[m.pid];
  const holder = lockHolder();
  upd(job, 'waiting', holder ? '盯梢正在扫，等它这一轮做完' : '准备打开页面');
  if (!(await lock('inbox', 5 * 60e3))) return upd(job, 'fail', '等了 5 分钟盯梢还占着页面，稍后再试');
  try {
    upd(job, 'running', `打开 ${m.platform} 的会话`);
    const c = await P.open();
    try {
      const r = await P.mod.readList(c);
      if (r.login) return upd(job, 'fail', `${m.platform} 登录掉了`);
      if (r.captcha) return upd(job, 'fail', `${m.platform} 弹了人机验证`);
      // BOSS：用接口列表按完整主键找（带 securityId）；「拉最新」只读不点开会话（推断不给 HR 留已读），发东西才点开
      const api = P.mod.listApi ? await P.mod.listApi(c) : null;
      const it = (api?.items || []).find((x) => `${m.pid}|${x.name}|${x.company}|${x.title}` === m.key)
        || (r.items || []).find((x) => x.name === m.name && x.company === m.company && (!m.title || x.title === m.title))
        || (r.items || []).find((x) => x.name === m.name && x.company === m.company) || { name: m.name, company: m.company };
      const conv = (job.type === 'refresh' && it.securityId && P.mod.historyApi && await P.mod.historyApi(c, it)) || await P.mod.openConv(c, it);
      if (!conv) return upd(job, 'fail', '会话没点开（列表里没找到或点歪了）');
      saveConv(m.key, { platform: m.platform, pid: m.pid, name: m.name, company: m.company, title: m.title, job: conv.job, msgs: conv.msgs, cards: conv.cards });
      if (job.type === 'refresh') return upd(job, 'ok', `已拉到最新 ${conv.msgs.length} 条`);
      // 10/16：卡片按钮和发简历（用户：「这种发送简历的按钮能不能一块做进去，彻底接管」）
      if (job.type === 'resume' || job.type === 'agree' || job.type === 'reject') {
        if (m.pid !== 'boss') return upd(job, 'fail', '智联的附件简历要在智联 APP 里发；投递时已经带了在线简历');
        let r;
        const v = VARIANTS.find((x) => x.id === job.variant) || pickVariant(m.title);
        if (job.type === 'reject') { upd(job, 'running', '点「拒绝」'); r = await boss.answerCard(c, job.card || 'resume', 'reject'); }
        else if (job.type === 'agree' && job.card && job.card !== 'resume') {
          if (job.card === 'wechat') return upd(job, 'fail', `交换微信会把你的主微信发出去，不点；${cfg().wechatAlt ? `要给就在回复框里打 ${cfg().wechatAlt}` : '要给就在回复框里手动打'}`);
          upd(job, 'running', '点「同意」'); r = await boss.answerCard(c, job.card, 'agree');
        } else { upd(job, 'running', `发「${v.label}」版附件简历`); r = await boss.sendResume(c, v); }
        const label = job.type === 'reject' ? '❌ 拒绝了 HR 的请求' : job.card === 'phone' ? '📱 同意交换电话' : `📎 附件简历（${v.label}版）`;
        log({ manual: true, key: m.key, platform: m.platform, name: m.name, company: m.company, title: m.title, text: label, sent: r.ok, err: r.ok ? undefined : r.why });
        const after = await P.mod.openConv(c, it).catch(() => null);          // 再读一遍，卡片状态跟着更新
        if (after) saveConv(m.key, { platform: m.platform, pid: m.pid, name: m.name, company: m.company, title: m.title, job: after.job, msgs: after.msgs, cards: after.cards });
        if (!r.ok) return upd(job, 'fail', r.why);
        recordSent(m.key, label, 'manual');
        return upd(job, 'ok', r.how ? `成了（${r.how}）` : '成了');
      }
      upd(job, 'running', '正在发送');
      const s = await P.mod.sendText(c, job.text);
      log({ manual: true, key: m.key, platform: m.platform, name: m.name, company: m.company, title: m.title, text: job.text, sent: s.ok, err: s.why || undefined });
      if (!s.ok) return upd(job, 'fail', s.why);
      recordSent(m.key, job.text, 'manual');
      // 回过了 = 处理过了：清掉「稍后」「已处理」，让它按新状态排
      const u = readJson(F('inbox-state.json'), {}); delete u[m.key]?.status; writeFileSync(F('inbox-state.json'), JSON.stringify(u));
      upd(job, 'ok', '发出去了');
    } finally {
      if (P.mod.leaveSession) await P.mod.leaveSession(c).catch(() => {});        // 智联：别停在会话上，不然新消息被自动标已读
      await c.close();
    }
  } finally { unlock(); }
}

// ---------- 10/16 岗位描述（用户：聊天页上没有岗位描述）----------
// 从平台接口读（boss.jobInfo / zl.jobInfo，只读、不点开会话），读过的存 data\jd\，一个会话只读一次（BOSS 详情页读多了会弹验证）
const JD_DIR = F('jd');
const jdFile = (key) => path.join(JD_DIR, `${createHash('sha1').update(key).digest('hex').slice(0, 16)}.json`);
const jdBusy = new Map();
async function jobDetail(key, fresh) {
  const file = jdFile(key);
  if (!fresh && existsSync(file)) return readJson(file, {});
  if (jdBusy.has(key)) return jdBusy.get(key);
  const p = (async () => {
    const m = buildModel().convs.find((c) => c.key === key);
    if (!m) return { status: 404, err: '找不到这个会话' };
    const P = MOD[m.pid];
    if (!P?.mod.jobInfo) return { status: 404, err: '' };              // 51job 网页没有会话，读不了
    const L = readJson(F(`list-${m.pid}.json`), { items: [] });
    const it = (L.items || []).find((x) => `${m.pid}|${x.name}|${x.company}|${x.title}` === key) || { name: m.name, company: m.company, title: m.title };
    if (m.pid === 'boss' && !it.securityId) return { status: 404, err: '列表快照里没有这家（可能太久没聊了）' };
    if (!(await lock('inbox-jd', 60e3))) return { status: 503, err: '盯梢正占着页面，过一会儿再点' };
    let r;
    try {
      const c = await P.open();
      try { r = await P.mod.jobInfo(c, it); } finally { await c.close(); }
    } finally { unlock(); }
    if (!r || r.err) return { status: 502, err: r?.err || '没读到' };
    const out = {
      title: r.title || '', salary: r.salary || '', city: r.city || '', exp: r.exp || '', degree: r.degree || '',
      scale: (r.companyBase || []).join(' · '), desc: r.jd || '', address: r.address || '', keywords: r.keywords || [],
      business: r.business || [], intro: r.intro || '', hrActive: r.hrActive || '', company: r.company || '',
      url: r.url || '', from: `${m.platform} 岗位详情 · ${new Date(Date.now() + 8 * 3600e3).toISOString().slice(5, 16).replace('T', ' ')} 读的`,
    };
    mkdirSync(JD_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify(out));
    return out;
  })().finally(() => jdBusy.delete(key));
  jdBusy.set(key, p);
  return p;
}

// ---------- 10/16 晚 投递表 / 今天页（tracker.mjs）：每 5 分钟把 6 个来源合一遍 ----------
async function syncTracker() {
  const h = await hunt.read().catch(() => null);
  return tracker.sync(buildModel(), h?.ok ? h : null);
}
const syncSoon = () => syncTracker().then(broadcast).catch((e) => console.log('tracker 同步失败：', e.message));
hunt.setOnChange(() => broadcast());                              // 找岗位一键扫的进度、猎聘发送状态一变就推给页面
setTimeout(syncSoon, 3000);
setInterval(syncSoon, 5 * 60e3);

// ---------- 推送：数据文件一变就通知页面重拉 ----------
const clients = new Set();
let bTimer = null;
function broadcast() {
  clearTimeout(bTimer);
  bTimer = setTimeout(() => { for (const r of clients) r.write(`data: ${Date.now()}\n\n`); }, 300);
}
// 只盯会改变页面内容的文件。盯梢的 stdout（watch.out）、看过哪些（state.json）、Telegram 草稿（push-body.json）这些也在 data\ 里，
// 以前一写就让所有打开的页面整份重拉一次 model（20 多万字），一轮扫下来能刷十几次
const NOISE = /^(watch\.out|state\.json|push-.*|inbox\.pid|autostart\.log|.*\.txt|.*\.tmp)$/i;
for (const d of [DATA, STORE]) watch(d, (_, f) => { if (!f || !NOISE.test(String(f))) broadcast(); });
setInterval(() => { for (const r of clients) r.write(': ping\n\n'); }, 25000);

// ---------- HTTP ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const body = (req) => new Promise((ok) => { let s = ''; req.on('data', (d) => (s += d)); req.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch { ok({}); } }); });
const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
const setUser = (key, patch) => {
  const u = readJson(F('inbox-state.json'), {});
  u[key] = { ...(u[key] || {}), ...patch, at: bjNow() };
  for (const k of Object.keys(u[key])) if (u[key][k] === null) delete u[key][k];
  writeFileSync(F('inbox-state.json'), JSON.stringify(u, null, 1));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  // 安全：只认 127.0.0.1:8790 / localhost:8790 这个地址（防别的网站用域名指过来读数据），
  // POST 只认收件箱页面自己发的 JSON（防用户逛的随便哪个网页偷偷 POST 过来，替他给 HR 发消息、关盯梢、点「投」）
  const ME = new RegExp(`^(127\\.0\\.0\\.1|localhost):${PORT}$`);
  if (!ME.test(String(req.headers.host || ''))) { res.writeHead(403); return res.end('forbidden'); }
  if (req.method === 'POST') {
    const origin = req.headers.origin;
    if ((origin && !new RegExp(`^http://(127\\.0\\.0\\.1|localhost):${PORT}$`).test(origin)) || !/^application\/json/i.test(req.headers['content-type'] || '')) return send(res, 403, { err: '只接受收件箱页面自己发的请求' });
  }
  try {
    if (req.method === 'GET' && p === '/api/model') return send(res, 200, buildModel());
    if (req.method === 'GET' && p === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write('retry: 3000\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return;
    }
    if (req.method === 'GET' && p === '/api/env') return send(res, 200, { ...(await pluginStatus()), configMissing: missing(), configError: configError() });
    if (req.method === 'GET' && p === '/api/profile') { const c = cfg(); return send(res, 200, { wechatAlt: c.wechatAlt, nearDistricts: c.nearDistricts, city: c.city, portfolio: c.portfolio }); }
    if (req.method === 'GET' && p === '/api/variants') return send(res, 200, VARIANTS.map((v) => ({ id: v.id, label: v.label })));
    if (req.method === 'GET' && p === '/api/hunt') return send(res, 200, await hunt.read(url.searchParams.has('fresh')));
    if (req.method === 'GET' && p === '/api/applied') return send(res, 200, findApplied(url.searchParams.get('company') || '', url.searchParams.get('title') || '') || {});
    if (req.method === 'GET' && p === '/api/tracker') {
      if (url.searchParams.has('fresh') || !tracker.syncInfo().at) await syncTracker().catch(() => {});
      const q = Object.fromEntries(['view', 'platform', 'by', 'stage', 'q'].map((k) => [k, url.searchParams.get(k) || '']));
      return send(res, 200, tracker.listApps({ ...q, view: q.view || 'active' }));
    }
    if (req.method === 'GET' && p === '/api/tracker/item') { const r = tracker.appDetail(Number(url.searchParams.get('id'))); return r ? send(res, 200, r) : send(res, 404, { err: '没有这条投递' }); }
    if (req.method === 'GET' && p === '/api/today') {
      if (url.searchParams.has('fresh') || !tracker.syncInfo().at) await syncTracker().catch(() => {});
      return send(res, 200, tracker.today(buildModel()));
    }
    if (req.method === 'GET' && p === '/api/jd') { const r = await jobDetail(url.searchParams.get('key') || '', url.searchParams.has('fresh')); return send(res, r.status || 200, r); }
    if (req.method === 'POST') {
      const b = await body(req);
      if (!b.key && /^\/api\/(send|refresh|resume|card|draft|mark|note|manual)$/.test(p)) return send(res, 400, { err: '没指定是哪家会话' });
      // 同一家已经有一件事在排队或在做（发消息 / 发简历 / 点卡片）：不再收一样的，防连点两下给 HR 发两遍
      const busy = (type, same) => jobs.find((j) => j.key === b.key && j.type === type && ['queued', 'waiting', 'running'].includes(j.state) && same(j));
      if (p === '/api/send') {
        const text = String(b.text || '').trim();
        if (!text) return send(res, 400, { err: '回复框是空的' });
        if (busy('send', (j) => j.text === text)) return send(res, 409, { err: '这句已经在发了，别重复点' });
        return send(res, 200, enqueue({ type: 'send', key: b.key, text }));
      }
      if (/^\/api\/(resume|card)$/.test(p) && jobs.some((j) => j.key === b.key && j.type !== 'send' && j.type !== 'refresh' && ['queued', 'waiting', 'running'].includes(j.state))) return send(res, 409, { err: '这家上一个操作还没做完，等它做完再点' });
      if (p === '/api/refresh') return send(res, 200, busy('refresh', () => true) || enqueue({ type: 'refresh', key: b.key }));
      if (p === '/api/resume') return send(res, 200, enqueue({ type: 'resume', key: b.key, variant: b.variant }));
      if (p === '/api/card') return send(res, 200, enqueue({ type: b.action === 'reject' ? 'reject' : 'agree', key: b.key, card: b.card || 'resume', variant: b.variant }));
      if (p === '/api/hunt/approve') return send(res, 200, await hunt.approve(b.jobId, b.greeting));
      if (p === '/api/hunt/drop') return send(res, 200, await hunt.drop(b.jobId));
      if (p === '/api/hunt/unapprove') return send(res, 200, await hunt.unapprove(b.jobId));
      if (p === '/api/hunt/batch') return send(res, 200, await hunt.batch(b.action === 'approve' ? 'approve' : 'drop', (b.items || []).slice(0, 50)));
      if (p === '/api/hunt/scan-all') { const r = hunt.scanAll(Array.isArray(b.sources) ? b.sources.filter((x) => ['boss', '51job', 'zhilian', 'liepin', 'campus'].includes(x)) : null); return send(res, r.status || 200, r); }
      if (p === '/api/hunt/scan-stop') return send(res, 200, await hunt.scanStop());
      if (p === '/api/hunt/run') return send(res, 200, await hunt.runToday());
      if (p === '/api/hunt/stop') return send(res, 200, await hunt.stopToday());
      if (p === '/api/hunt/daily') {
        const d = {};
        if (Array.isArray(b.keywords)) d.keywords = b.keywords.map((k) => String(k).trim()).filter(Boolean).slice(0, 20);
        for (const k of ['boss', 'job51', 'zhilian', 'bigOnly']) if (typeof b[k] === 'boolean') d[k] = b[k];
        if (Number.isFinite(b.perKeyword)) d.perKeyword = Math.max(1, Math.min(30, Math.round(b.perKeyword)));
        return send(res, 200, await hunt.setDaily(d));
      }
      if (p === '/api/draft') {
        const m = buildModel().convs.find((c) => c.key === b.key);
        if (!m) return send(res, 404, { err: '找不到会话' });
        const msgs = m.thread.map((t) => ({ me: t.me, text: t.text }));
        return send(res, 200, await draft({ platform: m.platform, company: m.company, title: m.title, name: m.name, msgs, hint: b.hint || '', mode: b.mode }));
      }
      if (p === '/api/mark') {
        const map = { done: { status: 'done' }, open: { status: null, pass: null }, snooze: { status: 'snooze', until: b.until }, pass: { pass: true }, unpass: { pass: null } };
        setUser(b.key, map[b.status] || {}); broadcast(); return send(res, 200, { ok: true });
      }
      if (p === '/api/note') { setUser(b.key, { note: String(b.note || '').slice(0, 500) || null }); broadcast(); return send(res, 200, { ok: true }); }
      if (p === '/api/manual') {
        const s = new Set(readJson(F('manual-only.json'), []));
        b.on ? s.add(b.key) : s.delete(b.key);
        writeFileSync(F('manual-only.json'), JSON.stringify([...s])); broadcast(); return send(res, 200, { ok: true });
      }
      // 今天页「完成 / 稍后」。会话类的顺手把收件箱里那家也标掉，两边说法一致
      if (p === '/api/task') {
        const t = tracker.setTask(Number(b.id), b.status === 'snooze' ? 'snooze' : b.status === 'open' ? 'open' : 'done', b.until);
        if (!t) return send(res, 404, { err: '没有这条待办（可能已经自动消失了）' });
        if (t.data.convKey && t.rkey.startsWith('conv:')) {
          if (b.status === 'done') setUser(t.data.convKey, { status: 'done' });
          else if (b.status === 'snooze') setUser(t.data.convKey, { status: 'snooze', until: tracker.open().prepare('SELECT until FROM tasks WHERE id=?').get(t.id).until });
          else setUser(t.data.convKey, { status: null });
        }
        broadcast(); return send(res, 200, { ok: true });
      }
      if (p === '/api/tracker/stage') {
        try { const r = tracker.setStage(Number(b.id), b.stage, b.outcome); if (!r) return send(res, 404, { err: '没有这条投递' }); } catch (e) { return send(res, 400, { err: e.message }); }
        broadcast(); return send(res, 200, { ok: true });
      }
      if (p === '/api/tracker/add') {
        const company = String(b.company || '').trim();
        if (!company) return send(res, 400, { err: '公司名是空的' });
        tracker.appendApplied({ platform: b.platform || '网申', company, title: String(b.title || '').trim(), url: String(b.url || ''), by: b.by || 'me', src: 'manual' });
        await syncTracker().catch(() => {});
        const hit = tracker.listApps({ view: 'all', q: company }).items.find((x) => x.company === company && (!b.title || x.title === String(b.title).trim()));
        broadcast(); return send(res, 200, { ok: true, id: hit?.id || null });
      }
      if (p === '/api/kick') { writeFileSync(F('kick'), ''); return send(res, 200, { ok: true }); }
      if (p === '/api/pause') { if (b.on) writeFileSync(F('pause'), 'inbox'); else if (existsSync(F('pause'))) unlinkSync(F('pause')); broadcast(); return send(res, 200, { ok: true }); }
      if (p === '/api/watch') {
        const st = watchStatus();
        if (b.on && !st.alive) spawn(process.execPath, [path.join(HERE, 'watch.mjs'), '--quiet-start'], { cwd: HERE, detached: true, stdio: 'ignore', windowsHide: true }).unref();
        if (!b.on && st.alive) { try { process.kill(st.pid); } catch {} try { unlinkSync(F('watch.pid')); } catch {} }
        setTimeout(broadcast, 1500); return send(res, 200, { ok: true });
      }
    }
    // 静态文件
    const PAGES = { '/': 'index.html', '/hunt': 'hunt.html', '/today': 'today.html', '/apps': 'apps.html' };
    const f = path.join(UI, PAGES[p] || path.normalize(p).replace(/^([/\\])+/, ''));
    if (!f.startsWith(UI) || !existsSync(f) || !statSync(f).isFile()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(readFileSync(f));
  } catch (e) { send(res, 500, { err: e.message }); }
});
server.listen(PORT, '127.0.0.1', () => {
  writeFileSync(F('inbox.pid'), String(process.pid));
  console.log(`HR 收件箱：http://127.0.0.1:${PORT}`);
});
process.on('exit', () => { try { unlinkSync(F('inbox.pid')); } catch {} unlock(); });
process.on('SIGINT', () => process.exit());
