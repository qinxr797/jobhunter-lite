/**
 * 模块 C 第 3 条：聊天里 HR 甩过来的网申链接（v0.7.0）。
 * 挂在 BOSS 聊天页和智联消息页，只读：看当前打开的会话里对方发的消息，
 * 命中网申系统的域名（mokahr / hotjob / feishu / zhiye / wjx …），或者提到「官网投递 / 网申 / 问卷 / 附加信息 / 测评」的，
 * 记成一张「网申待填」卡片（chrome.storage.local.afTodo），写明哪个平台、哪家、哪个 HR、原话。一个按钮都不点。
 *
 * 分不出是谁发的消息时按位置判断：气泡在聊天区左半边的是对方发的（两家聊天页都是对方靠左、自己靠右）。
 * 选择器 9/28 没在真聊天页核对过（没登录态），用的是位置 + 文字，不依赖 class 名。
 */
(() => {
  if (window.__jfzChatLinks) return;
  window.__jfzChatLinks = true;

  const DOMAINS = /(mokahr\.com|hotjob\.cn|jobs\.feishu\.cn|feishu\.cn\/hire|zhiye\.com|wjx\.cn|wjx\.top|iguopin\.com|campus\.51job\.com|xiaoyuan\.zhaopin\.com|zhaopin\.com\/campus|beisen|italent\.cn|dayee\.com|hr\.[a-z0-9-]+\.com|jobs\.[a-z0-9-]+\.com|career|recruit|campus)/i;
  const KEYWORDS = /官网投递|官网申请|网申|填写问卷|填个问卷|问卷|附加信息|测评|在线测试|报名表|申请表|简历链接|投递链接/;
  const PLATFORM = /zhipin\.com/.test(location.host) ? 'boss' : /zhaopin\.com/.test(location.host) ? 'zhilian' : 'other';
  const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  function header() {
    // 聊天窗口顶部：公司 / HR 名字（BOSS 用 base-info，智联没核对过，取右侧主区域最上面一段短文字）
    const h = document.querySelector('[class*="base-info"], .chat-header, [class*="chat-header"], [class*="im-header"], [class*="session-header"]');
    return squash(h?.innerText || '').slice(0, 80);
  }

  function scan() {
    const pane = [...document.querySelectorAll('[class*="chat-message"], [class*="message-list"], [class*="im-list"], [class*="msg-list"], [class*="chat-record"], [class*="im-content"], main')]
      .filter((e) => e.getBoundingClientRect().width > 200).sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
    if (!pane) return;
    const pr = pane.getBoundingClientRect();
    const mid = pr.left + pr.width / 2;
    const found = [];
    const seen = new Set();
    // 链接：<a href> 和纯文本里的网址都算
    const bubbles = [...pane.querySelectorAll('a[href], p, span, div')].filter((e) => e.children.length <= 3 && squash(e.innerText).length > 0 && squash(e.innerText).length < 600);
    for (const b of bubbles) {
      const t = squash(b.innerText);
      const href = b.tagName === 'A' ? b.href : (t.match(/https?:\/\/[^\s，。]+/) || [])[0] || '';
      const hitLink = href && DOMAINS.test(href);
      const hitWord = !href && KEYWORDS.test(t);
      if (!hitLink && !hitWord) continue;
      const r = b.getBoundingClientRect();
      if (r.width === 0) continue;
      const fromOther = (r.left + r.right) / 2 < mid;     // 左半边 = 对方发的
      if (!fromOther) continue;
      const key = href || t.slice(0, 80);
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ link: href, quote: t.slice(0, 200), kind: hitLink ? '网申链接' : '提到网申 / 问卷' });
    }
    if (!found.length) return;
    const head = header();
    chrome.storage.local.get('afTodo').then(({ afTodo = {} }) => {
      let changed = false;
      for (const f of found) {
        const id = `${PLATFORM}|${head}|${f.link || f.quote.slice(0, 60)}`;
        if (afTodo[id]) continue;
        afTodo[id] = { id, platform: PLATFORM, header: head, ...f, pageUrl: location.href, at: Date.now(), state: '待填' };
        changed = true;
      }
      if (changed) chrome.storage.local.set({ afTodo });
    }).catch(() => {});
  }

  let timer = null;
  const kick = () => { clearTimeout(timer); timer = setTimeout(scan, 1500); };
  new MutationObserver(kick).observe(document.documentElement, { childList: true, subtree: true });
  kick();
})();
