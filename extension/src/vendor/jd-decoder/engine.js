/*
 * 翻译引擎：纯函数，不碰 DOM，浏览器和 Node 都能跑（测试见 test/）。
 *
 *   JDD.analyze(text, prefs) -> {
 *     marks:  [{i, j, k, c}]           原文里要高亮的片段（已去重叠，按位置排好）
 *     items:  [{k, c, w, say, ask, veto, quote, n}]   每种黑话一条，同一种只计一次分
 *     score:  0-100                    坑度
 *     level:  0 可以投 / 1 问清再说 / 2 快跑
 *     vetos:  items 里一票否决的那几条
 *     asks:   建议问 HR 的问题，最多 5 条
 *   }
 */
(function (root) {
  const JDD = (root.JDD = root.JDD || {});

  JDD.DEFAULT_PREFS = {
    minK: 4, // 薪资底线（K）
    bigSmallWeek: 'ask', // 大小周：ok 能接受 / ask 看情况 / no 不接受
    singleRestVeto: true, // 单休一票否决
    noTravel: false, // 不接受出差外派
    fresh: true, // 应届生或经验不足三年
    alwaysAskBase: true, // 每次都问无责底薪
    plus: [], // 自定义加分词
    minus: [], // 自定义避雷词
  };

  JDD.LEVELS = [
    { name: '可以投', color: '#2f8a57', lines: ['看着挺正经，投吧。面试时把下班时间当面再问一遍。', '没翻出什么坑，放心投。', '干净得让人有点不习惯。'] },
    { name: '问清再说', color: '#c98a12', lines: ['不是不能去，但下面那几个问题问不清楚别往下走。', '有几句话术，先把钱和下班时间问清楚。', '一半是正经岗位，一半是话术，问一问就知道是哪一半。'] },
    { name: '快跑', color: '#c2362b', lines: ['这段话每一句都在劝你别来。', '翻完了，结论只有两个字。', '不用问了，去翻下一家。'] },
  ];

  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const THRESHOLD = { ask: 25, run: 55, vetoFloor: 70 };
  const BASE_ASK = '无责底薪是多少？就是不看业绩也一定拿到手的那部分。';

  JDD.normalizePrefs = function (p) {
    const d = JDD.DEFAULT_PREFS;
    const o = Object.assign({}, d, p || {});
    o.minK = Number.isFinite(+o.minK) && +o.minK >= 0 ? +o.minK : d.minK;
    if (!['ok', 'ask', 'no'].includes(o.bigSmallWeek)) o.bigSmallWeek = d.bigSmallWeek;
    const words = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,，、\s]+/)).map((s) => String(s).trim()).filter(Boolean).slice(0, 50);
    o.plus = words(o.plus);
    o.minus = words(o.minus);
    return o;
  };

  /* 按设置把词典展开成这一次要用的规则表 */
  JDD.activeRules = function (prefs) {
    const p = JDD.normalizePrefs(prefs);
    const out = [];
    for (const r of JDD.RULES) {
      let rule = r;
      if (r.tune) {
        const t = r.tune(p);
        if (t === null) continue;
        rule = Object.assign({}, r, t);
      }
      if (!rule.w) continue;
      out.push(rule);
    }
    if (p.plus.length) out.push({ k: '你的加分词', custom: true, re: new RegExp(p.plus.map(escRe).join('|'), 'gi'), c: 'good', w: -12, say: '命中了你在设置里填的加分词。' });
    if (p.minus.length) out.push({ k: '你的避雷词', custom: true, re: new RegExp(p.minus.map(escRe).join('|'), 'gi'), c: 'fit', w: 25, say: '命中了你在设置里填的避雷词。' });
    return { rules: out, prefs: p };
  };

  JDD.analyze = function (text, prefs) {
    text = String(text || '');
    const { rules, prefs: p } = JDD.activeRules(prefs);
    const hits = [];

    for (const r of rules) {
      const re = new RegExp(r.re.source, r.re.flags.includes('g') ? r.re.flags : r.re.flags + 'g');
      let m;
      while ((m = re.exec(text))) {
        if (!m[0]) { re.lastIndex++; continue; }
        hits.push({ i: m.index, j: m.index + m[0].length, rule: r });
      }
    }
    for (const r of JDD.CALC) {
      for (const h of r.test(text, p)) hits.push({ i: h.i, j: h.j, rule: Object.assign({}, r, { say: h.say, ask: h.ask }) });
    }

    // 重叠的只留一个：绝对分高的优先，其次长的，其次靠前的
    hits.sort((a, b) => Math.abs(b.rule.w) - Math.abs(a.rule.w) || (b.j - b.i) - (a.j - a.i) || a.i - b.i);
    const kept = [];
    for (const h of hits) if (!kept.some((t) => h.i < t.j && t.i < h.j)) kept.push(h);
    kept.sort((a, b) => a.i - b.i);

    const byK = new Map();
    for (const h of kept) {
      const r = h.rule;
      if (!byK.has(r.k)) {
        byK.set(r.k, { k: r.k, c: r.c, w: r.w, say: r.say, ask: r.ask || null, veto: !!r.veto, quote: r.label ? r.k : text.slice(h.i, h.j), n: 0 });
      }
      byK.get(r.k).n++;
    }
    const items = [...byK.values()];
    const names = new Set(items.map((x) => x.k));
    for (const c of JDD.COMBOS) {
      if (c.need.every((n) => names.has(n)) && c.any.some((n) => names.has(n))) {
        items.push({ k: c.k, c: c.c, w: c.w, say: c.say, ask: null, veto: false, quote: '组合技', combo: true, n: 1 });
      }
    }

    const vetos = items.filter((x) => x.veto);
    let score = Math.max(0, Math.min(100, Math.round(items.reduce((s, x) => s + x.w, 0))));
    let level = score < THRESHOLD.ask ? 0 : score < THRESHOLD.run ? 1 : 2;
    if (vetos.length) { level = 2; score = Math.max(score, THRESHOLD.vetoFloor); }

    // 坏的按分从高到低，好的按分从好到次
    items.sort((a, b) => (b.veto - a.veto) || ((b.w > 0) - (a.w > 0)) || (b.w > 0 ? b.w - a.w : a.w - b.w));

    const asks = [];
    const push = (q) => {
      if (!q || asks.length >= 5) return;
      if (/无责底薪/.test(q) && asks.some((a) => /无责底薪/.test(a))) return;
      if (asks.includes(q)) return;
      asks.push(q);
    };
    if (p.alwaysAskBase) push(BASE_ASK);
    items.filter((x) => x.ask && x.w > 0).forEach((x) => push(x.ask));
    if (!names.has('准点下班') && !asks.some((q) => /下班/.test(q))) push('一般几点下班？');
    if (!['双休', '单休', '大小周', '单双休'].some((k) => names.has(k)) && !asks.some((q) => /双休|周末/.test(q))) push('是周末双休吗？');
    items.filter((x) => x.ask && x.w < 0).forEach((x) => push(x.ask));

    return {
      marks: kept.map((h) => ({ i: h.i, j: h.j, k: h.rule.k, c: h.rule.c, say: h.rule.say })),
      items, score, level, vetos, asks,
    };
  };

})(typeof globalThis !== 'undefined' ? globalThis : window);
