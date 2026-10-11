/**
 * 模块 A 的侧边栏这一半：模型初筛 + 你的操作（已投 / 不投）+ 排序。
 * 拉取和本地初筛在 campus-source.js（background 也要用）。模型走 screen（9/28 起 DeepSeek，你拍板换的）。
 */
import { getCampus, setCampus, pullCampus, today } from './campus-source.js';
import { cohortOf } from './library.js';
import { screenCampus } from './llm.js';
import { getRuntime, setRuntime } from './store.js';
import { recordChannel } from './company-archive.js';

export { getCampus, pullCampus };

const BATCH = 15;
let screening = null; // { stop }
export const isScreening = () => Boolean(screening);
export function stopScreening() { if (screening) screening.stop = true; }

/** 待模型筛的，按「求职城市 > 全国大单位」「大单位 > 其他」「截止近的在前」排 */
export function pendingOf(c) {
  return Object.values(c.items).filter((x) => x.state === '待筛' && (!x.deadline || x.deadline >= today()))
    .sort((a, b) => (b.hefei - a.hefei) || (b.big - a.big) || String(a.deadline || '9').localeCompare(String(b.deadline || '9')));
}

/**
 * 模型初筛：一批 15 条送模型。onProgress(text) 给侧边栏显示进度。
 * 模型漏掉的 id 留在「待筛」下一批再送；同一条漏两次就不再烧钱，直接放进「等你定」。
 */
export async function screenPending(config, onProgress = () => {}, limit = 300) {
  if (screening) throw new Error('网申公告正在筛，等这一轮完');
  screening = { stop: false };
  const stat = { batches: 0, done: 0, go: 0, ask: 0, no: 0, failed: 0, secs: [] };
  try {
    for (;;) {
      if (screening.stop) break;
      const c = await getCampus();
      const pend = pendingOf(c).slice(0, Math.max(0, limit - stat.done));
      if (!pend.length) break;
      const batch = pend.slice(0, BATCH);
      onProgress(`模型初筛网申公告：第 ${stat.batches + 1} 批 ${batch.length} 条（还剩 ${pend.length} 条，一批几秒到十几秒）…`);
      const t0 = Date.now();
      let res = [];
      try {
        res = await screenCampus(batch, config);
      } catch (e) {
        // 接口挂了不硬撑：已经筛完的留着，剩下的下次再点
        stat.error = e.message;
        break;
      }
      stat.secs.push(Math.round((Date.now() - t0) / 1000));
      stat.batches++;
      const got = new Map(res.map((r) => [r.id, r]));
      const c2 = await getCampus();
      const items = { ...c2.items };
      for (const x of batch) {
        const k = String(x.id);
        const cur = items[k];
        if (!cur) continue;
        const r = got.get(k);
        if (!r) {
          const tries = (cur.tries || 0) + 1;
          items[k] = tries >= 2
            ? { ...cur, tries, state: '已筛', ai: { verdict: '等你定', priority: '能干', company_tier: cur.big ? '大单位' : '看不出', matched_positions: cur.hits || [], grade_risk: '看不出', reason: '模型两次都漏了这条，没判出来，你自己看一眼', veto: [] } }
            : { ...cur, tries };
          if (tries >= 2) { stat.failed++; stat.done++; stat.ask++; }
          continue;
        }
        items[k] = { ...cur, state: '已筛', ai: fixVerdict(cur, r, config), screenedAt: Date.now() };
        stat.done++;
        const v = items[k].ai.verdict;
        if (v === '投') stat.go++; else if (v === '等你定') stat.ask++; else stat.no++;
      }
      await setCampus({ items });
    }
  } finally {
    screening = null;
  }
  return stat;
}

/** 本地兜底：模型说了不算的几条硬规矩 */
const MATCH_BAD = /工程师|研发|算法|机器学习|开发|设计师|生产|制造|工艺|采矿|矿|机电|财务|会计|法务|审计|精算|研究员|科学家|医|护|教师|施工|土建/;
// 「软件 / 硬件 / 测试」只在不是产品经理时才算技术岗（「软件产品经理」算对口）
const isTech = (p) => MATCH_BAD.test(p) || (/软件|硬件|测试/.test(p) && !/产品经理|产品运营/.test(p));

export function fixVerdict(x, r, config = {}) {
  const ai = { ...r };
  const year = cohortOf(config.resume?.graduation);
  const city = (config.filter?.cities || [])[0] || '';
  if ((x.typeTag || []).some((t) => /国企|央企|外企|上市|合资/.test(t))) ai.company_tier = '大单位';
  // 批次写的届别比你晚的一律标风险，除非模型明说公告收往届 / 择业期；只标出来，不改结论
  const later = /(?:20)?(\d{2})\s*(届|秋招|春招|校招)/.exec(x.batch || '');
  if (year && later && Number(later[1]) > year % 100 && !(ai.grade_risk === '无' && /往届|择业期/.test(ai.reason))) ai.grade_risk = '届别对不上，需看公告';
  // 模型挑的「对口岗位」里混进研发 / 生产 / 算法类的剔掉；剔完一个不剩就是不投（9/28 重筛见过：凯泉「生产管培生」、中煤「管培生采矿工程」、KLA「人工智能与机器学习」被判了投）
  const kept = (ai.matched_positions || []).filter((p) => !isTech(p) && !/^人工智能/.test(p));
  if (!kept.length && ai.verdict !== '不投') {
    ai.verdict = '不投';
    ai.reason = `挑出来的岗位都是技术 / 研发 / 生产类（${(ai.matched_positions || []).join('、')}），不对口`;
  } else ai.matched_positions = kept;
  if (city && !x.hefei && ai.verdict === '投') { ai.verdict = '等你定'; if (!ai.reason.includes(city)) ai.reason += `（只写全国，需确认${city}有没有岗）`; }
  return ai;
}

/** 侧边栏要显示的：筛过且不是「不投」、没被你处理掉的。大单位在前，同档截止近的在前 */
export function visibleOf(c) {
  const TIER = { 大单位: 0, 中型: 1, 看不出: 2, 小公司: 3 };
  return Object.values(c.items)
    .filter((x) => x.state === '已筛' && x.ai && x.ai.verdict !== '不投')
    .sort((a, b) => (TIER[a.ai.company_tier] ?? 2) - (TIER[b.ai.company_tier] ?? 2)
      || String(a.deadline || '9999').localeCompare(String(b.deadline || '9999')));
}

export const appliedOf = (c) => Object.values(c.items).filter((x) => x.state === '已投').sort((a, b) => (b.appliedAt || 0) - (a.appliedAt || 0));

/** 截止还剩几天（负数 = 已过） */
export function daysLeft(deadline) {
  if (!deadline) return null;
  const d = new Date(deadline + 'T23:59:59');
  return Math.floor((d - Date.now()) / 864e5);
}

/** 你按「已投」：公告标已投，同时记进「已投」列表（不占 BOSS 每天 15 个的额度） */
export async function markApplied(id, extra = {}) {
  const c = await getCampus();
  const x = c.items[String(id)];
  if (!x) throw new Error('网申列表里没有这一条');
  const items = { ...c.items, [String(id)]: { ...x, state: '已投', appliedAt: Date.now(), ...extra } };
  await setCampus({ items });
  await recordChannel(x.company, 'campus', { title: (x.ai?.matched_positions || []).join('、') }).catch(() => {});
  const rt = await getRuntime();
  await setRuntime({
    done: [{ jobId: `campus-${x.id}`, title: (x.ai?.matched_positions || []).join('、') || x.positions.slice(0, 30), company: x.company,
      salary: '', score: '', verdict: x.ai?.verdict || '', priority: x.ai?.priority || '', platform: 'campus',
      href: extra.url || x.applyUrl, at: Date.now() }, ...(rt.done || [])].slice(0, 200),
  });
  return items[String(id)];
}

/** 你按「不投」：以后不再出现（留着记录做去重） */
export async function dropCampus(id) {
  const c = await getCampus();
  const x = c.items[String(id)];
  if (!x) return;
  await setCampus({ items: { ...c.items, [String(id)]: { ...x, state: '不投', droppedAt: Date.now() } } });
}
