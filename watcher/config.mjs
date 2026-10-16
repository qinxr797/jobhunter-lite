// 设置：所有因人而异的东西都从这里来（简历、城市、求职标准、拉黑、微信小号、DeepSeek、Telegram、端口）。
// 文件：<数据目录>\config.json，桌面助手的设置向导负责写，这里只读；改了不用重启（按修改时间重新读）。
// 目录约定（和 desktop\ 一致）：
//   HRDESK_HOME = 安装目录（外壳拉起时传）；没传就当 watcher 的上一级
//   HRDESK_DATA = 数据目录（外壳拉起时传）；没传就是 <安装目录>\data
//   watcher 自己的数据（状态、日志、会话、投递总表）放 <数据目录>\watcher\
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WATCHER = path.dirname(fileURLToPath(import.meta.url));
export const HOME = path.resolve(process.env.HRDESK_HOME || path.join(WATCHER, '..'));
export const DATA_ROOT = path.resolve(process.env.HRDESK_DATA || path.join(HOME, 'data'));
export const DATA = path.join(DATA_ROOT, 'watcher');
export const CONFIG_FILE = path.join(DATA_ROOT, 'config.json');
export const EXTENSION_DIR = path.join(HOME, 'extension');
mkdirSync(DATA, { recursive: true });

// 默认值：和 config.example.json 一致；设置里没写的项用它
const DEFAULTS = {
  deepseek: { apiKey: '', model: 'deepseek-flash', base: 'https://api.deepseek.com' },
  city: '',
  keywords: [],
  resumeText: '',
  portfolio: '',
  blacklist: [],
  telegram: { token: '', chatId: '', proxy: '' },
  wechatAlt: '',
  intro: '',
  pronoun: '他',
  salaryExpect: '',
  criteria: '',
  nearDistricts: [],
  dailyLimit: 15,
  autopilot: { autoReply: true, askInterview: true, neverAskPay: true, hours: [8, 22], intervalMin: 5 },
  goodUnits: [
    '日企、外企、合资，或正规公司里英文外向的岗位（外贸单证、海外商务支持、外企助理）',
    '大单位：上市公司、国企央企、事业单位、世界 500 强、有名的品牌企业、规模上千人的正规公司（含分公司）',
    '学校的非教师岗：高校、职业院校、中小学的行政、宣传、教务、学工、实验室',
    '冷门宝藏：协会 / 学会 / 商会秘书处、科研院所课题组、出版社 / 杂志社、检测认证、知识产权流程、外资办事处',
  ],
  resumeFiles: [{ id: 'general', label: '通用', file: '', keywords: [] }],
  cityCodes: { boss: '', zhilian: '', liepin: '' },
  ports: { inbox: 8790, boss: 9401, zhaopin: 9401, j51: 9401, lp: 9401, plugin: 9334, deskTabs: { boss: 9402, zhaopin: 9403, j51: 9403, lp: 9404, research: 9405 } },
  browserPath: '', // 跑求职插件的后台浏览器；空 = 自动找 Chrome，再找 Edge（见 plugin-host.mjs）
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
function merge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    if (k.startsWith('_')) continue;
    out[k] = isObj(v) && isObj(a[k]) ? merge(a[k], v) : v;
  }
  return out;
}

let cache = null, cacheMtime = -1, cacheErr = '';
/** 当前设置（文件没变就用缓存）。读坏了不抛：用上一份好的，错误放在 configError() */
export function cfg() {
  let m = 0;
  try { m = existsSync(CONFIG_FILE) ? statSync(CONFIG_FILE).mtimeMs : 0; } catch {}
  if (cache && m === cacheMtime) return cache;
  try {
    const raw = m ? JSON.parse(readFileSync(CONFIG_FILE, 'utf8').replace(/^﻿/, '')) : {};
    cache = merge(DEFAULTS, raw);
    cacheErr = '';
  } catch (e) {
    cacheErr = `设置文件读不懂（${e.message}），先用上一次的设置`;
    cache = cache || merge(DEFAULTS, {});
  }
  cacheMtime = m;
  return cache;
}
export const configError = () => (cfg(), cacheErr);
export const hasConfig = () => existsSync(CONFIG_FILE);

/** 还缺哪些必填项（人话），设置向导和页面顶上提示用 */
export function missing() {
  const c = cfg();
  const out = [];
  if (!c.deepseek.apiKey) out.push('DeepSeek 的 key（自动回复、起草、筛岗位都要用）');
  if (!c.city) out.push('找工作的城市');
  if (!c.resumeText.trim()) out.push('简历');
  return out;
}

/** 提示词里用的简历素材：截前 6000 字（够模型看，也不爆上下文） */
export const resumeFacts = () => cfg().resumeText.trim().slice(0, 6000);

/** 附件简历版本（BOSS「发简历」选简历框里按文件名找），形状和插件 variants 一样 */
export function variants() {
  const list = (cfg().resumeFiles || []).filter((v) => v && (v.file || v.label));
  const norm = list.map((v, i) => ({ id: v.id || `v${i}`, label: v.label || v.file || `简历 ${i + 1}`, note: v.file ? `附件：${v.file}` : '', keywords: v.keywords || [] }));
  return norm.length ? norm : [{ id: 'general', label: '通用', note: '', keywords: [] }];
}

/** 城市 → 各平台城市代码。BOSS 代码优先用设置里的，没写就查插件的城市表；猎聘没有表，没写就是空（猎聘跳过） */
let cityTable = null;
export async function cityCodes() {
  const c = cfg();
  let boss = c.cityCodes.boss || '';
  if (!boss && c.city) {
    try {
      cityTable ||= (await import(new URL(`file:///${path.join(EXTENSION_DIR, 'src', 'lib', 'cities.js').replace(/\\/g, '/')}`).href)).CITY_CODES;
      const hit = cityTable[c.city] || cityTable[c.city.replace(/市$/, '')];
      if (hit) boss = String(hit[0]);
    } catch {}
  }
  return { boss, liepin: c.cityCodes.liepin || '', name: c.city };
}

/** 公司名去掉开头的地名（「浙江省杭州市XX」「杭州XX」→「XX」），去重比对用：先去「X省」，再去设置里的城市，最后去「X市」 */
export function stripPlace(name = '') {
  const city = cfg().city.replace(/市$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let s = String(name).replace(/^[一-龥]{2,3}省/, '');
  if (city) s = s.replace(new RegExp(`^${city}市?`), '');
  return s.replace(/^[一-龥]{2,3}市/, '');
}

/** 拉黑：公司名包含任一关键词就不回、不推、不投 */
export const isBlocked = (company = '') => cfg().blacklist.some((k) => k && company.includes(k));

/** 现在是不是自动回复的时段 */
export function inHours(d = new Date()) {
  const [a, b] = cfg().autopilot.hours || [8, 22];
  const h = d.getHours();
  return h >= a && h < b;
}
