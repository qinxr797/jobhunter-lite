/**
 * 定制简历页：读侧边栏存进来的拼法（chrome.storage.local.resumeDraft），按素材库原句排成一页 A4。
 * 超出一页就从最不相关的条目开始压（展开 → 一句话 → 去掉），直到装进一页。
 * 「下载 PDF」用 chrome.debugger 的 Page.printToPDF 出文件，存到 下载\求职简历\。
 */
import { getConfig } from '../lib/store.js';
import { buildPlan, resumeHtml, shrinkOnce, describePlan } from '../lib/resume-render.js';

const $ = (id) => document.getElementById(id);
const status = (t) => { $('tb-status').textContent = t; };

let fileBase = '简历';

function overflows() {
  const main = document.querySelector('.main');
  const side = document.querySelector('.side');
  return main.scrollHeight > main.clientHeight + 1 || side.scrollHeight > side.clientHeight + 1;
}

async function render() {
  const [{ resumeDraft: d }, config] = await Promise.all([chrome.storage.local.get('resumeDraft'), getConfig()]);
  const lib = config.library;
  if (!lib) { status('还没有简历：去插件「设置」粘贴简历、点解析、再点保存'); return; }

  const plan = d?.plan ? structuredClone(d.plan) : buildPlan(lib, d?.spec || {});
  const photo = lib.profile.photo ? chrome.runtime.getURL(lib.profile.photo) : '';
  const page = $('page');
  const shrunk = [];
  page.innerHTML = resumeHtml(lib, plan, photo);
  await document.fonts.ready;
  await new Promise((r) => { const img = page.querySelector('img'); if (!img || img.complete) r(); else { img.onload = r; img.onerror = r; } });
  for (let i = 0; i < 12 && overflows(); i++) {
    const what = shrinkOnce(lib, plan);
    if (!what) break;
    shrunk.push(what);
    page.innerHTML = resumeHtml(lib, plan, photo);
  }

  const job = d?.job || {};
  const clean = (s) => String(s || '').replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 20);
  fileBase = [clean(lib.profile.name) || '简历', clean(job.company), clean(job.title)].filter(Boolean).join('-');
  document.title = fileBase;
  $('tb-title').textContent = job.title ? `定制简历 — ${job.title} @ ${job.company}` : '简历预览';
  $('tb-plan').textContent = describePlan(lib, plan) + (shrunk.length ? `。为了压进一页：${shrunk.join('、')}` : '');
  $('tb-reasons').innerHTML = (d?.reasons || []).map((r) => `<li>${r.replace(/[&<>]/g, '')}</li>`).join('');
  if (overflows()) status('⚠ 压到最短还是超出一页，打印出来会被截掉最后几行');
}

/** 用调试接口把本页打成 PDF（不弹打印框），存到 下载\求职简历\ */
async function downloadPdf() {
  const btn = $('btn-pdf');
  btn.disabled = true;
  status('正在生成 PDF…');
  const tab = await chrome.tabs.getCurrent();
  const target = { tabId: tab.id };
  try {
    await chrome.debugger.attach(target, '1.3');
    const { data } = await chrome.debugger.sendCommand(target, 'Page.printToPDF', {
      printBackground: true, preferCSSPageSize: true,
      marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
    });
    await chrome.debugger.detach(target).catch(() => {});
    await chrome.downloads.download({ url: `data:application/pdf;base64,${data}`, filename: `求职简历/${fileBase}.pdf`, conflictAction: 'uniquify' });
    status(`已存到：下载\\求职简历\\${fileBase}.pdf`);
  } catch (e) {
    await chrome.debugger.detach(target).catch(() => {});
    status(`直接生成失败（${e.message}），改用「打印 / 另存」，目标打印机选「另存为 PDF」、边距选「无」`);
  } finally {
    btn.disabled = false;
  }
}

$('btn-pdf').onclick = downloadPdf;
$('btn-print').onclick = () => window.print();
render().catch((e) => status(`出错了：${e.message}`));
