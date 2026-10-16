/**
 * 面试备战包页：按 ?id= 读 chrome.storage.local.interviewPacks 里的一份，排成能打印的 A4。
 */
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const li = (xs) => (xs || []).filter(Boolean).map((x) => `<li>${esc(x)}</li>`).join('');

async function main() {
  const id = new URLSearchParams(location.search).get('id');
  const { interviewPacks: list = [] } = await chrome.storage.local.get('interviewPacks');
  const rec = list.find((x) => x.id === id) || list[0];
  const sheet = document.getElementById('sheet');
  if (!rec) { sheet.innerHTML = '<p class="muted">还没有备战包。在侧边栏顶上「工具 → 面试备战包」填公司和岗位生成一份。</p>'; document.getElementById('btn-print').hidden = true; return; }
  const P = rec.pack;
  const B = P.company_brief || {};
  document.title = `面试备战-${rec.company}`;
  document.getElementById('tb-title').textContent = `面试备战包 · ${rec.company}`;
  const date = new Date(rec.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  sheet.innerHTML = `
    <h1>${esc(rec.company)}${rec.title ? ` · ${esc(rec.title)}` : ''}</h1>
    <p class="meta">${date} 生成${rec.hasJd ? '' : ' · 插件里没存这个岗位的 JD，岗位要求是按岗位名推断的'}${rec.check ? ` · 查公司：${esc(rec.check.tier)} / ${esc(rec.check.verdict)}` : ''}</p>
    ${(rec.notes || []).length ? `<div class="warn">${rec.notes.map(esc).join('<br>')}</div>` : ''}
    ${rec.check ? `<div class="box">${esc(rec.check.one_line)}${rec.check.workload?.level && rec.check.workload.level !== '看不出' ? `<br><small>加班：${esc(rec.check.workload.level)}，${esc(rec.check.workload.evidence)}</small>` : ''}</div>` : ''}
    ${rec.check?.risks?.length ? `<div class="warn">查公司看到的风险：${esc(rec.check.risks.join('；'))}</div>` : ''}

    <h2>这家公司是干什么的</h2>
    <p><b>${esc(B.what)}</b></p>
    <p>主要业务 / 产品：${esc(B.products)}</p>
    <p>规模：${esc(B.scale)}</p>
    <p>近况：${esc(B.recent)}</p>
    ${(B.src || []).length ? `<p><small>出处：${B.src.map(esc).join('；')}</small></p>` : ''}

    <h2>这个岗位最看重什么</h2>
    <ul>${li(P.role_focus)}</ul>

    <h2>自我介绍</h2>
    <p class="muted">1 分钟版</p>
    <div class="box">${esc(P.self_intro_60s)}</div>
    <p class="muted">30 秒版</p>
    <div class="box">${esc(P.self_intro_30s)}</div>

    <h2>网上的面经</h2>
    ${(P.mianjing || []).length ? `<ul>${P.mianjing.map((m) => `<li>${esc(m.point)} <small>（${esc(m.src)}）</small></li>`).join('')}</ul>` : '<p class="muted">没搜到这家的面经，下面的题是按岗位和你的简历推的。</p>'}

    <h2>可能被问的题</h2>
    ${(P.questions || []).map((q, i) => `<div class="q">
      <span class="tag">${esc(q.type)}</span><b>${i + 1}. ${esc(q.q)}</b>
      <p><small>为什么问：${esc(q.why)}</small></p>
      <ul>${li(q.outline)}</ul>
      ${q.fill_in ? `<p class="fill">${esc(q.fill_in)}</p>` : ''}
      ${q.avoid ? `<p><small>别踩：${esc(q.avoid)}</small></p>` : ''}
    </div>`).join('')}

    <h2>反问</h2>
    <ul>${li(P.ask_back)}</ul>

    <h2>面试时顺口问清 / 留意</h2>
    <ul>${li(P.verify_on_site)}</ul>

    <h2>去之前准备</h2>
    <ul>${li(P.prep_todo)}</ul>

    ${(rec.links || []).length ? `<h2>搜到的链接</h2><ul>${rec.links.map((l) => `<li><a href="${esc(l.url)}" target="_blank">${esc(l.title)}</a></li>`).join('')}</ul>` : ''}
  `;
}

document.getElementById('btn-print').onclick = () => window.print();
main();
