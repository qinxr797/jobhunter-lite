// 智联（.chrome-jobs，调试口 9334，无头）：读消息列表、打开会话、发消息
import { connect, sleep, PORTS } from './lib.mjs';

const PORT = PORTS.zhaopin;                                // 9334 老的无头 Chrome，或 HR Desk 的 9401（见 lib.mjs）
const IM = 'https://i.zhaopin.com/im';

const LIST = `(()=>{const t=e=>(e?.innerText||'').replace(/\\s+/g,' ').trim();
  if(/passport|login/.test(location.href)) return {login:true};
  return {items:[...document.querySelectorAll('.im-session-item')].slice(0,40).map(e=>{const last=t(e.querySelector('.im-session-item__preview-text, .im-session-item__preview'));
    return {name:t(e.querySelector('.im-session-item__name')),company:t(e.querySelector('.im-session-item__company-name')),title:t(e.querySelector('.im-session-item__job')),
      time:t(e.querySelector('.im-session-item__time')),unread:Number(t(e.querySelector('.im-session-item__badge')))||0,last,fromMe:/^\\[(送达|已读|未读)\\]/.test(t(e.querySelector('.im-session-item__preview-row')))}})}})()`;

const SYS = /^在线简历$|^附件简历$|已发送简历|打招呼语|以下为新消息/;

export async function openZhaopin() {
  const c = await connect(PORT, 'i.zhaopin.com/im', IM);
  if (!c) throw new Error('桌面助手里没有智联消息页（在「更多 › 智联」扫码登录）');
  return c;
}

/**
 * 10/16 会话对应的岗位：/im 页每个会话的 Vue 对象里带 jobNumber，拿它调智联自己的岗位详情接口（只读，不点进会话）
 */
export async function jobInfo(c, it) {
  return c.ev(`(async()=>{const ss=[...document.querySelectorAll('.im-session-item')].map(e=>e.__vue__&&e.__vue__.$props&&e.__vue__.$props.session).filter(Boolean);
    const co=${JSON.stringify((it.company || '').slice(0, 4))};
    const s=ss.find(x=>x.jobTitle===${JSON.stringify(it.title || '')}&&String(x.companyName||'').includes(co))||ss.find(x=>String(x.companyName||'').includes(co));
    if(!s||!s.jobNumber)return {err:'会话里没找到岗位编号'};
    const j=await (await fetch('https://fe-api.zhaopin.com/c/i/jobs/position-detail-new?number='+s.jobNumber,{credentials:'include'})).json();
    if(!j||j.code!==200)return {err:'详情接口 code '+(j&&j.code)};
    const p=j.data.detailedPosition||{},cp=j.data.detailedCompany||{};
    const txt=h=>String(h||'').replace(/<br\\s*\\/?>/gi,'\\n').replace(/<[^>]+>/g,'').replace(/&nbsp;/g,' ').replace(/\\n\\s*\\n+/g,'\\n').trim();
    return {jobId:s.jobNumber,title:p.name,salary:p.salary60,city:[p.workCity,p.cityDistrict].filter(Boolean).join('·'),address:p.workAddress,exp:p.workingExp,degree:p.education,
      jd:txt(p.jobDesc),keywords:(p.skillLabel||[]).map(x=>x.value),publish:p.publishTime,url:'https://jobs.zhaopin.com/'+s.jobNumber+'.htm',
      company:cp.companyName,companyBase:[cp.companySize,cp.industryLevel,cp.financingStageName].filter(Boolean),intro:String(cp.companyDescription||'').replace(/<[^>]+>/g,'').slice(0,600),
      hrActive:p.staff&&p.staff.hrOnlineState}})()`).catch((e) => ({ err: e.message }));
}

/**
 * 10/16 用 REA 逆向查到：消息页停在某个会话上（网址带 sessionId）时，那个 HR 再发来的消息会被页面自动标成已读、未读清零，
 * HR 那边还会看到「已读」。所以读列表之前、处理完一轮之后，都回到不带会话的 /im
 */
export async function leaveSession(c) {
  const href = await c.ev('location.href');
  if (!/sessionId=/.test(href || '')) return false;
  await c.send('Page.navigate', { url: IM });
  await sleep(6000);
  return true;
}

export async function readList(c, { reload = false } = {}) {
  const left = await leaveSession(c);                       // 回 /im 本身就是整页刷新，不用再 reload
  if (reload && !left) { await c.send('Page.reload'); await sleep(7000); }
  let r = {};
  for (let k = 0; k < 6; k++) { r = (await c.ev(LIST)) || {}; if (r.login || (r.items || []).length) break; await sleep(1500); }
  return r;
}

export async function openConv(c, it) {
  const p = await c.ev(`(()=>{const e=[...document.querySelectorAll('.im-session-item')].find(x=>(x.querySelector('.im-session-item__name')||{}).innerText===${JSON.stringify(it.name)}
      &&(x.querySelector('.im-session-item__company-name')||{}).innerText===${JSON.stringify(it.company)});
    if(!e)return null;e.scrollIntoView({block:'center'});const b=e.getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2}})()`);
  if (!p) return null;
  await c.click(p);
  await sleep(2500);
  const r = await c.ev(`(()=>{const t=e=>(e?.innerText||'').replace(/\\s+/g,' ').trim();
    const act=document.querySelector('.im-session-item.is-active');
    const head=act?t(act.querySelector('.im-session-item__name')):'';
    const ms=[...document.querySelectorAll('.im-main-panel__timeline-inner > .im-message')];
    const msgs=ms.map(m=>({me:!!m.querySelector('.im-message__bubble--me'),text:t(m.querySelector('.im-msg-text, .im-message__bubble-inner')||m)})).filter(m=>m.text);
    return {head,msgs}})()`);
  if (!r || r.head !== it.name) return null;
  r.msgs = r.msgs.filter((m) => !SYS.test(m.text)).slice(-14);
  return r;
}

export async function sendText(c, text) {
  const inp = await c.ev(`(()=>{const e=document.querySelector('textarea.im-sender__input');if(!e)return null;e.focus();const b=e.getBoundingClientRect();return {x:b.left+20,y:b.top+10}})()`);
  if (!inp) return { ok: false, why: '输入框没找到' };
  await c.click(inp);
  await c.type(text);
  await sleep(800);
  await c.enter();
  await sleep(3000);
  const left = await c.ev(`(document.querySelector('textarea.im-sender__input')||{}).value||''`);
  const mine = await c.ev(`(()=>{const m=[...document.querySelectorAll('.im-message__bubble--me')].pop();return m?m.innerText:''})()`);
  const ok = !left.trim() && mine.includes(text.slice(0, 12));
  return { ok, why: ok ? '' : `发完输入框还剩「${left.slice(0, 20)}」或者最后一条不是这句` };
}
