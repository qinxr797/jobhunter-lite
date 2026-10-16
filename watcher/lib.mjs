// HR 盯梢的公共件：CDP 连接、状态文件、日志、Telegram 推送、用户在不在桌面 2
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA as CFG_DATA, cfg } from './config.mjs';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DATA = CFG_DATA;   // <数据目录>\watcher（见 config.mjs）
mkdirSync(DATA, { recursive: true });
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, bad) => setTimeout(() => bad(new Error(`${what} 超过 ${ms / 1000} 秒没反应`)), ms))]);
const bj = (ms = Date.now()) => new Date(ms + 8 * 3600e3).toISOString();
export const bjDay = () => bj().slice(0, 10);
export const bjTime = () => bj().slice(11, 16);

// ---------- CDP ----------
// 10/16 HR Desk：BOSS 可以挪进 HR Desk 软件（（作者本机路径），内核调试口 9401）。
// data\ports.json 写 {"boss":9401} 就切过去，删掉这个文件就回到老的 9333 Chrome（改完要重启盯梢和收件箱后台）。
// 智联 / 51job 同理：加 "zhaopin":9401,"j51":9401，不写就还在 9334
const PORTS_FILE = path.join(DATA, 'ports.json');
export const PORTS = { boss: cfg().ports.boss, zhaopin: cfg().ports.zhaopin, j51: cfg().ports.j51, lp: cfg().ports.lp, ...(existsSync(PORTS_FILE) ? JSON.parse(readFileSync(PORTS_FILE, 'utf8')) : {}) };

/** 挑页面：HR Desk 里每个平台都有两张页（用户看的 + 盯梢专用的），优先连盯梢专用那张（软件把它们的 id 写在 data\desk.json） */
export function pickTab(tabs, match) {
  const pages = tabs.filter((t) => t.type === 'page' && t.url.includes(match));
  try {
    const d = JSON.parse(readFileSync(path.join(DATA, 'desk.json'), 'utf8'));
    const ids = new Set([d.workerTarget, ...Object.values(d.workers || {})]);
    const hit = pages.find((t) => ids.has(t.id));
    if (hit) return hit;
  } catch {}
  return pages[0];
}

/** 连上某端口里网址含 match 的页面；没有就新开 openUrl（后台标签） */
export async function connect(port, match, openUrl, { keep = false } = {}) {   // keep：自己开的标签用完也不关（插件侧边栏页要一直开着发送器才活着）
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(5000) })).json();
  let tab = pickTab(tabs, match);
  let opened = false;
  if (!tab && openUrl) {
    tab = await newBackgroundTab(port, openUrl);
    opened = true;
    await sleep(6000);
  }
  if (!tab) return null;
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await withTimeout(new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = () => bad(new Error('CDP 连不上')); }), 10000, 'CDP 连接');
  let id = 0; const pend = new Map();
  const subs = {};                                         // 10/16：CDP 事件订阅（51job 接页面自己发的请求的返回用）
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } else if (m.method) for (const f of subs[m.method] || []) f(m.params); };
  const on = (method, fn) => { (subs[method] ||= []).push(fn); };
  // 10/11：每条 CDP 命令限时 30 秒。以前没限时，页面弹个 alert 或连接断了，整个盯梢会一直卡在那里
  ws.onclose = () => { for (const [, f] of pend) f({ error: { message: 'CDP 连接断了' } }); pend.clear(); };
  const send = (method, params = {}) => withTimeout(new Promise((ok) => {
    const i = ++id; pend.set(i, ok);
    try { ws.send(JSON.stringify({ id: i, method, params })); } catch (e) { pend.delete(i); ok({ error: { message: e.message } }); }
  }), 30000, method);
  // 10/11：假装页面有焦点，输入框 focus / 打字在后台标签里也能用。
  // 以前靠 Page.bringToFront，它在 Windows 上会把 BOSS 窗口硬拽到最前面 —— 用户玩电脑时突然弹窗就是它
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
  // 10/16 REA 逆向：BOSS 的风控脚本会采鼠标轨迹（直线移动、瞬移到按钮上都可疑）。点之前从上一个位置沿一条带弧度的曲线
  // 分 8~14 步移过去，每步停十几到三十几毫秒，先快后慢，停一下再按。CDP 发的鼠标事件页面看是真实点击（isTrusted），绝不用 element.click()
  let pos = { x: 300 + Math.random() * 400, y: 250 + Math.random() * 250 };
  const click = async (p) => {
    const steps = 8 + Math.floor(Math.random() * 7);
    const cx = (pos.x + p.x) / 2 + (Math.random() - 0.5) * 160, cy = (pos.y + p.y) / 2 + (Math.random() - 0.5) * 160;
    for (let i = 1; i <= steps; i++) {
      const e = 1 - (1 - i / steps) ** 3;
      const x = (1 - e) ** 2 * pos.x + 2 * (1 - e) * e * cx + e * e * p.x, y = (1 - e) ** 2 * pos.y + 2 * (1 - e) * e * cy + e * e * p.y;
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await sleep(12 + Math.random() * 23);
    }
    await sleep(60 + Math.random() * 140);
    for (const type of ['mousePressed', 'mouseReleased']) { await send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 }); await sleep(70 + Math.random() * 60); }
    pos = { x: p.x, y: p.y };
  };
  const enter = async () => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  };
  // 10/16：9333 重开后点输入框焦点留不住（焦点停在别的元素上），Input.insertText 返回成功、框里是空的，
  // 10 条开场白全没发出去。打完核一下输入框里有没有这段字，没有就把焦点放回输入框、用页面里的 execCommand 补
  const type = async (text) => {
    const box = `(()=>{const a=document.activeElement;return document.querySelector('#chat-input')||(a&&a!==document.body?a:document.querySelector('[contenteditable=true],textarea'))})()`;
    await ev(`${box}?.focus()`);
    await send('Input.insertText', { text });
    const probe = JSON.stringify(text.slice(0, 8));
    const got = await ev(`(()=>{const e=${box};return !!e&&String(e.value??e.innerText??'').includes(${probe})})()`);
    if (!got) await ev(`(()=>{const e=${box};if(!e)return false;e.focus();return document.execCommand('insertText',false,${JSON.stringify(text)})})()`);
  };
  const close = async () => {
    ws.close();
    if (opened && !keep) await fetch(`http://127.0.0.1:${port}/json/close/${tab.id}`).catch(() => {});
  };
  return { send, ev, click, enter, type, close, tab, on };
}

/** 后台开新标签：Target.createTarget 带 background，不激活窗口（/json/new 会把标签切到前台） */
async function newBackgroundTab(port, url) {
  const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(5000) })).json();
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  try {
    await withTimeout(new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = () => bad(new Error('CDP 连不上')); }), 10000, 'CDP 连接');
    const r = await withTimeout(new Promise((ok) => { ws.onmessage = (e) => ok(JSON.parse(e.data)); ws.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url, background: true } })); }), 15000, 'Target.createTarget');
    const targetId = r.result?.targetId;
    if (!targetId) throw new Error(`开不了新标签：${r.error?.message || '没返回 targetId'}`);
    for (let k = 0; k < 10; k++) {
      const tabs = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(5000) })).json();
      const t = tabs.find((x) => x.id === targetId);
      if (t) return t;
      await sleep(500);
    }
    throw new Error('新标签开了但找不到');
  } finally { ws.close(); }
}

/** 页面里按文字找可见元素，返回中心坐标（scope 是 CSS，限定在哪个区域里找） */
export const findByText = (text, scope = 'body', exact = true) => `(()=>{const q=${JSON.stringify(text)};
  const root=document.querySelector(${JSON.stringify(scope)})||document.body;
  const es=[...root.querySelectorAll('button,a,span,div,li,p')].filter(x=>x.offsetWidth&&x.children.length<3&&(${exact}?(x.innerText||'').trim()===q:(x.innerText||'').includes(q)));
  const e=es.pop();if(!e)return null;e.scrollIntoView({block:'center'});const b=e.getBoundingClientRect();
  return {x:b.left+b.width/2,y:b.top+b.height/2,cls:String(e.className||'')}})()`;

// ---------- 状态 / 日志 ----------
const STATE = path.join(DATA, 'state.json');
export const loadState = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { seen: {}, notes: {} });
export const saveState = (s) => writeFileSync(STATE, JSON.stringify(s, null, 1));
export function log(obj) {
  const line = JSON.stringify({ at: bj().slice(0, 19), ...obj });
  appendFileSync(path.join(DATA, 'log.jsonl'), line + '\n');
  console.log(line);
}

// ---------- Telegram（直接打 Bot API，走电脑代理 7897；不依赖「手机遥控」开没开） ----------
const OWNER = () => cfg().telegram.chatId;
const botToken = () => cfg().telegram.token;
/** html=true 用 Telegram 的 HTML 排版（加粗/引用框/折叠）；万一标签被 Telegram 拒了，自动退回去掉标签的纯文本再发 */
export function telegram(text, { html = false } = {}) {
  if (!botToken() || !OWNER()) return Promise.resolve(false);   // 设置里没填 Telegram 就不推
  // 正文写进 UTF-8 文件再让 curl 读：命令行直接带中文会被 curl 按 GBK 读坏
  const body = path.join(DATA, 'push-body.json');
  const write = (asHtml) => writeFileSync(body, JSON.stringify({ chat_id: OWNER(), text: asHtml ? text.slice(0, 4000) : plain(text).slice(0, 3900), disable_web_page_preview: true, ...(asHtml ? { parse_mode: 'HTML' } : {}) }));
  write(html);
  const args = ['-s', '-m', '30', ...(cfg().telegram.proxy ? ['-x', cfg().telegram.proxy] : []), '-X', 'POST', '-H', 'content-type: application/json',
    '--data-binary', `@${body}`, `https://api.telegram.org/bot${botToken()}/sendMessage`];
  const once = () => new Promise((resolve) => {
    execFile('curl.exe', args, { windowsHide: true }, (err, out) => {
      resolve({ ok: !err && /"ok":true/.test(out || ''), why: err ? `exit ${err.code}` : (out || '').slice(0, 200) });
    });
  });
  // 10/10 约面试的提醒丢过一次（代理偶发超时），失败隔 20 秒再试，共 4 次
  return (async () => {
    const fails = [];
    for (let i = 0; i < 4; i++) {
      if (i) await new Promise((r) => setTimeout(r, 20000));
      const r = await once();
      if (r.ok) return true;
      fails.push(r.why);
      if (html && /can't parse|parse entities/i.test(r.why)) { html = false; write(false); i--; }   // 排版出错不算一次失败，换纯文本马上重发
    }
    appendFileSync(path.join(DATA, 'push-failed.txt'), `${bj()} 4 次都失败：${fails.join(' / ')}
${text}

`);
    return false;
  })();
}

const plain = (t) => t.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// ---------- 用户是不是正看着桌面 2（编号从 0 数，1 = 桌面 2） ----------
export function ownerOnDesk2() { return Promise.resolve(false); }   // 作者自用的「虚拟桌面」判断，公开版不用

// ---------- 收件箱用的数据（10/16 加，给 inbox.mjs 看）----------
// 用户 10/16：「你怎么回复的、有什么消息，都是你在干，我一点进度和内容都不知道」
// 盯梢每读一次列表、每点开一个会话、每发一句话，都落一份到 data\ 里，收件箱页面照着画
export const STORE = path.join(DATA, 'convs');
mkdirSync(STORE, { recursive: true });
const keyFile = (key) => path.join(STORE, Buffer.from(key).toString('base64url').slice(0, 180) + '.json');

/** 消息列表快照：一个平台一个文件，整份覆盖 */
export function saveList(pid, items) {
  writeFileSync(path.join(DATA, `list-${pid}.json`), JSON.stringify({ at: bj().slice(0, 19), items }));
}
/** 点开会话读到的聊天记录（最近 14 条），一个会话一个文件 */
export function saveConv(key, conv) {
  writeFileSync(keyFile(key), JSON.stringify({ key, at: bj().slice(0, 19), ...conv }));
}
export function loadConv(key) {
  try { return JSON.parse(readFileSync(keyFile(key), 'utf8')); } catch { return null; }
}
/** 谁发的：auto = 盯梢自动回，manual = 用户在收件箱里手动回 */
export function recordSent(key, text, by) {
  appendFileSync(path.join(DATA, 'sent.jsonl'), JSON.stringify({ at: bj().slice(0, 19), key, text, by }) + '\n');
  const c = loadConv(key);
  if (c) { c.msgs = [...(c.msgs || []), { me: true, text, by }]; c.at = bj().slice(0, 19); writeFileSync(keyFile(key), JSON.stringify(c)); }
}
/** 盯梢此刻在干嘛（收件箱顶上那行状态） */
export function setStatus(patch) {
  const f = path.join(DATA, 'status.json');
  let s = {};
  try { s = JSON.parse(readFileSync(f, 'utf8')); } catch {}
  Object.assign(s, patch, { updated: bj().slice(0, 19) });
  writeFileSync(f, JSON.stringify(s));
}
/** 用户在收件箱点了「这家我自己回」的会话：盯梢不替他回 */
export function manualOnly() {
  try { return new Set(JSON.parse(readFileSync(path.join(DATA, 'manual-only.json'), 'utf8'))); } catch { return new Set(); }
}

// 盯梢和收件箱共用浏览器页面：同一时间只能一个在点。谁拿到锁谁动手，另一个等
const LOCK = path.join(DATA, 'cdp.lock');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
export async function lock(who, waitMs = 120000) {
  const end = Date.now() + waitMs;
  for (;;) {
    try { writeFileSync(LOCK, JSON.stringify({ who, pid: process.pid, t: Date.now() }), { flag: 'wx' }); return true; }
    catch {
      let l = null;
      try { l = JSON.parse(readFileSync(LOCK, 'utf8')); } catch {}
      // 拿锁的进程没了，或者拿了 16 分钟还不放（一轮最多 15 分钟）：当作死锁，抢过来
      if (!l || !alive(l.pid) || Date.now() - l.t > 16 * 60e3) { try { unlinkSync(LOCK); } catch {} continue; }
      if (Date.now() > end) return false;
      await sleep(1500);
    }
  }
}
export function unlock() {
  try { const l = JSON.parse(readFileSync(LOCK, 'utf8')); if (l.pid === process.pid) unlinkSync(LOCK); } catch {}
}
export const lockHolder = () => { try { const l = JSON.parse(readFileSync(LOCK, 'utf8')); return alive(l.pid) ? l : null; } catch { return null; } };
