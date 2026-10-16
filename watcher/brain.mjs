// HR 盯梢的「脑子」：一个会话的聊天记录 → DeepSeek 判断该怎么办 → 本地规则再把一遍关
import path from 'node:path';
import { cfg, DATA, isBlocked, variants, stripPlace } from './config.mjs';
import { brainSystem, badReply, chat } from './prompts.mjs';

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const BLOCKED = path.join(DATA, 'blocked.txt');
// 我们约过面试之后 HR 的话里出现这些（给时间、答应、问哪天）→ 推给用户定
const ACCEPT = /面试|面谈|来公司|到公司|过来|周[一二三四五六日天末]|星期|礼拜|今天|明天|后天|上午|下午|晚上|\d{1,2}\s*[点:：号]|好的|可以|行啊|没问题|^\s*(行|好|嗯|ok|OK)\s*$/;
const NO_IV = path.join(DATA, 'no-interview.txt');   // 10/14：不主动约面试的公司（上海那 8 家）



// 10/14 22:52 用户：约面试要审查，好单位才约（下面 5 条至少满足一条），别啥都叫他去来回跑
// 投递记录（records\投递记录-*.xlsx）汇成 data\applied.json，按公司名查规模/休息/背调；xlsx 有更新就重建
const APPLIED = path.join(DATA, 'applied.json');
let appliedCache = null, appliedAt = 0;
// 投递记录：投递总表导出的 applied.json（公开版不读 xlsx）
function loadApplied() {
  try { const m = statSync(APPLIED).mtimeMs; if (!appliedCache || m !== appliedAt) { appliedCache = JSON.parse(readFileSync(APPLIED, 'utf8')); appliedAt = m; } } catch { appliedCache = appliedCache || []; }
  return appliedCache;
}
const core = (s = '') => stripPlace(s).replace(/[（(][^）)]*[）)]/g, '').replace(/有限|责任|股份|公司|集团|中国|科技|分公司/g, '').replace(/\s/g, '');
export function findApplied(company = '', title = '') {
  const a = core(company);
  if (a.length < 2) return null;
  const hit = loadApplied().filter((r) => { const b = core(r.company); return b.length >= 2 && (b.includes(a) || a.includes(b)); });
  return hit.find((r) => title && (r.title.includes(title) || title.includes(r.title.split(/[（(]/)[0]))) || hit[hit.length - 1] || null;
}
// 第 5 条「小而美」= 正规（模型按背调判 legit）+ 时间好：双休，而且下班在 17~19 点（六七点下班）。时间只认记录里的休息栏和 HR 说的话，不让模型猜
export function timeOk(text = '') {
  if (!/双休/.test(text) || /单休|大小周/.test(text)) return false;
  const ends = [];
  for (const m of text.matchAll(/(\d{1,2})(?:[:：.]\d{2})?\s*(?:点)?\s*[-–—~～至到]\s*(?:下午|晚上)?\s*(\d{1,2})(?:[:：.](\d{2}))?/g)) ends.push([+m[2], +(m[3] || 0)]);
  for (const m of text.matchAll(/(\d{1,2}|五|六|七)\s*点\s*(半)?\s*下班/g)) ends.push([{ 五: 5, 六: 6, 七: 7 }[m[1]] ?? +m[1], m[2] ? 30 : 0]);
  return ends.some(([h, mi]) => { if (h < 12) h += 12; return h >= 17 && (h < 19 || (h === 19 && mi === 0)); });
}


// 面试红线（用户 9/29：面试他自己接）。HR 说的话里出现这些，一律不回、立刻推给用户
// 10/14 用户：我们可以主动提出面试，但 HR 一接话（给时间、地址、问哪天方便）照样推给用户，具体安排他自己定
export const INTERVIEW = /面试|约面|面谈|复试|初试|笔试|试岗|来公司|到公司|来我们公司|过来聊|当面聊|线下聊|到店|视频面|电话面|语音面|什么时候方便|哪天方便|几点方便|时间方便|有空过来|地址发你|发你地址|公司地址|定位发|入职|报到|offer|Offer/;
// 要电话 / 微信：换联系方式是用户的事
export const CONTACT = /换电话|换微信|加微信|加个微信|微信号|手机号|电话号码|留个电话|打电话|vx|VX|加v|加V/;
// 发出去之前的硬检查：语气（10/3 用户定）+ 不许替他答应面试 / 留联系方式
// 2026-10-09 用户：薪资/休息这些待遇问题整个前期都不问，后期话题自然走到那儿他自己问 —— 这里直接拦死
// 10/14 用户「主动去提出面试」：「面试」放行；但不许替他报具体日子和钟点（明天/周几/几点/几号），时间让 HR 定、他本人确认
const BAD_REPLY = { test: (s) => badReply().test(s) };   // 规则见 prompts.mjs badReply()，跟着设置变

export async function decide(conv) {
  const lines = conv.msgs.map((m) => `${m.me ? '我' : 'HR'}：${m.text}`).join('\n');
  const rec = findApplied(conv.company, conv.title);
  conv.applied = rec;
  const tf = timeOk(`${rec?.rest || ''} ${conv.msgs.filter((m) => !m.me).map((m) => m.text).join(' ')}`);
  const recLine = rec ? `投递记录（${rec.day}）：${rec.company}｜${rec.title}｜规模：${rec.size || '没记'}｜休息：${rec.rest || '没记'}｜背调：${rec.bg || '没记'}\n` : '投递记录：没查到这家\n';
  const user = `平台：${conv.platform}\nHR：${conv.name}｜公司：${conv.company}｜岗位：${conv.title || '（没读到）'}\n${recLine}程序判的时间：${tf ? '双休、六七点下班（第 5 条的时间这项占了）' : '没确认双休六七点下班'}\n${conv.resumeSent ? '（这个会话里附件简历之前已经发过了，不要再选 send_resume）\n' : ''}聊天记录（从早到晚，最多最近 14 条）：\n${lines}\n\n按上面的规则判断，输出 json。`;
  const j = await chat(brainSystem(), user);
  const d = JSON.parse(j.choices[0].message.content);
  return guard(conv, d, j.usage);
}

/** 本地规则把关：模型说什么都不能越过这几条 */
export function guard(conv, d, usage) {
  const hr = conv.msgs.filter((m) => !m.me);
  const lastMine = conv.msgs.map((m) => m.me).lastIndexOf(true);
  const fresh = conv.msgs.slice(lastMine + 1).filter((m) => !m.me).map((m) => m.text).join(' ');
  const out = { kind: d.kind || '其他', action: d.action || 'escalate', reply: (d.reply || '').trim(), tell: d.tell || '', worth: d.worth || '', usage };
  out.ask_interview = /面试|当面聊|面谈/.test(out.reply);   // 以草稿里实际写没写为准，不信模型自报
  const outreach = !conv.msgs.some((m) => m.me);
  // 10/14：我们上一条已经提过面试，HR 回什么都推给用户（「周四下午两点吧」这种不带面试字眼的也算）
  const mine = conv.msgs.filter((m) => m.me);
  const askedBefore = mine.some((m) => /面试|当面聊|面谈/.test(m.text));
  const askedLast = /面试|当面聊|面谈/.test(mine[mine.length - 1]?.text || '');
  // 好单位闸门：1~4 条看模型（有投递记录的规模/背调作依据），第 5 条时间合适由本地规则判
  const units = String(d.good_unit || '').split(/[,，、\s]+/).filter((x) => +x >= 1 && +x <= cfg().goodUnits.length);
  const timeFit = timeOk(`${conv.applied?.rest || ''} ${hr.map((m) => m.text).join(' ')}`);
  const xmm = timeFit && d.legit === true;               // 小而美：正规 + 双休六七点下班，两样都要
  if (xmm) units.push(String(cfg().goodUnits.length + 1));
  out.good_unit = units.join(',');
  out.unit_why = [d.unit_why, xmm ? '小而美：正规、双休、六七点下班' : timeFit ? '双休六七点下班，但看不出正规，不算' : ''].filter(Boolean).join('；');
  if (outreach) { out.action = 'ignore'; out.outreach = true; }          // HR 主动找来的：只汇报，不替他接
  if (INTERVIEW.test(fresh) && !(outreach && out.worth === '别理')) { out.action = 'escalate'; out.kind = '约面试'; out.why = '出现面试类字眼'; }
  else if (askedLast && ACCEPT.test(fresh) && out.action !== 'ignore') { out.action = 'escalate'; out.kind = '约面试'; out.why = 'HR 在回我们的面试邀约'; }
  else if (CONTACT.test(fresh) && out.action !== 'ignore') { out.action = 'escalate'; out.why = '要联系方式'; }
  // 已经约过一次、HR 没接：不追问；不约面试的公司（外地等，data\no-interview.txt）：不提
  const noIv = existsSync(NO_IV) ? readFileSync(NO_IV, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
  // 10/15：回复写精炼后模型常把约面试那句漏掉 —— 好单位、没约过、HR 正常接话（不是主动找来、不是外地名单）就补上标准的一句

  if (cfg().autopilot.askInterview && !out.ask_interview && out.good_unit && !askedBefore && !outreach && (out.action === 'reply' || out.action === 'send_resume')
      && !noIv.some((k) => (conv.company || '').includes(k))) {
    out.reply = `${out.reply}${/[。！？?!]$/.test(out.reply) || !out.reply ? '' : '。'}如果您觉得合适，想约个时间去公司当面聊聊，您看什么时候方便？`;
    out.ask_interview = true;
  }
  if (out.ask_interview && (out.action === 'reply' || out.action === 'send_resume')) {
    if (noIv.some((k) => (conv.company || '').includes(k))) { out.action = 'escalate'; out.why = `这家不主动约面试（外地）；草稿：${out.reply}`; out.reply = ''; out.ask_interview = false; }
    else if (askedBefore || !out.good_unit || !cfg().autopilot.askInterview) {
      // 约过一次 HR 没接：不追问；不是好单位：不约。都是把提面试的那句删掉，剩下的照发
      out.reply = out.reply.split(/(?<=[。！？?!])/).filter((x) => !/面试|当面聊|面谈/.test(x)).join('').trim();
      out.ask_interview = false;
      if (!out.reply && out.action === 'reply') { out.action = 'escalate'; out.why = askedBefore ? '之前已经约过面试，HR 没接，这轮没别的可回' : '不算好单位、没约面试，这轮没别的可回'; }
    }
  }
  if ((out.action === 'reply' || out.action === 'send_resume') && out.reply) {
    // 10/15 用户：精炼，不亮短板 —— 写长了或写了「没做过 / 不会」就不发，推给用户
    // 10/16：德科那条「光伏这块我确实没有行业经验，CAD也不熟，就不占用您时间了」漏过去了 —— 补上「不熟 / 没有 X 经验 / 自己打退堂鼓」
    if (BAD_REPLY.test(out.reply) || out.reply.length > 150 || /没做过|没有做过|不会|没.{0,6}经验|缺乏|不太熟|不熟|不太了解|不了解|可以学|不占用您|不打扰您|不太匹配|不合适/.test(out.reply)) { out.action = 'escalate'; out.why = `草稿没过检查：${out.reply}`; out.reply = ''; }
  }
  if (out.action === 'send_resume' && conv.resumeSent) { out.action = out.reply && !/简历/.test(out.reply) ? 'reply' : 'escalate'; out.why = out.action === 'escalate' ? '简历之前发过了，HR 又提简历，你看一眼' : ''; }
  if (out.action === 'reply' && !out.reply) out.action = 'escalate';
  if (!hr.length) out.action = 'ignore';
  // 用户拉黑的公司（data\blocked.txt 一行一个关键词）：一句不回，也不再推
  const blocked = existsSync(BLOCKED) ? readFileSync(BLOCKED, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
  if (blocked.some((k) => (conv.company || '').includes(k)) || isBlocked(conv.company)) { out.action = 'ignore'; out.worth = '别理'; out.reply = ''; out.why = '用户拉黑的公司'; }
  if (!cfg().autopilot.autoReply && (out.action === 'reply' || out.action === 'send_resume')) { out.why = `设置里关了自动回复，草稿：${out.reply || '（发简历）'}`; out.action = 'escalate'; }
  return out;
}

/** 按岗位名挑附件简历（和插件同一套关键词） */
export function pickVariant(title = '') {
  for (const v of variants()) if ((v.keywords || []).some((k) => title.toLowerCase().includes(String(k).toLowerCase()))) return v;
  return variants().find((v) => v.id === 'general') || variants()[0];
}
