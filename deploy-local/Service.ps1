param([ValidateSet('Install','Remove','Start','Stop','Status')][string]$Action = 'Status')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$taskName = 'Es2API-Rebuild-Guard'
if ($Action -eq 'Install') {
  $nodePath = (Get-Command node.exe).Source
  $runner = Join-Path $PSScriptRoot 'operations.mjs'
  $hiddenCommand = "& '" + $nodePath.Replace("'", "''") + "' '" + $runner.Replace("'", "''") + "' guard"
  $command = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -Command "' + $hiddenCommand + '"') -WorkingDirectory $projectRoot
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $taskName -Action $command -Trigger $trigger -Settings $settings -Principal $principal -Description 'Es2API health recovery and daily private backups' -Force | Out-Null
  Start-ScheduledTask -TaskName $taskName
} elseif ($Action -eq 'Remove') {
  & node.exe (Join-Path $PSScriptRoot 'operations.mjs') disable
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
} elseif ($Action -eq 'Start') { Start-ScheduledTask -TaskName $taskName
} elseif ($Action -eq 'Stop') {
  & node.exe (Join-Path $PSScriptRoot 'operations.mjs') disable
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
} else { Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Select-Object TaskName,State }
