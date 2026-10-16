/**
 * 侧边栏导航（v1.1.0 重构，2026-10-16）：三个页签 待办 / 岗位 / 进度，加顶栏「工具」。
 * 「岗位」里再分「社招待审」「网申」两段；查公司页、工具页不在页签上，左上角「返回」回原来那页。
 * 老名字照收：queue / campus → 岗位页对应那段，today → 待办，records → 进度。
 */
const TAB_OF = { today: 'today', queue: 'jobs', campus: 'jobs', records: 'records' };
let lastPage = 'today';
let lastJobs = 'queue';
try { lastJobs = localStorage.getItem('jobsSeg') || 'queue'; } catch { /* 读不到就默认 */ }

export function showPanel(name) {
  if (name === 'jobs') name = lastJobs;
  const tab = TAB_OF[name] || '';
  if (tab) lastPage = name;
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
  document.getElementById('btn-tools')?.classList.toggle('on', name === 'tools');
  const panel = tab || name;
  document.querySelectorAll('.panel').forEach((x) => x.classList.toggle('active', x.id === `panel-${panel}`));
  if (tab === 'jobs') {
    lastJobs = name;
    try { localStorage.setItem('jobsSeg', name); } catch { /* 存不了就算了 */ }
    document.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.seg === name));
    document.querySelectorAll('.seg-panel').forEach((x) => x.classList.toggle('active', x.id === `panel-${name}`));
  }
  document.querySelector('main').scrollTop = 0;
}

export function goBack() { showPanel(lastPage); }

export function initNav() {
  document.querySelectorAll('.tab').forEach((t) => { t.onclick = () => showPanel(t.dataset.tab); });
  document.querySelectorAll('.seg button').forEach((b) => { b.onclick = () => showPanel(b.dataset.seg); });
  document.querySelectorAll('[data-back]').forEach((b) => { b.onclick = goBack; });
  const tools = document.getElementById('btn-tools');
  if (tools) tools.onclick = () => (tools.classList.contains('on') ? goBack() : showPanel('tools'));
  // 页面上带 data-go 的东西（待办页的数字卡、要你处理）点了就跳
  document.addEventListener('click', (e) => {
    const g = e.target.closest('[data-goto]');
    if (!g) return;
    e.preventDefault();
    showPanel(g.dataset.goto);
    if (g.dataset.scroll) document.getElementById(g.dataset.scroll)?.scrollIntoView({ block: 'start' });
  });
}
