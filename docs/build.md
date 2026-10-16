# 自己改代码、打包

## 目录

- `desktop/`：桌面外壳（Electron）。顶栏、各平台网页、网申面板、设置向导都在这里。
- `watcher/`：后台。包括盯 HR 消息、收件箱服务（127.0.0.1:8790）、投递总表、找岗位。外壳用自己带的 Node 拉起它，不用另外装。
- `extension/`：求职插件。外壳会把网申填表和查公司的代码从这里加载进来；找岗位时，后台会把它装进一个看不见的 Chrome / Edge。
- `data/`：运行时才生成，放设置（`config.json`）、各平台登录状态、日志和投递库。不进仓库，也不进安装包。

路径都是从安装目录推出来的，见 `desktop/paths.js`。可以用环境变量 `HRDESK_HOME` 和 `HRDESK_DATA` 改位置。

## 开发时跑起来

```
cd desktop
npm install
npx electron .
```

想和已经装好的那份同时开（比如测试），把端口错开：`HRDESK_CDP_PORT=9451`、`HRDESK_INBOX=http://127.0.0.1:8795`、`HRDESK_TAB_PORTS=0`。

## 打便携包

需要 PowerShell 7 和 Node.js 22 以上。

```
pwsh tools\build-portable.ps1
```

包会输出到 `dist\jobhunter-v<版本>-win64.zip`，打完会自动跑一遍隐私扫描。

## 发布前的隐私扫描

```
node tools/privacy-scan.mjs --git --terms <你自己的敏感词清单>
```

扫的范围是整个仓库、git 全部历史，以及 zip 里的文件（`app.asar` 也会拆开扫）。内置规则会查身份证号、API Key、Telegram token、本机用户目录和手机号。敏感词清单是一个文本文件，一行一个词，比如名字、电话、学校，**只放在你自己电脑上，别放进仓库**。确认过的误报写进 `tools/privacy-allow.txt`，格式是「文件:行号」。有一处命中就不许推。
