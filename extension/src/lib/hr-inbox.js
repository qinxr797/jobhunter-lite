/**
 * HR 消息（v0.9.1，2026-09-28）：读 BOSS 聊天列表，看谁回了、回的什么，告诉你下一步该干什么。
 * 参考 GitHub get_jobs 的 updateBlacklistFromChats（它按关键词把拒绝的公司自动拉黑），我们换成模型分类、只给建议。
 *
 * 只读：后台开一个 /web/geek/chat 标签，读左边会话列表（未读数、时间、HR 姓名 / 公司 / 职位、最后一条消息），关掉。
 * **不点开任何会话**（点开会给 HR 留「已读」），不发任何消息；回复草稿给你复制，他自己去发。
 * 9/28 按真页面核对的结构：li[role=listitem] .friend-content → .notice-badge / .time / .name-text + 两个 span（公司、职位）/ .last-msg-text；
 * 最后一条是自己发的，前面有「[送达]」「[已读]」。
 */
import { callJson, forTask } from './llm.js';
import { getArchive, findEntry, recordChannel } from './company-archive.js';
import { buildReview } from './review.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 页面里跑：读会话列表 */
function readChatList() {
  const t = (e) => (e?.innerText || '').replace(/\s+/g, ' ').trim();
  if (/登录|注册/.test(t(document.querySelector('.header, header'))) && !document.querySelector('.user-list-content')) return { login: true };
  const lis = [...document.querySelectorAll('.user-list-content li, li[role="listitem"]')].filter((li) => li.querySelector('.name-text'));
  return {
    items: lis.slice(0, 40).map((li) => {
      const spans = [...li.querySelectorAll('.name-box > span')].map(t).filter(Boolean);
      const all = t(li);
      return {
        name: t(li.querySelector('.name-text')),
        company: spans[1] || '',
        title: spans[2] || '',
        time: t(li.querySelector('.time')),
        unread: Number(t(li.querySelector('.notice-badge'))) || 0,
        last: t(li.querySelector('.last-msg-text')),
        fromMe: /\[(送达|已读|未读)\]/.test(all),
        mine: (all.match(/\[(送达|已读|未读)\]/) || [])[1] || '',   // 自己最后一条的状态（回顾用）
      };
    }),
  };
}

export async function readBossInbox() {
  const tab = await chrome.tabs.create({ url: 'https://www.zhipin.com/web/geek/chat', active: false });
  try {
    for (let i = 0; i < 40; i++) {
      const t = await chrome.tabs.get(tab.id).catch(() => null);
      if (!t) throw new Error('标签被关了');
      if (t.status === 'complete') break;
      await sleep(400);
    }
    let r = {};
    for (let k = 0; k < 8; k++) {       // 列表是异步渲染的，等它出来
      await sleep(1200);
      const [x] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readChatList });
      r = x?.result || {};
      if (r.login || (r.items || []).length) break;
    }
    if (r.login) throw new Error('BOSS 没登录，先在这个 Chrome 里登录 BOSS');
    return r.items || [];
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

const SCHEMA = {
  type: 'object',
  properties: { items: { type: 'array', items: { type: 'object', properties: {
    i: { type: 'integer' },
    kind: { type: 'string', enum: ['约面试', '要简历', '问问题', '主动邀约', '拒绝', '系统/无关'] },
    worth: { type: 'string', enum: ['值得跟', '看情况', '别理'] },
    next: { type: 'string' },
    reply: { type: 'string' },
  }, required: ['i', 'kind', 'worth', 'next', 'reply'] } } },
  required: ['items'],
};

/** 模型给每条 HR 消息分类 + 下一步 + 回复草稿（只给 HR 最后说话的；你自己最后说的就是在等对方） */
export async function classifyInbox(items, config) {
  const todo = items.map((x, i) => ({ ...x, i })).filter((x) => !x.fromMe && x.last && !/您正在与/.test(x.last));
  if (!todo.length) return [];
  const archive = await getArchive();
  const lines = todo.map((x) => {
    const hit = findEntry(archive, x.company);
    return `${x.i}. ${x.name}｜${x.company}｜${x.title}｜${x.time}｜未读 ${x.unread}｜${hit ? '他之前主动投过这家' : '他没主动投过（多半是 HR 主动找来的）'}｜最后一条：${x.last}`;
  }).join('\n');
  const d = await callJson(forTask(config, 'screen'), {
    system: `你在帮一个求职者看 BOSS 直聘上 HR 发来的消息，告诉他每条该怎么办。他的求职标准：\n${config.criteria || ''}`,
    user: `下面是聊天列表里 HR 最后发来的消息（只看得到最后一条）。逐条判断：
- kind：约面试 / 要简历（要附件简历、要作品、要微信电话）/ 问问题（问到岗时间、问经历、问期望薪资等等他回答）/ 主动邀约（HR 主动来推岗位）/ 拒绝（「不太匹配」「祝您找到」这类）/ 系统/无关
- worth：值得跟 / 看情况 / 别理。主动邀约里是销售、电销、主播、保险、招商、律所前台、「出国游」「底薪+提成」这种不对口或可疑的，给「别理」；和他方向对口、像正经公司的给「值得跟」
- next：一句话告诉他下一步干什么（比如「发附件简历」「回一句问无责底薪」「不用回，记进拒绝」）
- reply：给他一句可以直接发的回复草稿（自信、得体、自然、流畅（像一个靠谱的求职者在正常沟通；不开玩笑、不用比喻和自嘲、不用表情符号；事实只能来自他的简历）；不写可随时到岗；要简历的就说马上发附件；约面试的就确认时间地点；问底薪的问题照实问无责底薪）。拒绝和别理的给空字符串
${lines}
输出 json：{"items": [{"i": 编号, "kind": "...", "worth": "...", "next": "...", "reply": "..."}]}`,
    schema: SCHEMA, maxTokens: 3000, task: 'inbox',
  });
  const by = new Map((d.items || []).map((x) => [Number(x.i), x]));
  return todo.map((x) => ({ ...x, ai: by.get(x.i) || null }));
}

/** 读 + 分类 + 把拒绝 / 约面试记进公司档案，存起来给「今天」页用 */
export async function refreshInbox(config) {
  const items = await readBossInbox();
  const done = await classifyInbox(items, config);
  for (const x of done) {
    if (x.ai?.kind === '拒绝') await recordChannel(x.company, 'boss', { title: x.title, hr: 'rejected' }).catch(() => {});
    if (x.ai?.kind === '约面试') await recordChannel(x.company, 'boss', { title: x.title, hr: 'interview' }).catch(() => {});
  }
  const rec = { at: Date.now(), total: items.length, waitingMe: done.length, items: done };
  await chrome.storage.local.set({ hrInbox: rec });
  await buildReview(items, done).catch(() => {});   // 顺手更新「投过的回顾」
  return rec;
}
