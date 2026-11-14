function Test-SameTraderPath([string]$First,[string]$Second) {
  if(!$First -or !$Second){return $false}
  try{return [string]::Equals([IO.Path]::GetFullPath($First).TrimEnd('\','/'),[IO.Path]::GetFullPath($Second).TrimEnd('\','/'),[StringComparison]::OrdinalIgnoreCase)}catch{return $false}
}
function Assert-TraderProbeStopped([int]$ProbeStatus){
  if($ProbeStatus -eq 0){return}
  if($ProbeStatus -eq 1){throw 'An instance is still alive; no database backup was attempted.'}
  throw 'Cannot verify server exit because process access is denied or unknown. No database backup or second server start was attempted. Run restart.bat from your normal Windows session.'
}
function Assert-TraderStopped([string]$ProjectRoot){
  $lock=Join-Path $ProjectRoot 'data\instance.lock'
  if(!(Test-Path -LiteralPath $lock)){return}
  $lockId=0;if(![int]::TryParse((Get-Content -LiteralPath $lock -Raw).Trim(),[ref]$lockId) -or $lockId -le 0){throw 'Invalid process lock. No database backup was attempted.'}
  # A hidden or inaccessible process is not evidence that it has exited.
  $nodePath=(Get-Command node -ErrorAction Stop).Source
  & $nodePath -e 'try{process.kill(Number(process.argv[1]),0);process.exit(1)}catch(e){process.exit(e.code===String.fromCharCode(69,83,82,67,72)?0:2)}' $lockId
  Assert-TraderProbeStopped $LASTEXITCODE
}
function Test-TraderIdentity {
  param([int]$ProcessId,[string]$ProcessName,[string]$CommandLine,[string]$ProjectRoot,[int[]]$ListenerIds=@(),[string]$AuthenticatedDataDir)
  if($ProcessId -le 0 -or $ProcessName -notin @('node','node.exe')){return $false}
  $entry=(Join-Path $ProjectRoot 'src\server.js').Replace('\','/')
  $cmd=([string]$CommandLine).Replace('\','/')
  if($cmd -match ('(?i)(?:^|[\s"''])'+[regex]::Escape($entry)+'(?:$|[\s"''])')){return $true}
  return ($ProcessId -in $ListenerIds) -and (Test-SameTraderPath $AuthenticatedDataDir (Join-Path $ProjectRoot 'data'))
}
function Get-TraderPort([string]$ProjectRoot){
  $urlFile=Join-Path $ProjectRoot 'data\dashboard-url.txt'
  if(Test-Path -LiteralPath $urlFile){try{$u=[uri](Get-Content -LiteralPath $urlFile -Raw).Trim();if($u.IsLoopback -and $u.Port -ge 1024){return $u.Port}}catch{}}
  return 8787
}
function Get-TraderProof([string]$ProjectRoot){
  $port=Get-TraderPort $ProjectRoot
  $tokenFile=Join-Path $ProjectRoot 'data\access-token.txt'
  if(!(Test-Path -LiteralPath $tokenFile)){return $null}
  $token=(Get-Content -LiteralPath $tokenFile -Raw).Trim()
  try{
    $state=Invoke-RestMethod "http://127.0.0.1:$port/api/state" -Headers @{Authorization="Bearer $token"} -TimeoutSec 3
    if($state.mode -ne 'paper'){return $null}
    return @{Port=$port;DataDir=$state.config.dataDir;Headers=@{Authorization="Bearer $token"}}
  }catch{return $null}
}
function Get-TraderListeners([int]$Port){
  $ids=@();$wildcardV6=@()
  foreach($line in (& netstat.exe -ano -p tcp)){
    $parts=$line.Trim() -split '\s+'
    if($parts.Count -ge 5 -and $parts[0] -eq 'TCP' -and $parts[3] -eq 'LISTENING'){
      if($parts[1] -in @("127.0.0.1:$Port","0.0.0.0:$Port")){$ids += [int]$parts[4]}
      elseif($parts[1] -eq "[::]:$Port"){$wildcardV6 += [int]$parts[4]}
    }
  }
  if($ids.Count){return @($ids | Select-Object -Unique)}
  $wildcardV6=@($wildcardV6 | Select-Object -Unique)
  if($wildcardV6.Count -eq 1){return $wildcardV6}
  return @()
}
function Get-TraderInstance([string]$ProjectRoot){
  $proof=Get-TraderProof $ProjectRoot
  if($proof -and !(Test-SameTraderPath $proof.DataDir (Join-Path $ProjectRoot 'data'))){throw "Port $($proof.Port) belongs to a different data folder: $($proof.DataDir). No process was stopped."}
  $listeners=if($proof){@(Get-TraderListeners $proof.Port)}else{@()}
  $candidates=@($listeners)
  $lock=Join-Path $ProjectRoot 'data\instance.lock'
  if(Test-Path -LiteralPath $lock){$lockId=0;if([int]::TryParse((Get-Content -LiteralPath $lock -Raw).Trim(),[ref]$lockId)){$candidates+= $lockId}}
  foreach($candidate in @($candidates | Select-Object -Unique)){
    $p=Get-Process -Id $candidate -ErrorAction SilentlyContinue;if(!$p){continue}
    $cmd='';try{$cmd=(Get-CimInstance Win32_Process -Filter "ProcessId=$candidate" -ErrorAction Stop).CommandLine}catch{}
    $dataDir=if($proof){$proof.DataDir}else{''}
    if(Test-TraderIdentity -ProcessId $candidate -ProcessName $p.ProcessName -CommandLine $cmd -ProjectRoot $ProjectRoot -ListenerIds $listeners -AuthenticatedDataDir $dataDir){return @{Id=$p.Id;Started=$p.StartTime;Proof=$proof}}
  }
  return $null
}
function Stop-TraderInstance([string]$ProjectRoot){
  $instance=Get-TraderInstance $ProjectRoot
  if(!$instance){return $false}
  if($instance.Proof){try{Invoke-RestMethod "http://127.0.0.1:$($instance.Proof.Port)/api/shutdown" -Method Post -Headers $instance.Proof.Headers -TimeoutSec 3 | Out-Null}catch{}}
  $deadline=(Get-Date).AddSeconds(3)
  while((Get-Date) -lt $deadline -and (Get-Process -Id $instance.Id -ErrorAction SilentlyContinue)){Start-Sleep -Milliseconds 100}
  $p=Get-Process -Id $instance.Id -ErrorAction SilentlyContinue
  if($p){
    if($p.StartTime -ne $instance.Started){throw 'Process identity changed; no process was stopped.'}
    Stop-Process -Id $instance.Id -ErrorAction Stop
    Wait-Process -Id $instance.Id -Timeout 10 -ErrorAction SilentlyContinue
  }
  if(Get-Process -Id $instance.Id -ErrorAction SilentlyContinue){throw 'Server has not stopped; account files were not copied.'}
  return $true
}
