$ErrorActionPreference='Stop'
. (Join-Path (Split-Path $PSScriptRoot -Parent) 'scripts\process-control.ps1')
$project='D:\CoinAutoTrader-Next'
function Assert-Result([bool]$Value,[string]$Name){if(!$Value){throw "FAIL: $Name"};Write-Output "PASS: $Name"}
Assert-Result (Test-TraderIdentity -ProcessId 123 -ProcessName node -CommandLine 'node "D:\CoinAutoTrader-Next\src\server.js"' -ProjectRoot $project) 'absolute entry path'
Assert-Result (Test-TraderIdentity -ProcessId 123 -ProcessName node -CommandLine 'node src/server.js' -ProjectRoot $project -ListenerIds @(123) -AuthenticatedDataDir 'D:\CoinAutoTrader-Next\data') 'relative entry verified by authenticated data folder and port owner'
Assert-Result (!(Test-TraderIdentity -ProcessId 123 -ProcessName node -CommandLine 'node src/server.js' -ProjectRoot $project -ListenerIds @(456) -AuthenticatedDataDir 'D:\CoinAutoTrader-Next\data')) 'wrong port owner rejected'
Assert-Result (!(Test-TraderIdentity -ProcessId 123 -ProcessName node -CommandLine 'node src/server.js' -ProjectRoot $project -ListenerIds @(123) -AuthenticatedDataDir 'D:\Other\data')) 'other folder rejected'
Assert-Result (!(Test-TraderIdentity -ProcessId 123 -ProcessName python -CommandLine '' -ProjectRoot $project -ListenerIds @(123) -AuthenticatedDataDir 'D:\CoinAutoTrader-Next\data')) 'reused non-node PID rejected'
Assert-Result (!(Test-TraderIdentity -ProcessId 123 -ProcessName node -CommandLine 'node "D:\CoinAutoTrader-Next\src\server.js.backup"' -ProjectRoot $project)) 'entry path prefix mismatch rejected'
Assert-TraderProbeStopped 0
Assert-Result $true 'explicit missing-process result permits stopped backup'
foreach($status in @(1,2,99)){
 $refused=$false;try{Assert-TraderProbeStopped $status}catch{$refused=$true}
 Assert-Result $refused "alive or unknown process status $status blocks backup and second start"
}
