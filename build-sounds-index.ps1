# Scans the sounds/ folder for .mp3 files and writes sounds/index.json
$soundsDir = Join-Path $PSScriptRoot "sounds"
$files = Get-ChildItem -Path $soundsDir -Filter "*.mp3" | Sort-Object Name | ForEach-Object { $_.Name }
$json = $files | ConvertTo-Json -Compress
if (-not $json -or $json -eq "null") { $json = "[]" }
# Single file returns a string, wrap it
if ($json -notmatch '^\[') { $json = "[$json]" }
Set-Content -Path (Join-Path $soundsDir "index.json") -Value $json -Encoding UTF8 -NoNewline
Write-Host "sounds/index.json updated with $($files.Count) file(s)"
