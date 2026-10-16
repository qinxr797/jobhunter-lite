/**
 * 拆招聘公告的岗位表（照 Tabbit「求职助手」脚本的 jobsFromDocumentTables 补上）。
 *
 * 学校、医院、协会、事业单位常把岗位放在公告页的表格或附件（PDF / Excel / Word）里，一张表几十个岗位，
 * 每个岗位的专业、学历、年龄、户籍条件都不一样，人眼对很累。这里：
 *   1. 读当前公告页：正文、页面里的表格、附件链接（在你自己的标签里读，只读不点）
 *   2. 下附件：先在公告页里下（同站附件带着登录态），跨站下不了再用插件下
 *   3. 拆成文字：Excel 用 SheetJS、PDF 用 pdf.js（按坐标拼回行）、Word 用 JSZip 读 document.xml；老的 .doc 拆不了，说一声
 *   4. DeepSeek 按素材库对每个岗位判「他符不符合」「要不要笔试」，只许用表里写的条件
 * 设置里勾了「不考编」：要笔试的排后面、标灰，不删（万一有不考的编外岗）。
 */
import { callJson, forTask } from './llm.js';
import { factsFrom } from './autofill-lib.js';

// 三个库都大（合计 2.5MB），用到时才加载，侧边栏平时打开不受影响
let XLSX = null, pdfjs = null;
const loadXlsx = async () => (XLSX ||= await import('../vendor/sheetjs/xlsx.mjs'));
async function loadPdf() {
  if (!pdfjs) {
    pdfjs = await import('../vendor/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('src/vendor/pdfjs/pdf.worker.min.mjs');
  }
  return pdfjs;
}
async function loadZip() {
  if (!globalThis.JSZip) await import('../vendor/jszip/jszip.min.js');
  return globalThis.JSZip;
}

const ATTACH_RE = /\.(pdf|xlsx?|docx?|et|wps)(\?|#|$)/i;
const MAX_FILE = 15 * 1024 * 1024;

/** 页面里跑的：正文、表格、附件链接 */
export function scanNoticePage() {
  const t = (e) => (e?.innerText || '').replace(/[ \t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const tables = [...document.querySelectorAll('table')].filter((tb) => tb.rows.length >= 2 && t(tb).length > 30)
    .map((tb) => [...tb.rows].map((r) => [...r.cells].map((c) => t(c).replace(/\n/g, ' ')).join('\t')).join('\n'));
  const main = document.querySelector('article, .article, .content, #content, .main, main, [class*="detail"], [class*="article"]') || document.body;
  const links = [...document.querySelectorAll('a[href]')].map((a) => ({ href: a.href, text: t(a).slice(0, 80) }))
    // 认附件：网址是文件后缀，或者文字写着附件 / 岗位表；只写「下载」的要网址也像下载（栏目导航「文档下载」不算）
    .filter((l) => /^https?:/.test(l.href) && (/\.(pdf|xlsx?|docx?|et|wps)(\?|#|$)/i.test(l.href) || /附件|岗位表|岗位计划|一览表|职位表/.test(l.text) || (/下载/.test(l.text) && /download|attach|file|upload/i.test(l.href) && !/\.s?html?(\?|#|$)/i.test(l.href))))
    .filter((l, i, all) => all.findIndex((x) => x.href === l.href) === i).slice(0, 8);
  return { title: document.title, url: location.href, text: t(main).slice(0, 8000), tables: tables.slice(0, 6).map((x) => x.slice(0, 12000)), links };
}

/** 页面里跑的：在公告页里下附件（同站带登录态），返回 base64 */
export async function fetchInPage(urls, max) {
  const out = [];
  for (const u of urls) {
    try {
      const r = await fetch(u, { credentials: 'include' });
      if (!r.ok) { out.push({ url: u, err: `HTTP ${r.status}` }); continue; }
      const buf = new Uint8Array(await r.arrayBuffer());
      // 博达等学校网站系统：附件要先输图形验证码（10/16 合工大实测），插件不过验证码
      if (/text\/html/i.test(r.headers.get('content-type') || '') && /验证码/.test(new TextDecoder().decode(buf.subarray(0, 4000)))) {
        out.push({ url: u, err: '这个网站下附件要输图形验证码。你点开附件输一下、下到电脑上，再在上面「自己下到电脑上」那里选它', captcha: true });
        continue;
      }
      if (buf.length > max) { out.push({ url: u, err: '文件太大（超过 15MB）' }); continue; }
      let s = '';
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      out.push({ url: u, b64: btoa(s), type: r.headers.get('content-type') || '', name: decodeURIComponent((r.headers.get('content-disposition') || '').replace(/.*filename\*?=(UTF-8'')?"?([^";]+)"?.*/i, '$2') || '') });
    } catch (e) { out.push({ url: u, err: String(e.message || e) }); }
  }
  return out;
}

const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** 附件字节 → 文字（表格按行，格子之间用 tab） */
export async function extractText(bytes, hint = '') {
  const head = String.fromCharCode(...bytes.subarray(0, 8));
  if (head.startsWith('%PDF')) return pdfText(bytes);
  if (head.startsWith('PK')) {
    const zip = await (await loadZip()).loadAsync(bytes);
    if (zip.file('word/document.xml')) return docxText(await zip.file('word/document.xml').async('string'));
    return sheetText(await loadXlsx(), bytes);
  }
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf) {
    // OLE：老的 .xls 能读，老的 .doc / .wps 读不了
    if (/\.(doc|wps)(\?|$)/i.test(hint)) throw new Error('老格式 Word（.doc / .wps）拆不了，点开附件自己看，或者另存成 .docx 再说');
    try { return sheetText(await loadXlsx(), bytes); } catch { throw new Error('老格式 Office 文件拆不了（多半是 .doc），点开附件自己看'); }
  }
  throw new Error('不是 PDF / Excel / Word（可能是网页跳转或者要登录才能下）');
}

function sheetText(XLSX, bytes) {
  const wb = XLSX.read(bytes, { type: 'array', dense: true });
  return wb.SheetNames.map((n) => `【表：${n}】\n${XLSX.utils.sheet_to_csv(wb.Sheets[n], { FS: '\t', blankrows: false })}`).join('\n\n');
}

function docxText(xml) {
  const d = new DOMParser().parseFromString(xml, 'application/xml');
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const txt = (n) => [...n.getElementsByTagNameNS(W, 't')].map((x) => x.textContent).join('');
  const out = [];
  const body = d.getElementsByTagNameNS(W, 'body')[0];
  for (const n of body ? [...body.children] : []) {
    if (n.localName === 'tbl') {
      for (const tr of n.getElementsByTagNameNS(W, 'tr')) out.push([...tr.getElementsByTagNameNS(W, 'tc')].map((tc) => txt(tc).trim()).join('\t'));
    } else if (n.localName === 'p') {
      const s = txt(n).trim();
      if (s) out.push(s);
    }
  }
  return out.join('\n');
}

async function pdfText(bytes) {
  const pdfjs = await loadPdf();
  const doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
  const pages = [];
  for (let p = 1; p <= Math.min(doc.numPages, 30); p++) {
    const page = await doc.getPage(p);
    const { items } = await page.getTextContent();
    // 同一行（y 差不到 3）拼一起，x 隔得远的中间放 tab，表格就还原成一行行
    const rows = [];
    for (const it of items) {
      if (!it.str.trim()) continue;
      const [x, y] = [it.transform[4], it.transform[5]];
      let row = rows.find((r) => Math.abs(r.y - y) < 3);
      if (!row) rows.push(row = { y, cells: [] });
      row.cells.push({ x, w: it.width, s: it.str });
    }
    rows.sort((a, b) => b.y - a.y);
    pages.push(rows.map((r) => {
      r.cells.sort((a, b) => a.x - b.x);
      let line = '', end = -1;
      for (const c of r.cells) { line += (end >= 0 && c.x - end > 8 ? '\t' : '') + c.s; end = c.x + c.w; }
      return line;
    }).join('\n'));
  }
  // PDF 字体常把「人、文、子」存成康熙部首（⼈ ⽂ ⼦），NFKC 规范化回常用字（10/16 实测）
  return pages.join('\n\n').normalize('NFKC');
}

const SCHEMA = {
  type: 'object',
  properties: {
    org: { type: 'string' },
    kind: { type: 'string' },
    deadline: { type: 'string' },
    how_to_apply: { type: 'string' },
    exam: { type: 'string', enum: ['要笔试', '只面试/考核', '看不出'] },
    positions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          unit: { type: 'string' }, name: { type: 'string' }, count: { type: 'string' },
          major: { type: 'string' }, degree: { type: 'string' }, age: { type: 'string' },
          other: { type: 'string' }, form: { type: 'string' },
          fit: { type: 'string', enum: ['符合', '不符合', '看不出'] }, why: { type: 'string' },
        },
        required: ['name', 'major', 'degree', 'fit', 'why'],
      },
    },
    notes: { type: 'array', items: { type: 'string' } },
  },
  required: ['org', 'exam', 'positions', 'notes'],
};

function noticePrompt(F, material) {
  const E = F.education[0];
  return `任务：下面是一则招聘公告（网页正文、页面表格、附件拆出来的文字）。把里面的岗位一个个列出来，并判断这个求职者符不符合每个岗位的报名条件。

# 求职者
- ${E.school || '学校没写'} ${E.major || ''}，${E.degree || '学历没写'}，${E.graduation ? `${E.graduation} 毕业` : '毕业时间没写'}${F.basic.identity ? `，${F.basic.identity}` : ''}
- ${F.basic.age || ''} ${F.basic.gender || ''} ${F.basic.political || ''}；求职城市 ${F.intent.city || '没写'}；户籍材料里没写，遇到户籍限制判「看不出」并写明要求
- 英语：${F.english || '没写'}；证书：${(F.certificates || []).join('、') || '没写'}

# 规矩
- 只能用材料里写的条件，材料没写的写「没写」，不许编
- 专业要求要按「专业目录」理解：写「专业不限」「相关专业」或者写的专业大类包含他的专业时算符合；写具体别的专业就不符合
- 学历按他的学历对：要求高于他的就不符合；写「全日制」「第一学历」的，在 why 里点出来让他自己核对
- 年龄、工作经验、职称、证书、户籍、政治面貌任一条不满足就是「不符合」，why 写卡在哪一条
- form：编制性质（事业编 / 编外合同制 / 劳务派遣 / 人事代理 / 企业 / 没写）
- exam：整则公告要不要笔试（写了笔试、统一考试、专业知识测试就是要笔试；只写面试、考核、试讲的是只面试/考核）
- 岗位很多时最多列 60 个，符合的一个都不能漏
- notes：报名时间、报名方式、要交的材料里值得他注意的，每条一句，最多 5 条

# 材料
${material}

输出 json。`;
}

/** 拆当前标签的公告。onProgress(text)。返回记录并存进历史 */
export async function analyzeNotice(tabId, config, onProgress = () => {}, localFiles = []) {
  onProgress('读公告页…');
  const tab = await chrome.tabs.get(tabId);
  // 当前标签本身就是附件（浏览器直接打开的 PDF / 下载链接）：插件直接下
  const page = ATTACH_RE.test(tab.url || '')
    ? { title: tab.title || '', url: tab.url, text: '', tables: [], links: [{ href: tab.url, text: (tab.title || tab.url).slice(0, 80) }], direct: true }
    : (await chrome.scripting.executeScript({ target: { tabId }, func: scanNoticePage }))[0]?.result;
  if (!page) throw new Error('读不到这个页面');
  const parts = [`【公告页】${page.title}\n${page.url}\n${page.text}`];
  page.tables.forEach((t, i) => parts.push(`【页面表格 ${i + 1}】\n${t}`));
  const files = [];
  const urls = page.links.map((l) => l.href);
  if (urls.length) {
    onProgress(`下附件（${urls.length} 个）…`);
    const got = page.direct ? urls.map((url) => ({ url }))
      : ((await chrome.scripting.executeScript({ target: { tabId }, func: fetchInPage, args: [urls, MAX_FILE] }))[0]?.result || []);
    for (const g of got) {
      const label = page.links.find((l) => l.href === g.url)?.text || g.name || g.url.split('/').pop();
      let bytes = g.b64 ? b64ToBytes(g.b64) : null;
      if (!bytes) {
        // 跨站附件：公告页里下不了，插件自己下（要那个网站的权限，没有就说一声）
        try {
          const r = await fetch(g.url);
          if (r.ok) bytes = new Uint8Array(await r.arrayBuffer());
        } catch { /* 下面统一报 */ }
      }
      if (!bytes) { files.push({ label, url: g.url, err: g.err || '下载不了' }); continue; }
      onProgress(`拆附件「${label}」…`);
      try {
        const text = await extractText(bytes, g.url);
        files.push({ label, url: g.url, chars: text.length });
        parts.push(`【附件：${label}】\n${text}`);
      } catch (e) { files.push({ label, url: g.url, err: e.message }); }
    }
  }
  // 你自己下到电脑上的附件（要验证码的、跨站下不了的）
  for (const f of localFiles) {
    onProgress(`拆你选的「${f.name}」…`);
    try {
      const text = await extractText(f.bytes, f.name);
      files.push({ label: f.name, url: '本地文件', chars: text.length });
      parts.push(`【附件：${f.name}】\n${text}`);
    } catch (e) { files.push({ label: f.name, url: '本地文件', err: e.message }); }
  }
  const material = parts.join('\n\n').slice(0, 30000);
  if (material.length < 200) throw new Error('这页上没找到公告正文、表格或附件。打开具体那则公告（不是列表页）再点');
  if (!config.library) throw new Error('先去「设置」把简历填上，才知道你符不符合');
  onProgress(`DeepSeek 逐个岗位对条件（材料 ${material.length} 字，半分钟左右）…`);
  const F = factsFrom(config.library, config.resume?.summary || '');
  const t0 = Date.now();
  let usage = null;
  const r = await callJson(forTask(config, 'autofill'), { user: noticePrompt(F, material), schema: SCHEMA, maxTokens: 8000, task: 'notice', onUsage: (u) => { usage = u; } });
  delete r._usage;
  const order = { 符合: 0, 看不出: 1, 不符合: 2 };
  r.positions = (r.positions || []).sort((a, b) => (order[a.fit] ?? 1) - (order[b.fit] ?? 1));
  const rec = { at: Date.now(), url: page.url, title: page.title, files, result: r, ms: Date.now() - t0, usage, truncated: parts.join('\n\n').length > 30000 };
  const { notices = [] } = await chrome.storage.local.get('notices');
  await chrome.storage.local.set({ notices: [rec, ...notices.filter((n) => n.url !== page.url)].slice(0, 20) });
  return rec;
}

export async function noticeHistory() {
  const { notices = [] } = await chrome.storage.local.get('notices');
  return notices;
}

/** 导出 CSV（Excel 能直接开） */
export function noticeCsv(rec) {
  const head = ['他符合吗', '为什么', '用人单位', '岗位', '人数', '专业', '学历', '年龄', '其他条件', '编制'];
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = (rec.result.positions || []).map((p) => [p.fit, p.why, p.unit || rec.result.org, p.name, p.count, p.major, p.degree, p.age, p.other, p.form].map(cell).join(','));
  return '﻿' + [head.map(cell).join(','), ...lines].join('\r\n');
}
