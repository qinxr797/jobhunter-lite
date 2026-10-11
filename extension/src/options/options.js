import { getConfig, setConfig, setupMissing, DEFAULT_CRITERIA } from '../lib/store.js';
import { parseResumeText, testConnection } from '../lib/llm.js';
import { cityCodes } from '../lib/cities.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const splitList = (s) => (s || '').split(/[,，、]/).map((x) => x.trim()).filter(Boolean);
/** 数字框：空的、乱填的退回默认值，再夹到 [lo, hi] */
const num = (id, def, lo = 0, hi = Infinity) => {
  const v = Number($(id).value);
  return Math.min(hi, Math.max(lo, $(id).value === '' || !Number.isFinite(v) ? def : v));
};

let resume = null;
let variants = [];
let saved = null;   // 上次保存的配置，数字框乱填时退回它

$('ver').textContent = `v${chrome.runtime.getManifest().version}`;

// ---------------------------------------------------------------- 载入

async function load() {
  const c = await getConfig();
  saved = c;
  resume = c.resume;
  variants = c.variants || [];

  $('apiKey').value = c.apiKey || '';
  $('provider').value = c.provider || 'openai';
  $('apiBase').value = c.apiBase || '';
  $('model').value = c.model || '';
  $('effort').value = c.effort || 'medium';

  $('cities').value = (c.filter.cities || []).join(', ');
  $('bossCode').value = c.cityCode?.boss || '';
  $('job51Code').value = c.cityCode?.job51 || '';

  $('rawText').value = c.resume.rawText || '';
  fillBasics();
  $('criteria').value = c.criteria || DEFAULT_CRITERIA;

  $('salaryMin').value = c.filter.salaryMin;
  $('salaryFloorMin').value = c.filter.salaryFloorMin || 0;
  $('salaryMax').value = c.filter.salaryMax;
  $('maxYearsRequired').value = c.filter.maxYearsRequired;
  $('includeKeywords').value = c.filter.includeKeywords.join(', ');
  $('excludeKeywords').value = c.filter.excludeKeywords.join(', ');
  $('skipChatted').checked = c.filter.skipChatted;

  $('askMe').value = c.thresholds.askMe;

  $('dailyLimit').value = c.pace.dailyLimit;
  $('minDelay').value = Math.round(c.pace.minDelayMs / 1000);
  $('maxDelay').value = Math.round(c.pace.maxDelayMs / 1000);
  $('batchSize').value = c.pace.batchSize;
  $('longRest').value = Math.round(c.pace.longRestMs / 60000);
  $('stopOnCaptcha').checked = c.pace.stopOnCaptcha;

  $('maxChars').value = c.greeting.maxChars;
  $('tone').value = c.greeting.tone;
  $('mustInclude').value = c.greeting.mustInclude.join(', ');
  $('forbid').value = c.greeting.forbid.join(', ');

  $('afResume').value = c.autofill?.files?.dir || '';
  $('afPhoto').value = c.autofill?.files?.photo || '';
  $('afApiBase').value = c.models?.autofill?.apiBase || '';
  $('afModel').value = c.models?.autofill?.model || '';
  $('afApiKey').value = c.models?.autofill?.apiKey || '';

  renderResume();
  renderVariants();
  renderCity();
  renderChecklist();
}

// ---------------------------------------------------------------- 第一次用的清单 / 城市代码

/** 按表单上当前填的（还没保存也算）列出还缺什么 */
function renderChecklist() {
  const form = { apiKey: $('apiKey').value.trim(), filter: { cities: splitList($('cities').value) }, resume: { name: readBasics().name } };
  const miss = setupMissing(form);
  const steps = [['apiKey', '① 填 Key'], ['city', '② 填城市'], ['resume', '③ 解析简历']];
  $('checklist').innerHTML = steps.map(([k, t]) => {
    const ok = !miss.some((m) => m.key === k);
    return `<span class="${ok ? 'ok' : ''}">${ok ? '✓' : '○'} ${t}</span>`;
  }).join('') + (miss.length ? '' : '<span class="done">都填好了，保存后去侧边栏点「开始」</span>');
}

function renderCity() {
  const cfg = { filter: { cities: splitList($('cities').value) }, cityCode: { boss: $('bossCode').value.trim(), job51: $('job51Code').value.trim() } };
  const cc = cityCodes(cfg);
  const st = $('city-status');
  if (!cc.name) { st.textContent = '没填城市的话，搜索页按你在 BOSS / 51job 账号上的默认城市搜，筛选也不限城市。'; st.className = 'hint'; return; }
  const miss = [!cc.boss && 'BOSS', !cc.job51 && '51job'].filter(Boolean);
  st.textContent = miss.length
    ? `「${cc.name}」在 ${miss.join('、')} 的城市表里没查到，在下面手填代码（不填就按账号默认城市搜）`
    : `「${cc.name}」已对上：BOSS ${cc.boss}，51job ${cc.job51}`;
  st.className = miss.length ? 'hint err' : 'hint ok';
  if (miss.length) document.querySelector('#sec-city details').open = true;
}
for (const id of ['cities', 'bossCode', 'job51Code']) $(id).addEventListener('input', () => { renderCity(); renderChecklist(); });
$('apiKey').addEventListener('input', renderChecklist);

// ---------------------------------------------------------------- 简历

const BASIC_KEYS = [...document.querySelectorAll('[data-r]')].map((el) => el.dataset.r);

function fillBasics() {
  for (const el of document.querySelectorAll('[data-r]')) el.value = resume?.[el.dataset.r] ?? '';
}
function readBasics() {
  const out = {};
  for (const el of document.querySelectorAll('[data-r]')) out[el.dataset.r] = el.type === 'number' ? (Number(el.value) || 0) : el.value.trim();
  return out;
}
document.querySelectorAll('[data-r]').forEach((el) => el.addEventListener('input', renderChecklist));

function renderResume() {
  const box = $('resume-preview');
  if (!resume?.skills?.length && !resume?.experiences?.length && !resume?.projects?.length) {
    box.classList.remove('show');
    return;
  }
  box.classList.add('show');
  box.innerHTML = [
    resume.summary ? `<h4>个人概述</h4><p>${esc(resume.summary)}</p>` : '',
    resume.skills?.length ? `<h4>技能</h4><p>${resume.skills.map(esc).join(' · ')}</p>` : '',
    resume.experiences?.length
      ? '<h4>工作 / 实习经历</h4>' + resume.experiences.map((e) =>
          `<p><strong>${esc(e.company)}</strong> ｜ ${esc(e.role)} ｜ ${esc(e.period)}</p>` +
          `<ul>${(e.bullets || []).map((b) => `<li>${esc(b)}</li>`).join('')}</ul>`).join('')
      : '',
    resume.projects?.length
      ? '<h4>项目 / 校园经历</h4>' + resume.projects.map((p) =>
          `<p><strong>${esc(p.name)}</strong> ｜ ${esc(p.role)} ｜ ${esc(p.period)}</p>` +
          `<ul>${(p.bullets || []).map((b) => `<li>${esc(b)}</li>`).join('')}</ul>`).join('')
      : '',
    '<p class="hint">经历要改的话：「导出 JSON」改完再「导入 JSON」，或者改简历原文重新解析。</p>',
  ].join('');
}

$('parse-resume').onclick = async () => {
  const raw = $('rawText').value.trim();
  const st = $('resume-status');
  if (!raw) { st.textContent = '先粘贴简历全文'; st.className = 'hint err'; return; }
  if (!$('apiKey').value.trim()) { st.textContent = '先在 ① 填 API Key'; st.className = 'hint err'; return; }

  st.textContent = '解析中，大概 20-40 秒…';
  st.className = 'hint';
  $('parse-resume').disabled = true;
  try {
    // 手填过的作品集网址、期望薪资，简历里没写的话别被清掉
    const keep = readBasics();
    resume = await parseResumeText(raw, apiForm());
    for (const k of ['site', 'salary']) if (!resume[k] && keep[k]) resume[k] = keep[k];
    fillBasics();
    renderResume();
    renderChecklist();
    st.textContent = '解析完成 —— 检查一下格子里有没有读错，然后点最下面的「保存全部设置」';
    st.className = 'hint ok';
  } catch (e) {
    st.textContent = `失败：${e.message}`;
    st.className = 'hint err';
  }
  $('parse-resume').disabled = false;
};

$('import-json').onclick = () => $('file-json').click();
$('file-json').onchange = async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const st = $('resume-status');
  try {
    const parsed = JSON.parse(await file.text());
    // 两种都收：单独一份简历，或者一整套配置（带 filter/thresholds/pace 那种）
    const isBundle = parsed.resume || parsed.filter || parsed.thresholds || parsed.pace;
    if (isBundle) {
      await setConfig({ ...parsed, apiKey: parsed.apiKey || $('apiKey').value.trim() });
      await load();
      st.textContent = '整套配置已导入并保存 —— 往下翻检查一遍';
    } else {
      resume = { ...resume, ...parsed };
      if (resume.rawText) $('rawText').value = resume.rawText;
      fillBasics();
      renderResume();
      renderChecklist();
      st.textContent = '简历已导入，记得点最下面的「保存全部设置」';
    }
    st.className = 'hint ok';
  } catch (err) {
    st.textContent = `导入失败：${err.message}`;
    st.className = 'hint err';
  }
  e.target.value = '';
};

$('export-json').onclick = () => {
  const blob = new Blob([JSON.stringify({ ...resume, ...readBasics() }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'resume.json';
  a.click();
};

// ---------------------------------------------------------------- 简历变体

function renderVariants() {
  $('variants').innerHTML = variants.map((v, i) => `
    <div class="variant">
      <div class="row">
        <label>标签<input data-v="${i}" data-f="label" value="${esc(v.label)}" placeholder="偏新媒体" /></label>
        <label>适用关键词（逗号分隔）<input data-v="${i}" data-f="keywords" value="${esc((v.keywords || []).join(', '))}" placeholder="新媒体, 内容, 短视频" /></label>
      </div>
      <div class="row">
        <label>备注（BOSS 上的附件名，方便你对上号）<input data-v="${i}" data-f="note" value="${esc(v.note || '')}" placeholder="张三-新媒体运营.pdf" /></label>
        <button data-del="${i}" class="danger">删除</button>
      </div>
    </div>`).join('');

  $('variants').querySelectorAll('input[data-v]').forEach((inp) => {
    inp.oninput = () => {
      const i = +inp.dataset.v;
      const f = inp.dataset.f;
      variants[i][f] = f === 'keywords' ? splitList(inp.value) : inp.value;
    };
  });
  $('variants').querySelectorAll('button[data-del]').forEach((b) => {
    b.onclick = () => { variants.splice(+b.dataset.del, 1); renderVariants(); };
  });
}

$('add-variant').onclick = () => {
  variants.push({ id: `v${Date.now().toString(36)}`, label: '', keywords: [], note: '' });
  renderVariants();
};

// ---------------------------------------------------------------- 测试连接

/** 表单上当前填的接口设置（还没保存也能用来测试 / 解析简历） */
function apiForm() {
  return {
    provider: $('provider').value,
    apiBase: $('apiBase').value.trim() || ($('provider').value === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.deepseek.com'),
    apiKey: $('apiKey').value.trim(),
    model: $('model').value.trim() || ($('provider').value === 'anthropic' ? 'claude-sonnet-5' : 'deepseek-flash'),
    effort: $('effort').value,
  };
}

// 换服务商时把地址和模型换成对应的默认值
$('provider').onchange = () => {
  if ($('provider').value === 'anthropic') {
    if (/deepseek/.test($('apiBase').value) || !$('apiBase').value) $('apiBase').value = 'https://api.anthropic.com';
    if (!/^claude/.test($('model').value)) $('model').value = 'claude-sonnet-5';
  } else {
    if (/anthropic/.test($('apiBase').value) || !$('apiBase').value) $('apiBase').value = 'https://api.deepseek.com';
    if (/^claude/.test($('model').value) || !$('model').value) $('model').value = 'deepseek-flash';
  }
};

$('reset-criteria').onclick = () => {
  if ($('criteria').value.trim() && $('criteria').value !== DEFAULT_CRITERIA && !confirm('改过的标准会被模板覆盖，确定？')) return;
  $('criteria').value = DEFAULT_CRITERIA;
};

/** 接口域名不在 manifest 里的，要在点击的手势里先要权限（不能先 await 别的） */
function askHostPermission(base) {
  try {
    const u = new URL(/^https?:\/\//i.test(base) ? base : `https://${base}`);
    if (/(^|\.)deepseek\.com$|(^|\.)anthropic\.com$/.test(u.hostname)) return Promise.resolve(true);
    return chrome.permissions.request({ origins: [`${u.origin}/*`] });
  } catch { return Promise.resolve(true); }
}

$('test-api').onclick = async () => {
  const st = $('api-status');
  const f = apiForm();
  if (!f.apiKey) { st.textContent = '先填 Key'; st.className = 'hint err'; return; }
  const granted = await askHostPermission(f.apiBase);
  if (!granted) { st.textContent = '没给这个接口地址的访问权限，连不上'; st.className = 'hint err'; return; }
  st.textContent = '测试中…'; st.className = 'hint';
  try {
    const t0 = Date.now();
    await testConnection(f);
    st.textContent = `连接正常（${f.model}，${((Date.now() - t0) / 1000).toFixed(1)} 秒）`;
    st.className = 'hint ok';
  } catch (e) {
    st.textContent = `失败：${/401|403|Authentication|invalid/i.test(e.message) ? 'Key 不对，检查有没有复制全' : /402|Insufficient/i.test(e.message) ? '余额不足，去 DeepSeek 充值' : e.message}`;
    st.className = 'hint err';
  }
};

const afForm = () => ({ provider: 'openai', apiBase: $('afApiBase').value.trim(), model: $('afModel').value.trim(), apiKey: $('afApiKey').value.trim() });

$('test-af').onclick = async () => {
  const st = $('af-status');
  const f = afForm();
  const cfg = f.apiKey ? { ...f, apiBase: f.apiBase || 'https://api.deepseek.com', model: f.model || 'deepseek-flash' } : apiForm();
  st.textContent = '测试中…'; st.className = 'hint';
  try {
    const t0 = Date.now();
    await testConnection(cfg);
    st.textContent = `连接正常（${cfg.model}，${((Date.now() - t0) / 1000).toFixed(1)} 秒）`;
    st.className = 'hint ok';
  } catch (e) { st.textContent = `失败：${e.message}`; st.className = 'hint err'; }
};

// ---------------------------------------------------------------- 保存

$('save').onclick = async () => {
  const st = $('save-status');
  const permission = askHostPermission(apiForm().apiBase);   // 必须在手势里先发起
  const minD = num('minDelay', saved.pace.minDelayMs / 1000, 10);
  const maxD = num('maxDelay', saved.pace.maxDelayMs / 1000, 10);
  if (minD > maxD) {
    st.textContent = '间隔下限不能大于上限';
    st.className = 'hint err';
    return;
  }
  await permission.catch(() => false);

  await setConfig({
    ...apiForm(),
    models: { autofill: afForm() },
    cityCode: { boss: $('bossCode').value.trim(), job51: $('job51Code').value.trim() },
    criteria: $('criteria').value.trim() || DEFAULT_CRITERIA,
    resume: { ...resume, ...readBasics(), rawText: $('rawText').value },
    variants: variants.filter((v) => v.label),
    filter: {
      salaryMin: num('salaryMin', 0),
      salaryFloorMin: num('salaryFloorMin', 0),
      salaryMax: num('salaryMax', 0),
      maxYearsRequired: num('maxYearsRequired', 0),
      cities: splitList($('cities').value),
      includeKeywords: splitList($('includeKeywords').value),
      excludeKeywords: splitList($('excludeKeywords').value),
      skipChatted: $('skipChatted').checked,
    },
    thresholds: { askMe: num('askMe', saved.thresholds.askMe, 0, 100) },
    pace: {
      dailyLimit: num('dailyLimit', saved.pace.dailyLimit, 1, 100),
      minDelayMs: minD * 1000,
      maxDelayMs: maxD * 1000,
      batchSize: num('batchSize', saved.pace.batchSize, 1),
      longRestMs: num('longRest', saved.pace.longRestMs / 60000, 1) * 60000,
      stopOnCaptcha: $('stopOnCaptcha').checked,
    },
    greeting: {
      maxChars: num('maxChars', saved.greeting.maxChars, 30, 500),
      tone: $('tone').value,
      mustInclude: splitList($('mustInclude').value),
      forbid: splitList($('forbid').value),
    },
    autofill: { files: { dir: $('afResume').value.trim().replace(/^"|"$/g, ''), photo: $('afPhoto').value.trim().replace(/^"|"$/g, '') } },
  });
  await load();

  const miss = setupMissing(saved);
  st.textContent = miss.length ? `已保存。还差：${miss.map((m) => m.text).join('、')}` : '已保存，可以去侧边栏点「开始」了';
  st.className = miss.length ? 'hint err' : 'hint ok';
  setTimeout(() => (st.textContent = ''), 6000);
};

load();
