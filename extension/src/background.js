/**
 * Service worker。这里只做几件轻活：
 *   1. 点扩展图标时打开侧边栏
 *   2. 首次安装时打开设置页
 *   3. 每天自动拉一次校招网申公告（v0.7.0）—— 只拉数据、本地初筛，不调模型；模型初筛在侧边栏里跑
 * 真正的调度循环在侧边栏里跑 —— service worker 空闲 30 秒就会被杀，扛不住分钟级流程。
 */
import { autoPull } from './lib/campus-source.js';
import { getConfig } from './lib/store.js';
import { cohortOf } from './lib/library.js';

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.runtime.openOptionsPage();
  ensureAlarm();
});
chrome.runtime.onStartup.addListener(ensureAlarm);

function ensureAlarm() {
  // 每 3 小时醒一次，autoPull 自己判断今天拉过没有（一天只自动拉 1 次，留 1 次给你手动）
  chrome.alarms.get('campus-pull', (a) => { if (!a) chrome.alarms.create('campus-pull', { delayInMinutes: 1, periodInMinutes: 180 }); });
}

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== 'campus-pull') return;
  try {
    const config = await getConfig();
    // 网申公告是应届校招的；简历里没填毕业时间（社招）就不拉
    if (cohortOf(config.resume?.graduation) >= new Date().getFullYear() - 1) {
      await autoPull(config.filter?.excludeKeywords || [], (config.filter?.cities || [])[0] || '');
    }
  } catch { /* 失败原因 pullCampus 自己写进 storage，侧边栏会标红 */ }
  await deadlineReminder().catch(() => {});
});

/**
 * v0.8.1：建议投的网申 3 天内截止、还没投的，一天提醒一次（侧边栏关着也能看到）。9 点前不打扰。
 */
async function deadlineReminder() {
  if (new Date().getHours() < 9) return;
  const { campus, campusRemindDay } = await chrome.storage.local.get(['campus', 'campusRemindDay']);
  const day = new Date().toDateString();
  if (campusRemindDay === day) return;
  const end = (d) => Math.floor((new Date(d + 'T23:59:59') - Date.now()) / 864e5);
  const soon = Object.values(campus?.items || {})
    .filter((x) => x.state === '已筛' && x.ai?.verdict === '投' && x.deadline && end(x.deadline) >= 0 && end(x.deadline) <= 3)
    .sort((a, b) => a.deadline.localeCompare(b.deadline));
  await chrome.storage.local.set({ campusRemindDay: day });
  if (!soon.length) return;
  chrome.notifications.create('campus-deadline', {
    type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: `${soon.length} 家建议投的网申 3 天内截止`,
    message: soon.slice(0, 5).map((x) => `${x.company}（${end(x.deadline) === 0 ? '今天' : `还剩 ${end(x.deadline)} 天`}）`).join('、') + '。打开侧边栏「网申」→「7 天内截止」看。',
  });
}

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
