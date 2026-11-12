param(
  [string]$ExecName = 'caj-bofia-rate-discovery-prod-550ptm4',
  [string]$JobName = 'caj-bofia-rate-discovery-prod',
  [string]$ResourceGroup = 'rg-bofia-rate-agent-prod-southindia',
  [string]$Account = 'stbofiarateagentprod01',
  [string]$Container = 'agent-state',
  [int]$IntervalSec = 240,
  [int]$MaxChecks = 20,
  [string]$ReceiptFile = 'logs/sprint-010/execution-550ptm4-receipt.json'
)
$ErrorActionPreference = 'Continue'
$blobName = "output:latest:_execution_$ExecName.json"
for ($i = 1; $i -le $MaxChecks; $i++) {
  Start-Sleep -Seconds $IntervalSec
  $state = & az containerapp job execution show --name $JobName --job-execution-name $ExecName --resource-group $ResourceGroup --query 'properties.status' -o tsv 2>$null
  & az storage blob download --account-name $Account --container-name $Container --name $blobName --auth-mode login --no-progress --file $ReceiptFile --overwrite 2>$null | Out-Null
  try {
    $r = Get-Content $ReceiptFile -Raw | ConvertFrom-Json
    $s = $r.summary
    $done = [int]$s.succeeded + [int]$s.failed
    $ts = (Get-Date).ToUniversalTime().ToString('HH:mmZ')
    Write-Output "[check $i @ $ts] az=$state phase=$($r.phase) succ=$($s.succeeded) fail=$($s.failed) done=$done/$($s.total_banks) updated=$($r.updated_at)"
  } catch {
    Write-Output "[check $i] receipt read failed: $_"
  }
  if ($state -in @('Succeeded','Failed','Cancelled','Stopped','Degraded')) {
    Write-Output "TERMINAL: az=$state"
    exit 0
  }
  if ($r.phase -eq 'completed') {
    Write-Output "TERMINAL: receipt phase=completed"
    exit 0
  }
}
Write-Output "MAX CHECKS REACHED ($MaxChecks) without terminal state"
