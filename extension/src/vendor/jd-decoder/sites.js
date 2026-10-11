/*
 * 各招聘网站上「岗位描述在哪」。网站改版时只改这里。
 * 每项是候选选择器数组，按顺序试，命中第一个就用；都不中再用通用猜法。
 */
(function (root) {
  const JDD = (root.JDD = root.JDD || {});

  JDD.SITES = [
    {
      name: 'BOSS直聘',
      host: /(^|\.)zhipin\.com$/,
      // 详情页 /job_detail/ 和搜索页右侧详情栏
      jd: ['.job-sec-text', '.job-detail-box .desc', '.job-detail-body .desc', '.job-detail-section .text', '.job-sec .text'],
      salary: ['.job-banner .salary', '.job-detail-box .job-salary', '.info-primary .salary', '.job-detail-info .job-salary'],
    },
    {
      name: '前程无忧',
      host: /(^|\.)51job\.com$/,
      jd: ['.bmsg.job_msg', '.job_msg', '.jobdetail-desc', '[class*="job-desc"]'],
      salary: ['.cn strong', '.jobdetail-salary', '[class*="salary"]'],
    },
    {
      name: '智联招聘',
      host: /(^|\.)zhaopin\.com$/,
      jd: ['.describtion-card__detail-content', '.describtion__detail-content', '.job-detail__description', '.pos-ul'],
      salary: ['.summary-plane__salary', '.job-summary__salary', '[class*="salary"]'],
    },
    {
      name: '猎聘',
      host: /(^|\.)liepin\.com$/,
      jd: ['[data-selector="job-intro-content"]', '.job-intro-container dd', '.job-description'],
      salary: ['.job-salary', '.job-apply-content .salary', '[class*="salary"]'],
    },
  ];

  JDD.siteFor = (hostname) => JDD.SITES.find((s) => s.host.test(hostname)) || null;

  const PUA = /[-]/g; // BOSS 列表页的防爬字体字符，读出来是乱码
  const visibleCache = new WeakMap();
  function isShown(el) {
    if (visibleCache.has(el)) return visibleCache.get(el);
    const cs = el.ownerDocument.defaultView.getComputedStyle(el);
    const ok = cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0' && !(parseFloat(cs.fontSize) === 0);
    visibleCache.set(el, ok);
    return ok;
  }
  const BLOCK = /^(P|DIV|LI|UL|OL|DD|DT|DL|SECTION|ARTICLE|H[1-6]|TR|TABLE|PRE|BLOCKQUOTE)$/;

  function first(doc, sels) {
    for (const s of sels) {
      try {
        const el = doc.querySelector(s);
        if (el && el.textContent.trim().length >= 20) return el;
      } catch (e) { /* 选择器写错就跳过 */ }
    }
    return null;
  }

  /* 通用猜法：包含「职责/要求」字样、字数像一段 JD、里面没有更小的同类块 */
  function guess(doc) {
    const KEY = /(岗位|工作|职位)(职责|内容|描述)|任职(要求|资格)|职位要求/;
    const cands = [...doc.querySelectorAll('div, section, dd, article')].filter((el) => {
      const t = el.textContent || '';
      return t.length >= 40 && t.length <= 6000 && KEY.test(t) && isShown(el);
    });
    const leaves = cands.filter((el) => !cands.some((o) => o !== el && el.contains(o)));
    return leaves.sort((a, b) => b.textContent.length - a.textContent.length)[0] || null;
  }

  JDD.findJD = function (doc, site) {
    if (site) {
      const el = first(doc, site.jd);
      if (el) return el;
    }
    return guess(doc);
  };

  JDD.findSalary = function (doc, site) {
    if (!site) return '';
    for (const s of site.salary) {
      try {
        const el = doc.querySelector(s);
        const t = el && el.textContent.replace(PUA, '').trim();
        if (t && /\d/.test(t) && t.length < 40) return t;
      } catch (e) { /* 同上 */ }
    }
    return '';
  };

  /*
   * 把元素里看得见的字拼成一段文字，同时记下每个文字节点在这段里的起点，
   * 高亮时才能把「第 i 到 j 个字」对回页面上的节点。
   * 块级元素和 <br> 之间补一个换行（虚拟字符，不对应任何节点）。
   */
  JDD.textMap = function (rootEl) {
    const parts = [];
    let text = '';
    const walk = (node) => {
      if (node.nodeType === 3) {
        const v = node.nodeValue;
        if (v) { parts.push({ node, start: text.length }); text += v; }
        return;
      }
      if (node.nodeType !== 1) return;
      if (node.tagName === 'BR') { text += '\n'; return; }
      if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(node.tagName)) return;
      if (node !== rootEl && !isShown(node)) return; // BOSS 会在 JD 里塞看不见的干扰字
      const block = node !== rootEl && BLOCK.test(node.tagName);
      if (block && text && !text.endsWith('\n')) text += '\n';
      for (const c of node.childNodes) walk(c);
      if (block && text && !text.endsWith('\n')) text += '\n';
    };
    walk(rootEl);
    return { text, parts };
  };

  /* 按 [i, j) 区间给原文包 <mark>。倒着包，前面的偏移量就不会被打乱 */
  JDD.highlight = function (map, marks, makeMark) {
    const done = [];
    for (let x = marks.length - 1; x >= 0; x--) {
      const m = marks[x];
      for (let p = map.parts.length - 1; p >= 0; p--) {
        const { node, start } = map.parts[p];
        const end = start + node.nodeValue.length;
        if (end <= m.i || start >= m.j) continue;
        const a = Math.max(m.i, start) - start;
        const b = Math.min(m.j, end) - start;
        if (b <= a) continue;
        let target = node;
        if (b < target.nodeValue.length) target.splitText(b);
        if (a > 0) target = target.splitText(a);
        const mk = makeMark(m);
        target.parentNode.insertBefore(mk, target);
        mk.appendChild(target);
        done.push(mk);
      }
    }
    return done;
  };

  JDD.unhighlight = function (rootEl, cls) {
    rootEl.querySelectorAll('mark.' + cls).forEach((mk) => {
      const parent = mk.parentNode;
      while (mk.firstChild) parent.insertBefore(mk.firstChild, mk);
      parent.removeChild(mk);
      parent.normalize();
    });
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
