#!/usr/bin/env node
// 发布前的隐私扫描：一条命中都不许推。
//   node tools/privacy-scan.mjs                       扫整个仓库（跳过 .git、node_modules、dist、data）
//   node tools/privacy-scan.mjs dist/求职助手.zip       扫便携包：zip 解开、里面的 app.asar 也拆开逐个文件扫
//   node tools/privacy-scan.mjs --git                 另外扫 git 全部历史（每次提交的改动和提交说明）
//   --terms <文件>  自己的敏感词清单（一行一个：名字、电话、学校、公司……），也可以用环境变量 PRIVACY_TERMS。
//                   这个清单只放在你自己电脑上，别放进仓库 —— 写进仓库就等于把它公开了。
// 不带清单也会跑内置的通用规则：身份证号、API Key、Telegram 机器人 token、本机用户目录、手机号。
import { readFileSync, readdirSync, statSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, relative, extname, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : null; };
const flag = (k) => { const i = args.indexOf(k); return i >= 0 ? (args.splice(i, 1), true) : false; };
const termsFile = opt('--terms') || process.env.PRIVACY_TERMS || '';
const withGit = flag('--git');
const targets = args.length ? args.map((a) => resolve(a)) : [ROOT];
// 白名单 tools/privacy-allow.txt：一行「位置片段<Tab>规则名<Tab>理由」，只能放确认过的误报（比如第三方库里碰巧像手机号的数字）
const ALLOW = (() => { try { return readFileSync(join(ROOT, 'tools', 'privacy-allow.txt'), 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#')).map((l) => l.split('\t')); } catch { return []; } })();
const allowed = (where, rule) => ALLOW.some(([w, r]) => where.replace(/\\/g, '/').includes(w) && (!r || r === rule));

// ---------- 规则 ----------
const RULES = [
  { name: '身份证号', re: /(?<![\dA-Za-z])[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?![\dA-Za-z])/g },
  { name: 'API Key（sk-）', re: /sk-[A-Za-z0-9_-]{20,}/g },
  { name: 'Telegram 机器人 token', re: /(?<!\d)\d{8,10}:[A-Za-z0-9_-]{30,}/g },
  { name: '本机用户目录', re: /[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}(?!(?:Public|Default|你的用户名|<[^>]*>|%[^%]*%|\$\{?[A-Za-z_]+)\b)[^\\/\s"'`<>]+/g },
  { name: '手机号', re: /(?<![\d.])1[3-9]\d{9}(?![\d.])/g },
];
let private_ = [];
if (termsFile) {
  if (!existsSync(termsFile)) { console.error(`敏感词清单不存在：${termsFile}`); process.exit(2); }
  private_ = readFileSync(termsFile, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const privRe = private_.map((t, i) => ({ name: `敏感词#${i + 1}`, show: t.length > 1 ? t[0] + '*'.repeat(t.length - 1) : '*', re: new RegExp(esc(t), 'gi') }));
// 仓库自己的地址（github.com/<账号>/jobhunter-lite）是公开信息，先抹掉再比对
const STRIP = /github\.com\/[A-Za-z0-9-]+\/jobhunter-lite/gi;

// ---------- 读文件 ----------
const SKIP_DIR = new Set(['.git', 'node_modules', 'dist', 'data', 'profile']);
const BINARY = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.icns', '.woff', '.woff2', '.ttf', '.otf', '.exe', '.dll', '.pak', '.bin', '.dat', '.node', '.so', '.dylib', '.zip', '.pdf', '.mp4', '.webm', '.wasm']);
const BIG = 8 * 1024 * 1024;
const hits = [], passed = [];
let scanned = 0;

// nums：每行对应的真实行号（git 改动里按 @@ 头算出来的文件行号）；不给就按 1、2、3… 数
function scanText(where, text, nums = null) {
  scanned++;
  const lines = text.replace(STRIP, '').split(/\r?\n/);
  lines.forEach((line, i) => {
    const at = `${where}:${nums ? nums[i] : i + 1}`;
    for (const r of [...RULES, ...privRe]) {
      r.re.lastIndex = 0;
      if (!r.re.test(line)) continue;
      const m = line.match(new RegExp(r.re.source, r.re.flags.replace('g', '')))?.[0] || '';
      if (allowed(at, r.name)) { passed.push(`${at} [${r.name}]`); continue; }
      hits.push({ where: at, rule: r.name, sample: r.show || (m.length > 6 ? m.slice(0, 3) + '…' + m.slice(-2) : m) });
    }
  });
}

// app.asar：头 16 字节后是一段 JSON 目录，文件内容在目录后面按 offset 排
function scanAsar(file, label) {
  const buf = readFileSync(file);
  const headerSize = buf.readUInt32LE(4), jsonLen = buf.readUInt32LE(12);
  const header = JSON.parse(buf.subarray(16, 16 + jsonLen).toString('utf8'));
  const base = 8 + headerSize;
  const walk = (node, p) => {
    for (const [name, n] of Object.entries(node.files || {})) {
      const sub = `${p}/${name}`;
      if (n.files) { walk(n, sub); continue; }
      if (n.unpacked || n.link || BINARY.has(extname(name).toLowerCase()) || n.size > BIG) continue;
      scanText(`${label}!${sub}`, buf.subarray(base + Number(n.offset), base + Number(n.offset) + n.size).toString('utf8'));
    }
  };
  walk(header, '');
}

function scanPath(p, label = p, inZip = false) {
  const st = statSync(p);
  if (st.isDirectory()) {
    for (const name of readdirSync(p)) {
      if (!inZip && SKIP_DIR.has(name)) continue;
      scanPath(join(p, name), join(label, name), inZip);
    }
    return;
  }
  const ext = extname(p).toLowerCase();
  if (ext === '.zip') {
    const dir = mkdtempSync(join(tmpdir(), 'privacy-'));
    // Windows 用系统自带的 tar（bsdtar，认 zip）；Git Bash 里的 GNU tar 会把「D:」当成远程主机
    const sysTar = process.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : '';
    try { execFileSync(sysTar && existsSync(sysTar) ? sysTar : 'tar', ['-xf', p, '-C', dir]); scanPath(dir, `${label}!`, true); }
    finally { rmSync(dir, { recursive: true, force: true }); }
    return;
  }
  if (ext === '.asar') return scanAsar(p, label);
  if (BINARY.has(ext) || st.size > BIG) return;
  scanText(label, readFileSync(p, 'utf8'));
}

for (const t of targets) scanPath(t, relative(process.cwd(), t) || '.');

if (withGit) {
  // 每次提交的改动 + 提交说明（作者名、邮箱不扫：那是 GitHub 账号本身，仓库地址里就有）
  const log = execFileSync('git', ['-C', ROOT, 'log', '--all', '-p', '--format=COMMIT %h%n%s%n%b', '--no-color'], { maxBuffer: 1 << 30 }).toString('utf8');
  // 按「提交 / 文件」切开，命中位置写成 git:<提交> <文件>，白名单也能按文件路径放行
  // 改动行用文件里的真实行号（新增行按新文件、删掉的行按旧文件），白名单「文件:行号」对 git 历史也管用
  let commit = '', file = '(提交说明)', buf = [], nums = [], oldN = 0, newN = 0, inDiff = false;
  const flush = () => { if (buf.length) scanText(`git:${commit} ${file}`, buf.join('\n'), nums); buf = []; nums = []; };
  for (const line of log.split('\n')) {
    const c = line.match(/^COMMIT (\w+)/), d = line.match(/^diff --git a\/(.+?) b\//), h = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
    if (c) { flush(); commit = c[1]; file = '(提交说明)'; inDiff = false; continue; }
    if (d) { flush(); file = d[1]; inDiff = true; continue; }
    if (h) { oldN = +h[1]; newN = +h[2]; continue; }
    if (!inDiff) { buf.push(line); nums.push(buf.length); continue; }
    if (/^(\+\+\+|---|index |new file|deleted file|similarity|rename |Binary )/.test(line)) continue;
    if (line.startsWith('+')) { buf.push(line.slice(1)); nums.push(newN++); }
    else if (line.startsWith('-')) { buf.push(line.slice(1)); nums.push(oldN++); }
    else { oldN++; newN++; }
  }
  flush();
}

// ---------- 报告 ----------
console.log(`扫了 ${scanned} 个文件${withGit ? '（含 git 历史）' : ''}；规则：通用 ${RULES.length} 条${termsFile ? ` + 敏感词 ${private_.length} 条` : '（没给敏感词清单，只跑了通用规则）'}`);
if (passed.length) console.log(`白名单放行 ${passed.length} 处：\n  ${passed.join('\n  ')}`);
if (!hits.length) { console.log('0 命中，可以发'); process.exit(0); }
console.log(`命中 ${hits.length} 处，不许推：`);
for (const h of hits.slice(0, 300)) console.log(`  ${h.where}  [${h.rule}]  ${h.sample}`);
if (hits.length > 300) console.log(`  …还有 ${hits.length - 300} 处`);
process.exit(1);
