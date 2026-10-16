/**
 * 侧边栏「网申」页：拆这则招聘公告（v1.0.30）。逻辑在 lib/notice.js。
 */
import { getConfig } from '../lib/store.js';
import { requestPagePermission } from '../lib/autofill-engine.js';
import { analyzeNotice, noticeHistory, noticeCsv } from '../lib/notice.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let current = null;

function status(t, err = false) { const el = $('nt-status'); el.textContent = t; el.className = err ? 'status err' : 'status'; }

function render(rec) {
  current = rec;
  $('btn-nt-csv').hidden = !rec;
  if (!rec) { $('nt-result').innerHTML = ''; return; }
  const R = rec.result;
  const ps = R.positions || [];
  const n = (f) => ps.filter((p) => p.fit === f).length;
  const exam = R.exam === '要笔试';
  const card = (p) => `<div class="rv ${p.fit === '不符合' ? 'dim' : ''}">
    <span class="st ${p.fit === '符合' ? 'st-1' : p.fit === '看不出' ? 'st-2' : ''}">${esc(p.fit)}</span><b title="${esc(p.name)}">${esc(p.name)}</b><time>${esc(p.count || '')}</time>
    <div class="sub">${esc([p.unit, p.major, p.degree, p.age, p.form].filter((x) => x && x !== '没写').join(' · '))}</div>
    <div class="nx">${esc(p.why)}${p.other && p.other !== '没写' ? `<br><small>其他条件：${esc(p.other)}</small>` : ''}</div>
  </div>`;
  const files = (rec.files || []).map((f) => `<li>${esc(f.label)}：${f.err ? `<span class="err">${esc(f.err)}</span>` : `拆出 ${f.chars} 字`}</li>`).join('');
  $('nt-result').innerHTML = `
    <div class="rv-group">${esc(R.org)}${R.kind ? ` · ${esc(R.kind)}` : ''}${R.deadline ? ` · 截止 ${esc(R.deadline)}` : ''}</div>
    ${exam ? '<div class="warn-box">这则公告要笔试，报名前想清楚要不要备考</div>' : ''}
    <p class="hint" style="margin:0 0 4px">${ps.length} 个岗位：符合 ${n('符合')}、看不出 ${n('看不出')}、不符合 ${n('不符合')}｜${esc(R.exam)}${R.how_to_apply ? `｜${esc(R.how_to_apply)}` : ''}</p>
    ${(R.notes || []).length ? `<ul class="hint">${R.notes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${ps.map(card).join('') || '<p class="hint">没认出岗位。</p>'}
    ${files ? `<details><summary class="hint">附件 ${rec.files.length} 个</summary><ul class="hint">${files}</ul></details>` : ''}
    ${rec.truncated ? '<p class="hint">材料太长，后面一部分没送给模型，岗位可能没列全。</p>' : ''}`;
}

async function renderHistory() {
  const list = await noticeHistory();
  $('nt-history').innerHTML = list.length > (current ? 1 : 0)
    ? `之前拆过：${list.slice(0, 8).map((r, i) => `<a href="#" data-nt="${i}" title="${esc(r.url)}">${esc((r.result.org || r.title).slice(0, 14))}</a>`).join('　')}` : '';
}

export function initNotice() {
  $('btn-nt').onclick = async () => {
    const btn = $('btn-nt');
    btn.disabled = true;
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.url || !/^https?:/.test(tab.url)) throw new Error('先切到公告那个标签页');
      await requestPagePermission(tab.id);
      const local = await Promise.all([...($('nt-files').files || [])].map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
      const rec = await analyzeNotice(tab.id, await getConfig(), (t) => status(t), local);
      const R = rec.result;
      status(`拆完了，${(rec.ms / 1000).toFixed(0)} 秒。${(R.positions || []).filter((p) => p.fit === '符合').length} 个岗位你符合条件`);
      render(rec);
      renderHistory();
    } catch (e) { status(e.message, true); }
    btn.disabled = false;
  };
  $('btn-nt-csv').onclick = () => {
    if (!current) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([noticeCsv(current)], { type: 'text/csv;charset=utf-8' }));
    a.download = `公告岗位-${(current.result.org || '公告').slice(0, 20)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  $('nt-history').addEventListener('click', async (e) => {
    const a = e.target.closest('[data-nt]');
    if (!a) return;
    e.preventDefault();
    render((await noticeHistory())[Number(a.dataset.nt)]);
  });
  renderHistory();
}
