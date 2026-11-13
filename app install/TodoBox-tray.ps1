# TodoBox PWA - system tray server (runs near the clock)
param([string]$Port = "8080")

$ErrorActionPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$mutex = New-Object System.Threading.Mutex($false, "Global\TodoBoxPWA_Tray")
if (-not $mutex.WaitOne(0, $false)) { exit 0 }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script:scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:root = (Resolve-Path (Join-Path $script:scriptDir "..")).Path
$script:iconPath = Join-Path $script:root "icons\icon128.png"
$script:openScript = Join-Path $script:scriptDir "open-todobox.ps1"
$script:serverProc = $null
$script:trayIcon = $null
$script:bitmap = $null
$script:watchTimer = $null
$script:restarting = $false
$script:Port = $Port

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

function Test-MailHealth {
  try {
    $req = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$($script:Port)/api/mail/health")
    $req.Method = "GET"
    $req.Timeout = 2500
    $req.ReadWriteTimeout = 2500
    $resp = $req.GetResponse()
    $ok = [int]$resp.StatusCode -ge 200 -and [int]$resp.StatusCode -lt 300
    $resp.Close()
    return $ok
  } catch {
    return $false
  }
}

function Start-HiddenServer {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "node"
  $psi.Arguments = "mail-bridge\server.mjs"
  $psi.WorkingDirectory = $script:root
  $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  $psi.CreateNoWindow = $true
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $false
  $psi.RedirectStandardError = $false
  try {
    $psi.EnvironmentVariables["TODOBOX_PORT"] = "$($script:Port)"
  } catch {
    # EnvironmentVariables may be locked on some hosts
  }
  return [System.Diagnostics.Process]::Start($psi)
}

function Set-TrayStatus {
  param([string]$Status)
  if (-not $script:trayIcon) { return }
  $text = "TodoBox - $Status"
  if ($text.Length -gt 63) { $text = $text.Substring(0, 63) }
  $script:trayIcon.Text = $text
}

function Ensure-ServerRunning {
  if ($script:restarting) { return }
  if (Test-MailHealth) {
    Set-TrayStatus "mail online"
    return
  }

  $script:restarting = $true
  try {
    Set-TrayStatus "restarting mail..."

    if ($script:serverProc) {
      try {
        if (-not $script:serverProc.HasExited) {
          Stop-Process -Id $script:serverProc.Id -Force -ErrorAction SilentlyContinue
        }
      } catch { }
      $script:serverProc = $null
    }

    if (Test-PortListening -P $script:Port) {
      Stop-PortListener -P $script:Port
      Start-Sleep -Milliseconds 600
    }

    $script:serverProc = Start-HiddenServer

    for ($i = 0; $i -lt 12; $i++) {
      Start-Sleep -Milliseconds 400
      if (Test-MailHealth) {
        Set-TrayStatus "mail online"
        return
      }
    }
    Set-TrayStatus "mail offline - use Restart"
  } finally {
    $script:restarting = $false
  }
}

function Open-TodoBoxApp {
  if (Test-Path $script:openScript) {
    & $script:openScript -Port $script:Port
  } else {
    Start-Process "http://localhost:$($script:Port)/app.html"
  }
}

function Stop-TodoBox {
  if ($script:watchTimer) {
    $script:watchTimer.Stop()
    $script:watchTimer.Dispose()
    $script:watchTimer = $null
  }
  if ($script:serverProc -and -not $script:serverProc.HasExited) {
    Stop-Process -Id $script:serverProc.Id -Force -ErrorAction SilentlyContinue
  }
  Stop-PortListener -P $script:Port
  if ($script:trayIcon) {
    $script:trayIcon.Visible = $false
    $script:trayIcon.Dispose()
  }
  if ($script:bitmap) { $script:bitmap.Dispose() }
  if ($mutex) {
    try { $mutex.ReleaseMutex() } catch { }
    $mutex.Dispose()
  }
  [System.Windows.Forms.Application]::Exit()
}

if (-not (Test-Path (Join-Path $script:root "vendor\sql-wasm.js"))) {
  $install = Join-Path $script:root "install.bat"
  if (Test-Path $install) {
    Start-Process -FilePath "cmd.exe" -ArgumentList "/c `"$install`"" -WindowStyle Hidden -Wait
  }
}

$script:trayIcon = New-Object System.Windows.Forms.NotifyIcon
if (Test-Path $script:iconPath) {
  $script:bitmap = New-Object System.Drawing.Bitmap($script:iconPath)
  $script:trayIcon.Icon = [System.Drawing.Icon]::FromHandle($script:bitmap.GetHicon())
} else {
  $script:trayIcon.Icon = [System.Drawing.SystemIcons]::Application
}
$script:trayIcon.Text = "TodoBox"
$script:trayIcon.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = $menu.Items.Add("Open TodoBox")
$restartItem = $menu.Items.Add("Restart mail server")
$menu.Items.Add("-") | Out-Null
$exitItem = $menu.Items.Add("Exit")
$script:trayIcon.ContextMenuStrip = $menu

$openItem.Add_Click({
  Ensure-ServerRunning
  Open-TodoBoxApp
})
$restartItem.Add_Click({ Ensure-ServerRunning })
$exitItem.Add_Click({ Stop-TodoBox })
$script:trayIcon.Add_DoubleClick({
  Ensure-ServerRunning
  Open-TodoBoxApp
})

Ensure-ServerRunning

$script:watchTimer = New-Object System.Windows.Forms.Timer
$script:watchTimer.Interval = 20000
$script:watchTimer.Add_Tick({ Ensure-ServerRunning })
$script:watchTimer.Start()

[System.Windows.Forms.Application]::EnableVisualStyles()
[System.Windows.Forms.Application]::Run()
