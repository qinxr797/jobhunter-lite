// 猎聘（HR Desk 里的 persist:liepin 登录区，调试口 9401；开新标签走兼容口 9404）：读消息列表、读聊天、发消息、读岗位、搜岗位、聊一聊投递
// 10/16 摸底（CDP 旁听 + 拆 fe-im-pc 的 bundle）：
//   - 页面接口都在 api-c.liepin.com/api/<接口名>，同源 fetch 带 cookie + 几个 X-Fscp-* 头就能调（和页面自己发的一模一样）
//   - 聊天：消息走 MQTT（wss://socket-long.liepin.com/mqtt），列表 com.liepin.im.c.contact.get-contact-list、
//     历史 com.liepin.im.c.chat.chat-list（maxMessageId=-1 取最新），标已读是另一个接口 com.liepin.im.c.chat.readed-msg —— 我们不调它
//   - 搜岗位 com.liepin.searchfront4c.pc-search-job（JSON），岗位详情读 www.liepin.com/job/<id>.shtml 页面
//   - 账号的 imId / userId 在 cookie：imId_0、inited_user
//   - 「聊一聊」会先自动发账号设置里的默认招呼（sayHi），我们的开场白在它后面补一句
// 蓝本：loks666/get_jobs 的 worker/liepin（搜索页拦 pc-search-job 返回、卡片上点「聊一聊」）
import { connect, sleep, findByText, PORTS } from './lib.mjs';

const PORT = PORTS.lp || 9401;
const TAB_PORT = cfg().ports.deskTabs.lp;   // 桌面助手给猎聘登录区开新标签的兼容口
const HOME = 'https://c.liepin.com/';
import { cfg, cityCodes } from './config.mjs';
export let HEFEI = '';   // 猎聘城市代码，搜之前从设置里取

// 页面里用的接口调用器：和页面自己发请求一样的头
const API = `(()=>{if(window.__lpApi)return true;const ck=k=>decodeURIComponent((document.cookie.match('(?:^|; )'+k+'=([^;]*)')||[])[1]||'');
  window.__lpMe=()=>({imId:ck('imId_0'),userId:ck('inited_user')});
  window.__lpApi=async(name,body,json)=>{const h={'X-Client-Type':'web','X-Fscp-Version':'1.1','X-Fscp-Std-Info':JSON.stringify({client_id:location.host.startsWith('www')?'40108':'11156'}),
    'X-Requested-With':'XMLHttpRequest','X-Fscp-Trace-Id':crypto.randomUUID(),'X-Fscp-Bi-Stat':JSON.stringify({location:location.href}),'X-Fscp-Fe-Version':'1.0.0','X-XSRF-TOKEN':ck('XSRF-TOKEN'),
    'Content-Type':json?'application/json;charset=UTF-8':'application/x-www-form-urlencoded'};
    const r=await fetch('https://api-c.liepin.com/api/'+name,{method:'POST',credentials:'include',headers:h,body:json?JSON.stringify(body):new URLSearchParams(body).toString()});
    return r.json()};return true})()`;

/** 自己开一张猎聘标签（屏幕外小窗口），网址带个记号，connect 只会连到它，不会碰 HR Desk 自己的页面 */
export async function openTab(url = HOME) {
  const mark = `hrdesk=${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const u = url + (url.includes('?') ? '&' : '?') + mark;
  const t = await (await fetch(`http://127.0.0.1:${TAB_PORT}/json/new?${u}`, { method: 'PUT' })).json();
  await sleep(5000);
  const c = await connect(PORT, mark);
  if (!c) throw new Error('猎聘新标签开了但连不上');
  const close0 = c.close;
  c.close = async () => { await close0(); await fetch(`http://127.0.0.1:${TAB_PORT}/json/close/${t.id}`).catch(() => {}); };
  return c;
}

/** 盯梢用：连 HR Desk 里常驻的猎聘页（desk.json 里的盯梢专用页优先） */
export async function openLiepin() {
  const c = await connect(PORT, 'c.liepin.com');
  if (!c) throw new Error('HR Desk 里没有猎聘页');
  return c;
}

const ok = async (c) => { if (!(await c.ev(API).catch(() => false))) throw new Error('猎聘页面接口没准备好'); };

// 消息里的系统话术（自动招呼、卡片），不算 HR 说的话
const SYS = /^\[.*\]$|对方已查看|已向对方发送|简历已发送|系统消息/;

/**
 * 会话列表（接口版）。字段对齐 boss/zhaopin：name/company/title/last/unread/fromMe；另带 oppositeImId。
 * securityId 也填成 oppositeImId —— 盯梢判断「能不能走接口读聊天」看的是这个字段
 */
export async function readList(c) {
  await ok(c);
  const r = await c.ev(`(async()=>{const me=__lpMe();if(!me.imId)return {login:true};
    const a=await __lpApi('com.liepin.im.c.contact.get-contact-list',{imUserType:0,imId:me.imId,imApp:1,pageSize:40,curPage:0});
    if(!a||a.flag!==1)return {err:'列表接口 '+JSON.stringify(a).slice(0,80)};
    return {raw:(a.data&&a.data.list)||[]}})()`).catch((e) => ({ err: e.message }));
  if (!r || r.login) return { login: true };
  if (r.err) return { items: [], err: r.err };
  return { items: r.raw.map(mapContact) };
}
// 10/16 实测的联系人字段：name / company / title（HR 头衔，和 BOSS 一样拿来拼会话主键）/ oppositeImId / lastPayload（JSON 串）/
// unReadCnt / direction（"0" = 我方发出，推断）/ latestMsgTime
function mapContact(x) {
  const p = parsePayload(x.lastPayload);
  return {
    name: x.name || '', company: x.company || '', title: x.title || '', time: x.latestMsgTime ? new Date(Number(x.latestMsgTime) + 8 * 3600e3).toISOString().slice(5, 16).replace('T', ' ') : '',
    unread: Number(x.unReadCnt || 0) || 0, last: p.system ? '' : p.text, fromMe: String(x.direction) === '0',
    oppositeImId: x.oppositeImId || '', securityId: x.oppositeImId || '', homePage: x.homePage || '',
  };
}
/** 消息体：payload 是 JSON 串 {bodies:[{msg,type}], ext:{extType, extBody:{bizType,bizData}}}。extType 200 这类带跳转高亮的是平台系统提示 */
function parsePayload(s) {
  let o = s;
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch { return { text: String(s || ''), system: false }; } }
  const text = (o?.bodies || []).map((b) => b.msg || '').join(' ').replace(/\s+/g, ' ').trim();
  const ext = o?.ext || {};
  const system = Number(ext.extType) >= 100 || !!ext.extBody?.bizData?.highlightText;
  return { text, system, sayHi: String(ext.extBody?.bizType) === '3' };
}

/** 聊天历史（接口版，不点开会话、不调已读接口）。返回 {head, job, msgs:[{me,text}], cards, resumeSent} */
export async function historyApi(c, it) {
  const opp = it.oppositeImId || it.securityId;
  if (!opp) return null;
  await ok(c);
  const r = await c.ev(`(async()=>{const me=__lpMe();
    const a=await __lpApi('com.liepin.im.c.chat.chat-list',{maxMessageId:'-1',oppositeImId:${JSON.stringify(opp)},pageSize:30,imApp:1,imUserType:0,imId:me.imId});
    if(!a||a.flag!==1)return {err:JSON.stringify(a).slice(0,100)};
    return {me:me.imId,list:(a.data&&a.data.list)||[]}})()`).catch((e) => ({ err: e.message }));
  if (!r || r.err) return null;
  const msgs = [];
  // 接口按时间倒序给；direction "0" = 我方发出（10/16 实测我方两条都是 0；HR 发来的推断是 1，等第一条真 HR 消息核对）
  const list = [...r.list].sort((a, b) => Number(a.msgTime) - Number(b.msgTime));
  for (const m of list) {
    const p = parsePayload(m.payload);
    if (!p.text || p.system || SYS.test(p.text)) continue;
    msgs.push({ me: String(m.direction) === '0', text: p.text, at: Number(m.msgTime) });
  }
  return { head: it.name, job: it.title || '', msgs: msgs.slice(-14), cards: [], resumeSent: msgs.some((m) => m.me && /简历/.test(m.text)) };
}

/** 岗位详情：读 www.liepin.com/job/<id>.shtml（同源 fetch，不开标签） */
export async function jobInfo(c, it) {
  let link = it.link || it.url;
  // 会话来的（收件箱「岗位与背调」）：先用 get-chat-job 拿这段聊天挂的岗位 id。10/16 实测 jobKind 2 的详情页是 /job/19<jobId>.shtml
  if (!link && (it.oppositeImId || it.securityId)) {
    await ok(c);
    const j = await c.ev(`(async()=>{const me=__lpMe();const a=await __lpApi('com.liepin.im.c.chat.get-chat-job',{oppositeImId:${JSON.stringify(it.oppositeImId || it.securityId)},imUserType:0,imApp:1,imId:me.imId});return a&&a.data})()`).catch(() => null);
    if (j?.jobId) link = String(j.jobKind) === '2' ? `https://www.liepin.com/job/19${j.jobId}.shtml` : `https://www.liepin.com/a/${j.jobId}.shtml`;
  }
  if (!link) return { err: '没有岗位链接' };
  return c.ev(`(async()=>{const h=await (await fetch(${JSON.stringify(link)},{credentials:'include'})).text();
    const d=new DOMParser().parseFromString(h,'text/html');const t=e=>(e&&e.textContent||'').replace(/\\s+/g,' ').trim();
    if(/安全验证|验证码|captcha/i.test(d.title))return {err:'详情页弹了验证'};
    const ap=d.querySelector('section.job-apply-container');const jd=d.querySelector('section.job-intro-container dl.paragraph dd')||d.querySelector('section.job-intro-container dl.paragraph');
    if(jd)jd.querySelectorAll('br').forEach(b=>b.replaceWith('\\n'));
    const rc=d.querySelector('section.recruiter-container');
    const comp=[...d.querySelectorAll('.company-info-container .label-box, .company-other .label-box, .company-info-container li')].map(t).filter(Boolean);
    return {title:t(ap&&ap.querySelector('.name-box .name, .name')),salary:t(ap&&ap.querySelector('.salary')),
      city:t(ap&&ap.querySelector('.job-properties span'))||'',props:[...(ap?ap.querySelectorAll('.job-properties span'):[])].map(t),
      jd:jd?jd.textContent.replace(/\\n\\s*\\n+/g,'\\n').trim():'',labels:[...d.querySelectorAll('section.job-apply-container-desc .labels span, .job-apply-container-desc span')].map(t).filter(Boolean),
      recruiter:t(rc&&rc.querySelector('.name')),recruiterTitle:t(rc&&rc.querySelector('.title-box, .title')),recruiterLine:t(rc).slice(0,120),
      company:t(d.querySelector('.company-info-container .name, .company-card .name, .company-name'))||'',companyBase:comp.slice(0,8),
      address:t(d.querySelector('.company-address, [class*=address]')).slice(0,80),url:${JSON.stringify(link)},docTitle:d.title}})()`).catch((e) => ({ err: e.message }));
}

/** 搜岗位（接口版）：本地、关键词，返回卡片 [{jobId,title,salary,dq,years,edu,link,compId,compName,compScale,compIndustry,hr,hrTitle,hrImId,chatted,refresh}] */
export async function search(c, key, { page = 0, pubTime = '' } = {}) {
  HEFEI = (await cityCodes()).liepin;
  if (!HEFEI) throw Object.assign(new Error('设置里没填猎聘的城市代码，猎聘先跳过'), { fix: '设置 › 城市代码 › 猎聘' });
  await ok(c);
  const r = await c.ev(`(async()=>{const a=await __lpApi('com.liepin.searchfront4c.pc-search-job',{data:{mainSearchPcConditionForm:{city:'${HEFEI}',dq:'${HEFEI}',pubTime:${JSON.stringify(pubTime)},currentPage:'${page}',pageSize:40,key:${JSON.stringify(key)},
    suggestTag:'',workYearCode:'',compId:'',compName:'',compTag:'',industry:'',salaryCode:'',jobKind:'',compScale:'',compKind:'',compStage:'',eduLevel:'',salaryLow:'',salaryHigh:''},
    passThroughForm:{scene:'init',skId:'',fkId:'',ckId:'',suggest:null}}},true);
    if(!a||a.flag!==1)return {err:JSON.stringify(a).slice(0,120)};
    return {list:((a.data&&a.data.data&&a.data.data.jobCardList)||[]).map(x=>({jobId:x.job.jobId,jobKind:x.job.jobKind,title:x.job.title,salary:x.job.salary,dq:x.job.dq,years:x.job.requireWorkYears,edu:x.job.requireEduLevel,
      link:x.job.link,refresh:x.job.refreshTime,compId:x.comp&&x.comp.compId,compName:x.comp&&x.comp.compName,compScale:x.comp&&x.comp.compScale,compIndustry:x.comp&&x.comp.compIndustry,
      hr:x.recruiter&&x.recruiter.recruiterName,hrTitle:x.recruiter&&x.recruiter.recruiterTitle,hrImId:x.recruiter&&x.recruiter.imId,chatted:x.recruiter&&x.recruiter.chatted,hrOnline:x.recruiter&&x.recruiter.imShowText}))}})()`).catch((e) => ({ err: e.message }));
  return r || { err: '没返回' };
}

// 聊天窗口里的输入框和发送按钮（10/16 实测：textarea.im-ui-textarea，按钮 .im-ui-basic-send-btn，在 .im-ui-basic-chat-modal 弹窗里）
const BOX = `(()=>{const e=[...document.querySelectorAll('textarea.im-ui-textarea, .im-ui-basic-chat-modal textarea')].find(x=>x.offsetWidth);return e||null})()`;
const SEND_BTN = `(()=>{const e=[...document.querySelectorAll('.im-ui-basic-send-btn')].find(x=>x.offsetWidth);if(!e)return null;const b=e.getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2}})()`;

let lastOpp = '';                                          // openConv 点开的是谁：盯梢调 sendText(c, text) 不带对方 imId，用它核对
/** 往当前开着的聊天窗口里发一句，发完用接口回读核对最后一条是不是这句 */
export async function sendText(c, text, oppositeImId = lastOpp) {
  const has = await c.ev(`!!${BOX}`);
  if (!has) return { ok: false, why: '聊天输入框没找到（聊天窗口没开）' };
  await c.ev(`${BOX}.focus()`);                                // 先把焦点放进输入框：lib 的 type() 认 activeElement，刚点完按钮焦点停在按钮上
  await c.type(text);
  await sleep(400);
  const inBox = await c.ev(`(()=>{const e=${BOX};return e?String(e.value??e.innerText??''):''})()`);
  if (!String(inBox).includes(text.slice(0, 8))) return { ok: false, why: '字没打进输入框' };
  await c.enter();
  await sleep(2500);
  const left = await c.ev(`(()=>{const e=${BOX};return e?String(e.value??e.innerText??'').trim():''})()`);
  if (left && left.includes(text.slice(0, 8))) {                // 回车没发出去：点「发送」按钮
    const p = await c.ev(SEND_BTN);
    if (p) { await c.click(p); await sleep(2500); }
  }
  if (!oppositeImId) return { ok: true, how: '没核对（不知道对方 imId）' };
  const h = await historyApi(c, { oppositeImId, name: '' });
  const lastMe = [...(h?.msgs || [])].reverse().find((m) => m.me);
  if (lastMe && lastMe.text.includes(text.slice(0, 12))) return { ok: true, how: '接口回读核对过' };
  return { ok: false, why: `发完核对最后一条不是这句（最后一条我方：${(lastMe?.text || '无').slice(0, 30)}）` };
}

/**
 * 投递 = 在岗位详情页点「聊一聊」（猎聘没有单独的投递按钮，聊一聊就会把在线简历给对方看），
 * 默认招呼会自动发出；然后补发我们的开场白并核对。job: search() 的卡片
 */
export async function applyJob(c, job, greeting) {
  await c.send('Page.navigate', { url: job.link });
  await sleep(6000);
  const title = await c.ev('document.title');
  if (/安全验证|验证码/.test(title || '')) return { ok: false, why: '详情页弹了验证，停手' };
  const before = await c.ev(`(()=>{const s=document.querySelector('section.job-apply-container');return s?s.innerText.replace(/\\s+/g,' '):''})()`);
  if (/继续聊/.test(before || '')) return { ok: false, why: '以前聊过（按钮是「继续聊」），不重复投' };
  const p = await c.ev(findByText('聊一聊', 'section.job-apply-container'));
  if (!p) return { ok: false, why: '详情页上没找到「聊一聊」按钮' };
  await c.click(p);
  await sleep(4000);
  const opened = await c.ev(`!!${BOX}`);
  if (!opened) return { ok: false, why: '点了「聊一聊」，聊天窗口没出来（可能要先完善简历或弹了别的框）' };
  if (!greeting) return { ok: true, how: '只发了默认招呼' };
  const s = await sendText(c, greeting, job.hrImId);
  return { ok: s.ok, how: s.ok ? `默认招呼 + 开场白（${s.how}）` : undefined, why: s.ok ? undefined : `默认招呼发了，开场白：${s.why}` };
}

// 盯梢接口：点开会话。猎聘的会话在「我的沟通」抽屉里，按名字找联系人点开；点开会留已读，只在真要回复时用
export async function openConv(c, it) {
  await ok(c);
  const box = await c.ev(`!!${BOX}`);
  if (!box) {
    const p = await c.ev(`(()=>{const e=document.querySelector('.im-ui-chat-modal-container, [class*=siderbar] [class*=im]');if(!e)return null;const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    if (p) { await c.click(p); await sleep(2500); }
  }
  const q = await c.ev(findByText(it.name, 'body', false));
  if (!q) return null;
  await c.click(q);
  await sleep(2500);
  if (!(await c.ev(`!!${BOX}`))) return null;
  lastOpp = it.oppositeImId || it.securityId || '';
  return historyApi(c, it);
}

/** 处理完把聊天窗口关掉（停在聊天窗口上，HR 新消息会被当场看成已读） */
export async function leaveSession(c) {
  const p = await c.ev(`(()=>{const e=document.querySelector('.__im_basic__contacts-title svg, [class*=im-ui-chat] [class*=close]');if(!e)return null;const r=e.getBoundingClientRect();return r.width?{x:r.left+r.width/2,y:r.top+r.height/2}:null})()`);
  if (p) { await c.click(p); await sleep(800); return true; }
  return false;
}
