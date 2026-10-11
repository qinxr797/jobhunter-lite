/**
 * 投过的回顾（v1.0.9，2026-09-29 你：「第二天投简历的时候 连带之前投过简历的 来个回顾」）。
 *
 * 每天第一次跑「筛今天的岗位」（或者手动点「回顾」）时，把今天以前投过的每一家列出来，
 * 和 BOSS 聊天列表对上，告诉你现在是什么状态、下一步干什么：
 *   提到面试（他自己接）> HR 回了等你回 > 已读没回 > 送达没看 > 婉拒 > 51job/智联/网申（平台上看不到回复，只列出来）
 * 只读：聊天列表是 hr-inbox 读的（不点开会话），这里只做匹配和归类，不花模型钱。
 */
import { getArchive, sameCompany, CHANNEL_NAMES } from './company-archive.js';
import { getRuntime } from './store.js';

const DAY = 86400e3;
const INTERVIEW = /面试|约面|面谈|到店|来公司|视频面|电话面|什么时候方便|哪天方便|地址发你|来一趟/;
const REJECT = /不太匹配|不匹配|匹配度|很遗憾|遗憾|不合适|暂不考虑|祝您|祝你|早日找到|已招满|招满了/;

function startOfToday(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 今天以前投过的：rt.done（有岗位、薪资、链接）为主，档案里有、done 里没有的（9/24 手动打招呼那批）补上 */
async function appliedBefore(today) {
  const rt = await getRuntime();
  const rows = [];
  const seen = new Set();
  for (const d of rt.done || []) {
    if (d.dryRun || !d.company || d.at >= today) continue;
    const plat = d.platform || 'boss';
    const k = `${plat}|${d.company}`;
    if (seen.has(k)) continue;
    seen.add(k);
    rows.push({ company: d.company, platform: plat, title: d.title || '', salary: d.salary || '', href: d.href || '', at: d.at });
  }
  const archive = await getArchive();
  const hrOf = (name, plat) => Object.values(archive).find((v) => [v.name, ...(v.aliases || [])].some((n) => sameCompany(n, name)))?.ch?.[plat]?.hr || '';
  for (const r of rows) r.hr = hrOf(r.company, r.platform);
  for (const v of Object.values(archive)) {
    for (const [plat, c] of Object.entries(v.ch || {})) {
      if (!c.at || c.at >= today) continue;
      if (rows.some((r) => r.platform === plat && sameCompany(r.company, v.name))) continue;
      rows.push({ company: v.name, platform: plat, title: c.title || '', salary: '', href: '', at: c.at, hr: c.hr || '' });
    }
  }
  return rows;
}

/** 一行 BOSS 投递 + 聊天列表里对应的会话 → 状态和下一步 */
function bossStatus(row, chat, kindOf, now) {
  const days = Math.floor((now - row.at) / DAY);
  if (row.hr === 'dropped') return { state: '你放掉了', level: 5, next: '你说算了，不再跟' };
  if (!chat) return row.hr === 'rejected'
    ? { state: '婉拒', level: 5, next: '结束，不用回' }
    : { state: '没找到会话', level: 4, next: '聊天列表前 40 个里没有，可能太久没动静被挤下去了' };
  const last = chat.last || '';
  // 当前选中的会话在列表里只显示「您正在与 Boss XX 沟通」，看不到最后一条
  if (/^您正在与/.test(last)) return { state: '看不到最后一条', level: 1, next: '这个会话正开着，列表里看不到最新消息，去聊天页看一眼' };
  if (!chat.fromMe) {
    if (INTERVIEW.test(last)) return { state: '提到面试', level: 0, next: '你自己接：看时间地点，我不替你答应' };
    const kind = kindOf(chat);
    if (kind === '拒绝' || REJECT.test(last)) return { state: '婉拒', level: 5, next: '结束，不用回' };
    if (kind === '要简历' || /简历/.test(last)) return { state: 'HR 要简历', level: 1, next: '发附件简历' };
    return { state: 'HR 回了', level: 1, next: '去回：问清无责底薪、双休、几点下班' };
  }
  if (chat.mine === '已读' || /^\[?已读/.test(last)) {
    return days >= 2
      ? { state: '已读没回', level: 2, next: `看了 ${days} 天没回，可以跟一句问问进度；再过几天还不回就放掉` }
      : { state: '已读没回', level: 3, next: '刚看过，再等等' };
  }
  return days >= 5
    ? { state: '送达没看', level: 4, next: `${days} 天没看，HR 多半不活跃，放掉` }
    : { state: '送达没看', level: 3, next: 'HR 还没看，再等等' };
}

/**
 * chatItems：hr-inbox 读到的整个聊天列表（含自己最后说话的）；classified：hrInbox.items（有模型分类的那部分）
 * 返回 { at, rows }，rows 按要紧程度排：level 0 最急
 */
export async function buildReview(chatItems, classified = [], now = Date.now()) {
  const today = startOfToday(now);
  const applied = await appliedBefore(today);
  const kindOf = (chat) => classified.find((x) => x.company === chat.company && x.name === chat.name)?.ai?.kind || '';
  const rows = applied.map((r) => {
    const base = { ...r, days: Math.floor((now - r.at) / DAY), channel: CHANNEL_NAMES[r.platform] || r.platform };
    if (r.platform !== 'boss') {
      return { ...base, state: '已投简历', level: 6, next: `${base.channel} 上看不到 HR 回复，有邀约会在平台消息里`, last: '' };
    }
    const chat = (chatItems || []).find((c) => sameCompany(c.company, r.company));
    const s = bossStatus(r, chat, kindOf, now);
    return { ...base, ...s, hrName: chat?.name || '', last: chat?.last || '', lastTime: chat?.time || '' };
  });
  rows.sort((a, b) => a.level - b.level || b.at - a.at);
  const rec = { at: now, rows };
  await chrome.storage.local.set({ review: rec });
  return rec;
}

/** 你说「算了」的公司：档案里记 hr=dropped（不改投递时间），回顾里改成「你放掉了」 */
export async function dropCompany(company, platform) {
  const archive = await getArchive();
  const hit = Object.entries(archive).find(([, v]) => [v.name, ...(v.aliases || [])].some((n) => sameCompany(n, company)));
  if (hit && hit[1].ch?.[platform]) {
    hit[1].ch[platform] = { ...hit[1].ch[platform], hr: 'dropped' };
    await chrome.storage.local.set({ companies: { ...archive, [hit[0]]: hit[1] } });
  }
  const rv = await getReview();
  if (rv) {
    rv.rows = rv.rows.map((r) => (r.platform === platform && sameCompany(r.company, company) ? { ...r, hr: 'dropped', state: '你放掉了', level: 5, next: '你说算了，不再跟' } : r));
    await chrome.storage.local.set({ review: rv });
  }
}

export async function getReview() {
  const { review } = await chrome.storage.local.get('review');
  return review || null;
}

/** 今天回顾过没有（每天第一次跑筛选时自动回顾一次） */
export function reviewedToday(review, now = Date.now()) {
  return !!review && review.at >= startOfToday(now);
}

/** 导出给 Excel 打开的 CSV（带 BOM，Excel 才认得中文） */
export function reviewCsv(review) {
  const head = ['状态', '下一步', '投递日期', '过了几天', '平台', '公司', '岗位', '薪资', 'HR', 'HR/我 最后一条', '岗位链接'];
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const date = (t) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()}`; };
  const lines = (review?.rows || []).map((r) => [r.state, r.next, date(r.at), r.days, r.channel, r.company, r.title, r.salary, r.hrName || '', r.last || '', r.href || ''].map(cell).join(','));
  return '﻿' + [head.map(cell).join(','), ...lines].join('\r\n');
}
