param(
  [Parameter(Mandatory = $true)][string]$RunDir,
  [Parameter(Mandatory = $true)][string]$Specs,
  [int]$RepeatEach = 1,
  [switch]$NetLog,
  [switch]$Trace
)
# One filtered run against THIS worktree's live e2e:session (playwright.config
# reuses it), under the passive sampler; optional Chromium NetLog + trace.
$tools = $PSScriptRoot
# The worktree these tools are committed in: tools -> review dir -> reviews ->
# superpowers -> docs -> worktree root.
$wt = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..\..')).Path
$lane = Get-Content -Raw (Join-Path $wt 'e2e\.artifacts\lane.json') | ConvertFrom-Json
New-Item -ItemType Directory -Force -Path $RunDir | Out-Null
Copy-Item (Join-Path $wt 'e2e\.artifacts\lane.json') (Join-Path $RunDir 'lane.json')
$ports = @($lane.ports.app, $lane.ports.dashboard, $lane.ports.fake, $lane.ports.publicBase, 8000, 9000)
$stop = Join-Path $RunDir 'STOP'
$sampler = Start-Process powershell -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $tools 'run-sampler.ps1'), '-OutDir', (Join-Path $RunDir 'sampler'), '-Ports', ($ports -join ','), '-IntervalMs', '25', '-MaxSeconds', '4800', '-StopFile', $stop) -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 3
$args2 = @('run', 'e2e', '-w', '@housingchoice/e2e', '--')
if ($NetLog) {
  Copy-Item (Join-Path $tools 'netlog.playwright.config.ts') (Join-Path $wt 'e2e\zz-churn-netlog.playwright.config.ts')
  $env:CHURN_NETLOG = Join-Path $RunDir 'netlog.json'
  $args2 += @('-c', 'zz-churn-netlog.playwright.config.ts')
}
if ($Trace) { $env:E2E_TRACE = '1' }
$args2 += ($Specs -split ' ')
if ($RepeatEach -gt 1) { $args2 += "--repeat-each=$RepeatEach" }
[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() | Out-File -Encoding ascii (Join-Path $RunDir 'run.start')
$p = Start-Process -FilePath 'npm.cmd' -ArgumentList $args2 -WorkingDirectory $wt -RedirectStandardOutput (Join-Path $RunDir 'e2e.out') -RedirectStandardError (Join-Path $RunDir 'e2e.err') -WindowStyle Hidden -PassThru
$null = $p.Handle
$p.WaitForExit()
"EXIT=$($p.ExitCode)" | Out-File -Encoding ascii (Join-Path $RunDir 'run.exit')
[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() | Out-File -Encoding ascii (Join-Path $RunDir 'run.end')
if ($NetLog) { Remove-Item -Force (Join-Path $wt 'e2e\zz-churn-netlog.playwright.config.ts') -ErrorAction SilentlyContinue }
Copy-Item -Recurse -Force (Join-Path $wt 'e2e\.artifacts\test-results') (Join-Path $RunDir 'test-results') -ErrorAction SilentlyContinue
Copy-Item -Force (Join-Path $wt 'e2e\.artifacts\results.json') (Join-Path $RunDir 'results.json') -ErrorAction SilentlyContinue
Start-Sleep -Seconds 135
New-Item -ItemType File -Force -Path $stop | Out-Null
$sampler.WaitForExit(30000) | Out-Null
'DONE' | Out-File -Encoding ascii (Join-Path $RunDir 'run.done')
