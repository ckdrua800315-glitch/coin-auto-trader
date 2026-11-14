param([ValidateSet('Start','Stop','Status')][string]$Action='Status')
$ErrorActionPreference='Stop'
$projectRoot=Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'process-control.ps1')
if($Action -eq 'Stop'){if(Stop-TraderInstance $projectRoot){Write-Output 'Verified project server stopped.'}else{Write-Output 'No verified server is running for this project.'};exit}
$existing=Get-TraderInstance $projectRoot
if($Action -eq 'Status') {if($existing){Write-Output "Running: $($existing.Id)"}else{Write-Output 'No verified server found.'};exit}
if($existing){Write-Output 'Already running';exit}
$nodePath=(Get-Command node -ErrorAction Stop).Source
New-Item -ItemType Directory -Path (Join-Path $projectRoot 'logs') -Force | Out-Null
$entry=Join-Path $projectRoot 'src\server.js'
$process=Start-Process -FilePath $nodePath -ArgumentList @('"'+$entry+'"') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $projectRoot 'logs\stdout.log') -RedirectStandardError (Join-Path $projectRoot 'logs\stderr.log') -PassThru
Start-Sleep -Seconds 2
if($process.HasExited){throw 'Start failed. Read logs/stderr.log.'}
Write-Output "Started: $($process.Id). Open data/dashboard-url.txt in your browser."
