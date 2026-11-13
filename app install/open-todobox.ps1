param(
  [string]$Port = "8080"
)

$ErrorActionPreference = "SilentlyContinue"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = (Resolve-Path (Join-Path $scriptDir "..")).Path
$url = "http://localhost:$Port/app.html"
$icon = Join-Path $root "icons\icon128.png"
$programs = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
$ourShortcut = Join-Path $programs "TodoBox.lnk"

function Find-BrowserPwaShortcut {
  $folders = @(
    (Join-Path $programs "Chrome Apps"),
    (Join-Path $programs "Edge Apps"),
    (Join-Path $programs "Microsoft Edge Apps")
  )
  foreach ($folder in $folders) {
    if (-not (Test-Path $folder)) { continue }
    $hit = Get-ChildItem -Path $folder -Filter "TodoBox*.lnk" -File | Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  return $null
}

function Find-BrowserExe {
  $candidates = @(
    "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe",
    "${env:LocalAppData}\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles}\Microsoft\Edge\Application\msedge.exe"
  )
  foreach ($path in $candidates) {
    if (Test-Path $path) { return $path }
  }
  return $null
}

function New-AppShortcut {
  param([string]$BrowserPath)
  $ws = New-Object -ComObject WScript.Shell
  $s = $ws.CreateShortcut($ourShortcut)
  $s.TargetPath = $BrowserPath
  $s.Arguments = "--app=$url"
  $s.WorkingDirectory = $root
  if (Test-Path $icon) { $s.IconLocation = "$icon,0" }
  $s.Description = "TodoBox"
  $s.Save()
  return $ourShortcut
}

# Prefer a fresh localhost window — installed PWA shortcuts can open a stale
# start URL and show a bare "Not found" page if the path is wrong.
$browser = Find-BrowserExe
if ($browser) {
  Start-Process -FilePath $browser -ArgumentList "--app=$url"
  if (-not (Test-Path $ourShortcut)) {
    New-AppShortcut -BrowserPath $browser | Out-Null
  }
  exit 0
}

$shortcut = Find-BrowserPwaShortcut
if (-not $shortcut -and (Test-Path $ourShortcut)) {
  $shortcut = $ourShortcut
}
if ($shortcut) {
  Start-Process -FilePath $shortcut
  exit 0
}

Start-Process $url
exit 0
