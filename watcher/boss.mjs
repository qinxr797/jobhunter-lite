// BOSS 直聘（.chrome-boss，调试口 9333）：读聊天列表、打开会话、发消息、发附件简历
import { connect, sleep, findByText, PORTS } from './lib.mjs';

const PORT = PORTS.boss;                                   // 9333 老 Chrome，或 HR Desk 的 9401（见 lib.mjs）
const CHAT = 'https://www.zhipin.com/web/geek/chat';

const LIST = `(()=>{const t=e=>(e?.innerText||'').replace(/\\s+/g,' ').trim();
  if(/安全验证|验证码|captcha/i.test(document.title+t(document.querySelector('.page-verify, .verify-wrap')))) return {captcha:true};
  if(!document.querySelector('.user-list-content') && /登录/.test(t(document.body).slice(0,300))) return {login:true};
  const lis=[...document.querySelectorAll('.user-list-content li')].filter(li=>li.querySelector('.name-text'));
  return {items:lis.slice(0,40).map(li=>{const spans=[...li.querySelectorAll('.name-box > span')].map(t).filter(Boolean);const all=t(li);
    return {name:t(li.querySelector('.name-text')),company:spans[1]||'',title:spans[2]||'',time:t(li.querySelector('.time')),
      unread:Number(t(li.querySelector('.notice-badge')))||0,last:t(li.querySelector('.last-msg-text')),fromMe:/\\[(送达|已读|未读)\\]/.test(all)}})}})()`;

// 系统卡片 / 自己发的简历回执，不算 HR 说的话
const SYS = /竞争者PK|您正在与|已发送给Boss|点击查看附件|点击预览附件简历|附件简历请求已发送|\.pdf|对方已同意|你已同意|交换.*成功|以下为新消息|查看详细分析|系统自动向您匹配|该消息暂不支持/;
const RECEIPT = /点击预览附件简历|附件简历请求已发送|已发送给Boss|您的附件简历已发送|\.pdf/;

// 10/16 收件箱：HR 发来的「要附件简历 / 交换微信 / 交换电话」卡片，带「同意」「拒绝」按钮。
// 按钮还在、没变成「已同意 / 已拒绝」= 还没处理（pending）。还没在真页面上核对过按钮的 class，按文字认
const CARDS = `[...document.querySelectorAll('.chat-message .message-item')].map(m=>{
    const bs=[...m.querySelectorAll('span,a,button,div')].filter(x=>x.offsetWidth&&x.children.length<2&&/^(同意|拒绝)$/.test((x.innerText||'').trim()));
    if(!bs.length&&!/已同意|已拒绝/.test(m.innerText))return null;
    const txt=(m.innerText||'').replace(/\\s+/g,' ').trim();
    const type=/简历/.test(txt)?'resume':/微信/.test(txt)?'wechat':/电话|手机/.test(txt)?'phone':'other';
    const off=/已同意|已拒绝/.test(txt)||bs.every(b=>/disable|unable|gray|done/i.test(String(b.className)+' '+String(b.parentElement&&b.parentElement.className)));
    return {type,text:txt.replace(/\\s*(拒绝|同意)\\s*/g,' ').trim().slice(0,80),pending:!off}}).filter(Boolean)`;

// ---------- 10/16 用页面自己的接口读（REA 逆向后的大升级） ----------
// 以前读会话列表是扒网页上的字（只有最近 40 个、名字+公司当主键），读聊天要点开会话（点开 = 给 HR 留「已读」）。
// 现在借 BOSS 页面自己打包好的请求函数（webpack 模块里按接口路径找，页面会自动带上 zp_token / traceid / cookie / stoken），
// 和页面自己发的请求一模一样：列表 geekFilterByLabel + getGeekFriendList，历史 historyMsg。
// 已读是前端拉完历史后另发一条 MQTT 回执，我们只调接口、不发回执，推断不留已读（从我们这边没法实测 HR 那头看到什么）
const API = `(()=>{if(!window.__hrApi){let req;self.webpackChunkGeekChat.push([[Symbol('hr')],{},r=>{req=r}]);
  const cache={};window.__hrApi=(path)=>{if(cache[path])return cache[path];for(const id of Object.keys(req.m)){if(!String(req.m[id]).includes(path))continue;const ex=req(id);
    for(const k of Object.keys(ex)){let f;try{f=ex[k]}catch{continue}if(typeof f==='function'&&String(f).includes(path))return(cache[path]=f)}}return null}}
  return !!(__hrApi('/wapi/zprelation/friend/geekFilterByLabel')&&__hrApi('/wapi/zprelation/friend/getGeekFriendList.json')&&__hrApi('/wapi/zpchat/geek/historyMsg'))})()`;

/** 会话列表（接口版）：按最后一条消息时间倒序，最多 60 个。字段和网页版对齐（name/company/title 不变，状态主键才对得上），另带 securityId 等 */
export async function listApi(c) {
  if (!(await c.ev(API).catch(() => false))) return null;
  const r = await c.ev(`(async()=>{const a=await __hrApi('/wapi/zprelation/friend/geekFilterByLabel')({labelId:0});
    if(!a||a.code!==0)return {err:'列表接口 code '+(a&&a.code)};
    const fl=(a.zpData&&a.zpData.friendList||[]).sort((x,y)=>(y.updateTime||0)-(x.updateTime||0)).slice(0,60);
    const g=__hrApi('/wapi/zprelation/friend/getGeekFriendList.json');let L=[];
    for(let i=0;i<fl.length;i+=40){const b=await g({friendIds:fl.slice(i,i+40).map(x=>x.friendId).join(',')});if(!b||b.code!==0)return {err:'好友接口 code '+(b&&b.code)};L=L.concat(b.zpData.result||[])}
    const job=Object.fromEntries(fl.map(x=>[x.friendId,x.jobName]));
    return {items:L.sort((x,y)=>(y.lastTS||0)-(x.lastTS||0)).map(x=>({name:x.name,company:x.brandName,title:x.title,time:x.lastTime,unread:x.unreadMsgCount||0,
      last:(x.lastMsg||'').replace(/\\s+/g,' ').trim(),fromMe:!!x.lastMessageInfo&&x.lastMessageInfo.fromId!==x.uid,msgId:x.lastMessageInfo?String(x.lastMessageInfo.msgId):'',
      uid:x.uid,securityId:x.securityId,encryptBossId:x.encryptBossId,friendSource:x.friendSource,job:job[x.uid]||''}))}})()`).catch((e) => ({ err: e.message }));
  return r && r.items ? r : null;
}

/** 聊天历史（接口版，不点开会话）：返回和 openConv 一样的形状 {head, job, msgs, cards, resumeSent} */
export async function historyApi(c, it) {
  if (!it.securityId || !(await c.ev(API).catch(() => false))) return null;
  const r = await c.ev(`(async()=>{const h=await __hrApi('/wapi/zpchat/geek/historyMsg')({bossId:${JSON.stringify(it.encryptBossId)},maxMsgId:0,c:30,page:1,src:${JSON.stringify(it.friendSource || 0)},securityId:${JSON.stringify(it.securityId)}});
    if(!h||h.code!==0)return {err:'历史接口 code '+(h&&h.code)};
    const hr=${JSON.stringify(it.uid)};const msgs=[],cards=[];let resumeSent=false;
    for(const m of (h.zpData&&h.zpData.messages)||[]){const b=m.body||{};const me=!!m.from&&m.from.uid!==hr;let text='';
      if(b.type===1)text=b.text||'';
      else if(b.type===7&&b.dialog){const d=b.dialog;text=(d.text||'')+(d.operated?'':' 拒绝 同意');
        cards.push({type:/简历/.test(d.text)?'resume':/微信/.test(d.text)?'wechat':/电话|手机/.test(d.text)?'phone':'other',text:(d.text||'').slice(0,80),pending:!d.operated});}
      else if(b.type===12&&b.hyperLink&&/resume/i.test(b.hyperLink.extraJson||'')){resumeSent=true;msgs.push({me:true,text:'📎 附件简历已发送'});continue;}
      else continue;                                   // 系统动作（type 4）、岗位卡片（16）这些不算聊天
      if(b.templateId===3)continue;                    // 灰色系统提示（「对方已查看了您的附件简历」之类）
      text=text.replace(/\\s+/g,' ').trim();if(text)msgs.push({me,text});}
    return {msgs,cards,resumeSent}})()`).catch((e) => ({ err: e.message }));
  if (!r || r.err) return null;
  return { head: it.name, job: it.job || '', msgs: r.msgs.filter((m) => !SYS.test(m.text)).slice(-14), cards: r.cards, resumeSent: r.resumeSent };
}

/**
 * 10/16 会话对应的岗位（收件箱「岗位与背调」卡片用）：摘要走 getBossData（页面打开会话时自己也调），
 * JD 全文和工商信息读岗位详情页（同源 fetch，不开标签、不点会话、不调 historyMsg，推断不留已读）。
 * 详情页读多了可能弹验证：调用方按会话缓存，一个只读一次
 */
export async function jobInfo(c, it) {
  if (!it.securityId || !(await c.ev(API).catch(() => false))) return null;
  return c.ev(`(async()=>{const r=await __hrApi('/wapi/zpchat/geek/getBossData')({bossId:${JSON.stringify(it.encryptBossId)},bossSource:${JSON.stringify(it.friendSource || 0)},securityId:${JSON.stringify(it.securityId)}});
    if(!r||r.code!==0)return {err:'getBossData code '+(r&&r.code)};
    const j=r.zpData.job||{},d=r.zpData.data||{},id=d.encryptJobId;
    const out={jobId:id,title:j.jobName,salary:j.salaryDesc,city:j.locationName,exp:j.experienceName,degree:j.degreeName,company:j.brandName,url:id?'https://www.zhipin.com/job_detail/'+id+'.html':''};
    if(!id)return out;
    const html=await (await fetch(out.url,{credentials:'include'})).text();
    const doc=new DOMParser().parseFromString(html,'text/html');const t=e=>(e&&e.textContent||'').replace(/\\s+/g,' ').trim();
    if(/安全验证|security/i.test(doc.title))return {...out,err:'详情页弹了验证，先别读了'};
    const jd=doc.querySelector('.job-sec-text');if(jd)jd.querySelectorAll('br').forEach(b=>b.replaceWith('\\n'));
    return {...out,jd:jd?jd.textContent.replace(/\\n\\s*\\n+/g,'\\n').trim():'',address:t(doc.querySelector('.location-address')),
      keywords:[...doc.querySelectorAll('.job-keyword-list li')].map(t),
      companyBase:[...doc.querySelectorAll('.sider-company p')].map(t).filter(Boolean).slice(1),
      business:[...doc.querySelectorAll('.level-list li')].map(t).filter(Boolean),
      intro:t(doc.querySelector('.company-info-box .fold-text')).slice(0,600),hrActive:t(doc.querySelector('.boss-active-time'))}})()`).catch((e) => ({ err: e.message }));
}

/** 点 HR 卡片上的「同意」或「拒绝」（最后一张这种类型的卡片）。点完按钮没了 / 变成已同意已拒绝才算成 */
export async function answerCard(c, type, action) {
  const want = action === 'agree' ? '同意' : '拒绝';
  const find = `(()=>{const ms=[...document.querySelectorAll('.chat-message .message-item')].filter(m=>{const t=m.innerText||'';
      return ${JSON.stringify(type)}==='resume'?/简历/.test(t):${JSON.stringify(type)}==='wechat'?/微信/.test(t):${JSON.stringify(type)}==='phone'?/电话|手机/.test(t):true});
    const m=ms.pop();if(!m)return null;
    const b=[...m.querySelectorAll('span,a,button,div')].filter(x=>x.offsetWidth&&x.children.length<2&&(x.innerText||'').trim()===${JSON.stringify(want)}).pop();
    if(!b)return {gone:true};b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`;
  const p = await c.ev(find);
  if (!p) return { ok: false, why: '聊天里没找到这张卡片' };
  if (p.gone) return { ok: false, why: '卡片上已经没有这个按钮了（可能已经处理过）' };
  await c.click(p);
  await sleep(1800);
  return { ok: true };
}

/** 选简历弹框（点工具栏「发简历」或卡片「同意」后可能弹出来）：选中对应附件 → 点「发送」 */
async function pickInDialog(c, variant) {
  const name = variant.note.replace(/^.*附件：/, '');
  const open = await c.ev(`!![...document.querySelectorAll('.choose-resume-dialog, .boss-dialog__wrapper')].find(x=>x.offsetWidth)`);
  if (!open) return { ok: false, none: true };
  const pick = await c.ev(`(()=>{const li=[...document.querySelectorAll('.choose-resume-dialog li.list-item, .boss-dialog__wrapper li')].find(x=>x.offsetWidth&&x.innerText.includes(${JSON.stringify(name)}));
    if(!li)return null;const b=li.getBoundingClientRect();return {x:b.left+40,y:b.top+b.height/2}})()`);
  if (!pick) { await closeDialogs(c); return { ok: false, why: `选简历框里没找到「${name}」` }; }
  await c.click(pick);
  await sleep(700);
  const ok = await c.ev(`(()=>{const e=[...document.querySelectorAll('.boss-dialog__wrapper button, .choose-resume-dialog button')].find(x=>x.offsetWidth&&/^(发送|确定|确认)$/.test(x.innerText.trim()));
    if(!e)return null;const b=e.getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2,dis:e.disabled||/disable/.test(e.className)}})()`);
  if (!ok || ok.dis) { await closeDialogs(c); return { ok: false, why: '选简历框里的「发送」没找到或是灰的' }; }
  await c.click(ok);
  return { ok: true, how: `选了「${name}」` };
}

/** 关掉上一轮留下的弹框（比如没发成的选简历框） */
export async function closeDialogs(c) {
  const p = await c.ev(`(()=>{const e=[...document.querySelectorAll('.boss-dialog__wrapper .boss-popup__close')].find(x=>x.offsetWidth);if(!e)return null;const b=e.getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2}})()`);
  if (p) { await c.click(p); await sleep(800); }
  return !!p;
}

export async function openBoss() {
  const c = await connect(PORT, 'zhipin.com/web/geek/chat', CHAT);
  if (!c) throw new Error('桌面助手里没有 BOSS 聊天页（在「更多 › BOSS」扫码登录）');
  return c;
}

export async function readList(c, { reload = false } = {}) {
  if (reload) { await c.send('Page.reload'); await sleep(7000); }
  let r = {};
  for (let k = 0; k < 6; k++) { r = (await c.ev(LIST)) || {}; if (r.login || r.captcha || (r.items || []).length) break; await sleep(1500); }
  return r;
}

/** 点开会话，读最近消息。act=false 时不点（用户正看着桌面 2），返回 null */
export async function openConv(c, it) {
  // 10/11 删了 Page.bringToFront：它在 Windows 上会把 BOSS 窗口强行拽到最前（用户玩电脑时突然弹窗）。
  // 后台标签照样能点能打字，焦点靠 connect() 里的 Emulation.setFocusEmulationEnabled
  await closeDialogs(c);
  // 2026-10-09 加的防御（不是修 bug）：刷新后立刻按坐标点，坐标可能过时、点到右边聊天区的
  // 快捷回复上。滚完等一下再取一次坐标，并且只许点在左侧列表区。
  const find = `(()=>{const lis=[...document.querySelectorAll('.user-list-content li')];
    const li=lis.find(l=>{const t=l.innerText;return t.includes(${JSON.stringify(it.name)})&&t.includes(${JSON.stringify(it.company)})});
    if(!li)return null;li.scrollIntoView({block:'center'});const b=li.getBoundingClientRect();
    return {x:b.left+b.width/2,y:b.top+b.height/2,w:window.innerWidth,h:window.innerHeight}})()`;
  if (!(await c.ev(find))) return null;
  await sleep(900);
  const p = await c.ev(find);
  if (!p) return null;
  if (p.x > p.w * 0.45 || p.y < 0 || p.y > p.h) return null;   // 坐标不在左侧列表里：宁可不点
  await c.click(p);
  await sleep(2500);
  const r = await c.ev(`(()=>{const t=e=>(e?.innerText||'').replace(/\\s+/g,' ').trim();
    const head=t(document.querySelector('.chat-conversation .top-info-content, .chat-conversation [class*="base-info"], .chat-conversation .chat-header'));
    const job=t(document.querySelector('.chat-conversation [class*="position-name"], .chat-conversation .position-content'));
    const msgs=[...document.querySelectorAll('.chat-message .message-item')].map(m=>({me:m.className.includes('item-myself'),text:t(m).replace(/^(\\d{1,2}:\\d{2}\\s*)?(送达|已读|未读)?\\s*/,'')}));
    return {head,job,msgs,cards:${CARDS}}})()`);
  if (!r || !r.head.includes(it.name)) return null;            // 点歪了：标题不是这个 HR
  r.resumeSent = r.msgs.some((m) => RECEIPT.test(m.text));
  r.msgs = r.msgs.filter((m) => m.text && !SYS.test(m.text)).slice(-14);
  return r;
}

export async function sendText(c, text) {
  const inp = await c.ev(`(()=>{const e=document.querySelector('#chat-input');if(!e)return null;e.focus();const b=e.getBoundingClientRect();return {x:b.left+20,y:b.top+10}})()`);
  if (!inp) return { ok: false, why: '输入框没找到' };
  await c.click(inp);
  await c.type(text);
  await sleep(600);
  await c.enter();
  await sleep(2500);
  const left = await c.ev(`(document.querySelector('#chat-input')||{}).innerText||''`);
  const mine = await c.ev(`(()=>{const m=[...document.querySelectorAll('.chat-message .message-item.item-myself')].pop();return m?m.innerText:''})()`);
  const ok = !left.trim() && mine.includes(text.slice(0, 12));
  return { ok, why: ok ? '' : `发完输入框还剩「${left.slice(0, 20)}」或者最后一条不是这句` };
}

/** 发附件简历：先找 HR 发来的「要附件简历」卡片点「同意」，没有就点工具栏「发简历」再选附件。成功与否以聊天里出现附件回执为准 */
export async function sendResume(c, variant) {
  const before = await countReceipts(c);
  let how = '';
  // 10/16：昕徽那次「点了同意但没出现回执」—— 两个可能：同意后还弹了选简历框没人点；或者 HR 那张请求卡片本身就含「附件简历」，
  // 老的回执计数把它也算进去了。现在：同意后看有没有选简历框，有就选；成功看回执数涨了，或者请求卡片不再是待处理
  const pending = ((await c.ev(CARDS)) || []).some((x) => x.type === 'resume' && x.pending);
  if (pending) {
    const a = await answerCard(c, 'resume', 'agree');
    if (!a.ok) return { ok: false, why: a.why };
    how = '点了「同意」';
    const d = await pickInDialog(c, variant);
    if (d.ok) how += `，${d.how}`; else if (!d.none) return { ok: false, why: `${how}，${d.why}` };
  } else {
    const btn = await c.ev(`(()=>{const e=[...document.querySelectorAll('.toolbar-btn')].find(x=>(x.innerText||'').trim()==='发简历');
      if(!e)return null;if(/unable|disabled/.test(e.className))return {disabled:true};const b=e.getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2}})()`);
    if (!btn) return { ok: false, why: '没找到「发简历」按钮' };
    if (btn.disabled) return { ok: false, why: '「发简历」按钮是灰的' };
    await c.click(btn);
    await sleep(1800);
    const d = await pickInDialog(c, variant);
    if (!d.ok) return { ok: false, why: d.why || '点了「发简历」但没弹出选简历框' };
    how = d.how;
  }
  await sleep(3000);
  const after = await countReceipts(c);
  const still = ((await c.ev(CARDS)) || []).some((x) => x.type === 'resume' && x.pending);
  if (after > before || (pending && !still)) return { ok: true, how };
  return { ok: false, why: `${how}，但聊天里没出现附件简历回执${pending && still ? '，HR 的请求卡片也还是待处理' : ''}` };
}
// 回执：自己发出去的附件简历。HR 那张「我想要一份您的附件简历，是否同意」请求卡片不算
const countReceipts = (c) => c.ev(`[...document.querySelectorAll('.chat-message .message-item')].filter(m=>/附件简历|简历.*已发送|已发送.*简历|\.pdf/.test(m.innerText)&&!/是否同意/.test(m.innerText)).length`);
