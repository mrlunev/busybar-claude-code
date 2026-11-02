# Claude Code on the BUSY Bar: installs everything on Windows.
#
#   irm https://raw.githubusercontent.com/mrlunev/busybar-claude-code/main/install.ps1 | iex
#
# 1. Node.js, if missing or older than 20 (winget, else the official installer; Windows asks to allow it).
# 2. The busybar plugin, through the `claude` command (the terminal one or the desktop app's).
# 3. Setup: finds the bar on the USB cable, installs the app on it, opens port 8790 in the firewall (Windows asks
#    to allow it), asks to press Start on the bar.
#
# Works in Windows PowerShell 5.1, which every Windows 10 and 11 has. Everything sits in a function called on the
# last line, so a half-downloaded script does nothing.

function Install-BusyBarClaude {
  $ErrorActionPreference = 'Stop'
  # BUSYBAR_SOURCE: a local copy of the repository instead of GitHub, for testing before it is published.
  $Repo = if ($env:BUSYBAR_SOURCE) { $env:BUSYBAR_SOURCE } else { 'mrlunev/busybar-claude-code' }
  $NodeLine = 'latest-v24.x'

  function Say($text) { Write-Host ''; Write-Host $text -ForegroundColor Cyan }
  function Fail($text) { Write-Host ''; Write-Host $text -ForegroundColor Red; throw 'busybar-setup-failed' }

  # A new install puts Node on the PATH of new windows only; this window reads it again.
  function Update-Path {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  }

  function Test-Node {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { return $false }
    return [int](& node -p "process.versions.node.split('.')[0]") -ge 20
  }

  function Install-Node {
    Say 'Installing Node.js. If Windows asks to allow changes, click Yes.'
    if (Get-Command winget -ErrorAction SilentlyContinue) {
      winget install --exact --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements | Out-Host
    } else {
      $sums = (Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$NodeLine/SHASUMS256.txt").Content
      $name = ($sums -split "`n" | Where-Object { $_ -match 'x64\.msi$' } | Select-Object -First 1).Split(' ')[-1].Trim()
      $msi = Join-Path $env:TEMP $name
      Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$NodeLine/$name" -OutFile $msi
      Start-Process msiexec -ArgumentList "/i `"$msi`" /qn" -Verb RunAs -Wait
    }
    Update-Path
  }

  # The terminal `claude`, else the one inside the Claude desktop app (newest version).
  function Find-Claude {
    $cmd = Get-Command claude -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $local = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
    if (Test-Path $local) { return $local }
    $roots = @("$env:APPDATA\Claude\claude-code") + @(Get-ChildItem "$env:LOCALAPPDATA\Packages\Claude_*\LocalCache\Roaming\Claude\claude-code" -Directory -ErrorAction SilentlyContinue | ForEach-Object FullName)
    $found = Get-ChildItem $roots -Recurse -Depth 2 -Filter claude.exe -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | Select-Object -Last 1
    if ($found) { return $found.FullName }
    return $null
  }

  if (-not (Test-Node)) { Install-Node }
  if (-not (Test-Node)) { Fail 'Node.js 20 or newer is needed, and it is still missing. Install it from https://nodejs.org and run this again.' }

  $claude = Find-Claude
  $daemon = $null
  if ($claude) {
    Say 'Installing the busybar plugin for Claude Code...'
    & $claude plugin marketplace add $Repo *> $null
    if ($LASTEXITCODE -ne 0) { & $claude plugin marketplace update busybar *> $null }
    & $claude plugin install busybar@busybar | Out-Host
    if ($LASTEXITCODE -ne 0) { Fail 'Claude Code could not install the plugin.' }
    # Installed before: install leaves the old version, update brings the new one.
    & $claude plugin update busybar@busybar *> $null
    $daemon = Get-ChildItem "$env:USERPROFILE\.claude\plugins\cache\busybar\busybar\*\daemon\claude-bar-daemon.mjs" -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime | Select-Object -Last 1 | ForEach-Object FullName
  }
  if (-not $daemon) {
    # No `claude` command here: run setup from a download, the plugin is added inside Claude Code afterwards.
    $dir = Join-Path $env:USERPROFILE '.busybar-claude-code'
    if (Test-Path $Repo) {
      $dir = $Repo
    } else {
      Say 'Downloading...'
      $zip = Join-Path $env:TEMP 'busybar-claude-code.zip'
      Invoke-WebRequest -UseBasicParsing "https://codeload.github.com/$Repo/zip/main" -OutFile $zip
      if (Test-Path $dir) { Remove-Item $dir -Recurse -Force }
      Expand-Archive $zip -DestinationPath $dir
    }
    $daemon = Get-ChildItem $dir -Recurse -Filter claude-bar-daemon.mjs | Select-Object -First 1 | ForEach-Object FullName
  }

  Say 'Setting up the bar...'
  & node $daemon setup
  if ($LASTEXITCODE -ne 0) { return }

  if (-not $claude) {
    Say 'Last step: in Claude Code, send these two lines one by one:'
    Write-Host "  /plugin marketplace add $Repo"
    Write-Host '  /plugin install busybar@busybar'
  }
  Say 'Restart Claude Code, and your sessions appear on the bar.'
}

try { Install-BusyBarClaude } catch { if ("$_" -ne 'busybar-setup-failed') { Write-Host "$_" -ForegroundColor Red } }
