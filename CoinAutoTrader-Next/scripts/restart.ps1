$ErrorActionPreference='Stop'
$projectRoot=Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $projectRoot
. (Join-Path $PSScriptRoot 'process-control.ps1')
$task=Get-ScheduledTask -TaskName 'CoinAutoTrader-Next-Paper' -ErrorAction SilentlyContinue
if($task){
  $runner=(Join-Path $PSScriptRoot 'task-runner.ps1').Replace('\','/')
  $owned=@($task.Actions | Where-Object { $_.Arguments -and $_.Arguments.Replace('\','/').IndexOf($runner,[StringComparison]::OrdinalIgnoreCase) -ge 0 }).Count -gt 0
  if(!$owned){Write-Output 'Existing scheduled task belongs to another project folder; leaving it unchanged.';$task=$null}
}
if($task -and $task.State -eq 'Running'){
  Stop-ScheduledTask -TaskName 'CoinAutoTrader-Next-Paper'
  Start-Sleep -Seconds 2
}
& (Join-Path $PSScriptRoot 'background.ps1') -Action Stop
Assert-TraderStopped $projectRoot
# Copy committed SQLite and its WAL together while the engine is down.
$backupDir=Join-Path $projectRoot ('data\backups\'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $backupDir -ErrorAction Stop | Out-Null
foreach($file in @('trader.sqlite','trader.sqlite-wal','trader.sqlite-shm')){
  $source=Join-Path $projectRoot ('data\'+$file)
  if(Test-Path -LiteralPath $source){Copy-Item -LiteralPath $source -Destination (Join-Path $backupDir $file) -ErrorAction Stop}
}
$token=(Get-Content -LiteralPath (Join-Path $projectRoot 'data\access-token.txt') -Raw).Trim()
$headers=@{Authorization="Bearer $token"}
$port=Get-TraderPort $projectRoot
if($task){Start-ScheduledTask -TaskName 'CoinAutoTrader-Next-Paper'}
else{& (Join-Path $PSScriptRoot 'background.ps1') -Action Start}
$deadline=(Get-Date).AddSeconds(60)
$manualStarted=$false
while((Get-Date) -lt $deadline){
  Start-Sleep -Seconds 2
  try {
    $state=Invoke-RestMethod "http://127.0.0.1:$port/api/state" -Headers $headers -TimeoutSec 3
    if($state.config.rebuiltStrategyV15 -and $state.state.strategyRevision -eq 15 -and $state.mode -eq 'paper' -and $state.config.maxPositions -eq 5 -and $state.state.accountSchemaVersion -eq 1 -and $state.accounts.upbit.initialCash -eq 10000000 -and $state.accounts.bithumb.initialCash -eq 10000000){
      Write-Output "PASS: paper-only; separate accounts; configurable limits; all Upbit KRW radar; event-driven evaluation; morning signals; trade/depth checks. Positions retained: $($state.positions.Count)."
      Write-Output 'Daily candles and order books may need several seconds to initialize.'
      exit 0
    }
  } catch {}
  if(!$manualStarted -and (Get-Date) -gt $deadline.AddSeconds(-40)){
    if($task -and (Get-ScheduledTask -TaskName 'CoinAutoTrader-Next-Paper').State -ne 'Running'){Start-ScheduledTask -TaskName 'CoinAutoTrader-Next-Paper'}
    elseif(!$task){& (Join-Path $PSScriptRoot 'background.ps1') -Action Start}
    $manualStarted=$true
  }
}
throw 'Updated strategy not observed. Inspect logs/task.log and logs/stderr.log; do not delete account data.'
