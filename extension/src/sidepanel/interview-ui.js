/**
 * 侧边栏「工具」页：面试备战包。逻辑在 lib/interview.js，成品在 src/interview/interview.html。
 */
import { getConfig } from '../lib/store.js';
import { buildPack, packHistory } from '../lib/interview.js';
import { showPanel } from './nav.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const open = (id) => chrome.tabs.create({ url: chrome.runtime.getURL(`src/interview/interview.html?id=${encodeURIComponent(id)}`) });

function status(t, err = false) { const el = $('iv-status'); el.textContent = t; el.className = err ? 'status err' : 'status'; }

async function renderHistory() {
  const list = await packHistory();
  $('iv-history').innerHTML = list.length ? `之前的：${list.slice(0, 5).map((r) => `<a href="#" data-iv="${esc(r.id)}">${esc(r.company.slice(0, 10))}</a>`).join('　')}` : '';
}

async function run() {
  const btn = $('btn-iv');
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    const rec = await buildPack({ company: $('iv-company').value, title: $('iv-title').value, jd: $('iv-jd').value }, await getConfig(), (t) => status(t));
    status(`好了，${(rec.ms / 1000).toFixed(0)} 秒。已在新标签打开，能直接打印`);
    open(rec.id);
    renderHistory();
  } catch (e) { status(e.message, true); }
  btn.disabled = false;
}

/** 回顾里「要你接」那几家的「备战包」按钮调这个 */
export function prepareFor(company, title) {
  showPanel('tools');
  $('iv-details').open = true;
  $('iv-company').value = company || '';
  $('iv-title').value = title || '';
  $('iv-jd').value = '';
  $('iv-company').scrollIntoView({ block: 'center', behavior: 'smooth' });
  run();
}

export function initInterview() {
  $('btn-iv').onclick = run;
  $('iv-history').addEventListener('click', (e) => {
    const a = e.target.closest('[data-iv]');
    if (!a) return;
    e.preventDefault();
    open(a.dataset.iv);
  });
  renderHistory();
}
