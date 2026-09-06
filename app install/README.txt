TodoBox PWA (standalone web app)
================================

1. Run install.bat once (npm + vendor + sounds).
2. Run run.bat — first time asks: Windows startup or manual?

First run choices:
  [1] Start with Windows — server only (hidden; run.bat opens app, no CMD window)
  [2] Manual — run this file when needed; keep CMD open while using TodoBox
  [3] Start with Windows — server + open TodoBox at login (run.bat also without CMD)

Other tools:
  startup-settings.bat — change startup choice later
  stop-server.bat      — stop background server (port 8080)

TodoBox opens as installed PWA when possible; otherwise a Start Menu shortcut is created automatically.
The server runs in the system tray (near the clock). Right-click the TodoBox icon for Open or Exit.
Startup entry in Task Manager shows as TodoBox with the app icon.

Install as app (optional):
  Chrome/Edge: Install TodoBox from the browser menu

Copy this whole project folder to another PC; run install.bat then run.bat there.

Data:
- Same SQLite file (todobox.sqlite) as the Chrome extension.
- Connect a folder in TodoBox so the file is saved on disk.
- To sync across computers, put that folder inside Google Drive, OneDrive, or Dropbox, then connect the same folder on each PC and choose Merge. See the project README.
- "Most visited" is Chrome-only; hidden in the PWA.

Extension: load unpacked from the parent folder in chrome://extensions

Author: Moein Mollaee — https://moeinmollaee.com
