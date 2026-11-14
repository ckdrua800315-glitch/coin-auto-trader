$ErrorActionPreference='Stop'
$projectRoot=Split-Path $PSScriptRoot -Parent
$token=(Get-Content -LiteralPath (Join-Path $projectRoot 'data\access-token.txt') -Raw).Trim()
$headers=@{Authorization="Bearer $token"}
$uri='http://127.0.0.1:8787'
$before=Invoke-RestMethod "$uri/api/state" -Headers $headers
$oldId=[int](Get-Content -LiteralPath (Join-Path $projectRoot 'data\instance.lock') -Raw)
Invoke-RestMethod "$uri/api/control" -Method Post -Headers $headers -ContentType 'application/json' -Body '{"action":"pause"}' | Out-Null
& (Join-Path $PSScriptRoot 'background.ps1') -Action Stop
$deadline=(Get-Date).AddSeconds(45)
$recovered=$null
while((Get-Date) -lt $deadline){
  Start-Sleep -Seconds 2
  try {
    $current=Invoke-RestMethod "$uri/api/state" -Headers $headers -TimeoutSec 3
    if($current.startedAt -gt $before.startedAt -and $current.markets.Count -ge 300){$recovered=$current;break}
  } catch {}
}
if(!$recovered){throw 'Automatic restart timeout; inspect logs/task.log'}
$newId=[int](Get-Content -LiteralPath (Join-Path $projectRoot 'data\instance.lock') -Raw)
if($newId -eq $oldId){throw 'PID did not change'}
foreach($trade in $before.trades){if($trade.id -notin $recovered.trades.id){throw 'A prior trade was not recovered'}}
if(!$recovered.state.paused){throw 'Pause state was not recovered'}
if(!$before.state.paused){Invoke-RestMethod "$uri/api/control" -Method Post -Headers $headers -ContentType 'application/json' -Body '{"action":"resume"}' | Out-Null}
$report=[ordered]@{checkedAt=(Get-Date -Format o);oldPid=$oldId;newPid=$newId;markets=$recovered.markets.Count;priorTrades=$before.trades.Count;recoveredTrades=$recovered.trades.Count;pauseRecovered=$recovered.state.paused;taskState=[string](Get-ScheduledTask -TaskName 'CoinAutoTrader-Next-Paper').State;result='PASS'}
$report | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $projectRoot 'data\recovery-verification.json') -Encoding UTF8
$report | ConvertTo-Json
