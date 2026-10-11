/**
 * 侧边栏「查公司」页（v0.8.0）：你输入单位名字 → 后台搜 → DeepSeek 写「这家公司咋样」。
 * 网申卡片、筛选结果卡片上的「查公司」按钮也走这里（openCompany）。
 */
import { getConfig } from '../lib/store.js';
import { checkCompany, checkHistory } from '../lib/company-check.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let busy = false;

function status(t, err = false) { const el = $('co-status'); el.textContent = t; el.className = err ? 'status err' : 'status'; }

const V_CLS = { 值得投: 'v-good', 可以投但留个心: 'v-mid', 谨慎: 'v-mid', 别投: 'v-bad', 信息太少: '' };
const TIER_CLS = { 大单位: 'tier-big', 中型: 'tier-mid', 小公司: 'tier-small' };
const link = (s) => (/^https?:\/\//.test(s || '') ? `<a href="${esc(s)}" target="_blank" rel="noopener">${esc(s.replace(/^https?:\/\/(www\.)?/, '').slice(0, 40))}</a>` : esc(s || ''));

function renderResult(rec) {
  const r = rec.report;
  $('co-result').innerHTML = `<div class="job co-card">
    <h4>${r.tier && r.tier !== '看不出' ? `<span class="tier ${TIER_CLS[r.tier] || ''}">${esc(r.tier)}</span>` : ''}${esc(rec.name)}</h4>
    <div class="meta">${esc(r.full_name)} · 查于 ${new Date(rec.at).toLocaleString('zh-CN')}</div>
    <div><span class="co-verdict ${V_CLS[r.verdict] || ''}">${esc(r.verdict)}</span></div>
    <div class="one">${esc(r.one_line)}</div>
    ${(r.facts || []).length ? `<h5>工商 / 规模</h5><table>${r.facts.map((f) => `<tr><td class="k">${esc(f.k)}</td><td>${esc(f.v)}<div class="src">${link(f.src)}</div></td></tr>`).join('')}</table>` : ''}
    <h5>卷不卷：${esc(r.workload?.level || '看不出')}</h5><div class="company-check">${esc(r.workload?.evidence || '')}${r.workload?.src ? `<div class="src">${link(r.workload.src)}</div>` : ''}</div>
    <h5>求职城市</h5><div class="company-check">${esc(r.hefei || '没查到')}</div>
    ${(r.good || []).length ? `<h5>好的地方</h5><ul>${r.good.map((g) => `<li>${esc(g)}</li>`).join('')}</ul>` : ''}
    <h5>风险</h5>${(r.risks || []).length ? `<ul class="flags">${r.risks.map((g) => `<li>${esc(g)}</li>`).join('')}</ul>` : '<div class="company-check">没查到明显风险（不等于没有）</div>'}
    ${(r.todo || []).length ? `<h5>你自己再核对</h5><ul>${r.todo.map((g) => `<li>${esc(g)}</li>`).join('')}</ul>` : ''}
    ${(rec.notes || []).length ? `<div class="warn-box">${rec.notes.map(esc).join('<br>')}</div>` : ''}
    <details><summary class="hint">搜到的材料（百度 ${rec.sources?.baiduCount || 0} 条${rec.sources?.qcc ? '、企查查' : ''}${rec.sources?.own?.length ? '、插件自己的记录' : ''}）</summary>
      <ul>${(rec.links || []).map((l) => `<li>${esc(l.title)} ${link(l.url)}</li>`).join('')}</ul>
      ${(rec.sources?.own || []).map((o) => `<div class="src">${esc(o)}</div>`).join('')}
    </details>
  </div>`;
}

async function renderHistory() {
  const h = await checkHistory();
  $('co-history').innerHTML = h.length ? `<div class="co-hist hint">查过的：${h.map((c) => `<button data-co="${esc(c.name)}">${esc(c.name)}${c.report?.verdict ? ' · ' + esc(c.report.verdict) : ''}</button>`).join('')}</div>` : '';
}

async function run(name) {
  if (busy) return;
  name = String(name || '').trim();
  if (!name) { status('先输入公司名', true); return; }
  busy = true;
  $('btn-co').disabled = true;
  $('co-result').innerHTML = '';
  const t0 = Date.now();
  try {
    const rec = await checkCompany(name, await getConfig(), (t) => status(t));
    renderResult(rec);
    status(`查完了（${Math.round((Date.now() - t0) / 1000)} 秒）。结论只基于搜到的材料，关键数字点出处核对一下`);
    renderHistory();
  } catch (e) { status(e.message, true); }
  finally { busy = false; $('btn-co').disabled = false; }
}

/** 从别的卡片跳过来查：切到「查公司」页、填名字、开查 */
export function openCompany(name) {
  document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
  document.querySelectorAll('.panel').forEach((x) => x.classList.toggle('active', x.id === 'panel-company'));
  document.querySelector('main').scrollTop = 0;
  $('co-name').value = name;
  run(name);
}

export function initCompany() {
  // 「今天」页顶上的搜索框
  $('co-quick').addEventListener('submit', (e) => { e.preventDefault(); const n = $('co-quick-name').value.trim(); if (n) { openCompany(n); $('co-quick-name').value = ''; } });
  $('btn-co').onclick = () => run($('co-name').value);
  $('co-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') run($('co-name').value); });
  $('co-history').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-co]');
    if (!b) return;
    const rec = (await checkHistory()).find((c) => c.name === b.dataset.co);
    if (rec) { $('co-name').value = rec.name; renderResult(rec); status('这是之前查的结果；要最新的再点「查」'); }
  });
  renderHistory();
}
