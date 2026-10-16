// BOSS 实时推送：一直挂在 9333 的聊天页上「听」它自己的消息长连接，HR 一发消息几秒内叫醒盯梢
// 10/16 REA 逆向查到：BOSS 聊天走 MQTT over WebSocket（ws.zhipin.com/chatws），消息是 protobuf。
// 我们不解协议、不往里发任何东西：只用 CDP 的 Network 域旁听（页面自己察觉不到），
// 看到服务器推来一个 PUBLISH 包（MQTT 包类型 3）就当「有新动静」，让盯梢马上扫一轮；心跳包（PINGRESP）不算。
// 以前每 5 分钟才看一次，HR 平均要等两三分钟；现在几秒。5 分钟一轮的轮询照旧留着兜底。
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { sleep, PORTS, pickTab, DATA } from './lib.mjs';

const PORT = PORTS.boss;                                   // 9333 老 Chrome，或 HR Desk 的 9401（见 lib.mjs）
const CHAT = 'https://www.zhipin.com/web/geek/chat';

/** 找聊天页；没有就后台开一个并且留着（盯梢自己开的标签每轮用完会关，推送要一直有页面在线） */
async function chatTab() {
  const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json`, { signal: AbortSignal.timeout(5000) })).json();
  let t = pickTab(tabs, 'zhipin.com/web/geek/chat');
  if (t) return t;
  const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(5000) })).json();
  const b = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((ok, bad) => { b.onopen = ok; b.onerror = () => bad(new Error('CDP 连不上')); });
  // background：不把窗口拽到前台（10/11 的弹窗教训）
  b.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url: CHAT, background: true } }));
  await sleep(1500); b.close();
  await sleep(6000);
  const again = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  return again.find((x) => x.type === 'page' && x.url.includes('zhipin.com/web/geek/chat')) || null;
}

/**
 * 一直跑：断了 30 秒后重连。onPush() 在收到新推送时调用（同一阵推送 8 秒内只算一次，等列表渲染好）。
 * onState(ok, note) 报告连接状态给收件箱显示。
 */
export async function listenBoss({ onPush, onState }) {
  for (;;) {
    try {
      const t = await chatTab();
      if (!t) { onState(false, '没有聊天页'); await sleep(60000); continue; }
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = () => bad(new Error('CDP 连不上')); });
      ws.send(JSON.stringify({ id: 1, method: 'Network.enable' }));
      onState(true, '实时');
      let timer = null, lastPing = Date.now(), iv = null;
      await new Promise((done) => {
        ws.onmessage = (e) => {
          const m = JSON.parse(e.data);
          if (m.method === 'Network.webSocketFrameReceived') {
            const r = m.params.response;
            if (r.opcode !== 2) return;
            const type = Buffer.from(r.payloadData, 'base64')[0] >> 4;
            if (type === 13) { lastPing = Date.now(); return; }               // 心跳回包：连接还活着
            if (type === 3 && !timer) timer = setTimeout(() => { timer = null; onPush(); }, 8000);
          }
          // 页面被导航走了（用户把这个标签切去看岗位），重新找聊天页
          if (m.method === 'Inspector.detached' || (m.method === 'Page.frameNavigated' && !m.params.frame.parentId && !/\/web\/geek\/chat/.test(m.params.frame.url))) done();
        };
        ws.send(JSON.stringify({ id: 2, method: 'Page.enable' }));
        ws.onclose = () => done();
        // 页面心跳 25 秒一次；两分钟没听到，多半长连接断了或页面睡了，重连一遍
        iv = setInterval(() => { if (Date.now() - lastPing > 120000) done(); }, 30000);
      });
      clearInterval(iv); clearTimeout(timer);
      try { ws.close(); } catch {}
      onState(false, '推送断了，30 秒后重连');
    } catch (e) { onState(false, `推送连不上：${e.message.slice(0, 30)}`); }
    await sleep(30000);
  }
}

// ---------------------------------------------------------------- 智联
// 10/16 摸底（CDP 旁听 + 拆网易云信 NIM_Web_SDK v9.17.5）：智联聊天走云信的二进制 WebSocket。
// 帧头：varint 包长、u8 sid、u8 cid、u16le ser、u8 tag（tag&2 时再跟 u16le 返回码）；sid=4 且 cid∈{1,2,10,11} 是打包帧，跳过 8 字节 msgId 再解一层。
// 1_2 心跳（31 秒一次）；7_2 单条新消息、4_4 补离线消息、7_3 系统消息（HR 的卡片请求可能走这里）当「有新动静」。
// 7_2 是按 SDK 映射表推出来的，还没抓到真 HR 消息帧核实：头几天把所有非心跳的命令号记进 data\zl-frames.log，来一条真消息时对一下
function nimHead(b, at = 0) {
  let len = 0, shift = 0, i = at;
  for (; i < b.length; i++) { len |= (b[i] & 0x7f) << shift; shift += 7; if (!(b[i] & 0x80)) { i++; break; } }
  if (i + 5 > b.length) return null;
  const sid = b[i], cid = b[i + 1], tag = b[i + 4];
  return { sid, cid, end: i + 5 + (tag & 2 ? 2 : 0) };
}
const ZL_PUSH = new Set(['7_2', '4_4', '7_3']);
const ZL_QUIET = new Set(['1_2', '2_7', '4_3', '4_5']);

export async function listenZhaopin({ onPush, onState }) {
  const port = PORTS.zhaopin;
  for (;;) {
    try {
      const tabs = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(5000) })).json();
      const t = pickTab(tabs, 'i.zhaopin.com/im');
      if (!t) { onState(false, '没有消息页'); await sleep(60000); continue; }
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = () => bad(new Error('CDP 连不上')); });
      ws.send(JSON.stringify({ id: 1, method: 'Network.enable' }));        // 只开 Network，别开 Debugger
      onState(true, '实时');
      let timer = null, lastBeat = Date.now(), iv = null;
      await new Promise((done) => {
        ws.onmessage = (e) => {
          const m = JSON.parse(e.data);
          if (m.method !== 'Network.webSocketFrameReceived') { if (m.method === 'Inspector.detached') done(); return; }
          const r = m.params.response;
          if (r.opcode !== 2) return;
          const b = Buffer.from(r.payloadData, 'base64');
          let h = nimHead(b);
          if (!h) return;
          if (h.sid === 4 && [1, 2, 10, 11].includes(h.cid)) h = nimHead(b, h.end + 8) || h;
          const key = `${h.sid}_${h.cid}`;
          lastBeat = Date.now();
          if (key === '1_2') return;
          if (!ZL_QUIET.has(key)) { try { appendFileSync(path.join(DATA, 'zl-frames.log'), `${new Date().toISOString()} ${key} ${b.length}B\n`); } catch {} }
          if (ZL_PUSH.has(key) && !timer) timer = setTimeout(() => { timer = null; onPush(key); }, 8000);
        };
        ws.onclose = () => done();
        // 心跳 31 秒一次；两分钟什么都没收到 = 长连接断了或页面导走了（盯梢 leaveSession 会重开 /im），重连
        iv = setInterval(() => { if (Date.now() - lastBeat > 120000) done(); }, 30000);
      });
      clearInterval(iv); clearTimeout(timer);
      try { ws.close(); } catch {}
      onState(false, '推送断了，30 秒后重连');
    } catch (e) { onState(false, `推送连不上：${e.message.slice(0, 30)}`); }
    await sleep(30000);
  }
}
