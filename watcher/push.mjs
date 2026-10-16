// Telegram 推送排版（HTML 模式）：一家一张卡片，公司名加粗、HR 原话放引用框，「不用回」折叠起来
// 10/12 用户：推过来的消息要重排版、好读一点。以前是一整段纯文本挤在一起
const esc = (s = '') => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const cut = (s = '', n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
// 岗位名只去掉末尾的招聘编号：「网课市场运营专员J46709」「… (MJ026036)」
// 10/12 用户：岗位名里的福利（【】里的、+五险一金、双休这些）保留，有参考价值
const job = (t = '') => cut(t.replace(/\s*[(（]?[A-Z]{0,3}\d{4,}[)）]?\s*$/, '').trim(), 50);
// HR 这次说的话：一条一行，最多最近 3 条
const hrLines = (e, n = 100) => {
  const msgs = (e.hrFresh || e.hr || '').split(' / ').map((s) => s.replace(/^\d{1,2}:\d{2}\s*/, '').trim()).filter(Boolean).slice(-3);   // 去掉智联带的「15:58 」时间
  return `<blockquote>${msgs.map((m) => esc(cut(m, n))).join('\n')}</blockquote>`;
};
const head = (e) => `<b>${esc(e.company || '（没读到公司）')}</b> · ${esc(e.platform || '')}${e.title ? `\n${esc(job(e.title))}` : ''}`;

function cardEsc(e) {
  const out = [head(e), hrLines(e)];
  const why = [e.why && !/草稿/.test(e.why) ? e.why : '', e.tell].filter(Boolean).join('，');
  if (why) out.push(`👉 ${esc(why)}`);
  if (e.resume) out.push(`📎 简历：${esc(e.resume)}`);
  if (e.err) out.push(`⚠️ ${esc(e.err)}`);
  return out.join('\n');
}
function cardSent(e) {
  const out = [head(e), hrLines(e), `💬 <i>${esc(e.reply || '（只发了简历）')}</i>`];
  if (e.askInterview) out.push(`📅 我主动约了面试（好单位第 ${e.goodUnit || '?'} 条${e.unitWhy ? '：' + e.unitWhy : ''}），HR 给时间或地址会推给你定`);
  if (e.resume) out.push(`📎 简历：${esc(e.resume)}`);
  if (e.sent === false) out.push(`⚠️ 没发出去：${esc(e.err || '')}`);
  return out.join('\n');
}
const cardLook = (e) => [head(e), hrLines(e, 120), e.tell ? `💡 ${esc(e.tell)}` : ''].filter(Boolean).join('\n');

/** events → 若干条 Telegram 消息（HTML）。超长时按卡片切成几条，不会把一张卡片劈开 */
export function render(events, { time, dry = false, deferred = 0 } = {}) {
  const pick = (f) => events.filter(f);
  const raw = pick((e) => e.raw);
  const escs = pick((e) => e.action === 'escalate');
  const sent = pick((e) => e.action === 'reply' || e.action === 'send_resume');
  const look = pick((e) => e.outreach && e.worth === '值得看' && e.action === 'ignore');
  const quiet = pick((e) => e.action === 'ignore' && !(e.outreach && e.worth === '值得看'));

  const tally = [escs.length && `🔴 ${escs.length} 要你接`, sent.length && `✅ ${sent.length} 已回`, look.length && `🟡 ${look.length} 值得看`, quiet.length && `⚪ ${quiet.length} 不用回`].filter(Boolean).join('  ');
  const blocks = [`<b>📨 HR 消息</b>  ${esc(time || '')}${dry ? '（试跑，没发）' : ''}${tally ? `\n${tally}` : ''}`];
  for (const e of raw) blocks.push(esc(e.raw));
  const section = (title, list, card) => {
    if (!list.length) return;
    list.forEach((e, i) => blocks.push((i === 0 ? `━━━━━━━━━━\n${title}\n\n` : '') + card(e)));
  };
  section(`🔴 <b>要你接（${escs.length}）</b>`, escs, cardEsc);
  section(`✅ <b>我回了（${sent.length}）</b>`, sent, cardSent);
  section(`🟡 <b>HR 主动找来、像是值得看（${look.length}）</b>  <i>我没回</i>`, look, cardLook);
  if (quiet.length) {
    const lines = quiet.map((e) => `· <b>${esc(cut(e.company || '', 14))}</b>  ${esc(cut(e.tell || e.kind || '', 34))}`);
    blocks.push(`━━━━━━━━━━\n⚪ <b>不用回（${quiet.length}）</b>  <i>点开看理由</i>\n<blockquote expandable>${lines.join('\n')}</blockquote>`);
  }
  if (deferred) blocks.push(`<i>你在桌面 2，BOSS 还有 ${deferred} 条等你切走再处理</i>`);

  const msgs = [];
  let cur = '';
  for (const b of blocks) {
    if (cur && (cur + '\n\n' + b).length > 3800) { msgs.push(cur); cur = b; }
    else cur = cur ? cur + '\n\n' + b : b;
  }
  if (cur) msgs.push(cur);
  return msgs;
}
