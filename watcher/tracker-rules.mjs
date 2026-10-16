// 投递表的「阶段 / 结局 / 待办」规则（10/16 晚，HR Desk 按「今天 / 投递 / 消息」重做）
// 阶段名照 offerPilot（中文、每阶段记首次到达时间）；三层（阶段 + 结局 + 事件）照 job-ops；
// 待办和「事」同一个模型照 Huntr；逾期 / 今天分组、空组隐藏照 Linear Inbox + Todoist Today；面试后 1 天问结果照 career-ops
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { cfg, DATA } from './config.mjs';
import { INTERVIEW, CONTACT } from './brain.mjs';

// 拉黑：设置里的 blacklist + 数据目录里的 blocked.txt（一行一个公司关键词）
// 和盯梢共用 data\blocked.txt（一行一个公司关键词）：盯梢不回不推，投递表直接记结局「我不去」，今天页一条都不出
const BLOCKED_FILE = path.join(DATA, 'blocked.txt');
export function blockedHit(company = '') {
  const own = cfg().blacklist.find((k) => k && String(company).includes(k));
  if (own) return own;
  if (!existsSync(BLOCKED_FILE)) return '';
  const words = readFileSync(BLOCKED_FILE, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return words.find((k) => String(company).includes(k)) || '';
}

// 阶段：数字越大越往后。待发送 / 没投成 = 插件队列里还没投出去的
// 代码和中文名照 hr-desk/docs/api-contract.md
export const STAGE_NAME = { queued: '待发送', sending: '发送中', failed: '没投成', applied: '已投', viewed: 'HR 看了', replied: 'HR 回了', interview: '约面', offer: 'offer', closed: '结束' };
export const OUTCOME_NAME = { rejected: '婉拒', ghosted: '没戏', withdrawn: '不投了', declined: '我不去' };
export const RANK = { queued: 0, sending: 0, failed: 0, applied: 1, viewed: 2, replied: 3, interview: 4, offer: 5, closed: 6 };
export const PRE = new Set(['queued', 'sending', 'failed']);

// 只认明确说面试的字眼（brain 的 INTERVIEW 太宽，「公司地址」「入职」也算，拿来定阶段会误判）
const IV_WORD = /面试|约面|面谈|复试|初试|笔试|试岗/;
export const REJECT = /不太匹配|不匹配|很遗憾|遗憾|不合适|暂不考虑您|暂不考虑你|早日找到|已招满|招满了|已经招到/;
// 盯梢 / 代投已经判了「不投、不用回」的（一票否决、骗子岗、被婉拒）：不进「你接 / 要回」
export const SAID_REJECTED = /被婉拒|婉拒了|已被拒|被拒了|没过|不合适了/;
export const SAID_NO = /直接不投|不投|一票否决|不用回|别理|骗|引流|被婉拒|婉拒了|不考虑/;
// 「要你处理」放久了：≤2 天在你接 / 要回；3～7 天降到「逾期」；超过 7 天没动静不进今天页（投递页按阶段还找得到）
export const FRESH_DAYS = 2, STALE_DAYS = 7;
const JUNK_TITLE = /手动打招呼/;
export const cleanTitle = (t = '') => (JUNK_TITLE.test(t) ? '' : t);
const DAY = 864e5;
const ms = (s) => (s ? Date.parse(`${String(s).slice(0, 19)}+08:00`) : NaN);
export const addDays = (s, n) => new Date(ms(s) + n * DAY + 8 * 3600e3).toISOString().slice(0, 19);
export const daysBetween = (a, b) => Math.floor((ms(b) - ms(a)) / DAY);

/** 平台上的状态字 / 盯梢的分类 → 阶段（和结局）。认不出返回 null */
export function stageFromText(s = '') {
  s = String(s);
  if (/不合适|婉拒|拒绝|招满/.test(s)) return { stage: 'closed', outcome: 'rejected', why: s.slice(0, 40) };
  if (/面试过了|面试已接受|邀面试|约面试|提到面试/.test(s)) return { stage: 'interview' };
  if (/有意向|感兴趣|HR 回了|回答了问题|要简历|HR 回复/.test(s)) return { stage: 'replied' };
  if (/已读|已查阅|被查看|看过|看了没下文/.test(s)) return { stage: 'viewed' };
  if (/已投|送达|未读|投递成功|已投递|还没看|一直没看|等回复/.test(s)) return { stage: 'applied' };
  return null;
}

/** 一个盯梢会话 → 阶段证据。没跟 HR 说过话的（HR 主动找来、用户没回）返回 null，不算投递；linked = 已经对上一条投递了，照样算 */
export function stageFromConv(c, linked = false) {
  const mine = c.thread.some((m) => m.me) || c.list?.fromMe || c.auto || c.manual || c.waiting;
  if (!mine && !linked) return null;
  const hr = c.thread.filter((m) => !m.me);
  const lastHr = hr[hr.length - 1]?.text || '';
  const ev = c.events || [];
  if (c.last?.kind === '拒绝' || REJECT.test(lastHr)) return { stage: 'closed', outcome: 'rejected', why: lastHr.slice(0, 60) || 'HR 婉拒', at: c.lastAt };
  // 盯梢自己的总结里已经写了被拒（「已面试完被婉拒，不用回」）
  if (c.last?.action === 'escalate' && SAID_REJECTED.test(c.last.tell || '')) return { stage: 'closed', outcome: 'rejected', why: c.last.tell.slice(0, 60), at: c.last.at };
  const ivAt = ev.find((e) => e.kind === '约面试' || IV_WORD.test(e.hr || ''))?.at;
  if (ivAt || hr.some((m) => IV_WORD.test(m.text))) return { stage: 'interview', at: ivAt || c.lastAt };
  if (hr.length && !hr.every((m) => m.fromList && /^\[(送达|已读|未读)\]/.test(m.text))) return { stage: 'replied', at: hr.find((m) => m.at)?.at || c.lastAt };
  if (/^\[已读\]/.test(c.list?.last || '') || /已查看了您的/.test(lastHr)) return { stage: 'viewed', at: c.list?.at || c.lastAt };
  return { stage: 'applied', at: c.lastAt };
}

/** 自动结局：投 7 天没人看、看了 5 天没下文 = 没戏（不生成待办，照调研的规则） */
export function autoOutcome(app, now) {
  if (app.outcome || RANK[app.stage] >= RANK.replied || RANK[app.stage] < RANK.applied) return null;
  if (app.stage === 'applied' && app.appliedAt && daysBetween(app.appliedAt, now) >= 7) return { outcome: 'ghosted', why: `投了 ${daysBetween(app.appliedAt, now)} 天没人看` };
  const seen = app.stageAt?.viewed;
  if (app.stage === 'viewed' && seen && daysBetween(seen, now) >= 5) return { outcome: 'ghosted', why: `HR ${daysBetween(seen, now)} 天前看过，没下文` };
  return null;
}

/**
 * 待办规则。输入：投递（已合并好的）、盯梢会话、插件数据、现在时间；输出待办（rkey 唯一，状态由 tracker 保留）。
 * group：you 你接 / reply 要回 / todo 其余（按到期分进 逾期 / 今天）；type 照 api-contract
 * sig：内容的「版本」，用户点过完成以后 sig 变了（HR 又说了新话、又多了待审）就重新弹出来
 */
export function computeTasks({ apps, convs, hunt, now }) {
  const out = [];
  const byConv = new Map(apps.filter((a) => a.convKey).map((a) => [a.convKey, a]));
  const today = now.slice(0, 10);

  for (const c of convs) {
    const app = byConv.get(c.key);
    const hrLast = [...c.thread].reverse().find((m) => !m.me)?.text || c.preview || '';
    const base = { appKey: app?.key || '', convKey: c.key, platform: c.platform, company: c.company, title: cleanTitle(c.title || app?.title || '') };
    const judgedNo = !!app?.outcome || c.last?.worth === '别理' || SAID_NO.test(c.last?.tell || '') || !!blockedHit(c.company);
    const lastAt = [c.last?.at, c.lastAt].filter(Boolean).sort().pop() || now;
    const age = daysBetween(lastAt, now);
    const group = (g) => (age <= FRESH_DAYS ? g : 'todo');            // 放久了降到「逾期」（due = 推给他的那天，自然落进逾期组）
    if ((c.status === 'need' || c.status === 'look') && !judgedNo && age <= STALE_DAYS) {
      if (c.status === 'need') {
        const take = c.last?.kind === '约面试' || INTERVIEW.test(hrLast) || CONTACT.test(hrLast) || /联系方式|电话|微信/.test(c.last?.kind || '');
        out.push({ ...base, rkey: `conv:${c.key}`, type: take ? 'interview' : 'reply', group: group(take ? 'you' : 'reply'),
          text: take ? (CONTACT.test(hrLast) ? 'HR 要联系方式' : '约面试') : (c.last?.kind || 'HR 回了'),
          detail: c.last?.tell || hrLast, due: lastAt, sig: c.last?.at || c.lastAt, action: 'conv' });
      } else {
        out.push({ ...base, rkey: `conv:${c.key}`, type: 'reply', group: group('reply'), text: 'HR 主动找你，值得看', detail: c.last?.tell || hrLast,
          due: lastAt, sig: c.lastAt, action: 'conv' });
      }
    }
    // BOSS 已读不回满 2 天 → 跟进一句（只 1 次：rkey 固定，点完成就不再出现）
    if (c.pid === 'boss' && app && !app.outcome && c.list?.fromMe && /^\[已读\]/.test(c.list.last || '') && c.list.at && daysBetween(c.list.at, now) >= 2
      && RANK[app.stage] < RANK.replied) {
      out.push({ ...base, rkey: `followup:${app.key}`, type: 'followup', group: 'todo', text: '已读不回 2 天，跟进一句', detail: '只跟一次；还不回就算了',
        due: addDays(c.list.at, 2), sig: '1', action: 'conv' });
    }
  }

  for (const a of apps) {
    if (blockedHit(a.company) || blockedHit(a.fullCompany)) continue;
    const base = { appKey: a.key, convKey: a.convKey || '', platform: a.platform, company: a.company, title: cleanTitle(a.title) };
    if (a.stage === 'failed' && !a.outcome) {
      out.push({ ...base, rkey: `fail:${a.key}`, type: 'confirm_failed', group: 'todo', text: '没投成，去平台确认', detail: a.extra?.error || '',
        due: (a.appliedAt || now).slice(0, 10) + 'T23:59:00', sig: a.extra?.error || '1', action: 'url', href: a.url });
    }
    // 智联 / 51job 平台上标了有意向 / 邀面试：平台网页上 HR 留言盯梢读不到，要用户去平台看
    const ps = a.extra?.platformState || '';
    if ((a.pcode === 'zl' || a.pcode === '51') && /有意向|感兴趣|邀面试/.test(ps) && !a.outcome && !a.convKey) {
      const iv = /邀面试/.test(ps);
      out.push({ ...base, rkey: `plat:${a.key}:${ps}`, type: iv ? 'interview' : 'check_msg', group: iv ? 'you' : 'todo',
        text: iv ? `${a.platform} 上邀面试` : `${a.platform} 上标了${ps}，去看留言`, detail: iv ? '时间地点在平台上，你自己接' : '平台网页的留言盯梢读不到',
        due: a.stageAt?.[a.stage] || now, sig: ps, action: 'url', href: a.pcode === '51' ? 'https://i.51job.com/userset/my_apply.php' : 'https://i.zhaopin.com/schedule' });
    }
    // 约面的不管多老都不藏（10/16 队长）：超过 7 天没动静、又没有别的待办的，放「逾期」组底部折叠，问一句结果
    const ivAt = a.extra?.interviewAt;
    const lastMove = [a.conv?.lastAt, a.conv?.last?.at, a.stageAt?.interview].filter(Boolean).sort().pop();
    if (a.stage === 'interview' && !a.outcome && !ivAt && lastMove && daysBetween(lastMove, now) > STALE_DAYS) {
      out.push({ ...base, rkey: `stale-iv:${a.key}`, type: 'ask_result', group: 'todo', text: `${daysBetween(lastMove, now)} 天没动静，问一下结果？`,
        detail: '约过面试，后来没下文', due: lastMove, sig: lastMove, action: a.convKey ? 'conv' : 'url', href: a.url, fold: true });
    }
    // 面试时间过了 → 第二天问结果（照 career-ops：面试后 1 天）
    if (ivAt && ivAt < now && !a.outcome) {
      out.push({ ...base, rkey: `result:${a.key}`, type: 'ask_result', group: 'todo', text: '面试过了，问结果', detail: `面试时间 ${ivAt.slice(5, 16).replace('T', ' ')}`,
        due: addDays(ivAt, 1), sig: ivAt, action: a.convKey ? 'conv' : 'url', href: a.url });
    }
  }

  // 待审只生成一条「审 N 家」（BOSS / 51job / 智联 / 猎聘）；网申公告单独一条（10/16 队长：网申一下 188 条，混在一起看着吓人）
  const NAME = { boss: 'BOSS', '51job': '51job', zhilian: '智联', liepin: '猎聘' };
  const pending = (hunt?.queue || []).filter((q) => q.status === '待审核' && q.source !== 'campus');
  if (pending.length) {
    const by = {};
    for (const q of pending) { const k = NAME[q.source] || 'BOSS'; by[k] = (by[k] || 0) + 1; }
    out.push({ appKey: '', convKey: '', rkey: 'review-queue', type: 'review_jobs', group: 'todo', text: `审 ${pending.length} 家新岗位`,
      detail: `${Object.entries(by).map(([k, n]) => `${k} ${n}`).join(' · ')}，投还是不投你定`,
      due: `${today}T23:59:00`, sig: String(Math.max(...pending.map((q) => q.addedAt || 0))), action: 'hunt', count: pending.length });   // 审岗位不算逾期，永远是「今天」
  }
  // 网申：只算模型建议「投」、还没打开过、没截止的；3 天内截止的单独点出来
  const camp = (hunt?.queue || []).filter((q) => q.source === 'campus' && q.verdict === '投' && !q.opened && (!q.deadline || q.deadline >= today));
  if (camp.length) {
    const left = (d) => (d ? Math.round((Date.parse(d) - Date.parse(today)) / DAY) : 99);
    const soon = camp.filter((q) => left(q.deadline) <= 3);
    out.push({ appKey: '', convKey: '', rkey: 'review-campus', type: 'review_campus', group: 'todo',
      text: `网申公告 ${camp.length} 家建议投${soon.length ? `（${soon.length} 家 3 天内截止）` : ''}`,
      detail: soon.length ? `快截止：${soon.sort((a, b) => String(a.deadline).localeCompare(String(b.deadline))).slice(0, 4).map((q) => `${q.company}（${q.deadline.slice(5).replace('-', '/')}）`).join('、')}${soon.length > 4 ? ' 等' : ''}` : '打开投递链接自己填，交了点「我交了」',
      due: `${today}T23:59:00`, sig: String(camp.length), action: 'hunt-campus', count: camp.length });
  }
  for (const t of out) if (!t.due) t.due = `${today}T23:59:00`;
  return out;
}
