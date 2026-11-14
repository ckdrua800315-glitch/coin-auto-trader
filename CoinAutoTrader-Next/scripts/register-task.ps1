param([switch]$Remove)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path $PSScriptRoot -Parent
$taskName='CoinAutoTrader-Next-Paper'
if($Remove){Unregister-ScheduledTask -TaskName $taskName -Confirm:$false;exit}
if(Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue){throw 'Task name exists; inspect it before changing anything.'}
$nodePath=(Get-Command node -ErrorAction Stop).Source
$runner=Join-Path $PSScriptRoot 'task-runner.ps1'
$action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$runner+'" -NodePath "'+$nodePath+'"') -WorkingDirectory $projectRoot
$trigger=New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
$settings=New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description 'CoinAutoTrader Next: paper trading only; isolated data directory' | Out-Null
Write-Output 'Logon task registered. Stop any foreground instance before starting the task.'
