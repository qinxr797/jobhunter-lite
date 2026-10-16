# watcher 设计备忘

## 目录约定（和 desktop\ 一致）

- `HRDESK_HOME`：安装目录，外壳拉起时传；没传就当 watcher 的上一级。
- `HRDESK_DATA`：数据目录，外壳拉起时传；没传就是 `<安装目录>\data`。
- 设置：`<数据目录>\config.json`，外壳的设置向导写，watcher 只读，按修改时间热读。
- watcher 自己的数据：`<数据目录>\watcher\`。外壳往这里写 `desk.json`（盯梢专用页的 targetId）和 `applied-log.jsonl`（网申「我交了」的兜底记录）。
- 端口：外壳 CDP 9401，兼容口 9402-9405，收件箱 8790，都能在 config 的 `ports` 改。

## 插件宿主（plugin-host.mjs）

插件要用 tabs / scripting / sidePanel，Electron 的 `session.loadExtension` 跑不全，所以按需拉一个无头浏览器：

- 浏览器：`config.browserPath`，然后找 Chrome，最后找 Edge（Win10/11 自带）。10/16 实测 Chrome 155 和 Edge 都认 `--enable-unsafe-extension-debugging` 加 CDP `Extensions.loadUnpacked`。
- 资料目录 `<数据>\watcher\.chrome-plugin`；端口挑空闲的，写进 `plugin-host.json`。
- **重载插件只许 `Extensions.loadUnpacked` 原地重载**：同一路径就是同一个 id，存储也还在。**绝不调 `Extensions.uninstall`**，它会清空插件存储。

## 去个人化

- 提示词全部在 `prompts.mjs`，由设置拼出来：自我介绍、城市、简历、求职标准、作品集、期望薪资、微信小号、好单位条目。
- 作者私有仓库里的同步脚本从自用版取代码：先按文件精确替换（原文找不到就报错），再做通用清理，最后过一遍隐私红线扫描，命中就整批不落盘。
- 不带的东西：开机自启脚本（由外壳负责拉起）、作者的投递 xlsx 导入（applied 只走 tracker 和 applied-log）、虚拟桌面判断。

## 以后

- 评分和网申引擎改成在 Node 里给插件模块做一个 chrome 替身直接 import，不用再开浏览器。桌面助手的网申填表已经是这么跑的。
- 智联、猎聘的城市代码目前要在设置里手填（`cityCodes.zhilian / liepin`）；以后补一张城市代码表。
