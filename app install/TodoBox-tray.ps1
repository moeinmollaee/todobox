# TodoBox PWA — system tray server (runs near the clock)
param([string]$Port = "8080")

$ErrorActionPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$mutex = New-Object System.Threading.Mutex($false, "Global\TodoBoxPWA_Tray")
if (-not $mutex.WaitOne(0, $false)) { exit 0 }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = (Resolve-Path (Join-Path $scriptDir "..")).Path
$iconPath = Join-Path $root "icons\icon128.png"
$openScript = Join-Path $scriptDir "open-todobox.ps1"
$serverProc = $null
$trayIcon = $null
$bitmap = $null

function Test-PortListening {
  param([string]$P)
  $hit = netstat -ano | Select-String ":$P\s" | Select-String "LISTENING"
  return $null -ne $hit
}

function Stop-PortListener {
  param([string]$P)
  netstat -ano | Select-String ":$P\s" | Select-String "LISTENING" | ForEach-Object {
    $procId = ($_.Line.Trim() -split '\s+')[-1]
    if ($procId -match '^\d+$') {
      Stop-Process -Id ([int]$procId) -Force -ErrorAction SilentlyContinue
    }
  }
}

function Start-HiddenServer {
  if (Test-PortListening -P $Port) { return $null }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "cmd.exe"
  $psi.Arguments = "/c npx --yes serve -l $Port ."
  $psi.WorkingDirectory = $root
  $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  $psi.CreateNoWindow = $true
  $psi.UseShellExecute = $false
  return [System.Diagnostics.Process]::Start($psi)
}

function Open-TodoBoxApp {
  if (Test-Path $openScript) {
    & $openScript -Port $Port
  } else {
    Start-Process "http://localhost:$Port/app.html"
  }
}

function Stop-TodoBox {
  if ($serverProc -and -not $serverProc.HasExited) {
    Stop-Process -Id $serverProc.Id -Force -ErrorAction SilentlyContinue
  }
  Stop-PortListener -P $Port
  if ($trayIcon) {
    $trayIcon.Visible = $false
    $trayIcon.Dispose()
  }
  if ($bitmap) { $bitmap.Dispose() }
  if ($mutex) {
    try { $mutex.ReleaseMutex() } catch { }
    $mutex.Dispose()
  }
  [System.Windows.Forms.Application]::Exit()
}

if (-not (Test-Path (Join-Path $root "vendor\sql-wasm.js"))) {
  $install = Join-Path $root "install.bat"
  if (Test-Path $install) {
    Start-Process -FilePath "cmd.exe" -ArgumentList "/c `"$install`"" -WindowStyle Hidden -Wait
  }
}

$serverProc = Start-HiddenServer

$trayIcon = New-Object System.Windows.Forms.NotifyIcon
if (Test-Path $iconPath) {
  $bitmap = New-Object System.Drawing.Bitmap($iconPath)
  $trayIcon.Icon = [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())
} else {
  $trayIcon.Icon = [System.Drawing.SystemIcons]::Application
}
$trayIcon.Text = "TodoBox"
$trayIcon.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = $menu.Items.Add("Open TodoBox")
$menu.Items.Add("-") | Out-Null
$exitItem = $menu.Items.Add("Exit")
$trayIcon.ContextMenuStrip = $menu

$openItem.Add_Click({ Open-TodoBoxApp })
$exitItem.Add_Click({ Stop-TodoBox })
$trayIcon.Add_DoubleClick({ Open-TodoBoxApp })

[System.Windows.Forms.Application]::EnableVisualStyles()
[System.Windows.Forms.Application]::Run()
