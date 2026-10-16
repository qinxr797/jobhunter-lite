// 网申通道：把求职插件的网申填写引擎（extension/src/lib/autofill-engine.js，v1.2.0）原样搬进 HR Desk 主进程跑。
// 引擎只认 chrome.* 接口，这里给它一个「chrome 替身」，背后换成 Electron 的 webContents / 帧 / 调试器 / 本地文件。
// 插件代码不复制、不改：从 <安装目录>\extension 按路径 import，插件那边改了这边下次启动就用上。
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

const { EXT, DATA } = require('./paths.js');
const STORE = path.join(DATA, 'campus-store.json');      // 网申「记住我填的」、背调结果、插件格式的设置（向导写进来）
const PERSONAL = path.join(DATA, 'personal.json');       // 可选：网申常用的个人信息（政治面貌、英语等级…），向导里填
const TAB_ID = 1;                       // 只有一张网申页，引擎里的 tabId 一律是它

let getWc = () => null;                 // 由 main.js 注入：返回网申页的 webContents
let onActivate = () => {};
let engine = null, store = null, lib = null;

// ---------- 本地存储（替 chrome.storage.local） ----------
function readStore() { try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch { return {}; } }
function writeStore(s) { fs.mkdirSync(path.dirname(STORE), { recursive: true }); fs.writeFileSync(STORE, JSON.stringify(s)); }
const storageLocal = {
  async get(keys) {
    const s = readStore();
    if (keys == null) return s;
    const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    const out = {};
    for (const k of list) if (k in s) out[k] = s[k]; else if (keys && typeof keys === 'object' && !Array.isArray(keys)) out[k] = keys[k];
    return out;
  },
  async set(obj) { writeStore({ ...readStore(), ...obj }); },
  async remove(keys) { const s = readStore(); for (const k of [].concat(keys)) delete s[k]; writeStore(s); },
};

// ---------- 帧 ----------
// frameId：主帧 0，子帧用 Electron 的 frameTreeNodeId（同一页面里稳定）
function frames() {
  const wc = getWc();
  if (!wc) return [];
  return wc.mainFrame.framesInSubtree.map((f) => ({ frame: f, frameId: f === wc.mainFrame ? 0 : f.frameTreeNodeId, url: f.url, parentFrameId: f.parent ? (f.parent === wc.mainFrame ? 0 : f.parent.frameTreeNodeId) : -1 }));
}
function frameById(id) { return frames().find((x) => x.frameId === id)?.frame; }

// 页面一半（content/autofill.js）只在末尾用了 chrome.runtime.onMessage：包一层，把它注册的监听挂到 window.__jfzL 上
// 每次注入都重新读：插件那边改了页面脚本，不用重启软件
function contentScript() {
  const raw = fs.readFileSync(path.join(EXT, 'src/content/autofill.js'), 'utf8');
  return `(() => { const chrome = { runtime: { onMessage: { addListener(fn) { Object.defineProperty(window, '__jfzL', { value: fn, configurable: true }); } } } };\n${raw}\n})();`;
}
async function runInFrame(f, code) { return f.executeJavaScript(code, true); }

// ---------- chrome 替身 ----------
const detachFns = [];
const bgTabs = new Map();               // 背调用的隐藏页：id -> { wc }
let nextBg = 100;
let makeBg = async () => { throw new Error('主进程还没给隐藏页工厂'); };
function makeChrome() {
  return {
    storage: { local: storageLocal, sync: storageLocal, onChanged: { addListener() {} } },
    webNavigation: {
      async getAllFrames() { return frames().map(({ frameId, url, parentFrameId }) => ({ frameId, url, parentFrameId })); },
    },
    scripting: {
      async executeScript({ target, files, func, args }) {
        const bg = bgTabs.get(target.tabId);
        if (bg) return [{ frameId: 0, result: await bg.wc.executeJavaScript(`(${func})(...${JSON.stringify(args || [])})`, true) }];
        const list = target.allFrames ? frames() : frames().filter((x) => x.frameId === 0);
        const code = files ? contentScript() : `(${func})(...${JSON.stringify(args || [])})`;
        const out = [];
        for (const x of list) {
          if (!/^https?:/.test(x.url || '')) continue;
          try { out.push({ frameId: x.frameId, result: await runInFrame(x.frame, code) }); }
          catch (e) { if (!target.allFrames) throw e; }
        }
        return out;
      },
    },
    tabs: {
      async sendMessage(_tabId, msg, opt = {}) {
        const f = frameById(opt.frameId ?? 0);
        if (!f) throw new Error('Could not establish connection. 帧不在了');
        const r = await runInFrame(f, `new Promise((ok) => { const L = window.__jfzL; if (!L) return ok({ __none: true }); if (L(${JSON.stringify(msg)}, {}, ok) !== true) ok(undefined); })`);
        if (r && r.__none) throw new Error('Could not establish connection. Receiving end does not exist.');
        return r;
      },
      async update() { onActivate(); return { id: TAB_ID }; },
      // 背调要的后台标签（百度、企查查）：主进程给一个不挂在窗口上的隐藏页，读完就关
      async create({ url }) {
        const id = nextBg++;
        bgTabs.set(id, { wc: await makeBg(url) });
        return { id, url };
      },
      async remove(id) {
        const b = bgTabs.get(id); bgTabs.delete(id);
        try { const w = require('electron').BrowserWindow.fromWebContents(b.wc); if (w) w.destroy(); else b.wc.close(); } catch {}
      },
      async get(id) {
        const b = bgTabs.get(id);
        if (b) { if (b.wc.isDestroyed()) return null; return { id, url: b.wc.getURL(), status: b.wc.isLoading() ? 'loading' : 'complete' }; }
        const wc = getWc(); return { id: TAB_ID, url: wc?.getURL() || '', active: true, status: 'complete' };
      },
      async query() { const wc = getWc(); return [{ id: TAB_ID, url: wc?.getURL() || '', active: true }]; },
    },
    debugger: {
      // 网申页在伪装时已经挂着调试器（Electron 一个 webContents 只能挂一个），这里共用，不重复挂也不摘
      async attach() { const wc = getWc(); if (!wc.debugger.isAttached()) wc.debugger.attach('1.3'); },
      async detach() {},
      async sendCommand(_t, method, params = {}) { return getWc().debugger.sendCommand(method, params); },
      onDetach: { addListener(fn) { detachFns.push(fn); } },
    },
    downloads: {
      // 只用来找「求职简历-公司名.pdf」：扫「下载」文件夹
      async search({ filenameRegex }) {
        const dir = path.join(os.homedir(), 'Downloads');
        const re = new RegExp(filenameRegex);
        let hits = [];
        try {
          for (const n of fs.readdirSync(dir)) {
            const full = path.join(dir, n);
            if (re.test(full)) hits.push({ filename: full, t: fs.statSync(full).mtimeMs, exists: true });
          }
        } catch {}
        return hits.sort((a, b) => b.t - a.t).slice(0, 1);
      },
    },
    permissions: { async contains() { return true; }, async request() { return true; } },
    runtime: { getURL: (p) => pathToFileURL(path.join(EXT, p)).href, id: 'hr-desk', lastError: null, onMessage: { addListener() {} } },
  };
}

// ---------- 私密档案 → 引擎的「记住的值」 ----------
// 引擎按 `分块:归一化标签` 或 `:归一化标签` 查 afMemory。档案里的标量字段按常见叫法灌进去（只在本地填，敏感的不进模型）
const ALIAS = {
  出生日期: ['出生日期', '出生年月', '生日'],
  户口所在地: ['户口所在地', '户籍所在地', '户籍', '户口'],
  民族: ['民族'],
  籍贯: ['籍贯'],
  身份证号: ['身份证号', '身份证号码', '证件号码', '证件号'],
  现居住地: ['现居住地', '现居住城市', '现居地', '居住地', '现住址'],
  性别: ['性别'],
  政治面貌: ['政治面貌'],
  英语等级: ['英语等级', '英语水平', '外语等级'],
  英语四级分数: ['英语四级分数', '四级分数', 'CET4分数', 'CET-4分数'],
  学院名称: ['学院名称', '学院', '所在院系', '院系'],
  毕业时间: ['毕业时间', '毕业日期'],
};
async function seedMemory() {
  let p;
  try { p = JSON.parse(fs.readFileSync(PERSONAL, 'utf8')); } catch { return 0; }
  const { afMemory = {} } = await storageLocal.get('afMemory');
  let n = 0;
  for (const [k, names] of Object.entries(ALIAS)) {
    // 档案里的值可以带括号备注，比如「浙江省杭州市（只到市级）」，括号里的不填进表
    let v = p[k];
    if (v == null || typeof v === 'object') continue;
    v = String(v).replace(/[（(][^（）()]*[）)]/g, '').trim();
    if (!v || v === '全国') continue;                       // 户口所在地是「全国」= 还没确认，空着让你填
    if (k === '英语等级' && /^四级$/.test(v)) v = 'CET-4';  // 下拉里多写 CET-4；文字框写 CET-4 也通
    for (const label of names) {
      const key = `:${lib.normLabel(label)}`;
      if (afMemory[key] && afMemory[key].from !== 'personal') continue;   // 你在网申页上「记住我填的」存过的，不覆盖
      afMemory[key] = { label, section: '', value: String(v), sensitive: lib.SENSITIVE.test(label), at: Date.now(), from: 'personal' };
      n++;
    }
  }
  await storageLocal.set({ afMemory });
  return n;
}

async function load() {
  if (engine) return;
  globalThis.chrome = makeChrome();
  const imp = (p) => import(pathToFileURL(path.join(EXT, p)).href);
  lib = await imp('src/lib/autofill-lib.js');
  store = await imp('src/lib/store.js');
  engine = await imp('src/lib/autofill-engine.js');
  await seedMemory();
}

// ---------- 公司背调（插件的「查公司」：百度 4 次 + 企查查 + DeepSeek 总结，lib/company-check.js 原样用） ----------
let checker = null;
const running = new Map();               // 同一家正在查就共用一个结果，别重复搜
let queue = Promise.resolve();
const normName = (s) => String(s || '').replace(/\s/g, '');
async function findCheck(name) {
  const { deskChecks = [] } = await storageLocal.get('deskChecks');
  const n = normName(name);
  return deskChecks.find((c) => normName(c.name) === n) || null;
}

module.exports = {
  init({ webContents, activate, backgroundPage }) { getWc = webContents; onActivate = activate || (() => {}); if (backgroundPage) makeBg = backgroundPage; },
  findCheck,
  async checkCompany(name, onProgress = () => {}) {
    name = String(name || '').trim();
    if (running.has(name)) return running.get(name);
    // 一家一家查：你连着点开好几家时，百度别被并发连搜触发安全验证
    const prev = queue;
    const p = (async () => {
      await prev.catch(() => {});
      onProgress('排队中，前一家查完就轮到它…');
      await load();
      checker ||= await import(pathToFileURL(path.join(EXT, 'src/lib/company-check.js')).href);
      const config = await store.getConfig();
      const rec = await checker.checkCompany(name, config, onProgress);
      // 插件自己只在 companyChecks 留最近 30 家；收件箱会话多，另存一份留 500 家
      const { deskChecks = [] } = await storageLocal.get('deskChecks');
      await storageLocal.set({ deskChecks: [rec, ...deskChecks.filter((c) => normName(c.name) !== normName(name))].slice(0, 500) });
      return rec;
    })().finally(() => running.delete(name));
    running.set(name, p);
    queue = p.catch(() => {});
    return p;
  },
  onDebuggerDetach(reason) { for (const f of detachFns) try { f({ tabId: TAB_ID }, reason); } catch {} },
  async fill({ job = {}, fresh = false }, onProgress) {
    await load();
    const config = await store.getConfig();
    const report = await engine.fillPage({ tabId: TAB_ID, config, fresh, job, onProgress });
    await storageLocal.set({ afLast: report });
    return report;
  },
  async remember() { await load(); return engine.rememberPage(TAB_ID); },
  async scrollTo(key) { await load(); return engine.scrollToField(TAB_ID, key); },
  async lastReport() { return (await storageLocal.get('afLast')).afLast || null; },
  // 设置向导用：插件格式的设置写进存储（网申填表 / 查公司读它）；测试 key、解析简历直接调插件的 llm.js
  async syncConfig(patch) {
    const { config = {} } = await storageLocal.get('config');
    await storageLocal.set({ config: { ...config, ...patch, filter: { ...(config.filter || {}), ...(patch.filter || {}) }, resume: { ...(config.resume || {}), ...(patch.resume || {}) } } });
  },
  async testKey(cfg) { await load(); const llm = await import(pathToFileURL(path.join(EXT, 'src/lib/llm.js')).href); return llm.testConnection(cfg); },
  async parseResume(raw, cfg) { await load(); const llm = await import(pathToFileURL(path.join(EXT, 'src/lib/llm.js')).href); return llm.parseResumeText(raw, cfg); },
};
