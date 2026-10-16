// 求职助手桌面版（HR Desk）：今天 / 投递 / 消息 / 找岗位 / 网申 + 内嵌各招聘平台，一个窗口。
// v0.6.0 顶栏：今天（默认）｜投递｜消息｜找岗位｜网申｜更多▾（平台页），右侧常驻盯梢状态条（读 /api/model 的 status）
// 内核开调试口 9401（协议和 Chrome 一样），盯梢脚本（hr-watch）只要把 BOSS 端口指过来就能接着用。
const { app, BrowserWindow, WebContentsView, Tray, Menu, nativeImage, shell, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { HOME, DATA, WATCHER, WATCH_DATA } = require('./paths.js');
const campus = require('./campus.js');
const setup = require('./setup.js');
const { dialog } = require('electron');

// 端口一般不用改；同一台电脑上要并排开两份（比如测试）时用环境变量换开
// 端口跟 watcher 读同一份 config.json 的 ports（软件的调试口 = ports.boss，收件箱 = ports.inbox），两边改一处就对上
const PORTS = (() => { try { return require('./setup.js').read().ports || {}; } catch { return {}; } })();
const CDP_PORT = Number(process.env.HRDESK_CDP_PORT) || Number(PORTS.boss) || 9401;
const INBOX = process.env.HRDESK_INBOX || `http://127.0.0.1:${Number(PORTS.inbox) || 8790}`;
const HR_WATCH = WATCHER;
const BOSS_CHAT = 'https://www.zhipin.com/web/geek/chat';
const BAR_H = 44;
// 登录状态、日志都放 <安装目录>\data（打包成 exe 后 __dirname 在 resources/app 里，不能放那儿）
const ROOT = DATA;

// 对外装成同版本的普通 Chrome：UA 里不带 Electron / 软件名，版本号跟内核真实版本一致（版本对不上更容易被认出来）
const CHROME_MAJOR = process.versions.chrome.split('.')[0];
const UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;
// 品牌列表照 Chromium 自己的 GREASE 算法排（user_agent.cc：乱码字符、版本、顺序都由大版本号决定）。
// 拿 155 的真 Chrome 和 152 的 Electron 原生值对过：152 → [Chromium, Not?A_Brand, Google Chrome]
function brandList(full) {
  const major = Number(CHROME_MAJOR);
  const chars = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'];
  const gv = ['8', '99', '24'][major % 3];
  const ver = full ? process.versions.chrome : CHROME_MAJOR;
  const order = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]][major % 6];
  const out = [];
  out[order[0]] = { brand: `Not${chars[major % 11]}A${chars[(major + 1) % 11]}Brand`, version: full ? `${gv}.0.0.0` : gv };
  out[order[1]] = { brand: 'Chromium', version: ver };
  out[order[2]] = { brand: 'Google Chrome', version: ver };
  return out;
}
const UA_META = {
  brands: brandList(false),
  fullVersionList: brandList(true),
  fullVersion: process.versions.chrome, platform: 'Windows', platformVersion: '10.0.0', architecture: 'x86', model: '', mobile: false, bitness: '64', wow64: false,
};

app.setPath('userData', path.join(ROOT, 'profile'));
app.setAppUserModelId('HR Desk');
app.userAgentFallback = UA;
app.commandLine.appendSwitch('remote-debugging-port', String(CDP_PORT));
app.commandLine.appendSwitch('lang', 'zh-CN');
// 后台标签不许睡：BOSS 页被收件箱盖住时也要照常收消息、能被盯梢点
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// 参数带给已经开着的那个（Chromium 会吞掉第二个实例 argv 里的 --xxx，所以走 additionalData）
if (!app.requestSingleInstanceLock({ argv: process.argv })) { app.quit(); process.exit(0); }

let win, bar, panel, tray, quitting = false;
const PANEL_W = 380;
const views = {};          // id -> WebContentsView
let active = 'today';
let badge = 0;                // 消息：要你处理的家数（/api/today 读不到时顶替「今天」的数）
let counts = { today: null, todayHot: false, apps: null };   // 顶栏标签上的数字
let watchSt = null;           // /api/model 的 status
let watchFix = {};            // /api/model 的 watch（数据层给的人话修法）：平台 id → fix

const ZL_IM = 'https://i.zhaopin.com/im';
const J51_APPLY = 'https://i.51job.com/userset/my_apply.php?type=sh&tagType=ms&lang=c';

// worker：盯梢专用页，不在顶栏露面。你在对应标签里随便点也不会把盯梢的页面带走。
// keep：盯梢页允许停留的网址（含登录页），跑出去了就拉回 url
// page：收件箱后台（8790）的页面，互相跳转时切到对应标签；more：收进顶栏「更多▾」
const TABS = [
  { id: 'today', name: '今天', url: `${INBOX}/today`, page: '/today' },
  { id: 'apps', name: '投递', url: `${INBOX}/apps`, page: '/apps' },
  { id: 'inbox', name: '消息', url: `${INBOX}/`, page: '/' },
  { id: 'hunt', name: '找岗位', url: `${INBOX}/hunt`, page: '/hunt' },
  // 网申：各家招聘系统的登录单独存一个区，和平台互不影响；右边贴着填写面板（campus-panel.html）
  { id: 'apply', name: '网申', url: pathToFileURL(path.join(__dirname, 'campus-home.html')).href, partition: 'persist:campus' },
  { id: 'boss', name: 'BOSS 直聘', more: true, url: BOSS_CHAT, partition: 'persist:boss', login: /zhipin\.com\/web\/geek/, site: /(^|\.)zhipin\.com$/ },
  { id: 'zl', name: '智联', more: true, url: ZL_IM, partition: 'persist:jobs', login: /i\.zhaopin\.com/, site: /(^|\.)zhaopin\.com$/ },
  { id: 'j51', name: '51job', more: true, url: J51_APPLY, partition: 'persist:jobs', login: /i\.51job\.com/, site: /(^|\.)51job\.com$/ },
  { id: 'lp', name: '猎聘', more: true, url: 'https://c.liepin.com/', partition: 'persist:liepin', login: /c\.liepin\.com/, site: /(^|\.)liepin\.com$/ },
  // 企查查：和背调用的隐藏页同一个登录区（persist:research），你在这里登一次，背调就能读法人、注册资本、参保人数
  { id: 'qcc', name: '企查查', more: true, url: 'https://www.qcc.com/', partition: 'persist:research', site: /(^|\.)qcc\.com$/ },
  { id: 'bossw', worker: 'boss', url: BOSS_CHAT, partition: 'persist:boss', keep: /zhipin\.com\/web\/(geek\/chat|user)/ },
  { id: 'zlw', worker: 'zhaopin', url: ZL_IM, partition: 'persist:jobs', keep: /i\.zhaopin\.com\/im|passport\.zhaopin\.com|zhaopin\.com\/.*login/ },
  // 猎聘的消息是 c.liepin.com 首页上的弹窗（页面里挂着 MQTT 长连接），盯梢专用页常驻首页；登录态看 cookie imId_0
  { id: 'lpw', worker: 'lp', url: 'https://c.liepin.com/', partition: 'persist:liepin', keep: /c\.liepin\.com|passport\.liepin\.com|www\.liepin\.com\/(login|user)/ },
  { id: 'j51w', worker: 'j51', url: J51_APPLY, partition: 'persist:jobs', keep: /i\.51job\.com\/userset\/my_apply|login\.51job\.com|51job\.com\/.*login/ },
];
const WORKER_OF = { boss: 'bossw', zl: 'zlw', j51: 'j51w', lp: 'lpw' };   // 顶栏标签 → 它对应的盯梢页（看登录状态用）

// 盯梢页被带离（不是掉登录）就拉回来。Electron 的调试口不支持新开标签（Target.createTarget 返回 Not supported），
// 盯梢没法像在 Chrome 里那样自己补开页面，所以这里必须一直各留一张
function guardWorker() {
  for (const t of TABS.filter((x) => x.worker)) {
    const wc = views[t.id]?.webContents;
    if (!wc || wc.isLoading()) continue;
    const u = wc.getURL();
    if (!u || u === 'about:blank' || t.keep.test(u)) continue;
    log(`盯梢页 ${t.id} 跑到了`, u, '拉回');
    wc.loadURL(t.url);
  }
}

function log(...a) {
  try { fs.appendFileSync(path.join(ROOT, 'desk.log'), `${new Date().toISOString()} ${a.join(' ')}\n`); } catch {}
}

// 后台（watcher）用软件自带的 Node 跑：Electron 带 ELECTRON_RUN_AS_NODE=1 就是一个完整的 Node（v24，自带 sqlite），朋友电脑上不用另装 Node
const NODE_ENV = { ...process.env, ELECTRON_RUN_AS_NODE: '1', HRDESK_HOME: HOME, HRDESK_DATA: DATA };
function runWatcher(script, args = []) {
  const out = fs.openSync(path.join(DATA, `${path.basename(script, '.mjs')}.out`), 'a');
  spawn(process.execPath, [path.join(HR_WATCH, script), ...args], { cwd: HR_WATCH, env: NODE_ENV, detached: true, stdio: ['ignore', out, out], windowsHide: true }).unref();
}
// 收件箱服务（inbox.mjs）没起就拉起来；盯梢（watch.mjs）没在跑也拉起来（还没填设置时不拉，等向导填完）
async function ensureInbox() {
  try { await fetch(`${INBOX}/api/variants`, { signal: AbortSignal.timeout(2000) }); } catch {
    log(`收件箱后台（${INBOX}）没起，拉起 inbox.mjs`);
    runWatcher('inbox.mjs');
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try { await fetch(`${INBOX}/api/variants`, { signal: AbortSignal.timeout(1000) }); break; } catch {}
    }
  }
  if (!setup.ready()) return;
  try {
    const m = await (await fetch(`${INBOX}/api/model`, { signal: AbortSignal.timeout(8000) })).json();
    if (!m.status?.alive) { log('盯梢没在跑，拉起 watch.mjs'); runWatcher('watch.mjs', ['--quiet-start']); }
  } catch (e) { log('看盯梢状态失败', e.message); }
}

// 真 Chrome 的 window.chrome 有 loadTimes / csi / app，Electron 是空对象；照 puppeteer-extra-plugin-stealth 的做法补上，
// toString 也装成原生函数
const CHROME_STUB = `(() => {
  if (!window.chrome) Object.defineProperty(window, 'chrome', { value: {}, writable: true, configurable: true });
  const c = window.chrome; if (c.loadTimes) return;
  const nat = new WeakSet(); const anon = new WeakSet(); const ts = Function.prototype.toString;
  const fake = function toString() { return nat.has(this) ? 'function ' + (anon.has(this) ? '' : this.name) + '() { [native code] }' : ts.call(this); };
  nat.add(fake); Function.prototype.toString = fake;
  const t0 = performance.timeOrigin / 1000;
  const loadTimes = function loadTimes() { const n = performance.getEntriesByType('navigation')[0] || {}; return { requestTime: t0, startLoadTime: t0, commitLoadTime: t0 + (n.responseStart || 0) / 1000, finishDocumentLoadTime: t0 + (n.domContentLoadedEventEnd || 0) / 1000, finishLoadTime: t0 + (n.loadEventEnd || 0) / 1000, firstPaintTime: t0 + (n.responseEnd || 0) / 1000, firstPaintAfterLoadTime: 0, navigationType: 'Other', wasFetchedViaSpdy: true, wasNpnNegotiated: true, npnNegotiatedProtocol: 'h2', wasAlternateProtocolAvailable: false, connectionInfo: 'h2' }; };
  const csi = function csi() { return { onloadT: Date.now(), startE: Math.round(performance.timeOrigin), pageT: performance.now(), tran: 15 }; };
  const getDetails = function getDetails() { return null; };
  const getIsInstalled = function getIsInstalled() { return false; };
  const runningState = function runningState() { return 'cannot_run'; };
  [loadTimes, csi, getDetails, getIsInstalled, runningState].forEach((f) => nat.add(f));
  [loadTimes, csi].forEach((f) => anon.add(f));   // 真 Chrome 155 实测这两个打印出来是匿名的 function () { [native code] }
  const app = { isInstalled: false, getDetails, getIsInstalled, runningState,
    InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
    RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' } };
  Object.assign(c, { loadTimes, csi, app });
})();`;

// 外部网页统一套 Chrome 的 UA、客户端提示和 window.chrome
async function disguise(wc) {
  wc.setUserAgent(UA);
  const timer = setTimeout(() => log('伪装 10 秒没完成'), 10000);
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    await wc.debugger.sendCommand('Page.enable');
    await wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: CHROME_STUB });
    await wc.debugger.sendCommand('Emulation.setUserAgentOverride', { userAgent: UA, acceptLanguage: 'zh-CN,en-US,en', platform: 'Win32', userAgentMetadata: UA_META });
  } catch (e) { log('伪装失败', e.message); }
  clearTimeout(timer);
}

const failedOnce = new Set();
function makeView(tab) {
  const v = new WebContentsView({
    webPreferences: {
      partition: tab.partition,
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: tab.page ? path.join(__dirname, 'inbox-preload.js') : undefined,
    },
  });
  const wc = v.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    // 网申页里弹的新窗口（登录、下一步）就在网申页里打开，别跑到系统浏览器去丢了登录态
    if (tab.id === 'apply') { if (/^https?:/.test(url)) wc.loadURL(url); return { action: 'deny' }; }
    if (url.startsWith(INBOX)) { routeInbox(url); return { action: 'deny' }; }
    // 「去平台看 / 去平台确认」：BOSS 链接任何页点都进 BOSS 标签；8790 页里点智联 / 51job / 猎聘 / 企查查的链接进对应标签（登录态在那儿）
    if (/zhipin\.com/.test(url)) { openSite(url, 'boss'); return { action: 'deny' }; }
    if (tab.page && openSite(url)) return { action: 'deny' };
    shell.openExternal(url);
    return { action: 'deny' };
  });
  if (tab.page) {
    // 今天 / 投递 / 消息 / 找岗位互相跳转时切标签，不在一个标签里来回换页
    wc.on('will-navigate', (e, url) => {
      if (!url.startsWith(INBOX)) { e.preventDefault(); if (!openSite(url)) shell.openExternal(url); return; }
      if (goTab(url) || pageTab(url) !== tab.id) { e.preventDefault(); routeInbox(url); }
    });
  }
  wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (!isMain || code === -3) return;
    if (!failedOnce.has(tab.id)) log('加载失败', tab.id, code, desc, url);     // 后台没起时每 3 秒重试一次，日志只记第一次
    failedOnce.add(tab.id);
    if (!tab.partition) setTimeout(() => wc.loadURL(tab.url), 3000);
  });
  wc.on('did-finish-load', () => failedOnce.delete(tab.id));
  wc.on('page-title-updated', pushState);
  wc.on('did-navigate', pushState);
  if (tab.worker) wc.on('did-finish-load', writeDesk);
  // Ctrl+1~5 切顶栏五个主标签（今天 / 投递 / 消息 / 找岗位 / 网申），在哪一页里按都行；盯梢专用页不挂
  else wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || !input.control || input.alt || input.shift || !/^[1-5]$/.test(input.key)) return;
    const t = TABS.filter((x) => !x.worker && !x.more)[+input.key - 1];
    if (t) { e.preventDefault(); show(t.id); }
  });
  if (tab.id === 'apply') {
    const tell = () => panel?.webContents.send('campus:url', wc.getURL(), wc.getTitle());
    wc.on('did-navigate', tell); wc.on('did-navigate-in-page', tell); wc.on('page-title-updated', tell);
    wc.debugger.on('detach', (_e, reason) => campus.onDebuggerDetach(reason));
  }
  // 还没加载过任何页面时调试命令会一直挂着不回，所以先开个空白页，伪装好了再进 BOSS
  if (tab.partition) wc.loadURL('about:blank').then(() => disguise(wc)).then(() => wc.loadURL(tab.url));
  else wc.loadURL(tab.url);
  return v;
}

// 告诉盯梢哪几张是它专用的页面（lib.mjs 的 pickTab 读这个文件）
async function writeDesk() {
  const workers = {};
  for (const t of TABS.filter((x) => x.worker)) {
    try { workers[t.worker] = (await views[t.id].webContents.debugger.sendCommand('Target.getTargetInfo')).targetInfo.targetId; } catch {}
  }
  try {
    fs.mkdirSync(WATCH_DATA, { recursive: true });
    fs.writeFileSync(path.join(WATCH_DATA, 'desk.json'), JSON.stringify({ port: CDP_PORT, workers, workerTarget: workers.boss, pid: process.pid, at: new Date().toISOString() }));
  } catch (e) { log('写 desk.json 失败', e.message); }
}

// 8790 的网址属于哪个标签：/today → 今天，/apps → 投递，/hunt → 找岗位，其余（/、/index.html、/?c=…）→ 消息
function pageTab(url) {
  const p = new URL(url).pathname.replace(/\/next\//, '/').replace(/\.html$/, '');
  for (const t of TABS) if (t.page && t.page !== '/' && p.startsWith(t.page)) return t.id;
  return 'inbox';
}
// /?go=boss|zl|51|lp|qcc：8790 页面里「去登录 / 去平台看」切到「更多」里那个平台标签（停在它当前的页面上）
// /?go=campus&url=<编码后的网址>：找岗位里「投」网申 → 切到网申标签并打开那个网址（只认 http / https）；不带 url 就只切标签
const GO = { boss: 'boss', zl: 'zl', 51: 'j51', j51: 'j51', lp: 'lp', qcc: 'qcc', campus: 'apply' };
function goTab(url) { try { return GO[new URL(url).searchParams.get('go')] || null; } catch { return null; } }
function routeInbox(url) {
  const go = goTab(url);
  if (go === 'apply') {
    const target = new URL(url).searchParams.get('url') || '';
    if (/^https?:\/\//i.test(target)) { views.apply.webContents.loadURL(target); show('apply'); hint('在「网申」里打开了，登录后停在表单页，右边点「填这一页」'); }
    else { show('apply'); hint(target ? '这个网申链接不是 http / https 网址，没打开，只切到了「网申」' : '已切到「网申」'); }
    return;
  }
  if (go) { show(go); hint(`已切到「更多 › ${TABS.find((t) => t.id === go).name}」`); return; }
  const id = pageTab(url);
  if (views[id].webContents.getURL() !== url) views[id].webContents.loadURL(url);
  show(id);
  // 带 ?c= 的跳转（今天 / 投递 →「去消息」）告诉你去了哪
  if (id !== 'inbox' || !/[?&]c=/.test(url)) return;
  hint('已切到「消息」，打开了这家的聊天');
}
// 平台网址进对应的平台标签（用那里的登录态）；认不出是哪个平台返回 false
function openSite(url, id) {
  let host = '';
  try { host = new URL(url).hostname; } catch { return false; }
  const t = id ? TABS.find((x) => x.id === id) : TABS.find((x) => x.site?.test(host));
  if (!t) return false;
  views[t.id].webContents.loadURL(url);
  show(t.id);
  hint(`在「更多 › ${t.name}」里打开了`);
  return true;
}
function hint(text) { bar?.webContents.send('hint', text); }

function layout() {
  if (!win) return;
  const [w, h] = win.getContentSize();
  bar.setBounds({ x: 0, y: 0, width: w, height: BAR_H });
  const ch = Math.max(0, h - BAR_H);
  for (const [id, v] of Object.entries(views)) v.setBounds({ x: 0, y: BAR_H, width: id === 'apply' ? Math.max(0, w - PANEL_W) : w, height: ch });
  panel.setBounds({ x: Math.max(0, w - PANEL_W), y: BAR_H, width: PANEL_W, height: ch });
}

// 所有页面一直挂着、一样大，切标签只是把那一页提到最上面（被盖住的页不卸载、不休眠）
let lastPoll = 0;
function show(id) {
  if (!views[id]) return;
  active = id;
  // 切标签时顺手重拉一次角标（你在今天页办完一件再切走，数字马上对上），3 秒内最多一次
  if (Date.now() - lastPoll > 3000) { lastPoll = Date.now(); pollBadge(); }
  win.contentView.addChildView(views[id]);
  if (id === 'apply') win.contentView.addChildView(panel);      // 网申：页面左边、填写面板贴右边
  views[id].webContents.focus();
  pushState();
}

// 平台标签的登录点：看盯梢页（不是你看的那张）在不在登录后的页面上
function loginOf(t) {
  if (!t.login) return null;
  const w = views[WORKER_OF[t.id]]?.webContents;
  return w && !w.isLoading() && t.login.test(w.getURL()) && !/login|passport/.test(w.getURL()) ? 'on' : 'warn';
}
function pushState() {
  if (!bar) return;
  const todayN = counts.today ?? badge;
  const NUM = {
    today: { n: todayN, hot: counts.today == null ? badge > 0 : counts.todayHot, tip: counts.today == null ? `${badge} 家要你处理` : `今天要办 ${todayN} 件${counts.todayHot ? '，有要你亲自接的或已经逾期的' : ''}` },
    apps: { n: counts.apps, tip: counts.apps == null ? '' : `进行中的投递 ${counts.apps} 家` },
  };
  const st = {
    active, version: app.getVersion(),
    tabs: TABS.filter((t) => !t.worker && !t.more).map((t, i) => ({ id: t.id, name: t.name, key: `Ctrl+${i + 1}`, ...(NUM[t.id] || {}) })),
    more: TABS.filter((t) => t.more).map((t) => ({ id: t.id, name: t.name, login: loginOf(t) })),
    watch: watchView(),
  };
  bar.webContents.send('state', st);
}

// 盯梢状态 → 顶栏状态条：几个平台、各自实时还是定时、下一轮几点；坏了说是哪个、怎么办
const PLAT_NAME = { boss: 'BOSS', zl: '智联', 51: '51job', lp: '猎聘' };
const PLAT_TAB = { boss: 'boss', zl: 'zl', 51: 'j51', lp: 'lp' };
function watchView() {
  const s = watchSt;
  if (!s) return null;
  const plats = ['boss', 'zl', '51', 'lp'].filter((id) => s[`p_${id}`]).map((id) => {
    const p = s[`p_${id}`], lv = s[`live_${id}`];
    const live = !!lv?.ok && /实时/.test(lv.note || '实时');
    const mode = live ? '实时' : id === '51' ? '每 15 分' : '每 5 分';   // 盯梢一轮约 5 分钟，51job 网页没长连接、15 分钟查一次
    return { id, name: PLAT_NAME[id], ok: !!p.ok, live, mode, note: `${PLAT_NAME[id]}：${p.note || ''}${p.at ? ' · ' + p.at : ''}${lv && !lv.ok ? `（实时断了：${lv.note || ''}）` : ''}` };
  });
  const broken = plats.filter((p) => !p.ok);
  const staleMin = s.updated ? Math.round((Date.now() - Date.parse(s.updated + '+08:00')) / 60e3) : 0;
  const busy = s.alive && !s.paused && /扫|看|想|发|等收件箱/.test(s.doing || '');
  const v = { plats, busy, level: 'ok', dot: 'on', title: '盯梢', when: '', tip: '' };
  if (!s.alive && !setup.ready()) Object.assign(v, { level: 'idle', dot: '', title: '盯梢还没开始', when: '填完设置会自动开' });   // 第一次用：别一上来就报红
  else if (!s.alive) Object.assign(v, { level: 'bad', dot: 'bad', title: '盯梢没开', when: 'HR 的消息现在没人看 · 点这里打开' });
  else if (s.paused) Object.assign(v, { level: 'warn', dot: 'warn', title: '盯梢暂停中', when: '不看也不回 · 点这里继续' });
  else if (broken.length) {
    const b = broken[0];
    const what = /登录/.test(b.note) ? '登录掉了，点这里去扫码' : /验证/.test(b.note) ? '弹了人机验证，点这里去处理' : '连不上，点这里看看';
    Object.assign(v, { level: 'bad', dot: 'bad', title: `${b.name} ${what}`, when: broken.length > 1 ? `另有 ${broken.length - 1} 个平台也有问题` : '' });
  } else if (staleMin > 20) Object.assign(v, { level: 'warn', dot: 'warn', title: `盯梢 ${staleMin} 分钟没动静`, when: '可能卡住了 · 点这里立即扫一轮' });
  else v.when = busy ? `正在：${s.doing}` : s.next ? `下一轮 ${s.next}` : '';
  v.tip = [`正在：${s.doing || '—'}`, s.roundAt && `上一轮 ${s.roundAt}`, s.next && `下一轮约 ${s.next}`, ...plats.map((p) => `${p.ok ? '●' : '✕'} ${p.note}`)].filter(Boolean).join('\n');
  return v;
}

const getJson = async (p) => (await fetch(`${INBOX}${p}`, { signal: AbortSignal.timeout(8000) })).json();
async function pollBadge() {
  try {
    const m = await getJson('/api/model');
    badge = (m.convs || []).filter((c) => c.status === 'need').length;
    watchSt = m.status || null;
    watchFix = Object.fromEntries((m.watch?.platforms || []).filter((p) => p.fix).map((p) => [p.id, p.fix]));
  } catch { watchSt = null; }
  // 今天要办几件（四组加起来）、有没有要你亲自接的 / 逾期的；投递进行中几家。接口还没上线时就不显示数字
  try {
    const t = await getJson('/api/today');
    const gs = Array.isArray(t.groups) ? t.groups : null;
    // 优先用数据层给的 count（= 今天页上显示的件数），没有这个字段时退回四组加起来
    counts.today = Number.isFinite(t.count) ? t.count : gs ? gs.reduce((a, g) => a + (g.items?.length || 0), 0) : null;
    counts.todayHot = !!gs?.some((g) => (g.id === 'you' || g.id === 'overdue') && g.items?.length);
  } catch { counts.today = null; }
  try { const a = await getJson('/api/tracker?view=active'); counts.apps = a.counts?.active ?? null; } catch { counts.apps = null; }
  const n = counts.today ?? badge;
  tray?.setToolTip(n ? `HR Desk · 今天 ${n} 件事要你办` : 'HR Desk');
  win?.setTitle(n ? `(${n}) HR Desk` : 'HR Desk');
  pushState();
}

// 盯梢的几个动作走收件箱后台现成的接口（和收件箱页面上原来那几个按钮一样）
async function watchPost(p, body = {}) {
  const r = await fetch(`${INBOX}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`后台回了 ${r.status}`);
}
async function watchAct(what) {
  try {
    if (what === 'kick') { await watchPost('/api/kick'); hint('好，盯梢 5 秒内开始扫一轮'); }
    if (what === 'pause') { await watchPost('/api/pause', { on: true }); hint('暂停了：盯梢不看也不回，点状态条「继续」恢复'); }
    if (what === 'resume') { await watchPost('/api/pause', { on: false }); hint('继续盯了'); }
    if (what === 'start') { await watchPost('/api/watch', { on: true }); hint('盯梢打开了，十几秒后状态条变绿'); }
  } catch (e) { log('盯梢操作失败', what, e.message); hint(`没做成：收件箱后台没响应（${e.message}）`); }
  setTimeout(pollBadge, 1500);
}

// 顶栏的两个下拉：更多▾（平台页）、盯梢状态条（立即扫一轮 / 暂停）。用系统菜单，不会被 44px 高的顶栏裁掉
function popMenu(which, x, y) {
  let items;
  if (which === 'more') {
    items = TABS.filter((t) => t.more).map((t) => {
      const lg = loginOf(t);
      return { label: `${t.name}${lg === 'warn' ? '    要扫码登录' : ''}`, type: 'radio', checked: active === t.id, click: () => show(t.id) };
    });
    items.push({ type: 'separator' }, { label: '设置（Key、城市、简历…）', click: openSetup });
  } else {
    const s = watchSt, v = watchView();
    if (!s) items = [{ label: '读不到盯梢状态（收件箱后台没响应）', enabled: false }];
    else {
      items = [{ label: s.alive ? `正在：${s.doing || '—'}${s.roundAt ? ` · 上一轮 ${s.roundAt}` : ''}` : '盯梢没开，HR 的消息现在没人看', enabled: false }];
      for (const p of v.plats) {
        if (p.ok) items.push({ label: `● ${p.name} · ${p.mode} · ${(s[`p_${p.id}`].note || '')}`, enabled: false });
        else items.push({ label: `✕ ${p.name}：${s[`p_${p.id}`].note || '连不上'} → ${watchFix[p.id] || `去${p.name}页处理`}`, click: () => show(PLAT_TAB[p.id]) });
      }
      items.push({ type: 'separator' });
      if (!s.alive) items.push({ label: '打开盯梢', click: () => watchAct('start') });
      else {
        items.push({ label: '立即扫一轮', enabled: !s.paused, click: () => watchAct('kick') });
        items.push(s.paused ? { label: '继续盯', click: () => watchAct('resume') } : { label: '暂停（不看也不回）', click: () => watchAct('pause') });
      }
    }
  }
  Menu.buildFromTemplate(items).popup({ window: win, x, y });
}

// 设置向导页：没填设置时一打开就显示；之后从「更多 › 设置」进
let setupView = null;
function openSetup() {
  if (!setupView) {
    setupView = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'setup-preload.js'), contextIsolation: true, sandbox: true } });
    setupView.webContents.loadFile(path.join(__dirname, 'setup.html'));
    setupView.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
    views.setup = setupView;
    layout();
  } else setupView.webContents.reload();
  show('setup');
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 900, minHeight: 600,
    ...(process.env.HRDESK_WIN_XY ? { x: +process.env.HRDESK_WIN_XY.split(',')[0], y: +process.env.HRDESK_WIN_XY.split(',')[1] } : {}),
    title: 'HR Desk', icon: path.join(__dirname, 'icon.ico'),
    autoHideMenuBar: true, backgroundColor: '#f6f7f9', show: false,
  });
  win.setMenuBarVisibility(false);
  bar = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'bar-preload.js'), contextIsolation: true, sandbox: true } });
  win.contentView.addChildView(bar);
  bar.webContents.loadFile(path.join(__dirname, 'bar.html'));
  bar.webContents.on('did-finish-load', pushState);
  panel = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'campus-preload.js'), contextIsolation: true, sandbox: true } });
  panel.webContents.loadFile(path.join(__dirname, 'campus-panel.html'));
  win.contentView.addChildView(panel);
  for (const t of [...TABS].reverse()) { views[t.id] = makeView(t); win.contentView.addChildView(views[t.id]); }
  campus.init({ webContents: () => views.apply.webContents, activate: () => show('apply'), backgroundPage });
  layout();
  if (setup.ready()) show('today'); else openSetup();
  win.on('resize', layout);
  win.once('ready-to-show', () => { if (!process.argv.includes('--hidden')) win.show(); });
  // 关窗口 = 收进托盘，BOSS 页继续在后台跑；真退出走托盘菜单
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'icon.ico')));
  tray.setToolTip('HR Desk');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 HR Desk', click: () => { win.show(); win.focus(); } },
    { label: '看 BOSS 页', click: () => { win.show(); show('boss'); } },
    { type: 'separator' },
    { label: '退出（BOSS 页会关掉，盯梢连不上 BOSS）', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', () => { win.isVisible() && win.isFocused() ? win.hide() : (win.show(), win.focus()); });
}

ipcMain.on('tab', (_e, id) => show(id));
ipcMain.on('menu', (_e, which, x, y) => popMenu(which, x, y));

// 设置向导
ipcMain.handle('setup:get', async () => {
  const c = setup.read();
  let env = null;            // 后台报的环境：找岗位 / 网申要用的浏览器找到没有
  try { env = await (await fetch(`${INBOX}/api/env`, { signal: AbortSignal.timeout(3000) })).json(); } catch {}
  return {
    ready: setup.ready(), env,
    form: { apiKey: c.deepseek?.apiKey || '', city: c.city || '', intro: c.intro || '', pronoun: c.pronoun || '他', keywords: (c.keywords || []).join('\n'),
      resumeText: c.resumeText || '', criteria: c.criteria || '', salaryExpect: c.salaryExpect || '', nearDistricts: (c.nearDistricts || []).join('，'),
      portfolio: c.portfolio || '', blacklist: (c.blacklist || []).join('\n'), wechatAlt: c.wechatAlt || '', tgToken: c.telegram?.token || '', tgChat: c.telegram?.chatId || '', tgProxy: c.telegram?.proxy || '', resume: c.resume || null },
  };
});
ipcMain.handle('setup:save', async (_e, form) => {
  const c = setup.save(form);
  await campus.syncConfig(setup.pluginConfig(c));
  log('设置已保存', setup.missing(c).length ? `还差 ${setup.missing(c).join('、')}` : '齐了');
  if (setup.ready(c)) ensureInbox();          // 填齐了就把盯梢拉起来
  return { missing: setup.missing(c) };
});
const keyCfg = (apiKey) => ({ ...setup.pluginConfig(), apiKey: String(apiKey || '').trim() });
ipcMain.handle('setup:test', (_e, apiKey) => campus.testKey(keyCfg(apiKey)));
ipcMain.handle('setup:parse', (_e, text, apiKey) => campus.parseResume(String(text || ''), keyCfg(apiKey)));
ipcMain.handle('setup:pickResume', async () => {
  const r = await dialog.showOpenDialog(win, { title: '选简历文件', filters: [{ name: '文本', extensions: ['txt', 'md'] }], properties: ['openFile'] });
  if (r.canceled || !r.filePaths[0]) return null;
  return fs.readFileSync(r.filePaths[0], 'utf8').slice(0, 20000);
});
ipcMain.handle('setup:close', () => { if (setup.ready()) show('today'); });
ipcMain.on('reload', () => views[active]?.webContents.reload());
ipcMain.on('back', () => { const wc = views[active]?.webContents; if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); });
ipcMain.on('devtools', () => views[active]?.webContents.openDevTools({ mode: 'detach' }));

// 背调用的隐藏页（百度、企查查）：不显示的窗口，单独的登录区，同样伪装成 Chrome。读完由背调代码关掉
async function backgroundPage(url, partition = 'persist:research') {
  // 放在屏幕外、不抢焦点、不进任务栏：真窗口照常渲染（隐藏窗口页面会是 hidden 状态，点按钮、截图都不稳）
  const w = new BrowserWindow({ show: false, x: -3200, y: -3200, width: 1366, height: 900, skipTaskbar: true, focusable: false, webPreferences: { partition, backgroundThrottling: false, contextIsolation: true, sandbox: true } });
  const wc = w.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  await wc.loadURL('about:blank');
  await disguise(wc);
  w.showInactive();
  if (url && url !== 'about:blank') wc.loadURL(url).catch(() => {});
  return wc;
}

// 给外部脚本用的「开新标签」：Electron 调试口不支持 /json/new 和 Target.createTarget，
// 这里按登录区各开一个兼容口，脚本照 Chrome 的习惯 PUT /json/new?网址、GET /json/close/id 就行。
// 新标签是屏幕外的小窗口，用完脚本自己关；其余 /json 请求原样转给 9401
const DT = PORTS.deskTabs || {};
const TAB_PORTS = { [DT.boss || 9402]: 'persist:boss', [DT.zhaopin || 9403]: 'persist:jobs', [DT.lp || 9404]: 'persist:liepin', [DT.research || 9405]: 'persist:research' };
const scriptTabs = new Map();             // targetId -> BrowserWindow
function startTabPorts() {
  const http = require('node:http');
  for (const [port, partition] of Object.entries(TAB_PORTS)) {
    http.createServer(async (req, res) => {
      const reply = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
      try {
        const u = new URL(req.url, `http://127.0.0.1:${port}`);
        if (u.pathname === '/json/new') {
          const target = decodeURIComponent(u.search.slice(1)) || 'about:blank';
          const wc = await backgroundPage(target, partition);
          const { targetInfo } = await wc.debugger.sendCommand('Target.getTargetInfo');
          scriptTabs.set(targetInfo.targetId, BrowserWindow.fromWebContents(wc));
          for (let i = 0; i < 20; i++) {
            const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
            const hit = list.find((t) => t.id === targetInfo.targetId);
            if (hit) return reply(200, hit);
            await new Promise((r) => setTimeout(r, 250));
          }
          return reply(500, { error: '新标签开了但调试口里找不到' });
        }
        const close = u.pathname.match(/^\/json\/close\/(.+)$/);
        if (close) {
          const w = scriptTabs.get(close[1]);
          if (!w) return reply(404, 'Unknown target');          // 软件自己的页面不许脚本关
          scriptTabs.delete(close[1]); w.destroy();
          return reply(200, 'Target is closing');
        }
        const r = await fetch(`http://127.0.0.1:${CDP_PORT}${u.pathname}${u.search}`);
        return reply(r.status, await r.text());
      } catch (e) { log('兼容口出错', port, e.message); reply(500, { error: e.message }); }
    }).listen(Number(port), '127.0.0.1').on('error', (e) => log('兼容口起不来', port, e.message));
  }
}

// 收件箱：公司背调
ipcMain.handle('desk:getCheck', (_e, name) => campus.findCheck(name));
ipcMain.handle('desk:check', async (_e, name) => {
  log('背调', name);
  try { return await campus.checkCompany(name, (t) => views.inbox.webContents.send('desk:checkProgress', name, t)); }
  catch (e) { log('背调出错', name, e.message); throw e; }
});

// 网申面板
ipcMain.handle('campus:open', (_e, url) => {
  if (!/^https?:\/\//i.test(url)) throw new Error('只能打开 http / https 网址');
  views.apply.webContents.loadURL(url);
  show('apply');
});
ipcMain.handle('campus:nav', (_e, what) => {
  const wc = views.apply.webContents;
  if (what === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  if (what === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  if (what === 'reload') wc.reload();
});
ipcMain.handle('campus:fill', async (_e, { job, fresh }) => {
  if (!/^https?:/.test(views.apply.webContents.getURL())) throw new Error('先在上面贴网申链接打开表单页');
  log('网申填写', views.apply.webContents.getURL(), job?.company || '');
  try {
    return await campus.fill({ job, fresh }, (t) => panel.webContents.send('campus:progress', t));
  } catch (e) { log('网申填写出错', e.stack || e.message); throw e; }
});
ipcMain.handle('campus:remember', () => campus.remember());
ipcMain.handle('campus:scroll', (_e, key) => campus.scrollTo(key));
ipcMain.handle('campus:last', () => campus.lastReport());
// 网申「我交了」：记进投递表（POST /api/tracker/add）。面板是本地页面，直接 POST 会被收件箱后台的来源检查挡掉，所以从这里转
ipcMain.handle('campus:submitted', async (_e, job) => {
  const company = String(job?.company || '').trim(), title = String(job?.title || '').trim();
  if (!company) throw new Error('先在上面「公司」里填上公司名，投递表要靠它认是哪家');
  const url = /^https?:/.test(views.apply.webContents.getURL()) ? views.apply.webContents.getURL() : '';
  log('网申我交了', company, title, url);
  const rec = { platform: '网申', company, title, url, by: 'me' };
  let r = null;
  try { r = await fetch(`${INBOX}/api/tracker/add`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rec), signal: AbortSignal.timeout(8000) }); } catch {}
  const j = r ? await r.json().catch(() => ({})) : {};
  if (r?.ok && j.ok) { setTimeout(pollBadge, 500); return { id: j.id, now: true }; }
  // 接口没响应 / 还没上线：追加到 applied-log.jsonl（数据层每 5 分钟合并一次进投递表），不丢
  if (!r || r.status === 404 || r.status >= 500) {
    try {
      const pad = (n) => String(n).padStart(2, '0'), d = new Date();
      const at = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      fs.mkdirSync(WATCH_DATA, { recursive: true });
      fs.appendFileSync(path.join(WATCH_DATA, 'applied-log.jsonl'), JSON.stringify({ at, ...rec }) + '\n');
      return { now: false };
    } catch (e) { log('写 applied-log 失败', e.message); }
  }
  throw new Error(`没记上：${j.err || (r ? `后台回了 ${r.status}` : '收件箱后台没响应')}，过一会儿再点一次`);
});
ipcMain.handle('campus:goTab', (_e, id) => { if (TABS.some((t) => t.id === id && !t.worker)) show(id); });

// 再双击一次 = 把窗口叫出来；带 --quit = 真退出（脚本重启软件用，别强杀）
app.on('second-instance', (_e, _argv, _cwd, extra) => {
  const argv = extra?.argv || _argv;
  if (argv.includes('--quit')) { quitting = true; app.quit(); return; }
  if (win) { win.show(); win.focus(); }
});
app.on('window-all-closed', (e) => e.preventDefault());

// 打包版第一次打开：桌面上放一个「求职助手」快捷方式（只放一次，删了不会再放）
function desktopShortcut() {
  if (!app.isPackaged || process.platform !== 'win32') return;
  const flag = path.join(DATA, '.shortcut-made');
  if (fs.existsSync(flag)) return;
  try {
    shell.writeShortcutLink(path.join(app.getPath('desktop'), '求职助手.lnk'), { target: process.execPath, cwd: path.dirname(process.execPath), description: '求职助手（HR Desk）' });
    fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(flag, new Date().toISOString());
  } catch (e) { log('放桌面快捷方式失败', e.message); }
}

app.whenReady().then(async () => {
  desktopShortcut();
  log('启动', `chrome ${process.versions.chrome}`, `cdp ${CDP_PORT}`);
  // 后台最多等 4 秒：没起来也先把窗口开出来，8790 的页面加载失败会自己每 3 秒重试
  await Promise.race([ensureInbox(), new Promise((r) => setTimeout(r, 4000))]);
  createWindow();
  createTray();
  pollBadge();
  setInterval(pollBadge, 15000);
  setInterval(guardWorker, 60000);
  if (process.env.HRDESK_TAB_PORTS !== '0') startTabPorts();
});
