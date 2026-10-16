// 插件宿主：找岗位（51job / 智联）、网申公告、猎聘 / BOSS 的评分都要调求职插件里的函数，
// 插件跑不进桌面助手（Electron 只支持很少一部分 chrome.* 接口），所以这里按需拉一个无头浏览器把插件装进去：
//   浏览器：设置里的 browserPath → 本机 Chrome → Edge（Win10/11 自带）
//   资料目录：<数据目录>\watcher\.chrome-plugin（插件存储也在这里，换电脑带走数据目录就行）
//   调试口：挑一个空闲端口，写进 <数据目录>\watcher\plugin-host.json，别的脚本从这里读，不写死（免得和用户自己的调试口撞）
//   装插件：--enable-unsafe-extension-debugging + CDP Extensions.loadUnpacked(<安装目录>\extension)
//
// ⚠️ 重载插件只许 Extensions.loadUnpacked 原地重载（同一路径 = 同一个 id = 存储还在）。
//    绝不调 Extensions.uninstall：卸载会把插件存储整个清空（待审、设置、去重记录全没）。
//
// 以后：评分 / 网申引擎可以改成在 Node 里给插件模块做一个 chrome 替身直接 import（桌面助手的网申填表就是这么跑的），不用再开浏览器。
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { cfg, DATA, EXTENSION_DIR } from './config.mjs';

const STATE = path.join(DATA, 'plugin-host.json');
const PROFILE = path.join(DATA, '.chrome-plugin');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CANDIDATES = () => {
  const env = process.env;
  const roots = [env['PROGRAMFILES'], env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
  return [
    ...roots.map((r) => path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe')),
    ...roots.map((r) => path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
  ];
};

/** 用哪个浏览器：设置里写了就用它，否则 Chrome 优先、Edge 兜底；都没有返回 null */
export function findBrowser() {
  const own = cfg().browserPath;
  if (own && existsSync(own)) return own;
  return CANDIDATES().find((p) => existsSync(p)) || null;
}

const freePort = () => new Promise((ok, bad) => {
  const s = net.createServer();
  s.once('error', bad);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); });
});
const readState = () => { try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch { return null; } };
async function alive(port) {
  try { const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) }); return r.ok ? await r.json() : null; } catch { return null; }
}

/** 连一个 CDP 端点（浏览器级或页面级）发一条命令 */
async function browserCmd(wsUrl, method, params = {}) {
  const ws = new WebSocket(wsUrl);
  await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = () => bad(new Error('连不上插件浏览器的调试口')); });
  try {
    return await new Promise((ok, bad) => {
      const t = setTimeout(() => bad(new Error(`${method} 30 秒没回`)), 30000);
      ws.onmessage = (m) => { const j = JSON.parse(m.data); if (j.id === 1) { clearTimeout(t); j.error ? bad(new Error(j.error.message)) : ok(j.result); } };
      ws.send(JSON.stringify({ id: 1, method, params }));
    });
  } finally { ws.close(); }
}

/**
 * 确保插件浏览器在跑、插件装好，返回 { ok, port, extId, browser } 或 { ok:false, why, fix }。
 * 已经在跑就直接复用（不重开、不重装）。
 */
export async function ensure() {
  const st = readState();
  if (st?.port && st.extId && (await alive(st.port))) return { ok: true, ...st };
  if (st?.loginPid && pidAlive(st.loginPid)) return { ok: false, why: `${st.loginSite || ''} 登录窗口还开着`, fix: '在弹出的窗口里登好以后把它关掉，再点一次' };
  const browser = findBrowser();
  if (!browser) return { ok: false, why: '这台电脑上没找到 Chrome 或 Edge', fix: '装一个 Chrome（google.cn/chrome），装好后重开桌面助手；找岗位、网申公告、岗位评分要靠它在后台跑求职插件' };
  if (!existsSync(path.join(EXTENSION_DIR, 'manifest.json'))) return { ok: false, why: `安装目录里缺求职插件（${EXTENSION_DIR}）`, fix: '重新解压一遍桌面助手的压缩包' };
  mkdirSync(PROFILE, { recursive: true });
  const port = await freePort();
  const child = spawn(browser, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${PROFILE}`,
    '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check',
    '--window-size=1920,1080', '--lang=zh-CN', '--accept-lang=zh-CN,zh', 'about:blank',
  ], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  let ver = null;
  for (let i = 0; i < 40 && !ver; i++) { await sleep(250); ver = await alive(port); }
  if (!ver) return { ok: false, why: '插件浏览器没起来', fix: '关掉所有桌面助手窗口再开一次；还不行在设置里把浏览器换成 Chrome' };
  let extId;
  try { extId = (await browserCmd(ver.webSocketDebuggerUrl, 'Extensions.loadUnpacked', { path: EXTENSION_DIR })).id; }
  catch (e) { return { ok: false, why: `求职插件装不进后台浏览器：${e.message}`, fix: '把浏览器更新到最新版（Chrome 或 Edge 都行）' }; }
  const out = { port, extId, browser, pid: child.pid, at: new Date().toISOString() };
  writeFileSync(STATE, JSON.stringify(out, null, 1));
  return { ok: true, ...out };
}

// 插件在后台浏览器里筛 51job 要登着 51job。用户只在桌面助手「更多 › 51job」里扫一次码，
// 每次扫之前把桌面助手里 51job 的 cookie 复制进后台浏览器（BOSS / 智联不这么做：它们同一时间只认一处登录，复制过去会把桌面助手挤掉，
// 所以 BOSS / 智联的搜和投都直接在桌面助手的登录区里做，见 hunt-boss.mjs / hunt-zhilian.mjs）
const LOGIN_SITES = {
  '51job': { match: /51job\.com/, urls: ['https://www.51job.com/', 'https://we.51job.com/', 'https://i.51job.com/', 'https://jobs.51job.com/', 'https://login.51job.com/', 'https://cupid.51job.com/'], port: (c) => c.ports.j51, name: '51job' },
};
/** 把桌面助手里某个平台的登录复制进插件浏览器。返回 { ok, n } 或 { ok:false, why, fix } */
export async function syncLogin(site) {
  const s = LOGIN_SITES[site];
  if (!s) return { ok: false, why: `不认识的平台 ${site}` };
  const h = await ensure();
  if (!h.ok) return h;
  let tabs = [];
  try { tabs = await (await fetch(`http://127.0.0.1:${s.port(cfg())}/json/list`, { signal: AbortSignal.timeout(3000) })).json(); } catch {}
  const src = tabs.find((t) => t.type === 'page' && s.match.test(t.url));
  if (!src) return { ok: false, why: `桌面助手里没开着 ${s.name} 的页面`, fix: `在桌面助手「更多 › ${s.name}」里扫码登录一次` };
  const got = await browserCmd(src.webSocketDebuggerUrl, 'Network.getCookies', { urls: s.urls });
  const cookies = (got.cookies || []).map((k) => ({
    name: k.name, value: k.value, domain: k.domain, path: k.path, secure: k.secure, httpOnly: k.httpOnly,
    ...(k.sameSite ? { sameSite: k.sameSite } : {}), ...(k.expires > 0 ? { expires: k.expires } : {}),
  }));
  if (!cookies.length) return { ok: false, why: `桌面助手里的 ${s.name} 还没登录`, fix: `在桌面助手「更多 › ${s.name}」里扫码登录一次` };
  const ver = await alive(h.port);
  await browserCmd(ver.webSocketDebuggerUrl, 'Storage.setCookies', { cookies });
  return { ok: true, n: cookies.length };
}

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/**
 * 退路：登录复制不成（桌面助手里没登、或网站不认复制过来的登录）时，把后台浏览器换成看得见的窗口打开登录页，让用户在里面登一次。
 * 登好关掉窗口，下次 ensure() 会照常无头启动，登录留在资料目录里。只按 PID 关自己开的后台浏览器。
 */
const LOGIN_PAGES = { '51job': 'https://login.51job.com/login.php' };
export async function openLogin(site, { headless = false } = {}) {
  const url = LOGIN_PAGES[site];
  if (!url) return { ok: false, why: `不认识的平台 ${site}` };
  const browser = findBrowser();
  if (!browser) return { ok: false, why: '这台电脑上没找到 Chrome 或 Edge' };
  const st = readState();
  if (st?.pid && pidAlive(st.pid)) {   // 同一个资料目录同时只能开一个浏览器，先关掉后台那个
    await new Promise((ok) => spawn('taskkill', ['/PID', String(st.pid), '/T', '/F'], { windowsHide: true }).on('exit', ok));
    await sleep(800);
  }
  mkdirSync(PROFILE, { recursive: true });
  const child = spawn(browser, [...(headless ? ['--headless=new'] : []), `--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check', '--new-window', url],
    { detached: true, stdio: 'ignore', windowsHide: headless });
  child.unref();
  writeFileSync(STATE, JSON.stringify({ loginPid: child.pid, loginSite: site, at: new Date().toISOString() }, null, 1));
  return { ok: true, pid: child.pid, note: `弹出了 ${site} 登录窗口：在里面登好，关掉窗口，再点一次扫描` };
}

/** 插件侧边栏页的地址（hunt.mjs 等用 CDP 连它，在它的上下文里调插件函数） */
export const panelUrl = (extId) => `chrome-extension://${extId}/src/sidepanel/panel.html`;
/** 不拉起浏览器，只看现在的状态（/api/env 用） */
export async function status() {
  const st = readState();
  const up = st?.port ? Boolean(await alive(st.port)) : false;
  return { browser: findBrowser(), running: up, port: up ? st.port : null, extId: up ? st.extId : null };
}
