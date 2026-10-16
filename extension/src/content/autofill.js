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
    // 1b. <label>文字 <input></label> 这种把框包在里面的写法：只取 label 自己的文字节点（不取下拉里的选项字），
    // 而且这个 label 里只能有这一个框。10/16 HR Desk 网申实测：以前认不出，模型按顺序猜，整页串了一格
    const wrap = el.closest?.('label');
    if (wrap && controlsIn(wrap) === 1) {
      const own = [...wrap.childNodes].filter((n) => n.nodeType === 3 || (n.nodeType === 1 && !n.matches('input,textarea,select') && !n.querySelector?.('input,textarea,select'))).map((n) => n.textContent).join(' ');
      if (norm(own) && norm(own).length < 40) return { label: clean(own), star: /[*＊]/.test(own) || requiredCls(wrap) };
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
      // 起止日期框：两格都读
      const two = f.kind === 'date' ? [...el.querySelectorAll('input')] : [];
      if (two.length === 2) return two.some((i) => i.value) ? `${two[0].value} ~ ${two[1].value}` : '';
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
          // 两个框的默认当「开始 / 结束」；但籍贯、手机、证件、薪资这类一题两格的交给 nameBlanks 起名，别标成开始结束
          const half = all.length === 4 && i >= 0 ? (i < 2 ? '开始' : '结束') : all.length === 2 && !/年|月|日/.test(lb.label) && !BLANK_RULES.some((b) => b.re.test(t.text)) ? (i === 0 ? '开始' : '结束') : '';
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
        // 起止日期连在一个框里（antd RangePicker / element daterange：一个外壳两个 input）
        range: c.kind === 'date' && !el.matches('input') && el.querySelectorAll('input').length === 2,
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
    nameBlanks(fields, cands);
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

  // ---------------------------------------------------------------- 一题多格：给每格起名（思路参考求职方舟 k.F，规则自己写）
  // 「籍贯」下面并排三个下拉、「手机号码」前面带个区号下拉，几格认出来的标签一模一样，模型和近义补齐都分不清谁是谁
  // （以前区号下拉会被当成「手机号码」的近义栏目，补成 11 位手机号）。按题型给每格接个后缀，localRule 认这些后缀
  const BLANK_RULES = [
    { re: /居住地|现居|籍贯|户籍|户口|生源地|所在地|省份|城市|地点/, n: [2, 3], names: (n) => (n === 2 ? ['省', '市'] : ['省', '市', '区']) },
    { re: /手机|电话|联系方式/, n: [2], names: () => ['区号', '号码'] },
    { re: /身份证|证件/, n: [2], names: () => ['证件类型', '证件号码'], firstPick: true },
    { re: /期望薪资|期望月薪|期望年薪|薪资要求|期望薪酬/, n: [2], names: () => ['下限', '上限'] },
  ];
  function nameBlanks(fields, cands) {
    const groups = new Map();
    fields.forEach((f, i) => {
      if (!f.label || ['file', 'radio', 'checkbox', 'textarea'].includes(f.kind)) return;
      const k = `${f.section}|${f.index}|${f.label}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(i);
    });
    for (const idx of groups.values()) {
      if (idx.length < 2 || idx.length > 3) continue;
      // 按页面上的先后排（collectCandidates 是先组件库下拉、后原生框，顺序不是页面顺序）
      const list = idx.map((i) => ({ i, el: cands[i].el })).sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
      // 这几格得挤在一个小容器里、容器里就这几个框 —— 别把两道同名的题当成一题多格
      let box = list[0].el.parentElement;
      while (box && !list.every((x) => box.contains(x.el))) box = box.parentElement;
      if (!box || controlsIn(box) > list.length) continue;
      const label = fields[list[0].i].label;
      const rule = BLANK_RULES.find((r) => r.re.test(label) && r.n.includes(list.length));
      if (!rule) continue;
      // 证件：第一格得是下拉（证件类型）才这么拆；两个都是文本框的不动
      if (rule.firstPick && !/select|cascader/.test(fields[list[0].i].kind)) continue;
      rule.names(list.length).forEach((nm, k) => { fields[list[k].i].label = `${label}-${nm}`; });
    }
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
      if (realClick(it.click)) hit++;
    }
    return { ok: hit === wanted.length, got: valueOf(f), ...(hit < wanted.length ? { why: '选项被别的东西挡住了，没点' } : {}) };
  }

  /**
   * 点一个元素：先用 elementFromPoint 看它中心点最上层是谁（思路参考求职方舟 N.sl）。
   *   - 最上层是它里面的字 / 图标，或者跟它同一个父亲的（隐藏 input 上盖着的样式 span）：点最上层那个，跟真鼠标一样，事件冒泡回去
   *   - 最上层是它的祖先（它自己 pointer-events:none）：还点它本身，事件照样冒泡到祖先
   *   - 最上层是不相干的东西（遮罩、别的弹窗）：滚到中间再看一次，还挡着就不点，返回 false —— 别隔着遮罩点到后面的东西
   * 返回有没有点下去。
   */
  function realClick(el) {
    if (!el?.isConnected) return false;
    let r = el.getBoundingClientRect();
    let target = el;
    if (r.width >= 2 && r.height >= 2) {
      const hitAt = () => document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      // 同一个父亲的兄弟只在「它自己是藏起来的勾选框」时才算自己人（样式 span 盖在隐藏 input 上）；
      // 普通按钮上盖着的兄弟多半就是遮罩（夹具实测：按钮和遮罩是兄弟，原来照点了遮罩）
      const hiddenSelf = /^(radio|checkbox)$/i.test(el.type || '') || getComputedStyle(el).opacity === '0';
      const related = (h) => !h || h === el || el.contains(h) || h.contains(el) || (hiddenSelf && h.parentElement === el.parentElement);
      let hit = hitAt();
      if (!related(hit) || r.bottom < 0 || r.top > innerHeight) {
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        r = el.getBoundingClientRect();
        hit = hitAt();
      }
      if (!related(hit)) return false;
      if (hit && hit !== el && (el.contains(hit) || (hiddenSelf && hit.parentElement === el.parentElement))) target = hit;
    }
    const o = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, view: window };
    target.dispatchEvent(new PointerEvent('pointerdown', o));
    target.dispatchEvent(new MouseEvent('mousedown', o));
    target.dispatchEvent(new PointerEvent('pointerup', o));
    target.dispatchEvent(new MouseEvent('mouseup', o));
    target.dispatchEvent(new MouseEvent('click', o));
    return true;
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
    rawStart(host);   // 顺便记下点开后新冒出来的东西：组件库认不出的弹层，后面 openRaw 要用
    if (!realClick(trigger)) return { ok: false, why: '下拉框被别的东西挡住了，没点' };
    trigger.focus?.();
    // 等弹层出来（组件库常异步渲染）
    await waitFor(() => openPopups().length > 0, 2000);
    if (search) {
      const inp = host.querySelector('input:not([readonly])');
      // 打完字搜索结果是远程拉的：等「加载中」没了、选项连续两轮不变再读，最多 3 秒（原来写死等 500ms，慢的网站读到一半的列表）
      if (inp) { setNative(inp, search); await waitOptsStable(3000); }
    } else {
      await waitOptsStable(1500);
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
    if (!realClick(leaf)) return { ok: false, why: '选项被别的东西挡住了，没点' };
    // element 的级联是 hover/点击展开下一级、选到叶子才关；下一级常是点了才去拉的，等它稳定
    await sleep(150);
    await waitOptsStable(3000);
    return { ok: true, ...readOpts() };
  }

  // 弹层里的「加载中」：aria-busy、class 带 loading / spinner / skeleton / spinning 的可见元素，或者选项文字就是「加载中…」
  const LOADING_CLS = /(^|[\s_-])(loading|spinner|skeleton|spinning)([\s_-]|$)/i;
  const LOADING_TXT = /^\s*(正在加载|加载中|等待加载|正在搜索|搜索中|loading)/i;
  function optSnapshot() {
    const pops = [...document.querySelectorAll(POPUP_SEL)].filter((p) => visible(p) && !popBase.has(p) && !p.closest('[data-jfz-ref]'));
    const texts = [];
    let loading = false;
    for (const p of pops) {
      for (const o of p.querySelectorAll(OPT_SEL)) {
        if (!visible(o) || o.querySelector(OPT_SEL)) continue;
        const t = textOf(o);
        if (t && t.length < 60) texts.push(t);
        if (LOADING_TXT.test(t)) loading = true;
      }
      if (!loading && [...p.querySelectorAll('[aria-busy="true"], [class*="loading"], [class*="spin"], [class*="skeleton"]')]
        .some((e) => visible(e) && (e.getAttribute('aria-busy') === 'true' || LOADING_CLS.test(String(e.className?.baseVal ?? e.className ?? ''))))) loading = true;
    }
    return { key: texts.join('\u0001'), n: texts.length, pops: pops.length, loading };
  }
  /**
   * 等下拉选项稳定（思路参考求职方舟 k.ao）：没有加载中提示、连续两轮选项文字一样才算；
   * 一个选项都没有的再多等到 1 秒（远程搜索有防抖）；弹层已经关了的直接返回；最多等 ms 毫秒。
   */
  async function waitOptsStable(ms = 3000) {
    const t0 = performance.now();
    let prev = null;
    await sleep(200);
    for (;;) {
      const s = optSnapshot();
      const spent = performance.now() - t0;
      if (prev !== null && s.key === prev && !s.loading && (s.n > 0 || s.pops === 0 || spent >= 1000)) return s;
      if (spent >= ms) return s;
      prev = s.key;
      await sleep(200);
    }
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

  // ---------------------------------------------------------------- 只读日期框：打开日期面板，翻到目标年月，再点日
  // 思路参考求职方舟 k.No / k._o / k.Zo（认日 / 月 / 年视图、翻页箭头按位置找、日子 <15 点第一个匹配格否则点最后一个），代码自己写。
  // 只点日期面板里面的东西；点完回读输入框，对不上就报没填上
  const DATE_POP_SEL = '.ant-picker-dropdown, .el-picker-panel, .ivu-picker-panel-body-wrapper, .ivu-date-picker-transfer, .arco-picker-container, .t-date-picker__panel, .n-date-panel, .layui-laydate, [class*="datepicker"], [class*="date-picker"][class*="panel"], [class*="date-picker"][class*="popup"], [class*="date-picker"][class*="dropdown"], [class*="calendar"], [class*="picker-panel"], [class*="picker-dropdown"]';
  const SUB_PANEL_SEL = '.ant-picker-panel, .el-date-range-picker__content, .ivu-picker-panel-content, .arco-panel-date, [class*="panel-content"]';
  const CN_MONTH = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 };
  const EN_MONTH = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  // 相邻月份 / 不能选的格子（element: prev-month / next-month，iview: cell-prev-month，layui: laydate-day-prev，bootstrap: old / new）
  const OUT_CELL_RE = /(prev|next|last|other)[-_]?(month|day|year)|day[-_](prev|next)|is-other|not-current|outside|disabled|(^|\s)(old|new)(\s|$)/i;
  const ARROW_TXT = /^[<>‹›«»←→〈〉《》‹›«»-]+$/;

  const clsOf = (e) => String(e?.className?.baseVal ?? e?.className ?? '');
  function monthOf(t) {
    let m = /^(0?[1-9]|1[0-2])月$/.exec(t);
    if (m) return Number(m[1]);
    m = /^(十[一二]?|[一二三四五六七八九])月$/.exec(t);
    if (m) return CN_MONTH[m[1]];
    if (/^[a-z]{3,9}\.?$/i.test(t)) { const i = EN_MONTH.indexOf(t.slice(0, 3).toLowerCase()); if (i >= 0) return i + 1; }
    return 0;
  }
  const yearOf = (t) => { const m = /^((?:19|20)\d{2})年?$/.exec(t); return m ? Number(m[1]) : 0; };
  /** 表头一段字里的年、月：「2026年10月」「2026 年」「10 月」「十月」「Oct 2026」「2026-10」都认 */
  function headYM(t) {
    const y = /((?:19|20)\d{2})/.exec(t);
    let m = /(?:^|[^\d])(\d{1,2})月/.exec(t) || /^(?:19|20)\d{2}[-/.](\d{1,2})$/.exec(t);
    let mo = m ? Number(m[1]) : 0;
    if (!mo) { m = /(十[一二]?|[一二三四五六七八九])月/.exec(t); if (m) mo = CN_MONTH[m[1]]; }
    if (!mo) { m = /^([a-z]{3,9})\.?(?:19|20)\d{2}$|^(?:19|20)\d{2}([a-z]{3,9})$/i.exec(t); const w = m && (m[1] || m[2]); if (w && EN_MONTH.includes(w.slice(0, 3).toLowerCase())) mo = EN_MONTH.indexOf(w.slice(0, 3).toLowerCase()) + 1; }
    if (!mo) mo = monthOf(t);   // 英文界面表头单独一个「Oct」「October」（antd / element 默认语言）
    return { y: y ? Number(y[1]) : 0, m: mo >= 1 && mo <= 12 ? mo : 0 };
  }

  /** 面板里自己带字的元素（叶子），按页面顺序；svg 里的、时间列（时分秒）里的不算 */
  function dateLeaves(box) {
    const out = [];
    for (const e of box.querySelectorAll('*')) {
      if (e instanceof SVGElement || e.closest('[class*="time-panel"], [class*="time-picker"], [class*="timepicker"], [class*="time-select"]')) continue;
      const own = [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').replace(/\s+/g, '');
      if (!own || own.length > 16 || !visible(e)) continue;
      out.push({ el: e, t: own });
    }
    return out;
  }

  /** 认一个面板现在是哪种视图：day（1~31 号）/ month（12 个月）/ year（一屏年份），以及表头写的是几年几月 */
  function dateView(box) {
    const L = dateLeaves(box);
    const inHead = (x) => { const h = x.el.closest('[class*="head"], [class*="title"], [class*="caption"], [class*="nav"]'); return !!h && h !== box && box.contains(h); };
    let head = L.filter(inHead);
    let body = L.filter((x) => !inHead(x));
    let mode = '';
    let cells = [];
    const pick = (list) => {
      const nums = list.filter((x) => /^\d{1,2}$/.test(x.t) && Number(x.t) >= 1 && Number(x.t) <= 31);
      const days = new Set(nums.map((x) => Number(x.t)));
      if (Array.from({ length: 28 }, (_, i) => i + 1).every((d) => days.has(d))) return ['day', nums];
      const ms = list.filter((x) => monthOf(x.t));
      if (new Set(ms.map((x) => monthOf(x.t))).size === 12) return ['month', ms];
      const ys = list.filter((x) => yearOf(x.t));
      if (ys.length >= 9) return ['year', ys];
      return ['', []];
    };
    [mode, cells] = pick(body);
    if (!mode) return null;
    // 表头没有 class 可认的（自己写的面板）：第一个格子之前的字都算表头
    if (!head.length) { head = L.slice(0, L.indexOf(cells[0])); body = L.slice(L.indexOf(cells[0])); }
    // 表头只留写着年 / 月的那几段（按位置兜底时会把箭头、星期几也算进来，箭头就找不到了 —— 夹具实测）
    head = head.filter((x) => headYM(x.t).y || headYM(x.t).m);
    let year = 0;
    let month = 0;
    let yearEl = null;
    for (const x of head) {
      const ym = headYM(x.t);
      if (!year && ym.y && !/((?:19|20)\d{2}).*[-~–—至].*((?:19|20)\d{2})/.test(x.t)) { year = ym.y; yearEl = x.el; }
      if (!month && ym.m) month = ym.m;
    }
    return { box, mode, cells, head, year, month, yearEl };
  }

  /** 弹层里的面板：起止日期是左右两个月并排，各认各的；只有一个就整个弹层当一个面板（element 的表头在内容区外面） */
  function viewsOf(pop) {
    const subs = [...pop.querySelectorAll(SUB_PANEL_SEL)].filter(visible);
    const outer = subs.filter((s) => !subs.some((o) => o !== s && o.contains(s)));
    const vs = outer.map(dateView).filter(Boolean).sort((a, b) => a.box.getBoundingClientRect().left - b.box.getBoundingClientRect().left);
    if (vs.length >= 2 && vs.every((v) => v.year || v.mode === 'year')) return vs;
    const one = dateView(pop);
    return one ? [one] : vs;
  }

  /** 翻页箭头按位置找：表头那一行、表头文字左边的小元素往前翻，右边的往后翻；一边两个的，外侧翻年、内侧翻月 */
  function dateArrows(pop, heads) {
    const empty = { prevYear: null, prevMonth: null, nextMonth: null, nextYear: null };
    if (!heads.length) return empty;
    const rs = heads.map((x) => x.el.getBoundingClientRect());
    const top = Math.min(...rs.map((r) => r.top));
    const bottom = Math.max(...rs.map((r) => r.bottom));
    const left = Math.min(...rs.map((r) => r.left));
    const right = Math.max(...rs.map((r) => r.right));
    const prev = [];
    const next = [];
    for (const e of pop.querySelectorAll('*')) {
      if (e instanceof SVGElement || !visible(e)) continue;
      const r = e.getBoundingClientRect();
      if (r.width > 50 || r.height > 50 || r.top < top - 20 || r.bottom > bottom + 20) continue;
      if (heads.some((h) => h.el === e || e.contains(h.el) || h.el.contains(e))) continue;
      const tx = textOf(e).replace(/\s+/g, '');
      if (tx && !ARROW_TXT.test(tx)) continue;
      if (r.right <= left) prev.push(e);
      else if (r.left >= right) next.push(e);
    }
    // 只留最里层（图标），点它事件冒泡到按钮；同一个位置的只算一个
    const inner = (list) => list.filter((e) => !list.some((o) => o !== e && e.contains(o)))
      .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
      .filter((e, k, arr) => k === 0 || Math.abs(e.getBoundingClientRect().left - arr[k - 1].getBoundingClientRect().left) > 4);
    const p = inner(prev);
    const n = inner(next);
    return { prevYear: p[0] || null, prevMonth: p[p.length - 1] || null, nextMonth: n[0] || null, nextYear: n[n.length - 1] || null };
  }

  function outCell(el, box) {
    for (let e = el, k = 0; e && e !== box && k < 4; e = e.parentElement, k++) {
      const c = clsOf(e);
      if (OUT_CELL_RE.test(c)) return true;
      if (/ant-picker-cell(\s|$)/.test(c) && !/ant-picker-cell-in-view/.test(c)) return true;
    }
    return false;
  }
  /** 日子格：先排掉相邻月份的格子；还剩好几个同号的，小于 15 号取第一个、否则取最后一个（相邻月的小号在开头、大号在结尾） */
  function dayCell(v, d) {
    const all = v.cells.filter((x) => Number(x.t) === d);
    const inView = all.filter((x) => !outCell(x.el, v.box));
    const list = inView.length ? inView : all;
    return d < 15 ? list[0] : list[list.length - 1];
  }

  function datePops(host) {
    const ps = [...document.querySelectorAll(DATE_POP_SEL)].filter((p) => visible(p) && !p.contains(host));
    return ps.filter((p) => !ps.some((o) => o !== p && o.contains(p)));
  }

  /** 在开着的面板上一步步翻到 t（{y,m,d}）并点下去 */
  async function walkTo(t, getPop, trace = []) {
    let lastSig = '';
    let same = 0;
    let triedHead = false;
    const click = async (el, ms = 220) => { if (!el || !realClick(el)) return false; await sleep(ms); return true; };
    for (let step = 0; step < 45; step++) {
      const pop = getPop();
      if (!pop) return { ok: true, closed: true };     // 面板自己关了（选完了）；对不对由回读判断
      const vs = viewsOf(pop);
      if (!vs.length) return { ok: false, why: '认不出日期面板（不是年 / 月 / 日的格子）' };
      const v = vs[0];
      const last = vs[vs.length - 1];
      const sig = vs.map((x) => `${x.mode}${x.year}-${x.month}-${x.cells.length}`).join('|');
      trace.push(sig);   // 走过的视图，没填上时带回去，方便看卡在哪一步
      same = sig === lastSig ? same + 1 : 0;
      lastSig = sig;
      if (same >= 3) return { ok: false, why: '日期面板翻页没反应' };
      const nav = dateArrows(pop, vs.flatMap((x) => x.head));
      const settledSame = async (mode) => { const p2 = getPop(); const v2 = p2 && viewsOf(p2)[0]; return !p2 || !v2 || v2.mode === mode; };

      if (v.mode === 'day') {
        const hit = vs.find((x) => x.year === t.y && x.month === t.m);
        if (hit) {
          const cell = dayCell(hit, t.d || 1);
          if (!cell) return { ok: false, why: `${t.y}-${t.m} 的面板里找不到 ${t.d || 1} 号` };
          if (!(await click(cell.el, 300))) return { ok: false, why: '日子格被挡住了' };
          return { ok: true };
        }
        if (!v.year || !v.month) return { ok: false, why: '读不出日期面板现在是几年几月' };
        const diff = (t.y - v.year) * 12 + (t.m - v.month);           // 比左边那个面板早多少个月
        const diffR = (t.y - last.year) * 12 + (t.m - last.month);    // 比右边那个面板晚多少个月
        // 差一年以上：先点表头的年份切到选年视图（快），切不过去再用翻年箭头
        if (Math.abs(diff) >= 12 && v.yearEl && !triedHead) { triedHead = true; await click(v.yearEl, 250); continue; }
        const back = diff < 0;
        const big = Math.abs(back ? diff : diffR) >= 12;
        const btn = back ? (big ? nav.prevYear : nav.prevMonth) : (big ? nav.nextYear : nav.nextMonth);
        if (!(await click(btn))) return { ok: false, why: '找不到日期面板的翻页箭头' };
        continue;
      }
      if (v.mode === 'month') {
        if (!v.year) return { ok: false, why: '读不出月份面板是哪一年' };
        if (v.year === t.y) {
          const c = v.cells.find((x) => monthOf(x.t) === t.m && !outCell(x.el, v.box)) || v.cells.find((x) => monthOf(x.t) === t.m);
          if (!(await click(c?.el, 300))) return { ok: false, why: `月份面板里点不到 ${t.m} 月` };
          // 点完还停在月视图 / 面板关了：这是选到月的框，这个日期就选完了；跳到日视图就接着点日
          if (await settledSame('month')) return { ok: true };
          continue;
        }
        if (v.yearEl && !triedHead && Math.abs(t.y - v.year) > 1) { triedHead = true; await click(v.yearEl, 250); continue; }
        if (!(await click(t.y < v.year ? nav.prevYear : nav.nextYear))) return { ok: false, why: '找不到月份面板的翻年箭头' };
        continue;
      }
      // 年视图
      const c = v.cells.find((x) => yearOf(x.t) === t.y && !outCell(x.el, v.box)) || v.cells.find((x) => yearOf(x.t) === t.y);
      if (c) {
        if (!(await click(c.el, 300))) return { ok: false, why: `年份面板里点不到 ${t.y}` };
        if (await settledSame('year')) return { ok: true };
        continue;
      }
      const ys = v.cells.map((x) => yearOf(x.t));
      if (!(await click(t.y < Math.min(...ys) ? nav.prevYear : nav.nextYear))) return { ok: false, why: '找不到年份面板的翻页箭头' };
    }
    return { ok: false, why: '翻了 45 次还没翻到' };
  }

  async function pickDatePanel(ref, value) {
    const host = byRef(ref);
    if (!host) return { ok: false, why: '字段不见了' };
    const targets = [...String(value).matchAll(/((?:19|20)\d{2})[-./年](\d{1,2})(?:[-./月](\d{1,2}))?/g)].map((m) => ({ y: Number(m[1]), m: Number(m[2]), d: m[3] ? Number(m[3]) : 0 }));
    if (!targets.length) return { ok: false, why: `「${value}」不是日期（「至今」这类要你自己点）` };
    const inputs = host.matches('input') ? [host] : [...host.querySelectorAll('input')];
    const want = targets.slice(0, inputs.length >= 2 ? 2 : 1);
    host.scrollIntoView({ block: 'center', behavior: 'instant' });
    closePopups();
    await sleep(200);
    // 前面 typeDate 点开过的面板还在关闭动画里：等它真关了再记「原来就开着的」，不然同一个面板重开会被当成老的（引擎实测）
    await waitFor(() => !datePops(host).some((p) => viewsOf(p).length), 1000);
    const before = new Set(datePops(host));
    // class 认不出的自制面板：点开以后新加进页面的元素也算候选（夹具实测，光靠 class 列表找不到）
    const added = [];
    const mo = new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) added.push(n); });
    mo.observe(document.body, { childList: true, subtree: true });
    try { return await pickDateInner(host, inputs, want, before, added); } finally { mo.disconnect(); }
  }
  async function pickDateInner(host, inputs, want, before, added) {
    const getPop = () => {
      const extra = added.filter((e) => e.isConnected && visible(e) && !e.contains(host) && !host.contains(e));
      const ps = [...datePops(host), ...extra.filter((e) => !extra.some((o) => o !== e && o.contains(e)))];
      return ps.filter((p) => !before.has(p) && !ps.some((o) => o !== p && o.contains(p)) && viewsOf(p).length).pop() || null;
    };
    const trigger = inputs[0] || host;
    if (!realClick(trigger)) return { ok: false, why: '日期框被别的东西挡住了，没点' };
    trigger.focus?.();
    await waitFor(() => !!getPop(), 900);
    if (!getPop()) {
      // element-plus 这类：框已经聚焦了才认 mousedown 打开；你点的是侧边栏，页面本身没焦点，focus 事件不一定发出来（夹具实测）
      // 所以补发一次 focus / focusin，再点一次
      trigger.dispatchEvent(new FocusEvent('focus'));
      trigger.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      realClick(trigger);
      await waitFor(() => !!getPop(), 1500);
    }
    if (!getPop()) return { ok: false, why: '点了日期框，日期面板没弹出来' };
    const trace = [];
    for (const [k, t] of want.entries()) {
      if (k === 1 && inputs[1] && /\d{4}/.test(inputs[0].value)) {
        // antd 起止日期：选完开始日期它已经写进第一格了，靠 focus 事件切到第二格；页面没焦点时这个事件不来，
        // 再点日子会把开始日期改掉（夹具实测）。所以手动点一下第二格，让它知道接下来选的是结束日期
        realClick(inputs[1]);
        inputs[1].focus();
        inputs[1].dispatchEvent(new FocusEvent('focus'));
        inputs[1].dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        await sleep(300);
      }
      const r = await walkTo(t, getPop, trace);
      if (!r.ok) { closePopups(); return { ok: false, why: r.why, got: valueOf({ el: host, kind: 'date' }), trace: trace.slice(-12) }; }
      if (r.closed) break;
    }
    // 选完面板一般自己关（antd 起止日期要等关闭动画走完才落值，这时候按 Esc 会把刚选的撤掉 —— 夹具实测）
    await waitFor(() => !getPop(), 1200);
    // 还开着的：带时间的面板要点「确定」才生效，只在日期面板里面找这个按钮
    const pop = getPop();
    if (pop) {
      const okBtn = [...pop.querySelectorAll('button, a, span, [role="button"]')].find((b) => visible(b) && /^(确定|确认|OK)$/i.test(norm(b.innerText || '')) && !SUBMIT_RE.test(norm(b.innerText || '')) && !b.closest('a[href]'));
      if (okBtn) { realClick(okBtn); await waitFor(() => !getPop(), 1000); }
      if (getPop()) closePopups();
    }
    await sleep(250);
    // 回读：每一格读出来的年月（日）要和目标一样
    const got = inputs.length >= 2 ? inputs.map((i) => i.value).join(' ~ ') : (inputs[0]?.value || valueOf({ el: host, kind: 'date' }));
    const gotDates = [...String(got).matchAll(/((?:19|20)\d{2})\D{1,3}(\d{1,2})(?:\D{1,3}(\d{1,2}))?/g)].map((m) => ({ y: Number(m[1]), m: Number(m[2]), d: m[3] ? Number(m[3]) : 0 }));
    const ok = want.every((t, k) => gotDates[k] && gotDates[k].y === t.y && gotDates[k].m === t.m && (!t.d || !gotDates[k].d || gotDates[k].d === t.d));
    return { ok, got, ...(ok ? {} : { why: `点完回读是「${got || '空'}」，对不上`, trace: trace.slice(-12) }) };
  }

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

  // ---------------------------------------------------------------- 认不出的弹层：压成带编号的精简 HTML，让模型挑点哪个（思路参考求职方舟 k.Co / k.Go / k.Ko，代码自己写）
  // 选城市 / 学校 / 专业那种多标签弹窗，选项不在常见组件库的 class 里，openSelect 读不出来。
  // 只发弹层里的文字（去掉所有属性、输入框的值、长串数字和邮箱），不发页面别处的东西；点之前过一遍安全规矩
  const POPLIKE_SEL = `${POPUP_SEL}, [role="dialog"], [class*="modal"], [class*="dialog"], [class*="drawer"], [class*="layer"], [class*="popover"], [class*="overlay"], [class*="picker"]`;
  // 弹层里的这些按钮插件不点（确定 / 保存 / 提交 / 投递…）：碰到就停下让你点
  const STOP_BTN_RE = /^(确定|确认|保存|提交|投递|完成|下一步|确定选择|确认选择|立即投递|申请)/;
  let rawBase = new Set();
  let rawAdded = [];
  let rawMo = null;
  let rawHost = null;
  let refMap = new Map();
  let rawPop = null;

  /**
   * 开始记「点开以后新冒出来的」：openSelect 每次点之前都调。同一个框上次点出来、现在还开着的那层留着
   * （自制弹窗 Esc 关不掉，第二次点又不会再弹一个新的 —— 引擎实测，原来就这样漏掉了）
   */
  function rawStart(host) {
    const keep = rawHost === host ? rawAdded.filter((e) => e.isConnected && visible(e)) : [];
    rawHost = host;
    rawAdded = keep;
    rawBase = new Set([...document.querySelectorAll(POPLIKE_SEL)].filter((e) => visible(e) && !keep.some((k) => k.contains(e) || e.contains(k))));
    rawMo?.disconnect();
    const mo = new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) rawAdded.push(n); });
    mo.observe(document.body, { childList: true, subtree: true });
    rawMo = mo;
    // 弹层都是点完两三秒内出来的，过了就不记了，免得一直挂着观察整页
    setTimeout(() => mo.disconnect(), 5000);
  }

  async function openRaw(ref) {
    const host = byRef(ref);
    if (!host) return { ok: false, why: '字段不见了' };
    rawStart(host);
    // 前面 openSelect 点出来的那层还开着就直接用，别再点一次（再点可能把它关掉）
    if (unknownPopup()) return { ok: true };
    host.scrollIntoView({ block: 'center', behavior: 'instant' });
    const trigger = host.querySelector('.ant-select-selector, .el-select__wrapper, .el-input__inner, .el-input, .ivu-select-selection, input') || host;
    if (!realClick(trigger)) return { ok: false, why: '框被别的东西挡住了，没点' };
    trigger.focus?.();
    await waitFor(() => !!unknownPopup(), 2000);
    await waitOptsStable(1500);
    return { ok: !!unknownPopup(), why: unknownPopup() ? '' : '点了没弹出任何东西' };
  }

  /** 点开以后新冒出来的那一层：新加进页面的、或者原来没显示现在显示了的弹层，取最外层、最后出现的那个 */
  function unknownPopup() {
    const big = (e) => e?.isConnected && visible(e) && e.getBoundingClientRect().width >= 100 && e.getBoundingClientRect().height >= 50 && textOf(e);
    const cands = [...rawAdded.filter((e) => e.isConnected), ...[...document.querySelectorAll(POPLIKE_SEL)].filter((e) => !rawBase.has(e))]
      .filter((e) => big(e) && rawHost && !e.contains(rawHost) && !rawHost.contains(e) && !e.closest('.jfz-badge'));
    const outer = cands.filter((e) => !cands.some((o) => o !== e && o.contains(e)));
    return outer[outer.length - 1] || null;
  }

  const redact = (s) => String(s || '').replace(/[^\s@]+@[^\s@]+\.[a-z]{2,}/gi, '[邮箱]').replace(/\d{7,}/g, '[数字]');
  /** 弹层 → 精简 HTML：去掉所有属性和看不见的；能点的（按钮、链接、li、短文字叶子）编号 r="N"，选中的标 sel */
  function snapshotPopup() {
    rawPop = unknownPopup();
    refMap = new Map();
    if (!rawPop) return { html: '' };
    let n = 0;
    const walk = (el) => {
      if (!visible(el)) return '';
      const tag = el.tagName.toLowerCase();
      if (/^(script|style|svg|img|canvas|noscript|iframe|input|textarea|select|video|audio)$/.test(tag)) return '';
      let inner = '';
      for (const c of el.childNodes) {
        if (c.nodeType === 3) inner += redact(c.textContent.replace(/\s+/g, ' '));
        else if (c.nodeType === 1) inner += walk(c);
      }
      inner = inner.trim();
      if (!inner) return '';
      const own = [...el.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent).join('').trim();
      const role = el.getAttribute('role') || '';
      const kids = [...el.children].filter((c) => textOf(c));
      const clickable = /^(button|a|label|li)$/.test(tag) || /option|menuitem|tab|button|treeitem|checkbox|radio/.test(role) || (own && own.length <= 40 && !kids.length);
      const sel = /(^|[\s_-])(active|selected|checked|current)([\s_-]|$)/i.test(clsOf(el)) || el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-checked') === 'true';
      if (clickable) { refMap.set(++n, el); return `<${tag} r="${n}"${sel ? ' sel' : ''}>${inner}</${tag}>`; }
      // 只包了一层的 div / span 直接拆掉，省字
      if (/^(div|span|section)$/.test(tag) && kids.length <= 1 && !own) return inner;
      return `<${tag}>${inner}</${tag}>`;
    };
    let html = walk(rawPop);
    if (html.length > 6000) html = html.slice(0, 6000) + '…（后面截掉了）';
    return { html, count: n };
  }

  /** 点精简 HTML 里编号 r 的那个；链接、确定 / 保存 / 提交类不点 */
  async function clickR(r) {
    const el = refMap.get(Number(r));
    if (!el || !el.isConnected || !visible(el)) return { ok: false, why: '那个编号的元素不见了' };
    const t = norm(el.innerText || el.textContent || '');
    const a = el.closest('a[href]') || el.querySelector('a[href]');
    if (a && !/^(#|javascript:)/i.test(a.getAttribute('href') || '')) return { ok: false, why: `「${t.slice(0, 12)}」是链接，不点` };
    if (SUBMIT_RE.test(t) || STOP_BTN_RE.test(t) || /提交|投递/.test(t)) return { ok: false, stop: true, why: `弹层要点「${t.slice(0, 8)}」才生效，这类按钮插件不点，你点一下` };
    if (!realClick(leafOf(el))) return { ok: false, why: `「${t.slice(0, 12)}」被挡住了，没点` };
    await sleep(250);
    await waitOptsStable(1500);
    return { ok: true, text: t.slice(0, 40), closed: !unknownPopup() };
  }
  function closeRaw() { rawMo?.disconnect(); rawMo = null; closePopups(); return { ok: true }; }

  // ---------------------------------------------------------------- 「编辑 → 保存」型分块（思路参考求职方舟 k.u / B.Z / B.q，规则自己写）
  // 有的网申（国企、银行常见）每块平时只显示文字，点「编辑」才出框，填完要点这一块自己的「保存」。
  // 你同意点分块自己的保存（10/16），但只认这一块容器里、文字是保存类的按钮；整页的「提交 / 投递 / 完成申请」永远不点
  const EDIT_RE = /^(编辑|修改)$/;
  const SAVE_RE = /^(保存|确定保存|保存本段|保存本条|保存修改|保存信息|保存并关闭)$/;
  function editBlocks() {
    const out = [];
    const seen = new Set();
    for (const b of document.querySelectorAll('button, a, span, i, [role="button"], div')) {
      if (!visible(b) || b.closest('[data-jfz-ref]')) continue;
      const t = norm(b.innerText || '');
      const iconEdit = !t && /^(i|span)$/i.test(b.tagName) && /(^|[^a-z])edit([^a-z]|$)/i.test(clsOf(b));
      if (!EDIT_RE.test(t) && !iconEdit) continue;
      if (b.children.length > 2 || [...b.children].some((c) => EDIT_RE.test(norm(c.innerText || '')))) continue;   // 只要最里面那层
      const a = b.closest('a[href]');
      if (a && !/^(#|javascript:)/i.test(a.getAttribute('href') || '')) continue;
      const sec = sectionOf(b);
      if (!sec.name || !sec.head) continue;
      // 这一块现在是「只读」：从标题往上到同时装着按钮的那层，里面一个输入框都没有
      let box = sec.head.parentElement;
      while (box && !box.contains(b)) box = box.parentElement;
      if (!box || controlsIn(box) > 0) continue;
      const key = refOf(b);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ref: key, section: sec.name, text: t || '编辑图标' });
    }
    // 同一分块有好几个「编辑」（每段经历一个）：记第几个，填的时候对应素材库第几条
    const n = {};
    for (const e of out) { n[e.section] = (n[e.section] || 0) + 1; e.nth = n[e.section]; }
    return { list: out };
  }

  /** 点这一块自己的保存：从刚填的这些框往上找，找到的那层里装的框不能比这一块多（不然就是整页的保存了），弹窗里的算这一块 */
  async function saveBlock(refs) {
    const els = refs.map(byRef).filter(Boolean);
    if (!els.length) return { ok: false, why: '这一块的框不见了' };
    let anc = els[0];
    while (anc && !els.every((e) => anc.contains(e))) anc = anc.parentElement;
    const dlg = activeDialog();
    let btn = null;
    for (let node = anc, hop = 0; node && hop < 8 && !btn; node = node.parentElement, hop++) {
      const inDialog = dlg && dlg.contains(node);
      if (!inDialog && controlsIn(node) > els.length + 2) break;
      const btns = [...node.querySelectorAll('button, a, span, [role="button"], input[type=button]')]
        .filter((b) => visible(b) && b.children.length <= 2);
      btn = btns.find((b) => SAVE_RE.test(norm(b.innerText || b.value || '')))
        // 编辑弹窗里「确定 / 取消」一对：这一块的确定就是保存
        || (inDialog ? btns.find((b) => /^确定$/.test(norm(b.innerText || b.value || '')) && btns.some((c) => /^取消$/.test(norm(c.innerText || c.value || '')))) : null)
        || null;
      if (node === document.body) break;
    }
    if (!btn) return { ok: false, why: '这一块里没找到自己的「保存」按钮，你填完自己点保存' };
    const t = norm(btn.innerText || btn.value || '');
    if (SUBMIT_RE.test(t) || /提交|投递|申请|完成/.test(t) || (btn.closest('a[href]') && !/^(#|javascript:)/i.test(btn.closest('a[href]').getAttribute('href') || ''))) return { ok: false, why: `按钮是「${t}」，不点` };
    if (!realClick(btn)) return { ok: false, why: '保存按钮被挡住了，没点' };
    await sleep(1200);
    // 读网站的红字：这一块里的表单项报错 + 全局的报错提示条
    const errs = [];
    const scope = anc?.isConnected ? anc : document;
    for (const e of scope.querySelectorAll(SITE_ERR_SEL)) if (visible(e) && textOf(e) && textOf(e).length <= 60) errs.push(textOf(e));
    for (const e of document.querySelectorAll('.ant-message-error, .el-message--error, .ivu-message-error, .arco-message-error, .t-message--error, .layui-layer-msg, [class*="message"][class*="error"], [class*="toast"][class*="error"]')) if (visible(e) && textOf(e)) errs.push(textOf(e).slice(0, 60));
    const closed = !els.some((e) => e.isConnected && visible(e));
    return { ok: !errs.length, clicked: t, errors: [...new Set(errs)].slice(0, 6), closed };
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
    if (!realClick(el)) return { ok: false, why: '按钮被别的东西挡住了，没点' };
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
    pickDate: (p) => pickDatePanel(p.ref, p.value),
    openRaw: (p) => openRaw(p.ref),
    snapshotPopup: () => snapshotPopup(),
    clickR: (p) => clickR(p.r),
    closeRaw: () => closeRaw(),
    editBlocks: () => editBlocks(),
    clickEdit: (p) => clickAdd(p.ref),
    saveBlock: (p) => saveBlock(p.refs || []),
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
