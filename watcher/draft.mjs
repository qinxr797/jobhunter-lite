// 收件箱里的「AI 起草」：用户手动回之前让 DeepSeek 先写一稿，他改完自己点发送（照 Chatwoot 的 Copilot：AI 起草、人来发）
// 跟盯梢自动回不同：这里不判断回不回、不把关，只按用户给的意思写，写出来是草稿
import { draftSystem, chat } from './prompts.mjs';

export async function draft({ platform, company, title, name, msgs = [], hint = '', mode = 'reply' }) {
  const lines = msgs.slice(-14).map((m) => `${m.me ? '我' : 'HR'}：${m.text}`).join('\n') || '（没有聊天记录）';
  const user = `平台：${platform}｜公司：${company}｜岗位：${title || '没读到'}｜HR：${name || ''}\n场景：${mode === 'follow' ? 'HR 很久没回，写一条跟进' : '回复 HR 最新的话'}\n${hint ? `他想表达的意思：${hint}\n` : ''}聊天记录（从早到晚）：\n${lines}`;
  const j = await chat(draftSystem(), user, { maxTokens: 500, temperature: 0.4 });   // 出错已经翻成人话
  let d;
  try { d = JSON.parse(j.choices[0].message.content); } catch { throw new Error('DeepSeek 回的格式不对，再点一次'); }
  const reply = String(d.reply || '').trim();
  if (!reply) throw new Error('DeepSeek 回了个空稿，再点一次或写清楚想表达的意思');
  return { reply, note: d.note || '' };
}
