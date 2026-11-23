# OpenSession —— Windows 安装脚本
#
# 与 Linux 的 install.sh 一一对应，把「常驻 / 开机自启 / 桌面图标」三件事做完：
#
#   .\install.ps1                 安装（默认）
#   .\install.ps1 -NoAutoStart    安装但不设开机自启
#   .\install.ps1 -NoDesktop      安装但不建桌面快捷方式
#   .\install.ps1 -Status         查看当前状态
#   .\install.ps1 -Uninstall      卸载（不碰会话数据与任何 CLI 配置）
#
# 设计取向：**不写系统目录、不改 HKLM、不装系统服务。**
#   - 常驻：当前用户的启动文件夹，登录即起（权限最低、卸载最干净）
#   - 自启：同一个 .lnk，用户能在「任务管理器 → 启动」里自己关掉
#   - 图标：桌面 .lnk，指向 wscript 起的隐藏窗口启动器
#
# 为什么用 wscript + .vbs 而不是 .lnk 直接指向 node.exe：
#   直接指 node 会弹一个常驻黑色控制台，关掉它就杀掉服务。用 .vbs 的
#   WScript.Shell.Run(cmd, 0, False) 以隐藏窗口起 node，用户全程看不到控制台，
#   体验上才等同「一个应用」。
#
# 若执行策略拦住脚本：
#   powershell -ExecutionPolicy Bypass -File .\install.ps1

[CmdletBinding()]
param(
    [switch]$NoAutoStart,
    [switch]$NoDesktop,
    [switch]$Status,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

# ---------- 路径 ----------
$AppDir     = $PSScriptRoot
$ServerJs   = Join-Path $AppDir 'opensession-server.js'
$IcoPath    = Join-Path $AppDir 'assets\opensession.ico'

$HomeDir    = $env:USERPROFILE
$DataDir    = Join-Path $HomeDir '.opensession'
$RunVbs     = Join-Path $DataDir 'launch.vbs'
$StopVbs    = Join-Path $DataDir 'stop.vbs'
$DesktopLnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'OpenSession.lnk'
$StartupDir = [Environment]::GetFolderPath('Startup')
$StartupLnk = Join-Path $StartupDir 'OpenSession.lnk'
$Port       = 8347

function Write-Step($m) { Write-Host "  $m" -ForegroundColor Gray }
function Write-Ok($m)   { Write-Host "  OK  $m" -ForegroundColor Green }
function Write-Warn2($m){ Write-Host "  !!  $m" -ForegroundColor Yellow }

# VBS 里双引号要写两遍，这里统一处理，避免漏转义
function VbsStr($s) { return '"' + ([string]$s).Replace('"', '""') + '"' }

# ---------- node 定位 ----------
# 先 PATH，再常见安装位置。找不到就明确报错——静默失败会让用户点图标后
# 什么都没发生，是最难排查的一种。
function Find-Node {
    $c = Get-Command node -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    foreach ($p in @(
        "$env:ProgramFiles\nodejs\node.exe",
        "${env:ProgramFiles(x86)}\nodejs\node.exe",
        "$env:LOCALAPPDATA\Programs\nodejs\node.exe",
        "$env:APPDATA\npm\node.exe"
    )) {
        if ($p -and (Test-Path -LiteralPath $p)) { return $p }
    }
    return $null
}

# ---------- 浏览器定位（Chrome / Edge 的应用模式）----------
function Find-AppBrowser {
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

# ---------- 服务探活 ----------
function Test-Server {
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/models" `
             -UseBasicParsing -TimeoutSec 2
        return ($r.StatusCode -eq 200)
    } catch { return $false }
}

# ---------- 隐藏窗口启动器 ----------
# 职责：探活 → 不活就起 → 等它真起来再开窗口。
# 探活用 XMLHTTP 同步请求，无需额外进程，VBS 里最省事的方式。
function New-Launcher($nodeExe, $browser) {
    New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

    # 浏览器命令行必须整段加引号：Chrome / Edge 的安装路径含空格，
    # 不加引号 VBS 的 Run 会把 "C:\Program" 当程序名，报找不到文件。
    # VBS 里表示一个双引号要写四个（"""" 是内含单个 " 的字符串），
    # 所以正确写法是  """" & browser & """ --app=" & url
    $openLine = if ($browser) {
        'sh.Run """" & browser & """ --app=" & url & " --window-size=1900,1150", 1, False'
    } else {
        'sh.Run url, 1, False'
    }

    $vbs = @'
' OpenSession 隐藏窗口启动器（由 install.ps1 生成，删掉不影响服务本身）
Option Explicit
Dim sh, node, js, dir, port, url, browser, i, up, xhr

Set sh = CreateObject("WScript.Shell")

node    = NODE_PATH_PLACEHOLDER
js      = JS_PATH_PLACEHOLDER
dir     = DIR_PLACEHOLDER
browser = BROWSER_PATH_PLACEHOLDER

port = PORT_PLACEHOLDER
url  = "http://127.0.0.1:" & port & "/"

Function Alive()
  Dim x, ok
  ok = False
  On Error Resume Next
  Set x = CreateObject("MSXML2.XMLHTTP")
  x.Open "GET", url & "api/models", False
  x.Send
  If Err.Number = 0 Then
    If x.Status = 200 Then ok = True
  End If
  Err.Clear
  On Error GoTo 0
  Alive = ok
End Function

up = Alive()

If Not up Then
  ' 第二个实例会因端口占用直接退出，所以先探活再起
  sh.CurrentDirectory = dir
  sh.Run """" & node & """ """ & js & """", 0, False
  ' 最多等 15 秒，避免机器慢时浏览器先打开报连接失败
  For i = 1 To 30
    WScript.Sleep 500
    If Alive() Then
      up = True
      Exit For
    End If
  Next
End If

BROWSER_LINE_PLACEHOLDER
'@

    $vbs = $vbs.Replace('NODE_PATH_PLACEHOLDER', (VbsStr $nodeExe))
    $vbs = $vbs.Replace('JS_PATH_PLACEHOLDER',   (VbsStr $ServerJs))
    $vbs = $vbs.Replace('DIR_PLACEHOLDER',       (VbsStr $AppDir))
    $vbs = $vbs.Replace('BROWSER_PATH_PLACEHOLDER', (VbsStr ([string]$browser)))
    $vbs = $vbs.Replace('PORT_PLACEHOLDER',      [string]$Port)
    $vbs = $vbs.Replace('BROWSER_LINE_PLACEHOLDER', $openLine)

    # VBS 必须是 ANSI 或 UTF-16LE+BOM。含中文注释，用 Unicode 落盘最稳；
    # UTF-8 无 BOM 会让 wscript 解析失败且报错信息毫无提示。
    [System.IO.File]::WriteAllText($RunVbs, $vbs, [System.Text.Encoding]::Unicode)

    $stop = @'
' 停止 OpenSession 后端（按命令行匹配，不误杀其它 node 进程）
Option Explicit
On Error Resume Next
Dim svc, procs, p, n
n = 0
Set svc = GetObject("winmgmts:\\.\root\cimv2")
Set procs = svc.ExecQuery("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='node.exe'")
For Each p In procs
  If Not IsNull(p.CommandLine) Then
    If InStr(LCase(p.CommandLine), "opensession-server.js") > 0 Then
      p.Terminate()
      n = n + 1
    End If
  End If
Next
WScript.Echo "已停止 " & n & " 个 OpenSession 进程"
'@
    [System.IO.File]::WriteAllText($StopVbs, $stop, [System.Text.Encoding]::Unicode)

    Write-Ok "隐藏启动器 $RunVbs"
}

# ---------- 快捷方式 ----------
function New-Shortcut($path, $target, $args, $icon, $desc) {
    $dir = Split-Path -Parent $path
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }
    $sh = New-Object -ComObject WScript.Shell
    try {
        $lnk = $sh.CreateShortcut($path)
        $lnk.TargetPath       = $target
        if ($args) { $lnk.Arguments = $args }
        $lnk.WorkingDirectory = $AppDir
        if ($icon -and (Test-Path -LiteralPath $icon)) { $lnk.IconLocation = "$icon,0" }
        if ($desc) { $lnk.Description = $desc }
        $lnk.Save()
    } finally {
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($sh)
    }
}

function Get-Wscript {
    $w = Join-Path $env:SystemRoot 'System32\wscript.exe'
    if (Test-Path -LiteralPath $w) { return $w }
    return 'wscript.exe'
}

# ---------- 状态 ----------
function Show-Status {
    $node = Find-Node
    Write-Host "OpenSession 状态" -ForegroundColor Cyan
    Write-Host ("  项目目录    " + $AppDir)
    Write-Host ("  node        " + $(if ($node) { $node } else { '未找到（必装）' }))
    Write-Host ("  服务地址    http://127.0.0.1:$Port  " + $(if (Test-Server) { '运行中' } else { '未运行' }))
    Write-Host ("  隐藏启动器  " + $(if (Test-Path -LiteralPath $RunVbs) { '已生成' } else { '未生成' }))
    Write-Host ("  桌面快捷    " + $(if (Test-Path -LiteralPath $DesktopLnk) { '已创建' } else { '未创建' }))
    Write-Host ("  开机自启    " + $(if (Test-Path -LiteralPath $StartupLnk) { '已启用' } else { '未启用' }))
    Write-Host ("  图标        " + $(if (Test-Path -LiteralPath $IcoPath) { 'assets\opensession.ico' } else { '缺失' }))
}

# ---------- 卸载 ----------
function Do-Uninstall {
    Write-Host "卸载 OpenSession" -ForegroundColor Cyan
    if (Test-Path -LiteralPath $StopVbs) {
        & (Get-Wscript) $StopVbs
        Write-Ok "已停止后端"
    }
    foreach ($f in @($DesktopLnk, $StartupLnk)) {
        if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force; Write-Ok "移除 $f" }
    }
    if (Test-Path -LiteralPath $DataDir) {
        Remove-Item -LiteralPath $DataDir -Recurse -Force
        Write-Ok "移除 $DataDir"
    }
    Write-Host "  会话数据与 CLI 配置未改动。" -ForegroundColor Gray
}

# ---------- 安装 ----------
function Do-Install {
    Write-Host "安装 OpenSession（Windows）" -ForegroundColor Cyan

    $node = Find-Node
    if (-not $node) { throw "未找到 node.exe。请先安装 Node.js 18+ 并确保 node 在 PATH 中。" }
    Write-Ok "node $node"

    if (-not (Test-Path -LiteralPath $ServerJs)) { throw "缺少 $ServerJs" }

    $icon = $IcoPath
    if (-not (Test-Path -LiteralPath $icon)) {
        Write-Warn2 "图标缺失（assets\opensession.ico），快捷方式将用系统默认图标"
        $icon = $null
    }

    $browser = Find-AppBrowser
    if ($browser) { Write-Ok "浏览器 $browser（--app 独立窗口）" }
    else { Write-Warn2 "未找到 Chrome/Edge，将以默认浏览器标签页打开" }

    New-Launcher $node $browser

    $wscript = Get-Wscript
    if (-not $NoDesktop) {
        New-Shortcut $DesktopLnk $wscript ('"' + $RunVbs + '"') $icon `
            'OpenSession — 聚合查看 Codex / Claude / Pi / Hermes 会话'
        Write-Ok "桌面快捷方式 $DesktopLnk"
    }
    if (-not $NoAutoStart) {
        New-Shortcut $StartupLnk $wscript ('"' + $RunVbs + '"') $icon 'OpenSession 开机自启'
        Write-Ok "开机自启 $StartupLnk"
    }

    # 立即拉起一次，让用户装完就能看到结果
    & $wscript $RunVbs
    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline) {
        if (Test-Server) { break }
        Start-Sleep -Milliseconds 500
    }
    if (Test-Server) { Write-Ok "服务已启动 http://127.0.0.1:$Port" }
    else { Write-Warn2 "服务未在 20 秒内就绪，请从桌面图标重试" }

    Write-Host ""
    Write-Host "完成。日常使用：双击桌面「OpenSession」。" -ForegroundColor Green
    Write-Host "  停止服务：wscript `"$StopVbs`"" -ForegroundColor Gray
    Write-Host "  开机自启可在「任务管理器 → 启动」里随时关闭。" -ForegroundColor Gray
}

# ---------- 入口 ----------
try {
    if ($Status)        { Show-Status }
    elseif ($Uninstall) { Do-Uninstall }
    else                { Do-Install }
} catch {
    Write-Host ""
    Write-Host ("失败：" + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
