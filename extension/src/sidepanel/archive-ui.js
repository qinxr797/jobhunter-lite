/**
 * 「已投」页下半部分：公司档案（v0.8.1）—— 一家公司在官网网申 / BOSS / 51job / 智联哪些渠道投过、什么时候投的。
 * 「已投」上半部分只有今天的，这里是全部的（档案从 v0.7.0 起记，之前的只补了当天的）。
 */
import { getArchive, CHANNEL_NAMES } from '../lib/company-archive.js';
import { openCompany } from './company-ui.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const md = (ms) => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()}`; };

async function render() {
  const a = await getArchive();
  const list = Object.values(a).sort((x, y) => (y.at || 0) - (x.at || 0));
  $('archive-list').innerHTML = `<div class="arch"><h4>公司档案（${list.length} 家，所有渠道合在一起）</h4>
    ${list.length ? `<table>${list.map((c) => `<tr>
      <td><b>${esc(c.name)}</b></td>
      <td>${Object.entries(c.ch || {}).map(([k, v]) => `<span class="ch" title="${esc(v.title || '')}">${esc(CHANNEL_NAMES[k] || k)} ${md(v.at)}</span>`).join('')}</td>
      <td><button data-arch="${esc(c.name)}">查公司</button></td></tr>`).join('')}</table>`
    : '<p class="empty">还没有。网申按「我投了」、平台上投成功的都会记进来。</p>'}</div>`;
}

export function initArchive() {
  $('archive-list').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-arch]');
    if (b) openCompany(b.dataset.arch);
  });
  chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.companies) render(); });
  render();
}
