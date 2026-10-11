/*
 * 页面上的部分：找到岗位描述 → 高亮黑话 → 右下角放一张判决卡。
 * 只读页面，不点任何按钮、不发任何请求。
 */
(function () {
  'use strict';
  if (window.__jddContent) return; // 右键菜单会重复注入，只初始化一次
  window.__jddContent = true;

  const JDD = globalThis.JDD;
  const MARK = 'jdd-mark';
  const hasChrome = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync;
  const store = {
    get: (keys) => (hasChrome ? chrome.storage.sync.get(keys) : Promise.resolve({})),
    set: (obj) => (hasChrome ? chrome.storage.sync.set(obj) : Promise.resolve()),
  };

  // 同一页面装了两份（独立版 + 求职插件里那份）时，只让先到的干活
  const root = document.documentElement;
  if (root.dataset.jddOwner) return;
  root.dataset.jddOwner = '1';

  let prefs = JDD.normalizePrefs(JDD.PRESET || {});
  let auto = true;
  let collapsed = !!(JDD.PRESET && JDD.PRESET.startCollapsed);
  // 测试页（test/fixtures）用 window.__jddTestSite 指定按哪个网站的规则找
  const site = JDD.siteFor(location.hostname) || JDD.SITES.find((x) => x.name === window.__jddTestSite) || null;

  /* ===== 判决卡（放在 shadow DOM 里，不受网页样式影响） ===== */
  const host = document.createElement('div');
  host.id = 'jdd-card-host';
  host.style.cssText = 'all:initial;position:fixed;right:20px;bottom:20px;z-index:2147483600;';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>
    :host{all:initial}
    *{box-sizing:border-box}
    .card{width:340px;max-height:62vh;display:flex;flex-direction:column;background:#fbf7ef;color:#211d18;border:1px solid #e3d8c4;border-radius:14px;
      box-shadow:0 18px 40px -16px rgba(40,25,5,.45),0 2px 6px rgba(40,25,5,.08);font:14px/1.6 "Microsoft YaHei UI","Microsoft YaHei","PingFang SC",sans-serif;overflow:hidden}
    .top{display:flex;gap:12px;align-items:center;padding:12px 14px 10px;border-bottom:1px dashed #e3d8c4;cursor:pointer}
    .stamp{flex:none;width:64px;height:64px;border-radius:50%;display:grid;place-items:center;border:3px solid var(--sc);color:var(--sc);
      font:700 17px/1 "STKaiti","KaiTi","Kaiti SC",serif;letter-spacing:.04em;transform:rotate(-12deg);position:relative;text-align:center}
    .stamp::before{content:"";position:absolute;inset:4px;border:1px solid var(--sc);border-radius:50%}
    .stamp.slam{animation:slam .42s cubic-bezier(.2,1.5,.45,1)}
    @keyframes slam{0%{opacity:0;transform:rotate(-24deg) scale(2.2)}100%{opacity:1;transform:rotate(-12deg) scale(1)}}
    .meta{flex:1;min-width:0}
    .row{display:flex;justify-content:space-between;align-items:baseline;font-size:12px;color:#8f8474}
    .score{font-size:26px;font-weight:700;line-height:1.1;color:#211d18;font-variant-numeric:tabular-nums}
    .score small{font-size:12px;font-weight:400;color:#8f8474}
    .line{font:15px/1.4 "STKaiti","KaiTi","Kaiti SC",serif;margin-top:2px}
    .btns{display:flex;gap:2px}
    .ib{border:0;background:transparent;color:#8f8474;cursor:pointer;font-size:16px;line-height:1;padding:4px 6px;border-radius:6px}
    .ib:hover{background:#efe6d6;color:#211d18}
    .body{overflow:auto;padding:10px 14px 12px}
    .vetos{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:8px}
    .veto{font-size:12px;background:#c2362b;color:#fff;padding:1px 8px;border-radius:5px}
    h4{margin:10px 0 6px;font-size:12px;letter-spacing:.1em;color:#8f8474;font-weight:600;display:flex;justify-content:space-between;align-items:center}
    .tr{border-left:3px solid var(--mk);background:#fff8;border-radius:0 8px 8px 0;padding:6px 9px;margin-bottom:6px;transition:background .15s}
    .tr.hot{background:color-mix(in srgb,var(--mk) 26%,#fff)}
    .q{font-size:12px;color:#8f8474}
    .q b{color:#5c5347;font-weight:600}
    .q .w{float:right;font-variant-numeric:tabular-nums}
    .s{font-size:13.5px}
    ol{margin:0;padding-left:18px;font-size:13.5px}
    li{margin:2px 0}
    .chip{border:1px solid #e3d8c4;background:#fff;border-radius:99px;padding:1px 10px;font-size:12px;color:#5c5347;cursor:pointer}
    .chip:hover{border-color:#8f8474}
    .empty{color:#8f8474;font-size:13px}
    .foot{font-size:11.5px;color:#8f8474;padding:6px 14px 10px;border-top:1px dashed #e3d8c4;display:flex;justify-content:space-between}
    .foot a{color:#8f8474;cursor:pointer;text-decoration:underline}
    .mini{width:62px;height:62px;border-radius:50%;background:#fbf7ef;display:grid;place-items:center;cursor:pointer;box-shadow:0 10px 26px -10px rgba(40,25,5,.5);border:1px solid #e3d8c4}
    .mini .stamp{width:52px;height:52px;font-size:14px;border-width:2.5px}
    .mini .stamp::before{inset:3px}
    [hidden]{display:none!important}
  </style>
  <div class="mini" id="mini" hidden title="展开黑话翻译"><div class="stamp" id="miniStamp"></div></div>
  <div class="card" id="card" hidden>
    <div class="top" id="top" title="收起">
      <div class="stamp" id="stamp"></div>
      <div class="meta">
        <div class="row"><span id="src">黑话翻译官</span><span class="btns"><button class="ib" id="close" title="这一页不看了">×</button></span></div>
        <div class="score" id="score"></div>
        <div class="line" id="line"></div>
      </div>
    </div>
    <div class="body">
      <div class="vetos" id="vetos"></div>
      <div id="trs"></div>
      <h4 id="askH">替你问 HR <button class="chip" id="copy">复制</button></h4>
      <ol id="asks"></ol>
    </div>
    <div class="foot"><span>只认字面，会误判；拍板的是你</span><a id="opt">设置</a></div>
  </div>`;
  const $ = (id) => shadow.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let mounted = false;
  const mount = () => { if (!mounted && document.body) { document.body.appendChild(host); mounted = true; } };

  let last = null;
  let dismissedSig = null;

  function show(R, label) {
    const L = JDD.LEVELS[R.level];
    last = { R, line: L.lines[Math.abs(hash(R.items.map((x) => x.k).join())) % L.lines.length] };
    for (const id of ['stamp', 'miniStamp']) { const s = $(id); s.style.setProperty('--sc', L.color); s.textContent = L.name; }
    const st = $('stamp'); st.classList.remove('slam'); void st.offsetWidth; st.classList.add('slam');
    $('src').textContent = `${label} · 坑 ${R.items.filter((x) => x.w > 0).length} · 好信号 ${R.items.filter((x) => x.w < 0).length}`;
    $('score').innerHTML = `坑度 ${R.score}<small> / 100</small>`;
    $('line').textContent = last.line;
    $('vetos').innerHTML = R.vetos.map((v) => `<span class="veto">一票否决：${esc(v.k)}</span>`).join('');
    $('trs').innerHTML = R.items.length
      ? R.items.map((it) => `<div class="tr" data-k="${esc(it.k)}" style="--mk:${JDD.CATS[it.c].color}"><div class="q">原话 <b>${esc(it.quote)}</b>${it.n > 1 ? ` ×${it.n}` : ''}<span class="w">${it.w > 0 ? '+' : ''}${it.w}</span></div><div class="s">${esc(it.say)}</div></div>`).join('')
      : '<div class="empty">一句黑话都没翻出来。下面几个问题照样值得问。</div>';
    $('asks').innerHTML = R.asks.map((q) => `<li>${esc(q)}</li>`).join('');
    $('askH').hidden = !R.asks.length;
    mount();
    host.style.display = 'block';
    render();
  }
  function render() {
    $('card').hidden = collapsed;
    $('mini').hidden = !collapsed;
  }
  function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h; }

  $('top').addEventListener('click', (e) => { if (e.target.id === 'close') return; collapsed = true; render(); store.set({ 'jdd.collapsed': true }); });
  $('mini').addEventListener('click', () => { collapsed = false; render(); store.set({ 'jdd.collapsed': false }); });
  $('close').addEventListener('click', () => { host.style.display = 'none'; dismissedSig = currentSig; });
  $('copy').addEventListener('click', () => {
    if (!last) return;
    const msg = '您好，想先确认几个情况：\n' + last.R.asks.map((q, i) => `${i + 1}. ${q}`).join('\n') + '\n麻烦您了，谢谢！';
    navigator.clipboard.writeText(msg).then(() => { $('copy').textContent = '已复制'; setTimeout(() => ($('copy').textContent = '复制'), 1500); });
  });
  // 嵌进别的插件时（PRESET.embedded），没有自己的设置页，把链接藏掉
  if (JDD.PRESET && JDD.PRESET.embedded) $('opt').hidden = true;
  $('opt').addEventListener('click', () => { if (hasChrome) chrome.runtime.sendMessage({ type: 'jdd-open-options' }).catch(() => {}); });

  function focusItem(k) {
    collapsed = false; render();
    shadow.querySelectorAll('.tr').forEach((el) => el.classList.toggle('hot', el.dataset.k === k));
    const el = [...shadow.querySelectorAll('.tr')].find((x) => x.dataset.k === k);
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    setTimeout(() => shadow.querySelectorAll('.tr.hot').forEach((x) => x.classList.remove('hot')), 1500);
  }

  /* ===== 找 JD、高亮 ===== */
  let currentEl = null;
  let currentSig = null;

  function makeMark(m) {
    const mk = document.createElement('mark');
    mk.className = MARK;
    mk.dataset.c = m.c;
    mk.dataset.k = m.k;
    mk.title = m.say;
    return mk;
  }

  function scan() {
    if (!auto || !site) return;
    const el = JDD.findJD(document, site);
    if (!el) return;
    const map = JDD.textMap(el);
    const salary = JDD.findSalary(document, site);
    const sig = map.text.length + ':' + map.text.slice(0, 80) + '|' + salary;
    if (el === currentEl && sig === currentSig) return;
    if (currentEl && currentEl.isConnected) JDD.unhighlight(currentEl, MARK);
    currentEl = el; currentSig = sig;
    // 薪资拼在后面一起算分；高亮只管 JD 本身那一段
    const full = map.text + (salary ? '\n薪资：' + salary : '');
    const R = JDD.analyze(full, prefs);
    obs.disconnect();
    JDD.highlight(JDD.textMap(el), R.marks.filter((m) => m.j <= map.text.length), makeMark);
    watch();
    if (sig !== dismissedSig) show(R, site.name);
  }

  function clearAll() {
    if (currentEl && currentEl.isConnected) JDD.unhighlight(currentEl, MARK);
    currentEl = null; currentSig = null;
    host.style.display = 'none';
  }

  document.addEventListener('click', (e) => {
    const mk = e.target.closest && e.target.closest('mark.' + MARK);
    if (mk) focusItem(mk.dataset.k);
  }, true);

  let timer = null;
  const obs = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(scan, 500); });
  const watch = () => { if (document.body) obs.observe(document.body, { childList: true, subtree: true, characterData: true }); };

  /* ===== 右键「翻译选中的文字」 ===== */
  function showSelection(text) {
    const R = JDD.analyze(text, prefs);
    dismissedSig = null;
    collapsed = false;
    show(R, '选中的文字');
  }

  if (hasChrome && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'jdd-selection' && msg.text) showSelection(msg.text);
    });
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'sync') return;
      if (ch['jdd.prefs']) prefs = JDD.normalizePrefs(Object.assign({}, JDD.PRESET || {}, ch['jdd.prefs'].newValue || {}));
      if (ch['jdd.auto']) auto = ch['jdd.auto'].newValue !== false;
      if (ch['jdd.prefs'] || ch['jdd.auto']) { currentSig = null; if (auto) scan(); else clearAll(); }
    });
  }

  // 给测试页和调试用
  window.__jdd = { scan, showSelection, get prefs() { return prefs; } };

  store.get(['jdd.prefs', 'jdd.auto', 'jdd.collapsed']).then((v) => {
    prefs = JDD.normalizePrefs(Object.assign({}, JDD.PRESET || {}, v['jdd.prefs'] || {}));
    auto = v['jdd.auto'] !== false;
    if (typeof v['jdd.collapsed'] === 'boolean') collapsed = v['jdd.collapsed'];
    scan();
    watch();
  });
})();
