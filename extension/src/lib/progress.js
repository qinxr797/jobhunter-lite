/**
 * 51job / 智联的投递进度（照 Tabbit「招聘进度监控助手」补上，回顾里不再只写「平台上看不到回复」）。
 *
 * 怎么读（10/16 实测）：
 *   - 51job：i.51job.com/userset/my_apply.php 是服务端出的页面（GBK），tagType= 空/cy/xq/ms 分别是 全部/已查阅/感兴趣/邀面试，
 *     每页 20 条、page= 翻页。只保留近 60 天。
 *   - 智联：fe-api.zhaopin.com/c/i/schedule/feedback?status=send|viewed|intersted|unsuitable（投递成功/被查看/有意向/不合适），
 *     storeViewCount=false 不会把「新反馈」标成已看；面试邀请在 cgate.zhaopin.com/feedback/interview/listInterview。
 * 都在后台开一个平台自己的页面、在页面里调（带的是你自己的登录态，跟你点开「我的申请」一样，只读）。
 * 结果缓存 30 分钟，免得每次回顾都开两个标签。
 */
import { readTab } from './company-check.js';

const KEY = 'platProgress';
const MAX_AGE = 30 * 60e3;

/** 页面里跑的：51job 我的申请四张列表 */
async function read51() {
  const get = async (tag, page) => {
    const r = await fetch(`/userset/my_apply.php?lang=c&type=sh&tagType=${tag}&page=${page}`, { credentials: 'include' });
    const html = new TextDecoder('gbk').decode(await r.arrayBuffer());
    const d = new DOMParser().parseFromString(html, 'text/html');
    if (!d.querySelector('.myStates')) return { login: true, items: [], pages: 0 };
    const items = [...d.querySelectorAll('.e')].filter((e) => e.querySelector('a.gs')).map((e) => {
      const a = e.querySelector('a.zhn');
      const href = a?.getAttribute('href') || '';
      return {
        company: (e.querySelector('a.gs').getAttribute('title') || '').trim(),
        title: (a?.getAttribute('title') || '').trim(),
        salary: (e.querySelector('.xz')?.getAttribute('title') || '').trim(),
        city: (e.querySelector('.dq')?.getAttribute('title') || '').trim(),
        jobId: (/(\d{6,})\.html/.exec(href) || [])[1] || '',
        href: href.startsWith('//') ? `https:${href}` : href,
        appliedAt: (e.querySelector('.rq span')?.textContent || '').trim(),
      };
    });
    const pages = Math.max(1, ...[...d.querySelectorAll('a[href*="page="]')].map((x) => Number((/page=(\d+)/.exec(x.getAttribute('href')) || [])[1]) || 1));
    return { items, pages };
  };
  const out = new Map();
  const RANK = { 已投递: 0, 已查阅: 1, 感兴趣: 2, 邀面试: 3 };
  for (const [tag, status, maxPages] of [['', '已投递', 8], ['cy', '已查阅', 5], ['xq', '感兴趣', 3], ['ms', '邀面试', 3]]) {
    for (let p = 1; p <= maxPages; p++) {
      const r = await get(tag, p);
      if (r.login) return { login: true };
      for (const it of r.items) {
        const k = it.jobId || `${it.company}|${it.title}`;
        const old = out.get(k);
        if (!old || RANK[status] > RANK[old.status]) out.set(k, { ...(old || it), status });
      }
      if (p >= r.pages) break;
    }
  }
  return { items: [...out.values()] };
}

/** 页面里跑的：智联 求职反馈四种状态 + 面试邀请 */
async function readZhilian() {
  const out = new Map();
  const NAME = { send: '已投递', viewed: '被查看', intersted: '有意向', unsuitable: '不合适' };
  const RANK = { send: 0, viewed: 1, intersted: 2, unsuitable: 3 };
  for (const st of ['send', 'viewed', 'intersted', 'unsuitable']) {
    let got = 0;
    for (let index = 1; index <= 8; index++) {
      const r = await fetch(`https://fe-api.zhaopin.com/c/i/schedule/feedback?index=${index}&pageSize=20&status=${st}&storeViewCount=false`, { credentials: 'include' });
      const j = await r.json().catch(() => null);
      if (!j || j.code !== 200) return { login: true, why: j?.message || `HTTP ${r.status}` };
      const list = j.data?.data || [];
      for (const x of list) {
        const k = String(x.jobId || `${x.company?.name}|${x.jobName}`);
        const old = out.get(k);
        if (old && RANK[old.st] >= RANK[st]) continue;
        out.set(k, { company: x.company?.name || '', title: x.jobName || '', salary: x.salary || '', jobId: String(x.jobId || ''), href: x.jobURL || '', appliedAt: x.time || '', status: NAME[st], st });
      }
      got += list.length;
      if (!list.length || got >= (j.data?.total || 0)) break;
    }
  }
  let interviews = [];
  try {
    const r = await fetch('https://cgate.zhaopin.com/feedback/interview/listInterview?pageNo=1&pageSize=50&states=0', { credentials: 'include' });
    const j = await r.json();
    interviews = (j.data || []).map((x) => ({ company: x.companyName || '', title: x.jobName || '', jobId: String(x.jobId || ''), begin: x.beginTime || 0, state: x.interviewStateDesc || '', way: x.interviewWayDesc || '', created: x.createTime || 0 }));
  } catch { /* 面试邀请读不到不影响投递进度 */ }
  return { items: [...out.values()], interviews };
}

/** 读两个平台（30 分钟内读过就用缓存）。返回 { at, job51:{items}|{login}, zhilian:{items,interviews}|{login}, notes:[] } */
export async function readProgress({ fresh = false } = {}) {
  const { [KEY]: cached } = await chrome.storage.local.get(KEY);
  if (!fresh && cached && Date.now() - cached.at < MAX_AGE) return cached;
  const notes = [];
  const job51 = await readTab('https://i.51job.com/userset/my_apply.php', read51, 1500).catch((e) => ({ err: e.message }));
  if (job51.login) notes.push('51job 没登录（或登录过期了），51job 的进度没读到');
  else if (job51.err) notes.push(`51job 进度没读成：${job51.err}`);
  const zhilian = await readTab('https://i.zhaopin.com/schedule', readZhilian, 1500).catch((e) => ({ err: e.message }));
  if (zhilian.login) notes.push(`智联没登录（或登录过期了），智联的进度没读到${zhilian.why ? `（${zhilian.why}）` : ''}`);
  else if (zhilian.err) notes.push(`智联进度没读成：${zhilian.err}`);
  const rec = { at: Date.now(), job51, zhilian, notes };
  await chrome.storage.local.set({ [KEY]: rec });
  return rec;
}

const DAY = 86400e3;
const OUTSIDE = /上海|北京|杭州|南京|苏州|无锡|深圳|广州|武汉|成都|西安|郑州|宁波|天津|重庆|长沙|厦门|青岛|济南|合肥|福州|昆明|南昌|沈阳|大连|东莞|佛山|珠海/;
const parseDay = (s) => { const t = Date.parse(String(s || '').replace(' ', 'T')); return Number.isFinite(t) ? t : 0; };

/** 平台上的一条进度 → 回顾里的状态 / 等级 / 下一步（等级跟 review.js 的 BOSS 一致：0 最急，5 结束） */
export function progressStatus(p, platform, now = Date.now(), interview = null, homeCity = '') {
  const days = Math.floor((now - (parseDay(p.appliedAt) || now)) / DAY);
  const where = platform === '51job' ? '51job「我的申请」' : '智联「求职反馈」';
  if (interview) {
    const when = interview.begin ? new Date(interview.begin).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    if (/拒绝|取消/.test(interview.state)) return { state: '面试取消', level: 5, next: `智联面试邀请：${interview.state}` };
    if (interview.begin && interview.begin < now) return { state: '面试过了', level: 3, next: `${when} ${interview.way}，等结果；三天没消息可以问一句` };
    if (/接受/.test(interview.state)) return { state: '面试已接受', level: 0, next: `${when} ${interview.way}，记得去` };
    return { state: '邀面试', level: 0, next: `你自己接：智联「面试邀请」里有${when ? ` ${when}` : ''} ${interview.way}，我不替你答应` };
  }
  switch (p.status) {
    case '邀面试': return { state: '邀面试', level: 0, next: '你自己接：去 51job「我的申请-邀面试」看时间地点，我不替你答应' };
    case '感兴趣': case '有意向':
      // 智联「企业对你有意」里混着 HR 主动推来的外地岗：写了别的城市、没写你的求职城市的，降一档
      if (homeCity && OUTSIDE.test(`${p.title} ${p.city || ''}`) && !`${p.title} ${p.city || ''}`.includes(homeCity.replace(/市$/, ''))) return { state: '外地有意向', level: 4, next: `不在${homeCity}，看你要不要跟` };
      return { state: 'HR 有意向', level: 1, next: `去${platform === '51job' ? '51job' : '智联'}消息看 HR 留了什么` };
    case '不合适': return { state: '不合适', level: 5, next: '平台标了不合适，结束' };
    case '已查阅': case '被查看':
      return days >= 5 ? { state: '看了没下文', level: 4, next: `HR ${days} 天前就看过了，没下文多半没戏` } : { state: 'HR 看过了', level: 3, next: '刚看过，再等等' };
    default:
      return days >= 7 ? { state: '一直没看', level: 4, next: `投了 ${days} 天 HR 还没看，多半不活跃` } : { state: '还没看', level: 3, next: 'HR 还没看，再等等' };
  }
}
