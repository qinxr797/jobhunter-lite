/**
 * 网申表单自动填 —— 页面这一半（v0.7.0 模块 B）。
 *
 * 不常驻：你在侧边栏点「填这一页」时，用 chrome.scripting.executeScript 往当前标签的所有帧注入（北森等系统表单在 iframe 里）。
 * 这里只做本地的事：扫字段、填值、点下拉选项、上色、回读核对。认字段和出值在侧边栏（模型走你自己的 DeepSeek）。
 *
 * 思路参考求职方舟插件（本地扫字段 → 模型认字段出值 → 本地填 → 下拉让模型挑），代码是自己写的。区别：
 *   - 发给模型的是本地压好的字段清单，不是整页 HTML
 *   - 填文本框用原生 setter + input/change/blur 事件（React 受控组件直接写 .value 会被覆盖，这是他家漏填的来路之一）
 *   - 每个字段填完回读，对不上的标红
 *   - 永远不点「提交 / 投递 / 下一步」，识别到就描红写「你自己点」
 */
(() => {
  if (window.__jfzAutofill) return;
  window.__jfzAutofill = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const clean = (s) => norm(s).replace(/^[*＊\s]+|[*＊:：\s]+$/g, '').replace(/^[*＊]/, '').replace(/^\d{1,3}\s*[.、．)）]\s*/, '').replace(/[*＊:：\s]+$/, '').trim();

  // ---------------------------------------------------------------- 可见性 / 基础
  function visible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false;
    // 祖先 display:none 时 rect 为 0，上面已经挡住
    return true;
  }
  const textOf = (el) => norm(el?.innerText ?? el?.textContent ?? '');

  // 提交类按钮：永远不点，描红
  const SUBMIT_RE = /^(提交|投递|确认投递|提交申请|申请职位|立即投递|投递简历|保存并投递|保存并提交|下一步|提交简历|确认提交|完成|申请|立即申请)$/;
  const SKIP_BTN_RE = /^(提交|投递|保存|确定|确认|取消|上一步|下一步|删除|添加|新增|上传|重置|搜索|查找|登录|注册)/;
  const SECTION_RE = /(基本信息|个人信息|基础信息|联系方式|求职意向|意向信息|教育经历|教育背景|学历信息|实习经历|工作经历|工作经验|实践经历|项目经历|项目经验|校园经历|在校经历|社团经历|学生干部|获奖情况|获奖经历|奖励|荣誉|证书|资格证书|技能|专业技能|语言能力|外语|家庭成员|家庭信息|自我评价|个人评价|个人优势|个人简介|附加信息|其他信息|补充信息|附件|作品|论文|问答|问题|附加题|附加问题|开放题|其他)/;

  // ---------------------------------------------------------------- 找字段
  const FAKE_SELECT = '.ant-select, .el-select, .el-cascader, .ant-cascader, .ant-picker, .el-date-editor, .ivu-select, .ivu-date-picker, .n-select, .arco-select, .t-select, [class*="Select-container"], [role="combobox"]:not(input)';

  function isFakeSelectText(el) {
    // 「请选择」开头、class 里带 select 的自制下拉
    const cls = String(el.className || '');
    return /select|picker|dropdown/i.test(cls) && /^请选择/.test(textOf(el)) && el.children.length <= 4;
  }

  let seq = 0;
  const refOf = (el) => el.dataset.jfzRef || (el.dataset.jfzRef = `f${++seq}`);
  const byRef = (ref) => document.querySelector(`[data-jfz-ref="${CSS.escape(ref)}"]`);

  function inHeaderSearch(el) {
    const ph = el.getAttribute('placeholder') || '';
    if (window === top && el.getBoundingClientRect().top + scrollY < 90) return true;
    if (/职位关键字|搜索职位|关键词/.test(ph)) return true;
    if (/搜索|查找|search/i.test(ph)) return true;
    if (el.closest('header, nav, [role="search"], [class*="header"] [class*="search"]')) return true;
    return false;
  }

  // 页面上开着弹窗（BOSS 附加信息 / 问卷、添加经历的抽屉）时只扫弹窗里面，别碰后面的聊天输入框
  let ROOT = document;
  function activeDialog() {
    const ds = [...document.querySelectorAll('[role="dialog"], [class*="dialog"], [class*="modal"], [class*="drawer"], [class*="popup"]')]
      .filter((d) => visible(d) && d.querySelector('input:not([type=hidden]), textarea, select') && d.getBoundingClientRect().width > 250);
    // 最里层、面积最大的那个
    return ds.sort((a, b) => (b.getBoundingClientRect().width * b.getBoundingClientRect().height) - (a.getBoundingClientRect().width * a.getBoundingClientRect().height))
      .find((d) => !ds.some((o) => o !== d && d.contains(o) && o.querySelector('input,textarea,select'))) || null;
  }

  function collectCandidates() {
    const out = [];
    const taken = new Set();
    // 1. 组件库假下拉 / 日期框（整块当一个字段，里面的 input 不再单独算）
    for (const w of ROOT.querySelectorAll(FAKE_SELECT)) {
      if (!visible(w)) continue;
      if (w.parentElement?.closest(FAKE_SELECT)) continue;           // 嵌套的只要最外层
      const cls = String(w.className || '');
      const isDate = /picker|date/i.test(cls) && !/select/i.test(cls);
      const isCascader = /cascader/i.test(cls);
      out.push({ el: w, kind: isDate ? 'date' : isCascader ? 'cascader' : 'fake-select' });
      w.querySelectorAll('input, textarea').forEach((i) => taken.add(i));
    }
    for (const w of ROOT.querySelectorAll('div, span')) {
      if (taken.has(w) || w.closest(FAKE_SELECT) || !isFakeSelectText(w) || !visible(w)) continue;
      if ([...out].some((o) => o.el.contains(w) || w.contains(o.el))) continue;
      out.push({ el: w, kind: 'fake-select' });
    }
    // 2. 原生控件
    const radioGroups = new Map();
    for (const el of ROOT.querySelectorAll('input, textarea, select, [contenteditable="true"]')) {
      if (taken.has(el) || el.disabled) continue;
      const type = (el.getAttribute('type') || (el.tagName === 'TEXTAREA' ? 'textarea' : el.tagName === 'SELECT' ? 'select' : el.isContentEditable ? 'textarea' : 'text')).toLowerCase();
      if (['hidden', 'submit', 'button', 'reset', 'image', 'password', 'search', 'range', 'color'].includes(type)) continue;
      if (type === 'file') { out.push({ el, kind: 'file' }); continue; }   // 文件框经常是隐藏的，照样算
      if (type === 'radio' || type === 'checkbox') {
        const host = el.closest('label') || el.parentElement;
        if (!visible(host) && !visible(el)) continue;
        const key = el.name ? `n:${el.name}` : groupBox(el);
        if (!radioGroups.has(key)) radioGroups.set(key, { kind: type, inputs: [] });
        radioGroups.get(key).inputs.push(el);
        continue;
      }
      if (!visible(el) || inHeaderSearch(el)) continue;
      const kind = el.tagName === 'SELECT' ? 'select' : type === 'textarea' ? 'textarea' : /date|month/.test(type) ? 'date' : 'text';
      out.push({ el, kind });
    }
    // 组件库的单选组（.ant-radio-group / .el-radio-group）
    for (const g of ROOT.querySelectorAll('.ant-radio-group, .el-radio-group, .ant-checkbox-group, .el-checkbox-group, [role="radiogroup"]')) {
      if (!visible(g)) continue;
      const inputs = [...g.querySelectorAll('input[type=radio], input[type=checkbox]')];
      const key = `g:${refOf(g)}`;
      for (const [k, v] of radioGroups) if (v.inputs.some((i) => g.contains(i))) radioGroups.delete(k);
      radioGroups.set(key, { kind: /checkbox/.test(g.className) ? 'checkbox' : 'radio', inputs, box: g, roleOnly: !inputs.length });
    }
    for (const [, g] of radioGroups) {
      const box = g.box || commonBox(g.inputs);
      out.push({ el: box, kind: g.kind, inputs: g.inputs });
    }
    return out;
  }

  function groupBox(el) {
    const box = el.closest('[class*="radio-group"], [class*="checkbox-group"], [role="radiogroup"], .form-item, [class*="form-item"], [class*="FormItem"]') || el.parentElement?.parentElement;
    return `b:${refOf(box)}`;
  }
  function commonBox(inputs) {
    let a = inputs[0].closest('label')?.parentElement || inputs[0].parentElement;
    while (a && !inputs.every((i) => a.contains(i))) a = a.parentElement;
    return a || inputs[0].parentElement;
  }

  // ---------------------------------------------------------------- 认标签
  const ITEM_SEL = '.ant-form-item, .el-form-item, .ivu-form-item, .arco-form-item, .t-form__item, .n-form-item, .form-item, .form-group, [class*="form-item"], [class*="formItem"], [class*="FormItem"], [class*="field-item"], [class*="question"], .field, tr';
  const LABEL_SEL = '.ant-form-item-label, .el-form-item__label, .ivu-form-item-label, .arco-form-item-label, .t-form__label, .n-form-item-label, label, [class*="label"], [class*="title"], th, legend, .field-label';

  function labelOf(el, kind) {
    // 1. <label for>
    const id = el.id || el.querySelector?.('input,textarea,select')?.id;
    if (id) {
      const l = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (l && textOf(l) && textOf(l).length < 40) return { label: clean(textOf(l)), star: /[*＊]/.test(textOf(l)) || requiredCls(l) };
    }
    // 2. aria
    // 只认元素自己的 aria-label，不认里面图标的（antd 的 calendar / down 图标带 aria-label）
    const aria = el.getAttribute('aria-label');
    if (aria && !/^(请|select|search|calendar|down|close|clock|up|arrow)/i.test(aria)) return { label: clean(aria), star: false };
    const lb = el.getAttribute('aria-labelledby');
    if (lb) { const t = lb.split(/\s+/).map((i) => textOf(document.getElementById(i))).join(' '); if (t) return { label: clean(t), star: /[*＊]/.test(t) }; }
    // 3. 表单项容器里的标签
    // 一层层往上找（antd 的 textarea 外面包了好几层，最近的 [class*=form-item] 是 control-input，里面没标签）
    let item = el.closest(ITEM_SEL);
    for (let hop = 0; item && hop < 6; hop++, item = item.parentElement?.closest(ITEM_SEL)) {
      // 包了别的输入框的那层已经是一整块表单了，会拿到别人的标签（9/28 真 Moka 就是这样全认成「意向工作城市」）
      if (controlsIn(item) > 1) break;
      for (const l of item.querySelectorAll(LABEL_SEL)) {
        if (l.contains(el) || el.contains(l)) continue;
        if (l.querySelector('input, textarea, select')) continue;
        if ((kind === 'radio' || kind === 'checkbox') && l.closest('[class*="radio"], [class*="checkbox"]')) continue;
        const t = textOf(l);
        if (t && t.length <= 40) return { label: clean(t), star: /[*＊]/.test(t) || requiredCls(item) || requiredCls(l) };
      }
      if (item.tagName === 'TR') {
        const th = item.querySelector('th, td');
        if (th && !th.contains(el) && textOf(th).length <= 40) return { label: clean(textOf(th)), star: /[*＊]/.test(textOf(th)) };
      }
    }
    // 4. 同一行左边 / 上面最近的一段短中文
    const near = nearestText(el);
    if (near) return { label: clean(near), star: /[*＊]/.test(near) };
    // 5. placeholder
    const ph = el.getAttribute('placeholder') || el.querySelector?.('[placeholder]')?.getAttribute('placeholder') || textOf(el.querySelector?.('.ant-select-selection-placeholder, .el-select__placeholder'));
    if (ph) return { label: clean(ph.replace(/^(请输入|请选择|请填写|输入|选择)/, '')), star: false, fromPh: true };
    return { label: '', star: false };
  }
  const requiredCls = (el) => /required|is-required|ant-form-item-required/.test(String(el?.className || '')) || !!el?.querySelector?.('.ant-form-item-required, .is-required, [class*="required"]');

  function nearestText(el) {
    let node = el;
    for (let depth = 0; depth < 6 && node; depth++) {
      let sib = node.previousElementSibling;
      for (let k = 0; k < 3 && sib; k++, sib = sib.previousElementSibling) {
        if (sib.querySelector?.('input,textarea,select') ) break;
        const t = textOf(sib);
        if (t && t.length <= 30 && /[一-龥A-Za-z]/.test(t)) return t;
      }
      node = node.parentElement;
      if (node && node.querySelectorAll('input,textarea,select').length > 3) break;
    }
    return '';
  }

  /** 数一个容器里有几个输入控件：组件库下拉整块算一个 */
  function controlsIn(box) {
    let n = box.querySelectorAll(FAKE_SELECT).length;
    for (const i of box.querySelectorAll('input:not([type=hidden]):not([type=radio]):not([type=checkbox]), textarea, select')) if (!i.closest(FAKE_SELECT)) n++;
    n += box.querySelectorAll('[class*="radio-group"], [class*="checkbox-group"], [role="radiogroup"]').length;
    return n;
  }

  /** 往上找这个框所属的题目名（前一个兄弟是不含输入框的短文字），不管中间包了几个框 */
  function titleAbove(el) {
    let node = el;
    for (let d = 0; node && d < 8; d++, node = node.parentElement) {
      const sib = node.previousElementSibling;
      if (sib && !sib.querySelector('input,textarea,select')) {
        const t = textOf(sib);
        if (t && t.length <= 20 && /[\u4e00-\u9fa5]/.test(t)) return { text: t, star: /[*＊]/.test(t) || requiredCls(sib) || !!sib.querySelector('[class*="required"]'), box: node };
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- 分块 + 序号
  // 表单项自己的标签（「是否有项目经历」）不能当分块标题
  const LABELISH = 'label, .ant-form-item-label, .el-form-item__label, .ivu-form-item-label, .arco-form-item-label, .t-form__label, [class*="item-label"], [class*="item__label"], [class*="field-label"], .topichtml, th';
  function isHeading(node) {
    if (!node || node.querySelector('input,textarea,select')) return null;
    if (node.matches(LABELISH) || node.closest(LABELISH) || node.querySelector(LABELISH)) return null;
    const t = textOf(node);
    if (!t || t.length > 24 || !SECTION_RE.test(t) || /^是否|[?？]$/.test(t)) return null;
    return { text: t, el: node };
  }
  function headingIn(el) {
    // 先看容器自己开头的标题（「教育经历」块），再往前找兄弟（平铺的表单：标题和表单项是兄弟，要一直往前找到最近的标题）
    const first = el.firstElementChild;
    const h0 = first && isHeading(first);
    if (h0) return h0;
    let sib = el.previousElementSibling;
    for (let k = 0; k < 60 && sib; k++, sib = sib.previousElementSibling) {
      const h = isHeading(sib);
      if (h) return h;
    }
    return null;
  }

  function sectionOf(el) {
    let node = el;
    let prev = el;
    for (let depth = 0; node && depth < 14; depth++) {
      const h = headingIn(node);
      if (h) {
        // 标题自带编号（「实习经历 2」「经历二」）：名字去掉编号，编号当序号
        const raw = h.text.replace(/[*＊]/g, '').replace(/\s*(添加|新增|\+).*$/, '').trim();
        const m = /^(.*?)\s*[（(第]?\s*([0-9一二三四五六七八九十]{1,2})\s*[)）段条]?$/.exec(raw);
        const cn = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
        if (m && SECTION_RE.test(m[1])) return { name: m[1].trim().slice(0, 16), root: node, child: prev, head: h.el, explicit: Number(m[2]) || cn[m[2]] || 0 };
        return { name: raw.slice(0, 16), root: node, child: prev, head: h.el };
      }
      prev = node;
      node = node.parentElement;
    }
    return { name: '', root: null };
  }

  /** 同一分块里第几组：往上找「父节点下有 ≥2 个结构相同、都含输入框的兄弟」那一层 */
  function groupIndex(el, root, head) {
    // 标题里自带编号（「实习经历 2」「经历二」）
    let node = el;
    for (let depth = 0; node && depth < 16; depth++) {
      const p = node.parentElement;
      if (!p) break;
      const atRoot = node === root;
      // 结构相同的兄弟各自都要有 ≥2 个控件，才算同一分块的第几组（两栏布局里并排的表单项不算）
      let sibs = [...p.children].filter((c) => c.tagName === node.tagName && sig(c) === sig(node) && controlsIn(c) >= 3);
      // 分块标题和这些组是兄弟时（平铺的表单），只数这个标题到下一个标题之间的，别把别的分块算成「第几组」
      if (atRoot && head && head.parentElement === p) {
        const kids = [...p.children];
        const a = kids.indexOf(head);
        let b = kids.findIndex((k, i) => i > a && isHeading(k));
        if (b < 0) b = kids.length;
        sibs = sibs.filter((c) => { const i = kids.indexOf(c); return i > a && i < b; });
      }
      if (sibs.length >= 2 && controlsIn(node) >= 3) {
        const h = [...node.querySelectorAll('*')].slice(0, 8).map(textOf).find((t) => /[（(]?\s*[0-9一二三四五六七八九十]+\s*[)）]?/.test(t) && t.length < 16);
        return { index: sibs.indexOf(node) + 1, total: sibs.length, box: node, hint: h || '' };
      }
      if (atRoot) break;
      node = p;
    }
    return { index: 1, total: 1, box: null };
  }
  const sig = (e) => String(e.className || '').split(/\s+/).filter((c) => !/active|focus|hover|error|is-|--/.test(c)).sort().join('.');

  // ---------------------------------------------------------------- 读当前值 / 选项
  function valueOf(f) {
    const el = f.el;
    if (f.kind === 'radio' || f.kind === 'checkbox') {
      const on = (f.inputs || []).filter((i) => i.checked).map((i) => optText(i));
      if (on.length) return on.join('、');
      const act = el.querySelector('.ant-radio-wrapper-checked, .is-checked, [aria-checked="true"]');
      return act ? textOf(act) : '';
    }
    if (f.kind === 'fake-select' || f.kind === 'cascader' || (f.kind === 'date' && !/^(INPUT|TEXTAREA)$/.test(el.tagName))) {
      const inp = el.querySelector('input');
      const sel = el.querySelector('[class*="Input-display-value"] > *:not(:empty), .ant-select-selection-item, .ant-select-selection-overflow-item .ant-select-selection-item-content, .el-select__tags-text, .el-select__selected-item:not(.is-transparent), .ivu-select-selected-value');
      if (sel) return textOf(sel);
      if (inp && inp.value) return inp.value;
      const t = textOf(el).replace(/必填项?未填写|此项必填|请选择|请输入|不能为空/g, '').trim();
      return t;
    }
    if (el.tagName === 'SELECT') return el.selectedIndex > 0 || (el.value && el.options[el.selectedIndex]?.value) ? textOf(el.options[el.selectedIndex]) : '';
    if (el.isContentEditable) return textOf(el);
    return el.value || '';
  }
  function optText(i) {
    const l = i.closest('label') || (i.id && document.querySelector(`label[for="${CSS.escape(i.id)}"]`));
    if (l && textOf(l)) return norm(textOf(l));
    let box = i.parentElement;
    for (let k = 0; k < 4 && box; k++, box = box.parentElement) {
      if (box.querySelectorAll('input[type=radio], input[type=checkbox]').length > 1) break;
      const t = textOf(box);
      if (t) return norm(t);
    }
    return norm(i.value);
  }
  function optionsOf(f) {
    if (f.el.tagName === 'SELECT') return [...f.el.options].map((o) => textOf(o)).filter((t) => t && !/^请选择/.test(t));
    if (f.kind === 'radio' || f.kind === 'checkbox') {
      if (f.inputs?.length) return f.inputs.map(optText);
      return [...f.el.querySelectorAll('[role="radio"], [role="checkbox"], .ant-radio-wrapper, .el-radio')].map(textOf);
    }
    return null;
  }

  // ---------------------------------------------------------------- 扫描
  let lastScan = [];
  function scan() {
    ROOT = activeDialog() || document;
    const cands = collectCandidates();
    const fields = [];
    for (const c of cands) {
      const ref = refOf(c.el);
      const lb = labelOf(c.el, c.kind);
      const sec = sectionOf(c.el);
      if (!sec.name) {
        const q = c.el.closest('.field, [class*="question"], [class*="topic"], fieldset');
        if (q && controlsIn(q) >= 2) {
          const t = textOf(q.querySelector('[class*="field-label"], .topichtml, [class*="title"], legend'));
          // 一道题里的几个框就是一组（问卷星的「实习经历」题），不跟别的题比「第几组」
          if (t && t.length <= 40) { sec.name = clean(t).slice(0, 16); sec.compound = true; }
        }
      }
      let gi = sec.root ? groupIndex(c.el, sec.root, sec.head) : { index: 1, total: 1 };
      if (sec.explicit) gi = { index: sec.explicit, total: Math.max(sec.explicit, gi.total) };
      const el = c.el;
      const inner = el.matches('input,textarea,select') ? el : el.querySelector('input,textarea');
      if ((lb.fromPh && lb.label.length <= 2) || /^(年|月|日|至|到|-|—|开始|结束)?$/.test(lb.label)) {
        const t = titleAbove(c.el);
        if (t) {
          const all = [...t.box.querySelectorAll('input:not([type=hidden]), textarea, select')];
          const i = all.indexOf(c.el.matches('input,textarea,select') ? c.el : c.el.querySelector('input,textarea,select'));
          const half = all.length === 4 && i >= 0 ? (i < 2 ? '开始' : '结束') : all.length === 2 && !/年|月|日/.test(lb.label) ? (i === 0 ? '开始' : '结束') : '';
          // 四个框的「开始年 / 开始月 / 结束年 / 结束月」：选了值以后 placeholder 就没了，按位置补上年 / 月（9/28 真 Moka）
          const sub = lb.label || (all.length === 4 && i >= 0 ? (i % 2 === 0 ? '年' : '月') : '');
          lb.label = clean(`${t.text}${half ? '-' + half : ''}${sub ? '-' + sub : ''}`);
          lb.star = lb.star || t.star;
          lb.fromPh = false;
        }
      }
      const f = {
        ref, kind: c.kind, label: lb.label, fromPh: !!lb.fromPh,
        required: !!(lb.star || el.required || el.getAttribute('aria-required') === 'true' || inner?.required),
        placeholder: (inner?.getAttribute('placeholder') || textOf(el.querySelector?.('.ant-select-selection-placeholder,.el-select__placeholder')) || '').slice(0, 40),
        maxLength: Number(inner?.getAttribute('maxlength')) > 0 ? Number(inner.getAttribute('maxlength')) : null,
        section: sec.name, index: gi.index, groups: gi.total,
        value: '', options: null,
        accept: c.kind === 'file' ? (el.getAttribute('accept') || '') : undefined,
        inputType: inner?.getAttribute('type') || '',
        // 飞书招聘 / 字节这类表单每个字段带机器名（data-form-field-name="email"），比认中文标签稳（照 Tabbit 的字节简历配方加的）
        fieldName: fieldNameOf(el, c.kind),
      };
      // 必填星号在题目那一行的（真 Moka：.required-asterisk）
      if (!f.required) f.required = !!titleAbove(c.el)?.star;
      // 文件框：标签取周围「上传简历 / 上传照片」这类字
      if (c.kind === 'file' && !f.label) {
        const box = el.closest(ITEM_SEL) || el.parentElement?.parentElement;
        f.label = clean(textOf(box).slice(0, 30));
      }
      c.inputs && (f._inputs = c.inputs.length);
      const tmp = { el, kind: c.kind, inputs: c.inputs };
      f.value = String(valueOf(tmp) || '').slice(0, 300);
      const opts = optionsOf(tmp);
      if (opts) f.options = opts.slice(0, 60);
      if (!f.label) f.context = contextOf(el);
      fields.push(f);
    }
    lastScan = cands;
    // 提交类按钮描红
    const submits = [];
    for (const b of document.querySelectorAll('button, [role="button"], a, input[type=submit], input[type=button], .btn, [class*="btn"]')) {
      if (!visible(b)) continue;
      const t = norm(b.innerText || b.value || '');
      // 「预览并提交」「确认并投递」这类组合写法也算（真 Moka 的按钮是「预览并提交」）
      if (t && t.length <= 8 && (SUBMIT_RE.test(t) || /提交|投递/.test(t))) {
        b.style.outline = '3px solid #dc2626'; b.style.outlineOffset = '2px';
        b.title = '你自己点（插件永远不点这个）';
        if (!b.dataset.jfzSubmit) { b.dataset.jfzSubmit = '1'; badge(b, '你自己点', '#dc2626'); }
        submits.push(t);
      }
    }
    // 「添加一段」按钮，按所在分块归类
    const adds = [];
    for (const b of document.querySelectorAll('button, [role="button"], a, span, div')) {
      if (b.children.length > 3 || !visible(b)) continue;
      const t = norm(b.innerText || '');
      if (!/^[+＋]?\s*(添加|新增|增加|继续添加)/.test(t) || t.length > 14) continue;
      if (b.parentElement && /^[+＋]?\s*(添加|新增|增加)/.test(norm(b.parentElement.innerText || '')) && b.parentElement.innerText.length <= 14) continue; // 只要最里面那层
      adds.push({ ref: refOf(b), text: t, section: sectionOf(b).name });
    }
    return { url: location.href, title: document.title, fields, submits, adds, gate: pageGate(), frame: window === top ? 'top' : 'iframe' };
  }

  function fieldNameOf(el, kind) {
    if (kind === 'radio' || kind === 'checkbox') return '';
    const own = el.closest('[data-form-field-name]') || (el.matches(FAKE_SELECT) ? el.querySelector('[data-form-field-name]') : null);
    return own?.dataset.formFieldName || '';
  }

  // ---------------------------------------------------------------- 页面闸门：没登录 / 弹验证码 / 访问太频繁，就别填了
  // 照 Tabbit 字节简历配方的写法：填之前先看页面状态，挡住了直接告诉你，而不是扫出 0 个框或往遮罩后面乱填
  const CAPTCHA_SEL = '[class*="captcha"], [class*="Captcha"], [id*="captcha"], .geetest_panel, .geetest_box, [class*="nc_wrapper"], [class*="slider-verify"], [class*="verify-wrap"], [class*="verifyWrap"], iframe[src*="captcha"]';
  const LOGIN_SEL = '.login-container, .login-mask, [class*="login-modal"], [class*="loginModal"], [class*="login-dialog"], [class*="loginDialog"], [class*="LoginDialog"], [class*="login-pop"]';
  const ERRPAGE_SEL = '#error-screen, .error-container, [class*="error-page"], [class*="errorPage"], [class*="exception"]';
  function pageGate() {
    const big = (e) => visible(e) && e.getBoundingClientRect().width >= 150 && e.getBoundingClientRect().height >= 60;
    const cap = [...document.querySelectorAll(CAPTCHA_SEL)].find(big);
    if (cap) return { code: 'captcha', msg: textOf(cap).slice(0, 80) };
    const login = [...document.querySelectorAll(LOGIN_SEL)].find((e) => big(e) && /登录|登陆|sign in|log in/i.test(textOf(e)));
    if (login) return { code: 'login', msg: textOf(login).slice(0, 80) };
    const err = [...document.querySelectorAll(ERRPAGE_SEL)].find(visible);
    if (err && /频繁|too many requests|rate limit|稍后再试/i.test(textOf(err))) return { code: 'rate', msg: textOf(err).slice(0, 80) };
    return null;
  }

  // ---------------------------------------------------------------- 网站自己的红字（必填未填、格式不对）
  const SITE_ERR_SEL = '.ant-form-item-explain-error, .el-form-item__error, .ivu-form-item-error-tip, .arco-form-item-message-error, .t-input__extra--error, .n-form-item-feedback--error, .ud-formily-item-feedback-status-error, [class*="error-tip"], [class*="errorTip"], [class*="error-msg"], [class*="errorMsg"], [class*="feedback-error"], [class*="field-error"]';
  function siteErrors() {
    const list = [];
    for (const c of lastScan) {
      const ref = c.el.dataset.jfzRef;
      if (!ref || !c.el.isConnected) continue;
      // 只在「只装着这一个框」的那几层里找，别把隔壁字段的红字算到它头上
      let node = c.el;
      for (let hop = 0; node && hop < 5; hop++, node = node.parentElement) {
        if (hop > 0 && controlsIn(node) > 1) break;
        const hit = [...node.querySelectorAll(SITE_ERR_SEL)].find((e) => visible(e) && textOf(e) && textOf(e).length <= 60);
        if (hit) { list.push({ ref, msg: textOf(hit) }); break; }
      }
    }
    return { list };
  }


  function contextOf(el) {
    let box = el;
    for (let i = 0; i < 3 && box.parentElement; i++) { box = box.parentElement; if (textOf(box).length > 20) break; }
    const c = box.cloneNode(true);
    c.querySelectorAll('script,style,svg,img').forEach((x) => x.remove());
    c.querySelectorAll('*').forEach((x) => { for (const a of [...x.attributes]) if (!/^(placeholder|name|type|for|data-jfz-ref)$/.test(a.name)) x.removeAttribute(a.name); });
    return c.innerHTML.replace(/\s+/g, ' ').slice(0, 300);
  }

  // ---------------------------------------------------------------- 填
  const protoSetter = (el) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    return Object.getOwnPropertyDescriptor(proto, 'value').set;
  };
  const fire = (el, type, init = {}) => el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true, ...init }));
  const key = (el, k) => {
    for (const t of ['keydown', 'keypress', 'keyup']) el.dispatchEvent(new KeyboardEvent(t, { key: k, code: k, keyCode: k === 'Enter' ? 13 : 0, which: k === 'Enter' ? 13 : 0, bubbles: true }));
  };

  function setNative(el, v) {
    el.focus?.();
    protoSetter(el).call(el, v);
    fire(el, 'input', { composed: true });
    fire(el, 'change');
    return el.value;
  }

  async function fillText(ref, value, { blur = true } = {}) {
    const host = byRef(ref);
    if (!host) return { ok: false, why: '字段不见了' };
    const el = host.matches('input,textarea,select,[contenteditable]') ? host : host.querySelector('input,textarea');
    if (!el) return { ok: false, why: '找不到输入框' };
    if (el.isContentEditable) { el.focus(); el.textContent = value; fire(el, 'input'); if (blur) fire(el, 'blur'); return { ok: textOf(el) === norm(value), got: textOf(el) }; }
    const max = Math.max(0, Number(el.getAttribute('maxlength')) || 0);
    const v = max && value.length > max ? value.slice(0, max) : value;
    setNative(el, v);
    await sleep(60);
    if (blur) { el.dispatchEvent(new FocusEvent('blur', { bubbles: false })); el.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); }
    await sleep(120);
    const got = el.value;
    return { ok: got === v, got, truncated: v !== value };
  }

  /** 给 debugger 真打字用：聚焦、清空、返回坐标 */
  async function focusFor(ref) {
    const host = byRef(ref);
    const el = host && (host.matches('input,textarea') ? host : host.querySelector('input,textarea'));
    if (!el) return { ok: false };
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const rc = el.getBoundingClientRect();
    const hit = document.elementFromPoint(rc.left + rc.width / 2, rc.top + rc.height / 2);
    if (!hit || !(hit === el || el.contains(hit) || host.contains(hit))) return { ok: false, why: '框被别的东西挡住了，不点' };
    el.focus();
    protoSetter(el).call(el, '');
    fire(el, 'input');
    el.select?.();
    const r = el.getBoundingClientRect();
    return { ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2, top: window === top };
  }
  function readBack(ref) {
    const f = lastScan.find((c) => c.el.dataset.jfzRef === ref) || { el: byRef(ref), kind: 'text' };
    if (!f.el) return { value: '' };
    return { value: valueOf(f) };
  }

  function selectNative(ref, text) {
    const el = byRef(ref);
    if (!el || el.tagName !== 'SELECT') return { ok: false };
    const o = [...el.options].find((x) => textOf(x) === text) || [...el.options].find((x) => textOf(x).includes(text) || text.includes(textOf(x)) && textOf(x));
    if (!o) return { ok: false, why: '选项里没有' };
    protoSetter(el).call(el, o.value);
    fire(el, 'input'); fire(el, 'change');
    return { ok: el.value === o.value, got: textOf(o) };
  }

  function clickRadio(ref, text) {
    const f = lastScan.find((c) => c.el.dataset.jfzRef === ref);
    if (!f) return { ok: false, why: '字段不见了' };
    const wanted = String(text).split(/[、,，]/).map(norm).filter(Boolean);
    let hit = 0;
    const items = f.inputs?.length ? f.inputs.map((i) => ({ i, t: optText(i), click: i.closest('label') || i }))
      : [...f.el.querySelectorAll('[role="radio"], [role="checkbox"], .ant-radio-wrapper, .el-radio, .ant-checkbox-wrapper, .el-checkbox')].map((x) => ({ i: null, t: textOf(x), click: x }));
    for (const w of wanted) {
      const it = items.find((x) => x.t === w) || items.find((x) => x.t.includes(w) || w.includes(x.t));
      if (!it) continue;
      if (it.i?.checked) { hit++; continue; }
      realClick(it.click);
      hit++;
    }
    return { ok: hit === wanted.length, got: valueOf(f) };
  }

  function realClick(el) {
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, view: window };
    el.dispatchEvent(new PointerEvent('pointerdown', o));
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new PointerEvent('pointerup', o));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.dispatchEvent(new MouseEvent('click', o));
  }

  // ---------------------------------------------------------------- 下拉 / 级联 / 日期
  const POPUP_SEL = '.ant-select-dropdown, .ant-cascader-dropdown, .ant-picker-dropdown, .el-select-dropdown, .el-popper, .el-cascader__dropdown, .el-picker-panel, .ivu-select-dropdown, .arco-select-popup, .t-popup, .n-base-select-menu, [role="listbox"], [class*="dropdown"], [class*="popper"], [class*="popup"], [class*="picker-panel"]';
  const OPT_SEL = '[class*="Select-common-item"], [class*="Menu-container"], [class*="select-option"], [class*="option-item"], .ant-select-item-option, .ant-cascader-menu-item, .el-select-dropdown__item, .el-cascader-node, .ivu-select-item, .arco-select-option, .t-select-option, [role="option"], [role="menuitem"], li';

  let popBase = new Set();
  function openPopups() {
    return [...document.querySelectorAll(POPUP_SEL)].filter((p) => visible(p) && !popBase.has(p) && !p.closest('[data-jfz-ref]') && p.querySelector(OPT_SEL));
  }
  function readOpts() {
    const pops = openPopups();
    if (!pops.length) return { open: false, menus: [] };
    // 级联：一个弹层里有好几列菜单
    const pop = pops[pops.length - 1];
    const cols = [...pop.querySelectorAll('.ant-cascader-menu, .el-cascader-menu, .el-cascader-menu__list, [class*="cascader-menu"]')].filter(visible);
    const menus = (cols.length ? cols : [pop]).map((col) => {
      const opts = [...col.querySelectorAll(OPT_SEL)].filter((o) => visible(o) && !o.querySelector(OPT_SEL) && textOf(o) && textOf(o).length < 60 && !/disabled/.test(o.className) && o.getAttribute('aria-disabled') !== 'true');
      opts.forEach((o, i) => { o.dataset.jfzOpt = String(i); });
      return opts.map((o, i) => ({ i, t: textOf(o), active: /selected|active|is-active|in-active-path/.test(o.className) }));
    });
    return { open: true, menus };
  }

  async function openSelect(ref, search) {
    const host = byRef(ref);
    if (!host) return { ok: false, why: '字段不见了' };
    host.scrollIntoView({ block: 'center' });
    const trigger = host.querySelector('.ant-select-selector, .el-select__wrapper, .el-input__inner, .el-input, .ant-picker-input, .ivu-select-selection, input') || host;
    // 点开之前就在的不算（先把可能还开着的上一个下拉关掉，免得把它当成常驻的）
    closePopups();
    await sleep(150);
    popBase = new Set();
    popBase = new Set(openPopups());
    realClick(trigger);
    trigger.focus?.();
    // 等弹层出来（组件库常异步渲染）
    await waitFor(() => openPopups().length > 0, 2000);
    if (search) {
      const inp = host.querySelector('input:not([readonly])');
      if (inp) { setNative(inp, search); await sleep(500); }
    }
    const r = host.getBoundingClientRect();
    return { ok: true, ...readOpts(), x: r.left + r.width / 2, y: r.top + r.height / 2, top: window === top };
  }

  async function pickOpt(col, i) {
    const pops = openPopups();
    const pop = pops[pops.length - 1];
    if (!pop) return { ok: false, why: '下拉没开' };
    const cols = [...pop.querySelectorAll('.ant-cascader-menu, .el-cascader-menu, .el-cascader-menu__list, [class*="cascader-menu"]')].filter(visible);
    const menu = cols.length ? cols[col] : pop;
    const o = menu && [...menu.querySelectorAll(`[data-jfz-opt="${i}"]`)].find(visible);
    if (!o) return { ok: false, why: '选项不见了' };
    const leaf = leafOf(o);
    if (o.closest('a[href]') || leaf.closest('a[href]') || o.querySelector('a[href]') || SUBMIT_RE.test(norm(o.innerText))) return { ok: false, why: '这个「选项」是链接或提交按钮，不点' };
    o.scrollIntoView({ block: 'nearest' });
    realClick(leaf);
    // element 的级联是 hover/点击展开下一级、选到叶子才关
    await sleep(350);
    return { ok: true, ...readOpts() };
  }

  function leafOf(el) {
    let cur = el;
    for (let k = 0; k < 8; k++) {
      const kids = [...cur.children].filter((c) => visible(c) && textOf(c));
      if (kids.length !== 1) break;
      cur = kids[0];
    }
    return cur;
  }

  function closePopups() {
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    document.activeElement?.blur?.();
    key(document.body, 'Escape');
  }

  async function typeDate(ref, v) {
    const host = byRef(ref);
    const el = host && (host.matches('input') ? host : host.querySelector('input'));
    if (!el) return { ok: false, why: '找不到日期输入框' };
    el.scrollIntoView({ block: 'center' });
    realClick(el);
    el.focus();
    await sleep(150);
    if (el.readOnly) { closePopups(); return { ok: false, why: '日期框不让直接输入', readonly: true }; }
    setNative(el, v);
    await sleep(120);
    el.blur();
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    closePopups();
    await sleep(250);
    const got = el.value;
    return { ok: !!got && digits(got).startsWith(digits(v).slice(0, 6)), got };
  }
  const digits = (s) => String(s || '').replace(/\D/g, '');

  /** 等条件成立：DOM 一变就查一次，最多等 ms 毫秒 */
  function waitFor(cond, ms) {
    return new Promise((ok) => {
      if (cond()) return ok(true);
      const mo = new MutationObserver(() => { if (cond()) { done(); ok(true); } });
      const timer = setTimeout(() => { done(); ok(cond()); }, ms);
      const done = () => { mo.disconnect(); clearTimeout(timer); };
      mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
    });
  }

  // ---------------------------------------------------------------- 上色 / 定位
  const COLORS = { green: '#16a34a', yellow: '#eab308', red: '#dc2626', none: '' };
  function badge(el, text, color) {
    const b = document.createElement('span');
    b.className = 'jfz-badge';
    b.textContent = text;
    b.style.cssText = `display:inline-block;margin-left:6px;padding:0 4px;font:12px/18px sans-serif;color:#fff;background:${color};border-radius:3px;vertical-align:middle;pointer-events:none;`;
    el.insertAdjacentElement('afterend', b);
  }
  function paint(list) {
    for (const { ref, color, note } of list) {
      const el = byRef(ref);
      if (!el) continue;
      const box = el.matches('input[type=file]') ? el.parentElement : el;
      box.style.outline = color === 'none' ? '' : `2px solid ${COLORS[color]}`;
      box.style.outlineOffset = '1px';
      if (note) box.title = note;
    }
    return { ok: true };
  }
  function scrollTo(ref) {
    const el = byRef(ref);
    if (!el) return { ok: false };
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const box = el.matches('input[type=file]') ? el.parentElement : el;
    const old = box.style.boxShadow;
    box.style.boxShadow = '0 0 0 4px rgba(37,99,235,.5)';
    setTimeout(() => { box.style.boxShadow = old; }, 1800);
    return { ok: true };
  }
  function clickAdd(ref) {
    const el = byRef(ref);
    if (!el) return { ok: false };
    // 别误点提交类
    if (SUBMIT_RE.test(norm(el.innerText || ''))) return { ok: false, why: '这是提交按钮，不点' };
    el.scrollIntoView({ block: 'center' });
    realClick(el);
    return { ok: true };
  }
  function clearMarks() {
    document.querySelectorAll('[data-jfz-ref]').forEach((e) => { e.style.outline = ''; });
    return { ok: true };
  }

  // ---------------------------------------------------------------- 「记住这页我填的」：读出你填了值的字段
  function harvest() {
    const res = scan();
    return res.fields.filter((f) => f.value && f.kind !== 'file').map((f) => ({ label: f.label, section: f.section, value: f.value, kind: f.kind }));
  }

  // ---------------------------------------------------------------- 消息
  const H = {
    scan: () => scan(),
    fillText: (p) => fillText(p.ref, p.value, p),
    focusFor: (p) => focusFor(p.ref),
    readBack: (p) => readBack(p.ref),
    selectNative: (p) => selectNative(p.ref, p.text),
    clickRadio: (p) => clickRadio(p.ref, p.text),
    openSelect: (p) => openSelect(p.ref, p.search),
    readOpts: () => readOpts(),
    pickOpt: (p) => pickOpt(p.col || 0, p.i),
    closePopups: () => { closePopups(); return { ok: true }; },
    typeDate: (p) => typeDate(p.ref, p.value),
    paint: (p) => paint(p.list || []),
    scrollTo: (p) => scrollTo(p.ref),
    clickAdd: (p) => clickAdd(p.ref),
    clearMarks: () => clearMarks(),
    harvest: () => harvest(),
    siteErrors: () => siteErrors(),
    ping: () => ({ ok: true, url: location.href, top: window === top }),
  };
  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    if (!msg || msg.jfz !== true || !H[msg.action]) return false;
    Promise.resolve().then(() => H[msg.action](msg.payload || {})).then(reply, (e) => reply({ ok: false, error: String(e?.message || e) }));
    return true;
  });
})();
