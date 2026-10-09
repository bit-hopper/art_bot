# Unattended Met gate run (spec 11.4 steps 2-3): fill the Met index over as many capped passes as it takes, then write the
# 50-row audit sample and the per-department origin sample. Resumes from state/index/met.cache.json, so it is safe to
# stop and start again. Usage (from the repo root):  powershell -ExecutionPolicy Bypass -File scripts\overnight-met-audit.ps1
# Output: state\audit\met\overnight.log, met-audit.md/.json, met-origin.md and a DONE file when finished.
$ErrorActionPreference = "Continue"
Set-Location (Split-Path $PSScriptRoot -Parent)
$out = "state\audit\met"
New-Item -ItemType Directory -Force $out | Out-Null
$log = Join-Path $out "overnight.log"
function Say($m) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m" | Tee-Object -FilePath $log -Append }

# Keep the machine awake while this script runs (earlier runs died when the PC slept).
Add-Type -Namespace Win -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'
[void][Win.Power]::SetThreadExecutionState(0x80000001)

function CacheCount {
  $f = "state\index\met.cache.json"
  if (-not (Test-Path $f)) { return 0 }
  return @((Get-Content $f -Raw | ConvertFrom-Json).PSObject.Properties).Count
}

$zero = 0
for ($pass = 1; $pass -le 16 -and $zero -lt 2; $pass++) {
  $before = CacheCount
  Say "pass $pass start, cache $before"
  npm run build-index met 2>&1 | Select-Object -Last 3 | ForEach-Object { Say "  $_" }
  $grew = (CacheCount) - $before
  Say "pass $pass end, cache grew by $grew"
  if ($grew -le 0) { $zero++ } else { $zero = 0 }
  # A pass that stopped short of the 3,000 cap was probably cut off by the WAF: wait before the next one.
  Start-Sleep -Seconds $(if ($grew -lt 2900) { 1200 } else { 60 })
}

Say "index done (cache $(CacheCount)); sampling 50 rows"
npx tsx scripts/audit-sample.ts met $out 50 2>&1 | Select-Object -Last 5 | ForEach-Object { Say "  $_" }
Say "origin audit, 10 per department"
npx tsx scripts/audit-met-origin.ts $out 10 2>&1 | Select-Object -Last 5 | ForEach-Object { Say "  $_" }
Say "DONE"
"done $(Get-Date)" | Set-Content (Join-Path $out "DONE")
[void][Win.Power]::SetThreadExecutionState(0x80000000)
