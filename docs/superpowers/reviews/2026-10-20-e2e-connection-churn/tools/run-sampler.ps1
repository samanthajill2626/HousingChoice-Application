param(
  [Parameter(Mandatory = $true)][string]$OutDir,
  [Parameter(Mandatory = $true)][string]$Ports,
  [int]$IntervalMs = 50,
  [int]$MaxSeconds = 3600,
  [string]$StopFile = ''
)
$src = Join-Path $PSScriptRoot 'TcpChurnSampler.cs'
Add-Type -TypeDefinition (Get-Content -Raw -LiteralPath $src) -ReferencedAssemblies System.Management
$portList = [int[]]($Ports -split ',' | ForEach-Object { [int]$_ })
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
"started $(Get-Date -Format o) pid=$PID ports=$Ports interval=$IntervalMs" | Out-File -Encoding utf8 (Join-Path $OutDir 'sampler.log')
try {
  [TcpChurnSampler]::Run($OutDir, $portList, $IntervalMs, $MaxSeconds, $StopFile)
  "finished $(Get-Date -Format o)" | Out-File -Append -Encoding utf8 (Join-Path $OutDir 'sampler.log')
} catch {
  "ERROR $($_ | Out-String)" | Out-File -Append -Encoding utf8 (Join-Path $OutDir 'sampler.log')
}
