# Starts SEO Auditor in the background (if it isn't running) and opens it in the browser.
# -NoBrowser: start only (used by "Start with Windows").
# -Open <route>: open a screen directly, e.g. -Open link-building (the "Backlink Verifier" shortcut).
param([switch]$NoBrowser, [string]$Open = '')
$root = Split-Path -Parent $PSScriptRoot
$url = 'http://localhost:4560/'
if ($Open) { $url += '#/' + $Open }
# A TCP check, not Invoke-WebRequest: .NET proxy auto-detection makes local web requests stall for seconds.
function Test-Up { $c = New-Object Net.Sockets.TcpClient; try { $c.ConnectAsync('127.0.0.1', 4560).Wait(400) -and $c.Connected } catch { $false } finally { $c.Dispose() } }
if (-not (Test-Up)) {
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) {
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show('Node.js was not found. Install Node.js 22 or newer from nodejs.org, then try again.', 'SEO Auditor')
    exit 1
  }
  New-Item -ItemType Directory -Force (Join-Path $root 'data') | Out-Null
  # cmd does the log redirection: Start-Process -RedirectStandardOutput would keep this script alive until node exits.
  Start-Process -FilePath $env:ComSpec -ArgumentList ('/d /c ""' + $node + '" src/server.mjs > data\server.log 2> data\server-error.log"') -WorkingDirectory $root -WindowStyle Hidden
  for ($i = 0; $i -lt 60 -and -not (Test-Up); $i++) { Start-Sleep -Milliseconds 250 }
}
if (-not $NoBrowser) { Start-Process $url }
