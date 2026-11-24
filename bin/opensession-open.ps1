# opensession-open —— 命令行打开 OpenSession（Windows 版，对应 Linux 的 bin/opensession-open）
#
# 用法：
#   .\opensession-open.ps1                  独立无地址栏窗口（默认）
#   .\opensession-open.ps1 -Tab             退回普通浏览器标签页
#   .\opensession-open.ps1 -Tool claude     只打开 claude 的会话
#   .\opensession-open.ps1 -Q 关键词         打开并预先搜索
#   .\opensession-open.ps1 -Q 关键词 -Full   以全文模式搜索（搜正文与思考）
#   .\opensession-open.ps1 -Stop            停止后端
#   .\opensession-open.ps1 -Status          查看状态
#
# 与 Linux 版的差异：Linux 用 bash + unshare + systemd；这里用 VBS 隐藏窗口起 node，
# 因为 Node 服务必须无控制台常驻，而 .lnk / 双击都会带一个黑窗。

[CmdletBinding()]
param(
    [string]$Tool = "",
    [string]$Q = "",
    [switch]$Full,
    [switch]$Tab,
    [switch]$Stop,
    [switch]$Status,
    [int]$Port = 8347
)

$ErrorActionPreference = 'Stop'

$AppDir  = Split-Path -Parent $MyInvocation.MyCommand.Definition
$DataDir = Join-Path $env:USERPROFILE '.opensession'
$RunVbs  = Join-Path $DataDir 'launch.vbs'
$StopVbs = Join-Path $DataDir 'stop.vbs'

function Test-Server {
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/models" `
             -UseBasicParsing -TimeoutSec 2
        return ($r.StatusCode -eq 200)
    } catch { return $false }
}

function Find-Node {
    $c = Get-Command node -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    foreach ($p in @(
        "$env:ProgramFiles\nodejs\node.exe",
        "${env:ProgramFiles(x86)}\nodejs\node.exe",
        "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
    )) {
        if ($p -and (Test-Path -LiteralPath $p)) { return $p }
    }
    return $null
}

function Find-Browser {
    foreach ($p in @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
    )) {
        if ($p -and (Test-Path -LiteralPath $p)) { return $p }
    }
    return $null
}

# ---------- 子命令 ----------
if ($Stop) {
    if (Test-Path -LiteralPath $StopVbs) { & wscript.exe $StopVbs }
    else { Write-Host "后端未由本工具启动（找不到 $StopVbs）" }
    return
}

if ($Status) {
    Write-Host ("服务      " + $(if (Test-Server) { "运行中  http://127.0.0.1:$Port" } else { "未运行" }))
    Write-Host ("node      " + $(if (Find-Node) { Find-Node } else { "未找到" }))
    Write-Host ("启动器    " + $(if (Test-Path -LiteralPath $RunVbs) { $RunVbs } else { "未生成（先跑 install.ps1）" }))
    Write-Host ("浏览器    " + $(if (Find-Browser) { Find-Browser } else { "未找到 Chrome/Edge，将用默认浏览器" }))
    return
}

# ---------- 组装 URL ----------
$qs = @()
if ($Tool) { $qs += "tool=$Tool" }
if ($Q)    { $qs += "q=" + [Uri]::EscapeDataString($Q) }
if ($Full) { $qs += "full=1" }
$url = "http://127.0.0.1:$Port/"
if ($qs.Count) { $url += "?" + ($qs -join "&") }

# ---------- 服务探活，不活就拉起 ----------
if (-not (Test-Server)) {
    Write-Host "OpenSession 未运行，正在启动…"
    if (Test-Path -LiteralPath $RunVbs) {
        # install.ps1 生成的启动器：隐藏窗口起 node → 等就绪 → 开窗口。
        # 但它开的是固定 URL，带筛选时需要自己再开一次，所以这里不直接调用，
        # 只借它把服务拉起来。
        $node = Find-Node
        if ($node) {
            $js = Join-Path $AppDir 'opensession-server.js'
            if (Test-Path -LiteralPath $js) {
                Start-Process -FilePath $node -ArgumentList @($js) -WorkingDirectory $AppDir `
                    -WindowStyle Hidden
            }
        }
    } else {
        $node = Find-Node
        if (-not $node) { throw "未找到 node.exe，请先安装 Node.js 18+" }
        Start-Process -FilePath $node -ArgumentList @((Join-Path $AppDir 'opensession-server.js')) `
            -WorkingDirectory $AppDir -WindowStyle Hidden
    }
    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline) {
        if (Test-Server) { break }
        Start-Sleep -Milliseconds 500
    }
    if (-not (Test-Server)) { throw "服务未在 20 秒内就绪：$url" }
}

Write-Host "OpenSession: $url"

# ---------- 开窗口 ----------
$browser = Find-Browser
if (-not $Tab -and $browser) {
    # --app 独立窗口（无地址栏）；独立 user-data-dir 避免被已运行的实例吞掉
    $profile = Join-Path $env:LOCALAPPDATA 'opensession-chrome'
    New-Item -ItemType Directory -Force -Path $profile | Out-Null
    Start-Process -FilePath $browser -ArgumentList @(
        "--user-data-dir=$profile",
        "--window-size=1900,1150",
        "--no-first-run",
        "--no-default-browser-check",
        "--app=$url"
    )
} else {
    Start-Process $url
}
