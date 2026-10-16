// HR 盯梢：每 5 分钟扫一眼 BOSS / 智联的消息列表（只读不点），有新消息才点开 → DeepSeek 判断 → 回复 / 发简历 / 不回；面试类立刻推 Telegram
// 10/11 改：以前每 15 分钟才看一轮，HR 平均要等 7-8 分钟、用户在桌面 2 时还要再等一轮。
//   现在扫列表只是读页面（不点、不刷新、不切窗口），5 分钟一次没有动静；真有新消息才动手。
//   参考 BossHunter（github.com/powerycy/BossHunter，1.2k 星）：它 30 分钟一轮、不用 bringToFront；
//   bossbot 那种直接连 BOSS websocket 协议的封号风险大，不抄 —— 页面自己的 socket 已经在收消息，读页面就够快。
// 用法：node watch.mjs            一直跑（8:00-22:00）
//       node watch.mjs --once     只跑一轮
//       node watch.mjs --dry      只判断不发送、不记状态（试提示词用）
import { writeFileSync, existsSync, unlinkSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { cfg } from './config.mjs';
import { DATA, sleep, withTimeout, loadState, saveState, log, telegram, ownerOnDesk2, bjDay, bjTime,
  saveList, saveConv, recordSent, setStatus, manualOnly, lock, unlock, PORTS } from './lib.mjs';
import { decide, pickVariant, INTERVIEW } from './brain.mjs';
import * as boss from './boss.mjs';
import * as zl from './zhaopin.mjs';
import * as lp from './liepin.mjs';
import { check51 } from './job51.mjs';
import { render } from './push.mjs';
import { listenBoss, listenZhaopin } from './live.mjs';

const ONCE = process.argv.includes('--once');
const DRY = process.argv.includes('--dry');
const CHECK_SEC = Math.max(60, (cfg().autopilot.intervalMin || 5) * 60);   // 多久扫一次列表（另加 0-60 秒随机），设置里改
const RELOAD_MIN = 30;                 // 列表多久整页刷新一次（防止页面 socket 断了、列表不更新）
const J51_MIN = 15;                    // 51job 多久看一次（10/16 从 60 改 15：它网页没有长连接、做不了实时，相当于真人一刻钟刷一次个人中心）
const FAIL_RETRY_MIN = 10;             // 会话没点开，隔多久再试
const BEAT_MIN = 30;                   // 没事的时候多久往日志写一行「还活着」
const HOURS = cfg().autopilot.hours || [8, 22];   // 几点到几点之间才看（北京时间），设置里改
const PER_ROUND = 8;                   // 一个平台一轮最多处理几个会话，多的下一轮
const PAUSE = path.join(DATA, 'pause'); // 有这个文件就跳过（我手动在 BOSS 上干活时放一个，免得抢页面）

const PLATFORMS = [
  { id: 'boss', label: 'BOSS', mod: boss, open: boss.openBoss, usesDesk2: true },
  { id: 'zl', label: '智联', mod: zl, open: zl.openZhaopin, usesDesk2: false },
  // 10/16 猎聘（HR Desk 里的猎聘页，接口读列表和聊天；只在要回复时点开会话）
  { id: 'lp', label: '猎聘', mod: lp, open: lp.openLiepin, usesDesk2: false },
];
const SYS_LAST = /您正在与|已发送给Boss|点击查看附件|竞争者PK|^在线简历$/;

let round = 0;
const lastReload = {};                 // 平台 → 上次整页刷新的时间
let last51 = 0, lastBeat = 0, pauseLogged = false, running = null, kicked = false;

// 收件箱顶上显示每个平台连没连上
const health = (P, ok, note = '') => setStatus({ [`p_${P.id}`]: { ok, note, at: bjTime() } });

async function runPlatform(P, state, desk2, events) {
  let c;
  setStatus({ doing: `扫 ${P.label} 消息列表` });
  try { c = await P.open(); } catch (e) { health(P, false, '浏览器没开或连不上'); return once(state, `${P.id}:down`, `⚠️ ${P.label} 浏览器没开或连不上（${e.message}），这边消息我先看不到`, events); }
  try {
    const reload = Date.now() - (lastReload[P.id] || 0) > RELOAD_MIN * 60e3;
    if (reload) lastReload[P.id] = Date.now();
    let r = await P.mod.readList(c, { reload });
    // 10/16：BOSS 改用页面自己的接口读列表（60 个、带 securityId，不靠扒网页字）；接口不通就照旧用网页上读到的
    let viaApi = false;
    if (!r.captcha && !r.login && P.mod.listApi) { const a = await P.mod.listApi(c); if (a) { r = a; viaApi = true; } }
    if (r.captcha) { health(P, false, '弹了人机验证'); return once(state, `${P.id}:captcha`, `⚠️ ${P.label} 弹了人机验证，我停手了，等你有空去桌面 2 点一下`, events); }
    if (r.login) { health(P, false, '登录掉了'); return once(state, `${P.id}:login`, `⚠️ ${P.label} 登录掉了，要你扫码重新登录`, events); }
    const items = r.items || [];
    if (!DRY && items.length) saveList(P.id, items);
    health(P, true, `${items.length} 个会话${viaApi ? '（接口）' : ''}`);
    const mine = manualOnly();
    const first = !state.init?.[P.id];
    let done = 0;
    for (const it of items) {
      // 10/11：key 带上岗位。同一个 HR 同一家公司挂两个岗位时会互相覆盖，每轮都重新判断一遍（10/10 郑先生那条刷了几十次）
      const key = `${P.id}|${it.name}|${it.company}|${it.title}`;
      const oldKey = `${P.id}|${it.name}|${it.company}`;          // 旧写法，认 10/11 之前的状态用
      if (!it.name || !it.last || SYS_LAST.test(it.last)) continue;
      if (it.fromMe) { state.seen[key] = it.last; continue; }          // 最后是我们说的：在等对方
      if ((state.seen[key] ?? state.seen[oldKey]) === it.last) { state.seen[key] = it.last; continue; }
      if (state.failAt[key] && Date.now() - state.failAt[key] < FAIL_RETRY_MIN * 60e3) continue;   // 刚点歪过，过一会儿再试
      if (first && !it.unread) { state.seen[key] = it.last; continue; } // 第一次跑：没未读的老消息当作看过了
      const base = { platform: P.label, name: it.name, company: it.company, title: it.title, hr: it.last };

      if (P.usesDesk2 && desk2) {                                       // 用户正看着桌面 2：不点 BOSS，下一轮再说
        if (INTERVIEW.test(it.last)) { events.push({ ...base, action: 'escalate', kind: '约面试', tell: '出现面试类字眼，我没回' }); state.seen[key] = it.last; }
        else state.deferred = (state.deferred || 0) + 1;
        continue;
      }
      if (done >= PER_ROUND) break;
      done++;

      setStatus({ doing: `看 ${P.label} · ${it.company || it.name} 的新消息` });
      // 10/16：先用接口读聊天（不点开会话 = 推断不给 HR 留「已读」），读不到再点开；真要回复时下面才点开
      let conv = it.securityId && P.mod.historyApi ? await P.mod.historyApi(c, it) : null;
      let opened = false;
      if (!conv) { conv = await P.mod.openConv(c, it); opened = true; }
      if (!conv) {
        state.fail[key] = (state.fail[key] || 0) + 1;
        state.failAt[key] = Date.now();
        log({ ...base, err: '会话没打开或点歪了', n: state.fail[key] });
        if (state.fail[key] >= 3) { events.push({ ...base, action: 'escalate', tell: '这个会话我连着 3 次没打开，你看一眼' }); state.seen[key] = it.last; }
        continue;
      }
      if (!DRY) saveConv(key, { platform: P.label, pid: P.id, name: it.name, company: it.company, title: it.title, job: conv.job, msgs: conv.msgs, cards: conv.cards });
      // 10/16：用户在收件箱点了「这家我自己回」—— 只记下来、推给他，不替他回
      if (mine.has(key)) {
        const ev = { ...base, action: 'escalate', kind: '你接管的', tell: '这家你说自己回，我没动' };
        log(ev); events.push(ev); state.seen[key] = it.last;
        continue;
      }
      setStatus({ doing: `想怎么回 ${it.company || it.name}` });
      let d;
      try { d = await decide({ platform: P.label, name: it.name, company: it.company, title: it.title || conv.job, msgs: conv.msgs, resumeSent: conv.resumeSent }); }
      catch (e) { log({ ...base, err: `模型出错：${e.message}` }); continue; }
      const ev = { ...base, kind: d.kind, action: d.action, tell: d.tell, worth: d.worth, reply: d.reply, why: d.why, outreach: d.outreach, askInterview: d.ask_interview, goodUnit: d.good_unit, unitWhy: d.unit_why,
        hrFresh: conv.msgs.slice(conv.msgs.map((m) => m.me).lastIndexOf(true) + 1).filter((m) => !m.me).map((m) => m.text).join(' / ') };

      // 要发东西了：接口读的那种还没点开会话，现在点开（只有真回复的才会点，判了「不回」「交给你」的一下都不点）
      if (!DRY && !opened && (d.action === 'send_resume' || d.action === 'reply')) {
        setStatus({ doing: `打开 ${it.company || it.name} 的会话准备回复` });
        if (await P.mod.openConv(c, it)) opened = true;
        else { ev.action = 'escalate'; ev.err = '要回复，但会话没点开，草稿留给你'; }
      }
      if (!DRY && ev.action === 'send_resume') {
        if (P.id === 'boss') {
          const v = pickVariant(it.job || conv.job || it.title);
          const s = await boss.sendResume(c, v);
          ev.resume = s.ok ? `已发「${v.label}」版（${s.how}）` : `没发成：${s.why}`;
          if (!s.ok) ev.action = 'escalate';
          else recordSent(key, `📎 附件简历（${v.label}版）`, 'auto');
        } else {
          ev.resume = '智联投递时已经带了在线简历，HR 还要附件的话要你在 APP 里发';
        }
        if (d.reply && ev.action !== 'escalate') {
          setStatus({ doing: `给 ${it.company || it.name} 发回复` });
          await sleep(1500); const s = await P.mod.sendText(c, d.reply); ev.sent = s.ok; if (!s.ok) ev.err = s.why; else recordSent(key, d.reply, 'auto');
        }
      } else if (!DRY && ev.action === 'reply') {
        setStatus({ doing: `给 ${it.company || it.name} 发回复` });
        const s = await P.mod.sendText(c, d.reply);
        ev.sent = s.ok;
        if (!s.ok) { ev.err = s.why; ev.action = 'escalate'; } else recordSent(key, d.reply, 'auto');
      }
      ev.key = key;
      log(ev);
      events.push(ev);
      state.seen[key] = it.last;
      delete state.fail[key]; delete state.failAt[key];
      if (d.action === 'reply' || d.action === 'send_resume') await sleep(15000 + Math.random() * 20000);   // 别连珠炮
    }
    state.init = { ...(state.init || {}), [P.id]: true };
    delete state.notes[`${P.id}:down`]; delete state.notes[`${P.id}:login`]; delete state.notes[`${P.id}:captcha`];
  } finally {
    if (!DRY && P.mod.leaveSession) await P.mod.leaveSession(c).catch(() => {});   // 智联：别停在会话上，不然新消息被自动标已读
    await c.close();
  }
}

/** 同一个故障一天只推一次 */
function once(state, k, text, events) {
  if (state.notes[k] === bjDay()) return;
  state.notes[k] = bjDay();
  log({ notice: text });
  events.push({ raw: text });
}

async function tick() {
  round++;
  if (existsSync(PAUSE)) { setStatus({ doing: '暂停中（有 pause 文件）', paused: true }); if (!pauseLogged) log({ skip: '有 pause 文件，暂停中' }); pauseLogged = true; return; }
  if (pauseLogged) { log({ skip: 'pause 文件删了，接着盯' }); pauseLogged = false; }
  setStatus({ paused: false, round, roundAt: bjTime() });
  // 收件箱正在替用户手动发消息的话，等它发完（最多 3 分钟），两边不同时点页面
  if (!DRY) {
    setStatus({ doing: '等收件箱那边发完' });
    if (!(await lock('watch', 180000))) { setStatus({ doing: '收件箱一直占着页面，这轮跳过' }); return; }
  }
  try { await tickInner(); } finally { if (!DRY) unlock(); }
}

async function tickInner() {
  const state = loadState();
  state.fail ||= {}; state.failAt ||= {}; state.notes ||= {}; state.deferred = 0;
  const desk2 = PORTS.boss === 9333 ? await ownerOnDesk2() : false;   // BOSS 挪进 HR Desk 后盯梢点的是软件里藏着的那张页，用户在哪个桌面都碰不到
  const events = [];
  for (const P of PLATFORMS) {
    try { await runPlatform(P, state, desk2, events); }
    catch (e) { log({ platform: P.label, err: e.message }); }
  }
  if (Date.now() - last51 > J51_MIN * 60e3) {                       // 51job 一刻钟看一次
    last51 = Date.now();
    setStatus({ doing: '看 51job「我的申请」' });
    try { await check51(state, events); setStatus({ p_51: { ok: true, note: '每 15 分钟看一次', at: bjTime() } }); }
    catch (e) { log({ platform: '51job', err: e.message }); setStatus({ p_51: { ok: false, note: e.message.slice(0, 40), at: bjTime() } }); }
  }
  if (!DRY) saveState(state);
  // 5 分钟一轮，没事就不写日志；有事、或者隔 30 分钟写一行心跳
  if (events.length || Date.now() - lastBeat > BEAT_MIN * 60e3) { log({ round, desk2, deferred: state.deferred, events: events.length }); lastBeat = Date.now(); }
  if (events.length) {
    for (const text of render(events, { time: bjTime(), dry: DRY, deferred: state.deferred })) {
      if (DRY) console.log('\n' + text); else await telegram(text, { html: true });
    }
  }
}

function inHours() { const h = Number(bjTime().slice(0, 2)); return h >= HOURS[0] && h < HOURS[1]; }

// 收件箱点「立即扫一轮」、BOSS 推送来了新消息，都会放一个 kick 文件：睡觉时每 2 秒看一眼，有就提前醒。返回是谁叫醒的
const KICK = path.join(DATA, 'kick');
async function nap(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (existsSync(KICK)) { let why = ''; try { why = readFileSync(KICK, 'utf8'); unlinkSync(KICK); } catch {} return why || 'inbox'; }
    await sleep(2000);
  }
  return '';
}
const hhmm = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(11, 16);

// 10/16：试跑（--dry / --once）不碰 watch.pid —— 以前试跑会把正在跑的盯梢的 pid 覆盖再删掉，开关和重启就找不到它，起出第二个盯梢
if (!ONCE && !DRY) {
  writeFileSync(path.join(DATA, 'watch.pid'), String(process.pid));
  process.on('exit', () => { try { unlinkSync(path.join(DATA, 'watch.pid')); } catch {} });
}
process.on('exit', () => unlock());
process.on('SIGINT', () => process.exit());
if (ONCE || DRY) { await tick(); process.exit(); }
// 10/16：BOSS 实时推送（live.mjs 旁听页面自己的消息长连接）。HR 一发消息就放 kick 文件，几秒内扫一轮；轮询照旧兜底
listenBoss({
  onPush: () => { if (inHours() && !existsSync(PAUSE) && !existsSync(KICK)) writeFileSync(KICK, 'boss-push'); },
  onState: (ok, note) => setStatus({ live_boss: { ok, note, at: bjTime() } }),
}).catch((e) => log({ err: `推送监听退出了：${e.message}` }));
// 10/16：智联实时推送（旁听云信长连接），同样只放 kick 文件
listenZhaopin({
  onPush: (key) => { if (inHours() && !existsSync(PAUSE) && !existsSync(KICK)) writeFileSync(KICK, `zl-push:${key}`); },
  onState: (ok, note) => setStatus({ live_zl: { ok, note, at: bjTime() } }),
}).catch((e) => log({ err: `智联推送监听退出了：${e.message}` }));
if (!process.argv.includes('--quiet-start')) await telegram(`👀 HR 盯梢开了：${HOURS[0]}-${HOURS[1]} 点每 5 分钟扫一眼 BOSS 和智联，有新消息几分钟内处理，面试类消息我不回、马上推给你`);
for (;;) {
  // 一轮最多 15 分钟（正常几秒；回了好几家也就几分钟）。超时说明哪里卡住了，记一笔接着下一轮，不让整个盯梢停摆
  // 卡住的那一轮还在后台跑的话，这一轮跳过，免得两轮同时点页面
  if ((inHours() || kicked) && !running) {
    running = tick().catch((e) => log({ err: e.message })).finally(() => { running = null; });
    try { await withTimeout(running, 15 * 60e3, '这一轮'); } catch (e) { log({ err: e.message }); }
  }
  const wait = (CHECK_SEC + Math.random() * 60) * 1000;
  const paused = existsSync(PAUSE);
  setStatus({ doing: paused ? '暂停中（有 pause 文件）' : inHours() ? '歇着，等下一轮' : `下班了（${HOURS[0]}-${HOURS[1]} 点才看）`, next: inHours() ? hhmm(Date.now() + wait) : '', lastDone: bjTime() });
  kicked = await nap(wait);
  if (kicked) log({ skip: kicked === 'boss-push' ? 'BOSS 推送：来新消息了，马上扫' : kicked.startsWith('zl-push') ? `智联推送（${kicked.slice(8)}）：来新动静了，马上扫` : '收件箱点了「立即扫一轮」' });
}
