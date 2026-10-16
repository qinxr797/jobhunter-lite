// 51job（.chrome-jobs，9334，无头）：网页上聊不了天，只看「我的申请」里的「邀面试」「感兴趣」有没有新的
import { connect, sleep, PORTS } from './lib.mjs';

const URL = (tag) => `https://i.51job.com/userset/my_apply.php?type=sh&tagType=${tag}&lang=c`;
const ROWS = `(()=>{const b=(document.body.innerText||'').replace(/\\s+/g,' ');
  if(/login|passport/.test(location.href)) return {login:true};
  const out=[];const re=/(\\S+) (\\S+) 立即沟通 (\\S+?) (\\S+) 申请于(\\d{4}-\\d{2}-\\d{2})/g;let m;
  while((m=re.exec(b)))out.push({title:m[1],salary:m[2],company:m[3],day:m[5]});return {rows:out}})()`;

export async function check51(state, events) {
  state.j51 ||= { ms: [], xq: [] };
  for (const [tag, label] of [['ms', '邀面试'], ['xq', '感兴趣']]) {
    // 10/16：两个标签共用一张「我的申请」页（下面会 navigate 过去）。HR Desk 里开不了新标签，只能用它常驻的那张
    const c = await connect(PORTS.j51, 'i.51job.com/userset/my_apply', URL(tag));
    if (!c) throw new Error(`51job 浏览器（${PORTS.j51}）连不上`);
    try {
      // 10/16 REA 逆向：i.51job.com 页面自己会 POST vapi.51job.com/user.php?query=pc_personcenter，返回 news=1 就是有 HR 发来新聊天
      // （内容网页看不到，只能 APP / 小程序回）。我们不主动调它，只在 CDP 里接住页面自己那次请求的返回；
      // 页面上标已读的 /userset/ajax/set_im_message.php 绝不碰。只开 Network 域（开 Debugger 会触发它的反调试）
      let pcReq = null;
      if (tag === 'ms') { c.on('Network.responseReceived', (p) => { if (/pc_personcenter/.test(p.response?.url || '')) pcReq = p.requestId; }); await c.send('Network.enable'); }
      await c.send('Page.navigate', { url: URL(tag) });
      await sleep(5000);
      const r = (await c.ev(ROWS)) || {};
      if (r.login) { events.push({ raw: '⚠️ 51job 登录掉了，要你重新登录' }); return; }
      if (pcReq) await news51(c, pcReq, state, events);
      const first = !state.j51.init;
      for (const x of r.rows || []) {
        const k = `${x.company}|${x.title}`;
        if (state.j51[tag].includes(k)) continue;
        state.j51[tag].push(k);
        if (first) continue;                                  // 第一次跑：已有的当作看过了
        events.push(tag === 'ms'
          ? { platform: '51job', company: x.company, title: x.title, action: 'escalate', kind: '约面试', hr: '「我的申请」里标了邀面试', tell: '51job 网页聊不了，面试通知在 51job APP 里看' }
          : { platform: '51job', company: x.company, title: x.title, action: 'ignore', kind: '感兴趣', hr: '标了感兴趣', tell: 'HR 标了感兴趣' });
      }
    } finally { await c.close(); }
  }
  state.j51.init = true;
  state.j51.newsInit = true;
}

/** 51job 新聊天提醒：同一家同一个 HR 同一个岗位只推一次；第一次跑只记下来不推（用户已经知道的那条不重复吵他） */
async function news51(c, requestId, state, events) {
  let rb = null;
  try { rb = JSON.parse((await c.send('Network.getResponseBody', { requestId })).result?.body || '{}').resultbody; } catch { return; }
  if (!rb || rb.news !== '1' || !rb.coName) return;
  state.j51.news ||= [];
  const k = `${rb.coName}|${rb.hrName}|${rb.jobid}`;
  if (state.j51.news.includes(k)) return;
  state.j51.news.push(k);
  if (!state.j51.newsInit) return;
  events.push({ platform: '51job', company: rb.coName, name: rb.hrName || '', title: '', action: 'escalate', kind: '51job 聊天',
    hr: `${rb.hrName || 'HR'} 发来新的聊天消息`, tell: '51job 网页上看不到内容，去 51job APP 或微信小程序里看和回' });
}
