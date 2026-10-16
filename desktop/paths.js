// 所有路径都从「安装目录」<home> 算，不写死任何盘符：
//   <home>\HR Desk\HR Desk.exe   打包后的软件（exe 往上两级就是 <home>）
//   <home>\watcher\               后台：盯梢 + 收件箱 + 投递总表 + 找岗位
//   <home>\extension\             求职插件（网申填表、查公司的引擎从这里加载）
//   <home>\data\                  运行时生成：config.json、各平台登录状态、日志、投递库。不进仓库、不进安装包
// 开发时（electron desktop）<home> 是仓库根目录；也可以用环境变量 HRDESK_HOME 指定
const path = require('node:path');
let packaged = false;
try { packaged = require('electron').app?.isPackaged ?? false; } catch {}

const HOME = path.resolve(process.env.HRDESK_HOME || (packaged ? path.join(path.dirname(process.execPath), '..') : path.join(__dirname, '..')));
const DATA = path.resolve(process.env.HRDESK_DATA || path.join(HOME, 'data'));

module.exports = {
  HOME,
  DATA,
  WATCHER: path.join(HOME, 'watcher'),
  EXT: path.join(HOME, 'extension'),
  WATCH_DATA: path.join(DATA, 'watcher'),        // watcher 自己的数据（desk.json、status.json、tracker.db…），和窗口 3 约定的
  CONFIG: path.join(DATA, 'config.json'),         // 设置向导写、watcher 读
};
