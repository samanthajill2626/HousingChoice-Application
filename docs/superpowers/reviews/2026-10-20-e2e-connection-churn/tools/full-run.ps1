param(
  [Parameter(Mandatory = $true)][string]$RunDir,
  [switch]$Hook
)
# One full `npm run e2e` (bare, from the worktree) under the passive sampler,
# optionally with the churn hook preloaded into every node process.
$tools = $PSScriptRoot
# The worktree these tools are committed in: tools -> review dir -> reviews ->
# superpowers -> docs -> worktree root.
$wt = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..\..')).Path
New-Item -ItemType Directory -Force -Path $RunDir | Out-Null
$ports = @()
foreach ($l in 1..16) { $b = 9001 + $l * 100; $ports += $b, ($b + 10), ($b + 20), ($b + 30) }
$ports += 8000, 9000
$stop = Join-Path $RunDir 'STOP'
$sampler = Start-Process powershell -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $tools 'run-sampler.ps1'), '-OutDir', (Join-Path $RunDir 'sampler'), '-Ports', ($ports -join ','), '-IntervalMs', '25', '-MaxSeconds', '4800', '-StopFile', $stop) -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 3
if ($Hook) {
  New-Item -ItemType Directory -Force -Path (Join-Path $RunDir 'hook') | Out-Null
  $env:CHURN_HOOK_DIR = Join-Path $RunDir 'hook'
  $env:NODE_OPTIONS = '--import=file:///' + ((Join-Path $tools 'churn-hook.mjs') -replace '\\', '/')
}
[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() | Out-File -Encoding ascii (Join-Path $RunDir 'run.start')
$p = Start-Process -FilePath 'npm.cmd' -ArgumentList @('run', 'e2e') -WorkingDirectory $wt -RedirectStandardOutput (Join-Path $RunDir 'e2e.out') -RedirectStandardError (Join-Path $RunDir 'e2e.err') -WindowStyle Hidden -PassThru
# Touch the handle first, or ExitCode reads back empty after WaitForExit.
$null = $p.Handle
$p.WaitForExit()
"EXIT=$($p.ExitCode)" | Out-File -Encoding ascii (Join-Path $RunDir 'run.exit')
[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() | Out-File -Encoding ascii (Join-Path $RunDir 'run.end')
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
Copy-Item -Recurse -Force (Join-Path $wt 'e2e\.artifacts\test-results') (Join-Path $RunDir 'test-results') -ErrorAction SilentlyContinue
Copy-Item -Force (Join-Path $wt 'e2e\.artifacts\results.json') (Join-Path $RunDir 'results.json') -ErrorAction SilentlyContinue
# Let TIME_WAIT drain (120 s on this host) so every closed tuple is recorded.
Start-Sleep -Seconds 135
New-Item -ItemType File -Force -Path $stop | Out-Null
$sampler.WaitForExit(30000) | Out-Null
'DONE' | Out-File -Encoding ascii (Join-Path $RunDir 'run.done')
