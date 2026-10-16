# 打 Windows 便携包：dist\jobhunter-v<版本>-win64.zip
# 里面是 jobhunter\HR Desk\HR Desk.exe + watcher\ + extension\ + README.md + 使用教程.html；data\ 第一次打开时才生成，不进包
# 用法（PowerShell 7）：pwsh tools\build-portable.ps1
# 第一次用会在 desktop\ 里 npm install（下载 Electron，约 100MB）
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$desk = Join-Path $root 'desktop'
$pkg = Get-Content (Join-Path $desk 'package.json') -Raw | ConvertFrom-Json
$ver = $pkg.version
$electronVer = ($pkg.devDependencies.electron -replace '[^\d.]', '')
$dist = Join-Path $root 'dist'
$stage = Join-Path $dist 'stage'
$app = Join-Path $stage 'jobhunter'
$zip = Join-Path $dist "jobhunter-v$ver-win64.zip"

if (-not (Test-Path (Join-Path $desk 'node_modules\@electron\packager\bin\electron-packager.mjs'))) {
    Write-Host '第一次打包：安装 Electron 和打包工具…'
    Push-Location $desk; npm install --no-audit --no-fund; Pop-Location
}

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force $app | Out-Null

Write-Host "① 打包桌面程序 v$ver（Electron $electronVer）"
Push-Location $desk
# 直接用 node 跑打包工具（走 .cmd 的话 ^ 和 | 会被 cmd 当成特殊字符吃掉）
node (Join-Path $desk 'node_modules\@electron\packager\bin\electron-packager.mjs') . 'HR Desk' --platform=win32 --arch=x64 "--electron-version=$electronVer" --icon=icon.ico `
    "--out=$stage" --overwrite '--ignore=^[/\\](dist|data|profile|node_modules)' '--ignore=\.out$' '--ignore=desk\.log' "--app-version=$ver" | Out-Host
Pop-Location
Move-Item (Join-Path $stage 'HR Desk-win32-x64') (Join-Path $app 'HR Desk')

Write-Host '② 复制后台、插件、说明'
$skip = @('data', 'node_modules', '.chrome-plugin', 'profile')
function Copy-Clean($from, $to) {
    New-Item -ItemType Directory -Force $to | Out-Null
    Get-ChildItem $from -Force | Where-Object { $skip -notcontains $_.Name -and $_.Name -notmatch '\.(out|log|pid)$' -and $_.Name -notmatch '^\.' } | ForEach-Object {
        if ($_.PSIsContainer) { Copy-Clean $_.FullName (Join-Path $to $_.Name) } else { Copy-Item $_.FullName $to }
    }
}
Copy-Clean (Join-Path $root 'watcher') (Join-Path $app 'watcher')
Copy-Clean (Join-Path $root 'extension') (Join-Path $app 'extension')
Copy-Item (Join-Path $root 'README.md'), (Join-Path $root '使用教程.html') $app
Copy-Clean (Join-Path $root 'docs\img') (Join-Path $app 'docs\img')      # 教程里的截图
if (Test-Path (Join-Path $root 'LICENSE')) { Copy-Item (Join-Path $root 'LICENSE') $app }

Write-Host '③ 压缩'
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path $app -DestinationPath $zip -CompressionLevel Optimal
Remove-Item $stage -Recurse -Force
$mb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host "好了：$zip（$mb MB）"

Write-Host '④ 隐私扫描（有本地敏感词清单就用环境变量 PRIVACY_TERMS 指过来）'
node (Join-Path $root 'tools\privacy-scan.mjs') $zip
if ($LASTEXITCODE -ne 0) { Write-Host '隐私扫描有命中，这个包不许发' -ForegroundColor Red; exit 1 }
