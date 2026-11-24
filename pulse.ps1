<#
  Cluster Pulse - laptop-side control (Windows).

  Runs the three things the dashboard needs and reports them with a green/red
  dot so you never have to guess:

    1. MySQL container (docker: cluster-pulse-mysql)
    2. Node API on :3000  (ingest + WebSocket)
    3. Angular dev server on :4200

  Usage (from project/):
    .\pulse.cmd            # same as status
    .\pulse.cmd status
    .\pulse.cmd start
    .\pulse.cmd stop
    .\pulse.cmd restart
    .\pulse.cmd logs
#>

param(
  [Parameter(Position = 0)]
  [string]$Action = ''
)

$ErrorActionPreference = 'SilentlyContinue'
$Root       = Split-Path -Parent $MyInvocation.MyCommand.Path
$ServerDir  = Join-Path $Root 'server'
$UiDir      = Join-Path $Root 'cluster-pulse'
$NgCli      = Join-Path $UiDir 'node_modules\@angular\cli\bin\ng.js'
$ApiLog     = Join-Path $ServerDir 'api.log'
$UiLog      = Join-Path $UiDir 'ngserve.log'
$MysqlName  = 'cluster-pulse-mysql'
$SshHost    = 'arun.26025@10.16.1.50'
$SshKey     = Join-Path $env:USERPROFILE '.ssh\id_ed25519'
$ApiPort    = 3000
$UiPort     = 4200

function Write-Dot([bool]$ok, [string]$label, [string]$detail) {
  $dot = if ($ok) { [char]0x25CF } else { [char]0x25CB }   # . / .
  $colour = if ($ok) { 'Green' } else { 'Red' }
  Write-Host ('  ' + $dot + ' ') -ForegroundColor $colour -NoNewline
  Write-Host ($label.PadRight(26)) -NoNewline
  Write-Host $detail -ForegroundColor DarkGray
}

function Get-PortPid([int]$port) {
  $lines = netstat -ano | Select-String ":$port\s" | Select-String 'LISTENING'
  foreach ($line in $lines) {
    $parts = ($line.ToString().Trim() -split '\s+')
    if ($parts.Length -ge 5) { return [int]$parts[-1] }
  }
  return $null
}

function Wait-Port([int]$port, [int]$seconds, [string]$label) {
  # Readiness is judged from netstat, not a TCP connect: the Angular dev server
  # listens on [::1]:4200 only and .NET's TcpClient throws for that address
  # family unless constructed for IPv6, so a connect-based probe reported a
  # perfectly healthy UI as "down".
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    if (Get-PortPid $port) { Write-Host "  $label listening on :$port"; return $true }
    Start-Sleep -Milliseconds 700
  }
  Write-Host "  $label did not start within ${seconds}s" -ForegroundColor Red
  return $false
}

function Get-VpnIp {
  # The campus VPN hands out a new 10.22.x address almost every reconnect, and
  # the collector posts to whatever is written in post_url.txt on mgmt01.
  $text = (ipconfig) -join "`n"
  $match = [regex]::Match($text, '10\.22\.\d{1,3}\.\d{1,3}')
  if ($match.Success) { return $match.Value }
  return $null
}

function Invoke-Ssh([string]$remoteCommand, [int]$attempts = 3) {
  # The SSH channel drops ~1 in 3 attempts on this network; retry before crying.
  for ($i = 1; $i -le $attempts; $i++) {
    $out = ssh -i $SshKey -o BatchMode=yes -o ConnectTimeout=8 $SshHost $remoteCommand 2>$null
    if ($LASTEXITCODE -eq 0) { return @{ ok = $true; out = (($out | Out-String).Trim()) } }
    Start-Sleep -Milliseconds 800
  }
  return @{ ok = $false; out = '' }
}

function Sync-PostUrl {
  $ip = Get-VpnIp
  if (-not $ip) {
    Write-Dot $false 'collector target' 'no 10.22.x address - is the VPN connected?'
    return
  }
  $url = "http://${ip}:$ApiPort/api/ingest/cluster"

  $result = Invoke-Ssh 'cat ~/monitor/post_url.txt 2>/dev/null'
  if (-not $result.ok) {
    Write-Dot $false 'collector target' "cannot reach $SshHost after 3 tries (VPN or ssh key)"
    return
  }
  if ($result.out -eq $url) {
    Write-Dot $true 'collector target' "in sync ($ip)"
    return
  }

  $write = Invoke-Ssh ("echo '" + $url + "' > ~/monitor/post_url.txt")
  if ($write.ok) {
    Write-Dot $true 'collector target' "repointed to $ip (collector picks it up within 30s)"
  } else {
    Write-Dot $false 'collector target' "could not rewrite post_url.txt on $SshHost"
  }
}

function Get-ApiHealth {
  try {
    return Invoke-RestMethod -Uri "http://127.0.0.1:$ApiPort/health" -TimeoutSec 3
  } catch {
    return $null
  }
}

function Get-MySqlState {
  $state = docker inspect -f '{{.State.Running}}' $MysqlName 2>$null
  if ($state -eq 'true') {
    $uptime = docker inspect -f '{{.State.StartedAt}}' $MysqlName 2>$null
    return @{ running = $true; since = $uptime }
  }
  if (docker inspect $MysqlName 2>$null) { return @{ running = $false; since = 'exists, stopped' } }
  return @{ running = $false; since = 'container missing' }
}

function Show-Status {
  Write-Host ''
  Write-Host 'CLUSTER PULSE - laptop side' -ForegroundColor Cyan
  Write-Host ''

  # 1. MySQL
  $mysql = Get-MySqlState
  Write-Dot $mysql.running 'MySQL (docker)' $(if ($mysql.running) { "running" } else { $mysql.since })

  Sync-PostUrl

  # 2. API + data flow
  $health = Get-ApiHealth
  if ($health) {
    Write-Dot $true "API :$ApiPort" ("200 - db " + $health.db + " - " + $health.ingest_count + ' ingests')
    $before = $health.ingest_count
    Start-Sleep -Seconds 3
    $after = (Get-ApiHealth).ingest_count
    $delta = if ($null -ne $after) { $after - $before } else { 0 }
    Write-Dot ($delta -gt 0) 'collector feed' $(if ($delta -gt 0) { "live (+$delta in 3s)" } else { "no new data - check the HPC collector / VPN / post_url.txt" })
  } else {
    Write-Dot $false "API :$ApiPort" 'not answering'
    Write-Dot $false 'collector feed' 'unknown (API down)'
  }

  # 3. UI
  $uiPid = Get-PortPid $UiPort
  if ($uiPid) {
    Write-Dot $true "UI :$UiPort" "serving (pid $uiPid)"
  } else {
    Write-Dot $false "UI :$UiPort" 'not running'
  }

  Write-Host ''
  if ($health) {
    Write-Host "  dashboard : http://localhost:$UiPort" -ForegroundColor DarkGray
    Write-Host "  quick view: http://localhost:$ApiPort/live" -ForegroundColor DarkGray
  }
  Write-Host ''
}

function Start-Thing([string]$what) {
  switch ($what) {
    'mysql' {
      $state = Get-MySqlState
      if ($state.running) { Write-Host '  MySQL already running'; return }
      docker start $MysqlName | Out-Null
      Start-Sleep -Seconds 3
    }
    'api' {
      if (Get-PortPid $ApiPort) { Write-Host '  API already running'; return }
      Start-Process -FilePath 'node' `
        -ArgumentList '--env-file=.env', 'src/server.js' `
        -WorkingDirectory $ServerDir -WindowStyle Hidden `
        -RedirectStandardOutput $ApiLog -RedirectStandardError "$ApiLog.err" | Out-Null
      Write-Host '  API starting...'
      if (-not (Wait-Port $ApiPort 30 'API')) { Write-Host '  see server/api.log' -ForegroundColor DarkGray; return }
      $h = Get-ApiHealth
      if ($h) { Write-Host ('  API answering - db ' + $h.db) } else { Write-Host '  port open but /health failing - see server/api.log' -ForegroundColor Red }
    }
    'ui' {
      if (Get-PortPid $UiPort) { Write-Host '  UI already running'; return }
      if (-not (Test-Path $NgCli)) { Write-Host '  Angular CLI not found - run npm install in cluster-pulse/' -ForegroundColor Red; return }
      Start-Process -FilePath (Join-Path $UiDir 'run_ui.cmd') -WindowStyle Hidden
      Write-Host '  UI compiling...'
      if (-not (Wait-Port $UiPort 120 'UI')) { Write-Host '  see cluster-pulse/ngserve.log' -ForegroundColor DarkGray }
    }
  }
}

function Stop-Thing([string]$what) {
  switch ($what) {
    'api' {
      $procId = Get-PortPid $ApiPort
      if ($procId) { Stop-Process -Id $procId -Force; Write-Host "  API stopped (pid $procId)" }
      else { Write-Host '  API not running' }
    }
    'ui' {
      $procId = Get-PortPid $UiPort
      if ($procId) { Stop-Process -Id $procId -Force; Write-Host "  UI stopped (pid $procId)" }
      else { Write-Host '  UI not running' }
    }
    'mysql' {
      docker stop $MysqlName | Out-Null
      Write-Host '  MySQL stopped'
    }
  }
}

function Open-Dashboard {
  if (-not (Get-PortPid $UiPort)) {
    Write-Host '  UI is not running - start it first (option 2)' -ForegroundColor Red
    return
  }
  Start-Process "http://localhost:$UiPort"
  Write-Host "  opened http://localhost:$UiPort"
}

function Clear-Screen {
  # Clear-Screen throws in a non-interactive host (piped input, scheduled task)
  try { Clear-Host } catch { }
}

function Watch-Loop([int]$intervalSeconds = 15) {
  # Self-healing loop. The VPN drops and hands out a new address repeatedly; this
  # keeps the laptop side alive and keeps the cluster pointed at the current IP,
  # so a reconnect resumes on its own instead of needing a manual restart cycle.
  Write-Host 'watch mode - Ctrl+C to stop' -ForegroundColor Cyan
  while ($true) {
    $stamp = Get-Date -Format 'HH:mm:ss'
    $ip = Get-VpnIp

    if (-not $ip) {
      Write-Host ("[$stamp] VPN down - waiting (nothing to sync)") -ForegroundColor DarkYellow
      Start-Sleep -Seconds $intervalSeconds
      continue
    }

    if (-not (Get-PortPid $ApiPort)) { Write-Host "[$stamp] API down - starting" -ForegroundColor Yellow; Start-Thing 'api' }
    if (-not (Get-PortPid $UiPort))  { Write-Host "[$stamp] UI down - starting"  -ForegroundColor Yellow; Start-Thing 'ui' }

    $health = Get-ApiHealth
    $feed = if ($health) { $health.last_snapshot_ago_s } else { $null }

    if ($null -ne $feed -and $feed -gt 30) {
      # feed stalled: the common cause is our address having moved
      Sync-PostUrl
      Write-Host "[$stamp] feed stale (${feed}s) - re-synced target, waiting for the collector" -ForegroundColor Yellow
    } else {
      Write-Host ("[$stamp] ip=$ip  api=up  feed=" + $(if ($null -eq $feed) { '?' } else { "${feed}s" })) -ForegroundColor DarkGray
    }

    Start-Sleep -Seconds $intervalSeconds
  }
}

function Show-Menu {
  while ($true) {
    Clear-Screen
    Write-Host ''
    Write-Host '  ================================================' -ForegroundColor Cyan
    Write-Host '            CLUSTER PULSE  -  LAPTOP CONTROL' -ForegroundColor Cyan
    Write-Host '  ================================================' -ForegroundColor Cyan
    Write-Host ''
    Write-Host '    1)  status      - what is up, what is down'
    Write-Host '    2)  start       - start MySQL + API + UI'
    Write-Host '    3)  stop        - stop API + UI'
    Write-Host '    4)  restart     - stop, wait, start'
    Write-Host '    5)  logs        - tail the API and UI logs'
    Write-Host '    6)  open        - open the dashboard in a browser'
    Write-Host '    7)  watch       - keep it alive: auto-sync IP, restart API/UI (Ctrl+C to stop)'
    Write-Host '    0)  exit'
    Write-Host ''
    $choice = Read-Host '  choose'

    switch ($choice) {
      '1' { Clear-Screen; Show-Status }
      '2' { Clear-Screen
            Write-Host 'Starting Cluster Pulse...' -ForegroundColor Cyan
            Sync-PostUrl
            Start-Thing 'mysql'; Start-Thing 'api'; Start-Thing 'ui'
            Show-Status }
      '3' { Clear-Screen
            Write-Host 'Stopping Cluster Pulse...' -ForegroundColor Cyan
            Stop-Thing 'ui'; Stop-Thing 'api'
            Write-Host '  (MySQL left running on purpose)' -ForegroundColor DarkGray
            Show-Status }
      '4' { Clear-Screen
            Write-Host 'Restarting Cluster Pulse...' -ForegroundColor Cyan
            Stop-Thing 'ui'; Stop-Thing 'api'
            Start-Sleep -Seconds 2
            Start-Thing 'api'; Start-Thing 'ui'
            Show-Status }
      '5' { Clear-Screen
            Write-Host '--- server/api.log (last 30) ---' -ForegroundColor Cyan
            Get-Content $ApiLog -Tail 30
            Write-Host '--- cluster-pulse/ngserve.log (last 15) ---' -ForegroundColor Cyan
            Get-Content $UiLog -Tail 15 }
      '6' { Open-Dashboard }
      '7' { Clear-Screen; Watch-Loop }
      '0' { return }
      default { Write-Host '  not an option' -ForegroundColor Red }
    }
    Write-Host ''
    Read-Host '  press Enter to go back to the menu' | Out-Null
  }
}

switch ($Action.ToLower()) {
  'status'  { Show-Status }
  'start'   { Write-Host 'Starting Cluster Pulse...' -ForegroundColor Cyan
              Sync-PostUrl          # repoint the cluster first, before data can flow
              Start-Thing 'mysql'; Start-Thing 'api'; Start-Thing 'ui'
              Show-Status }
  'stop'    { Write-Host 'Stopping Cluster Pulse...' -ForegroundColor Cyan
              Stop-Thing 'ui'; Stop-Thing 'api'
              Write-Host '  (MySQL left running on purpose - use "stop mysql" if you want it down)' -ForegroundColor DarkGray
              Show-Status }
  'restart' { Write-Host 'Restarting Cluster Pulse...' -ForegroundColor Cyan
              Stop-Thing 'ui'; Stop-Thing 'api'
              Start-Sleep -Seconds 2
              Start-Thing 'api'; Start-Thing 'ui'
              Show-Status }
  'logs'    { Write-Host '--- server/api.log (last 30) ---' -ForegroundColor Cyan
              Get-Content $ApiLog -Tail 30
              Write-Host '--- cluster-pulse/ngserve.log (last 15) ---' -ForegroundColor Cyan
              Get-Content $UiLog -Tail 15 }
  'open'    { Open-Dashboard }
  'sync'    { Sync-PostUrl }
  'watch'   { Watch-Loop }
  default   { Show-Menu }
}
