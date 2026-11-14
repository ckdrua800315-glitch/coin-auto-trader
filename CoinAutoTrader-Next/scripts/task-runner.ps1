param([Parameter(Mandatory=$true)][string]$NodePath)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $projectRoot
New-Item -ItemType Directory -Path (Join-Path $projectRoot 'logs') -Force | Out-Null
while ($true) {
  try {
    & $NodePath (Join-Path $projectRoot 'src\server.js') >> (Join-Path $projectRoot 'logs\task.log') 2>&1
    "$(Get-Date -Format o) node exited: $LASTEXITCODE; retry in 10 seconds" | Out-File -LiteralPath (Join-Path $projectRoot 'logs\task.log') -Append
  } catch {
    $_ | Out-File -LiteralPath (Join-Path $projectRoot 'logs\task.log') -Append
  }
  Start-Sleep -Seconds 10
}
