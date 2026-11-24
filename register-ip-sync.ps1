# Re-registers ClusterPulse-IPSync so it never shows a window.
# The old action was powershell.exe directly, which flashes a console every run.
# Now: wscript.exe with a VBS launcher (window style 0) + task marked Hidden.

$root   = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs    = Join-Path $root 'sync-hidden.vbs'
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('//B "' + $vbs + '"')

$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 1)

$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -Hidden

Register-ScheduledTask -TaskName 'ClusterPulse-IPSync' -Action $action `
  -Trigger $trigger -Settings $settings `
  -Description 'Keeps Cluster Pulse POST target in sync with the laptop VPN IP (runs hidden)' -Force | Out-Null

Get-ScheduledTask -TaskName 'ClusterPulse-IPSync' | Select-Object TaskName, State, Hidden | Format-List
(Get-ScheduledTask -TaskName 'ClusterPulse-IPSync').Actions | Select-Object Execute, Arguments | Format-List
