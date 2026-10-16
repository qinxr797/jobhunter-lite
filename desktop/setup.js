// 设置向导的后台：读写 <data>\config.json（watcher 只读这份），并把插件需要的那部分转成插件格式写进网申引擎的存储
// 字段和 watcher 的 config.example.json 对齐；这里只管向导问的那些，其余字段保留原值或用 example 的默认值
const fs = require('node:fs');
const path = require('node:path');
const { CONFIG, WATCHER } = require('./paths.js');

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,，、；;]+/)).map((s) => String(s).trim()).filter(Boolean);

function read() {
  const example = readJson(path.join(WATCHER, 'config.example.json'), {});
  return { ...example, ...readJson(CONFIG, {}) };
}

// 能开始用 = 有 key、城市、简历
function ready(c = readJson(CONFIG, null)) {
  return !!(c && c.deepseek?.apiKey && c.city && String(c.resumeText || '').trim());
}
function missing(c = read()) {
  const m = [];
  if (!c.deepseek?.apiKey) m.push('DeepSeek 的 API Key');
  if (!c.city) m.push('求职城市');
  if (!String(c.resumeText || '').trim()) m.push('简历');
  return m;
}

// 向导表单 → config.json（合并，不丢向导没问的字段）
function save(form) {
  const cur = read();
  const next = {
    ...cur,
    deepseek: { ...(cur.deepseek || {}), apiKey: String(form.apiKey || '').trim(), model: form.model || cur.deepseek?.model || 'deepseek-flash' },
    intro: String(form.intro || '').trim(),
    pronoun: form.pronoun === '她' ? '她' : '他',
    city: String(form.city || '').trim(),
    nearDistricts: list(form.nearDistricts),
    keywords: list(form.keywords),
    resumeText: String(form.resumeText || '').trim(),
    salaryExpect: String(form.salaryExpect || '').trim(),
    criteria: String(form.criteria || '').trim(),
    portfolio: String(form.portfolio || '').trim(),
    blacklist: list(form.blacklist),
    wechatAlt: String(form.wechatAlt || '').trim(),
    telegram: { ...(cur.telegram || {}), token: String(form.tgToken || '').trim(), chatId: String(form.tgChat || '').trim(), proxy: String(form.tgProxy || '').trim() },
  };
  if (form.resume && typeof form.resume === 'object') next.resume = form.resume;      // 解析过的结构化简历（网申填表用）
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(next, null, 2));
  return next;
}

// config.json → 插件格式（网申填表、查公司用的就是插件代码，它只认 chrome.storage 里的 config）
function pluginConfig(c = read()) {
  const resume = { ...(c.resume || {}), rawText: c.resumeText || c.resume?.rawText || '' };
  if (c.portfolio) resume.site = c.portfolio;
  if (c.salaryExpect && !resume.salary) resume.salary = c.salaryExpect;
  const out = {
    provider: 'openai', apiBase: 'https://api.deepseek.com', apiKey: c.deepseek?.apiKey || '', model: c.deepseek?.model || 'deepseek-flash',
    filter: { cities: c.city ? [c.city] : [] },
    resume,
  };
  if (c.criteria) out.criteria = c.criteria;
  return out;
}

module.exports = { read, save, ready, missing, pluginConfig, CONFIG };
