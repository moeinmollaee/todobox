param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("enable", "open", "disable")]
  [string]$Mode
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = (Resolve-Path (Join-Path $scriptDir "..")).Path
$icon = Join-Path $root "icons\icon128.png"
$login = Join-Path $scriptDir "TodoBox-startup.bat"
$startup = [Environment]::GetFolderPath("Startup")

foreach ($name in @("TodoBox.lnk", "TodoBox PWA.lnk")) {
  $old = Join-Path $startup $name
  if (Test-Path $old) { Remove-Item $old -Force }
}

if ($Mode -eq "disable") { exit 0 }

$lnk = Join-Path $startup "TodoBox.lnk"
$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut($lnk)
$s.TargetPath = $login
$s.Arguments = if ($Mode -eq "open") { "open" } else { "" }
$s.WorkingDirectory = $scriptDir
$s.WindowStyle = 7
$s.Description = if ($Mode -eq "open") { "TodoBox - server and app" } else { "TodoBox - background server" }
if (Test-Path $icon) { $s.IconLocation = "$icon,0" }
$s.Save()
