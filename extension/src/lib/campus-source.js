/**
 * 模块 A：校招网申源（v0.7.0，2026-09-28 你要求）。
 *
 * 数据来自求职方舟公开的「27届秋招网申公告汇总表」接口（不登录就能拉，第三方未公开接口）：
 *   POST https://api.qiuzhifangzhou.com/api/campus/getCampusList
 *   body {"dateList":[{"date":"YYYY-MM-DD","md5":"上次拿到的md5或空"}, …]}
 *   返回 campusList[{date, md5, datas[]}]；某天的 md5 和上次一样，那天就不返回（9/28 实测）。
 *
 * 这个文件只管「拉 + 存 + 本地初筛」，不碰模型 —— background.js（service worker）也要 import 它，
 * service worker 里不能动态 import，也扛不住模型那种一两分钟的调用。模型初筛在 campus.js（侧边栏里跑）。
 *
 * 存储：chrome.storage.local.campus = {
 *   items: { id: 公告 },   只存本地初筛过的（求职城市 / 全国大单位），整张表几 MB，全存会撑爆配额
 *   md5: { date: md5 },   增量拉取用
 *   pulls: [{at, ok, n, kept, err, auto}],  拉取记录（一天最多 2 次）
 *   lastError: '',        最近一次失败原因，侧边栏标红显示
 * }
 */

export const CAMPUS_API = 'https://api.qiuzhifangzhou.com/api/campus/getCampusList';
export const MAX_PULLS_PER_DAY = 2;

// 方向关键词：岗位串拆开后，某个岗位名命中它、又没命中 BAD，才算对口候选
const DIR = /运营|电商|跨境|产品|AI|ＡＩ|人工智能|新媒体|内容|管培|管理培训生|培训生|储备|市场|品牌|数字化|数智/i;
// 岗位名里带这些的不算（研发、销售、财会、医护……）；「产品工程师」「营销管培生」这类靠它剔掉
const BAD = /工程师|研发|算法|开发|设计师|设计|销售|营销|财务|会计|法务|医|护|审计|精算|研究员|研究|实习|生产|制造|工艺|质量|技术|机械|电气|化学|土建|建筑|施工|风控|柜|客服|审核|采购|物流|仓|安全|科学家|飞行|机务|教学|老师|教师|保险/;
// 批次：日常实习、28 届、24/25/23 届的老公告不看
const BAD_BATCH = /实习|28|2[345]/;
export const BIG_TAGS = /国企|央企|外企|上市|合资/;

export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const dayStr = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** 岗位串拆成单个岗位名。求职方舟的岗位串有「、」分隔的，也有「研发类营销类」直接粘在一起的 */
export function splitPositions(s) {
  return String(s || '')
    .split(/[、，,/\\|；;\s]+|(?<=[岗类生员师])(?=[一-龥])/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** 本地初筛（不花钱）。返回 { pass, why, hits, hefei, big }；hefei = 地点含求职城市（字段名沿用旧版） */
export function localScreen(x, excludeKeywords = [], city = '') {
  const loc = String(x.locations || '');
  const hefei = city ? loc.includes(city) : true;
  const nationwide = /全国/.test(loc);
  const big = (x.typeTag || []).some((t) => BIG_TAGS.test(t));
  // 「人工智能」「人工智能类」单独出现多半是招哪个专业，不是 AI 运营岗
  const hits = splitPositions(x.positions).filter((p) => DIR.test(p) && !BAD.test(p) && !/^(人工智能|计算机|AI)(类|方向|相关专业|专业)?$/i.test(p));
  const r = (pass, why) => ({ pass, why, hits, hefei, big });
  if (!hefei && !nationwide) return r(false, `地点不含${city}也不含全国`);
  // 只写「全国」的小公司不值得花模型：多半你的城市根本没岗。全国的只留大单位
  if (!hefei && !big) return r(false, '只写全国、又不是大单位');
  if (x.deadline && x.deadline < today()) return r(false, '已截止');
  if (BAD_BATCH.test(x.batch || '')) return r(false, `批次「${x.batch}」不看`);
  if (!hits.length) return r(false, '岗位串里没有对口方向');
  const ex = excludeKeywords.find((k) => k && (String(x.company || '').includes(k) || hits.every((h) => h.includes(k))));
  if (ex) return r(false, `命中排除词「${ex}」`);
  return r(true, '', hits);
}

export async function getCampus() {
  const { campus } = await chrome.storage.local.get('campus');
  return { items: {}, md5: {}, pulls: [], lastError: '', ...(campus || {}) };
}
export async function setCampus(patch) {
  const cur = await getCampus();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ campus: next });
  return next;
}

/** 今天已经拉过几次（成功失败都算，防止一直重试把人家接口打爆） */
export const pullsToday = (c) => (c.pulls || []).filter((p) => dayStr(p.at) === today()).length;

/**
 * 拉一次。第一次拉最近 60 天，之后拉最近 3 天（带上次的 md5，没变的那天服务器不返回）。
 * opts: { auto: 是否定时触发, force: 手动按钮（仍受一天 2 次限制）, excludeKeywords }
 * 返回 { ok, n(拉到几条), added(新进本地的), kept(本地共存几条), err }
 */
export async function pullCampus(opts = {}) {
  const c = await getCampus();
  if (pullsToday(c) >= MAX_PULLS_PER_DAY) {
    return { ok: false, skipped: true, err: `今天已经拉过 ${MAX_PULLS_PER_DAY} 次了（一天最多 ${MAX_PULLS_PER_DAY} 次），明天再拉` };
  }
  const first = !Object.keys(c.items).length && !Object.keys(c.md5).length;
  const days = first ? 60 : 3;
  const dateList = [];
  for (let i = 0; i < days; i++) {
    const date = dayStr(Date.now() - i * 864e5);
    dateList.push({ date, md5: first ? '' : (c.md5[date] || '') });
  }

  const pull = { at: Date.now(), ok: false, n: 0, added: 0, kept: 0, err: '', auto: Boolean(opts.auto), days };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45000);
    const res = await fetch(CAMPUS_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dateList }),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json().catch(() => { throw new Error('返回的不是 JSON'); });
    const list = json?.campusList;
    // 字段变了要大声说，不能静默当成「今天没新公告」
    if (!Array.isArray(list)) throw new Error(`返回格式变了：没有 campusList（顶层字段 ${Object.keys(json || {}).join('/') || '空'}）`);
    const incoming = [];
    const newMd5 = {};
    for (const day of list) {
      if (day?.date && day.md5) newMd5[day.date] = day.md5;
      for (const x of day?.datas || []) {
        pull.n++;
        if (x?.id == null || !x.company || !('positions' in x) || !('locations' in x)) {
          throw new Error(`返回格式变了：公告缺 id/company/positions/locations（拿到的字段：${Object.keys(x || {}).join('/')}）`);
        }
        incoming.push(x);
      }
    }
    // 拉取要等好几秒，这期间你可能按了「已投 / 不投」、初筛也可能写进了结果：
    // 所以拿到数据后重新读一次最新的，只往里合并，不用开头那份旧快照整个覆盖（9/28 审查发现的坑）
    const cur = await getCampus();
    const items = { ...cur.items };
    const md5 = { ...cur.md5, ...newMd5 };
    for (const x of incoming) {
      const key = String(x.id);
      if (items[key]) { items[key] = { ...items[key], ...slim(x) }; continue; } // 按 id 去重；老的保留筛选结果和状态
      const ls = localScreen(x, opts.excludeKeywords || [], opts.city || '');
      if (!ls.pass) continue;
      items[key] = { ...slim(x), hits: ls.hits, hefei: ls.hefei, big: ls.big, state: '待筛', firstSeen: Date.now() };
      pull.added++;
    }
    // 过期 30 天以上的清掉，免得越存越多
    const cut = dayStr(Date.now() - 30 * 864e5);
    for (const [k, v] of Object.entries(items)) if (v.deadline && v.deadline < cut && v.state !== '已投') delete items[k];
    for (const d of Object.keys(md5)) if (d < dayStr(Date.now() - 90 * 864e5)) delete md5[d];
    pull.ok = true;
    pull.kept = Object.keys(items).length;
    await setCampus({ items, md5, lastError: '', lastOk: Date.now(), pulls: [pull, ...(cur.pulls || [])].slice(0, 30) });
    return pull;
  } catch (e) {
    pull.err = e.name === 'AbortError' ? '45 秒没回应，超时' : e.message;
    const cur = await getCampus();
    await setCampus({ lastError: `网申源拉取失败：${pull.err}`, pulls: [pull, ...(cur.pulls || [])].slice(0, 30) });
    return pull;
  }
}

/** 只留要用的字段 */
function slim(x) {
  return {
    id: x.id, createTime: x.createTime || '', company: x.company, positions: x.positions || '', locations: x.locations || '',
    deadline: x.deadline || '', typeTag: Array.isArray(x.typeTag) ? x.typeTag : [], industry: x.industry || '', batch: x.batch || '',
    noticeUrl: x.noticeUrl || '', applyUrl: x.applyUrl || '', urlType: x.urlType || '', referralCode: x.referralCode || '',
  };
}

/** 定时任务：今天还没成功拉过才拉（一天自动 1 次，给你手动留 1 次） */
export async function autoPull(excludeKeywords, city = '') {
  const c = await getCampus();
  if (c.lastOk && dayStr(c.lastOk) === today()) return null;
  if ((c.pulls || []).some((p) => p.auto && dayStr(p.at) === today())) return null;
  return pullCampus({ auto: true, excludeKeywords, city });
}
