/**
 * 模块 C 第 1 条：一家公司一份档案（v0.7.0）。
 * 网申、BOSS、51job、智联四条线按公司合在一起：网申已投 / BOSS 已打招呼 / 51job 已投 / 智联已投 / HR 回复了 / 约面试。
 * 筛选时在别的渠道投过的，卡片上标「已在 XX 投过」；给 HR 发消息时也能带上「我已经网申过」。
 *
 * chrome.storage.local.companies = { 归一化公司名: { name, aliases[], ch: { campus|boss|51job|zhilian: {at, title} }, hrReplied, interview, at } }
 */

export const CHANNEL_NAMES = { campus: '官网网申', boss: 'BOSS', '51job': '51job', zhilian: '智联' };

/** 去掉「有限公司 / 集团 / 股份」、括号、城市前缀这类，只留品牌主体 */
export function normCompany(name) {
  return String(name || '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/(股份)?有限(责任)?公司|集团(股份)?|股份|控股|科技|网络|信息技术|电子商务|分公司|总部|有限$/g, '')
    .replace(/^(中国|北京|上海|天津|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|内蒙古|广西|西藏|宁夏|新疆|深圳|广州|杭州|南京|苏州|武汉|成都|西安|合肥|长沙|郑州|青岛|厦门|宁波)(省|市|自治区)?/, '')
    .replace(/[\s·・.\-—_]/g, '')
    .toLowerCase();
}

export async function getArchive() {
  const { companies = {} } = await chrome.storage.local.get('companies');
  return companies;
}

/** 两个名字是不是一家：归一化后相等，或一个包含另一个（至少 2 个字） */
export function sameCompany(a, b) {
  const x = normCompany(a);
  const y = normCompany(b);
  if (!x || !y) return false;
  return x === y || (Math.min(x.length, y.length) >= 2 && (x.includes(y) || y.includes(x)));
}

export function findEntry(companies, name) {
  const k = normCompany(name);
  if (companies[k]) return [k, companies[k]];
  return Object.entries(companies).find(([, v]) => [v.name, ...(v.aliases || [])].some((n) => sameCompany(n, name))) || null;
}

/** 记一笔：某家公司在某个渠道投了 / 打了招呼 */
export async function recordChannel(name, channel, info = {}) {
  if (!name) return;
  const companies = await getArchive();
  const hit = findEntry(companies, name);
  const key = hit ? hit[0] : normCompany(name);
  const cur = hit ? hit[1] : { name, aliases: [], ch: {} };
  if (cur.name !== name && !cur.aliases.includes(name)) cur.aliases = [...cur.aliases, name].slice(-6);
  const prev = cur.ch?.[channel];
  // 只是记 HR 的反应（婉拒 / 约面试）时保留原来的投递时间和岗位，不然「投过的回顾」里投递日期会变成 HR 回复那天
  cur.ch = { ...cur.ch, [channel]: info.hr && prev ? { ...prev, hr: info.hr } : { at: Date.now(), ...info } };
  cur.at = Date.now();
  await chrome.storage.local.set({ companies: { ...companies, [key]: cur } });
}

/** 这家公司在「除了 exceptChannel 之外」的渠道投过没有，返回「已在 官网网申、BOSS 投过」这种话，没投过返回 '' */
export function appliedElsewhere(companies, name, exceptChannel) {
  const hit = findEntry(companies, name);
  if (!hit) return '';
  const chans = Object.keys(hit[1].ch || {}).filter((c) => c !== exceptChannel).map((c) => CHANNEL_NAMES[c] || c);
  return chans.length ? `已在 ${chans.join('、')} 投过` : '';
}

/** 第一次用：把现有「已投」记录（三个平台）并进档案 */
export async function backfillFromDone(done) {
  const { archiveBackfilled } = await chrome.storage.local.get('archiveBackfilled');
  if (archiveBackfilled) return;
  for (const d of done || []) {
    if (d.dryRun || !d.company) continue;
    await recordChannel(d.company, d.platform || 'boss', { title: d.title, at: d.at });
  }
  await chrome.storage.local.set({ archiveBackfilled: true });
}
