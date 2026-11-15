# Visual Scene path-layer benchmark. Windows PowerShell 5.1 or later; run from the repository root
# with a fresh scratch directory. Each render runs in its own node process; its process tree
# (node + ffmpeg/ffprobe children) is sampled every 50 ms for working set and CPU time.
#   powershell -File bench/visual-scene-v2-windows.ps1 -Scratch <new-directory> [-Backends]
# -Backends compares path rasterization in Skia (in-process) and headless Chrome (CDP) instead.
param([Parameter(Mandatory)][string]$Scratch, [ValidateRange(1, 10)][int]$Repeats = 3, [switch]$Backends)
$ErrorActionPreference = 'Stop'
$demo = (Resolve-Path -LiteralPath 'bench/visual-scene-v2.ts').Path
$tiles = (Resolve-Path -LiteralPath 'bench/visual-scenes.ts').Path
$node = (Get-Command node -CommandType Application | Select-Object -First 1).Source
$Scratch = [IO.Path]::GetFullPath($Scratch)
if (Test-Path -LiteralPath $Scratch) { throw 'Benchmark scratch directory already exists' }
New-Item -Path $Scratch -ItemType Directory | Out-Null

function Invoke-Node([string[]]$arguments) {
  & $node @arguments
  if ($LASTEXITCODE -ne 0) { throw "node $($arguments -join ' ') failed" }
}

function Measure-Node([string]$label, [string[]]$arguments, [int]$repetition) {
  $log = Join-Path $Scratch "$label-$repetition.json"
  $quoted = $arguments | ForEach-Object { '"{0}"' -f $_ }
  $proc = Start-Process -FilePath $node -ArgumentList $quoted -RedirectStandardOutput $log -RedirectStandardError "$log.stderr" -WindowStyle Hidden -PassThru
  # Windows PowerShell 5.1 reports ExitCode only when the handle was opened before exit.
  $null = $proc.Handle
  $cpu = @{}
  $peak = 0
  $samples = 0
  $failedSamples = 0
  while (!$proc.HasExited) {
    # WMI occasionally cancels a query under load; skip that sample instead of aborting the run.
    try { $rows = @(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='ffmpeg.exe' OR Name='ffprobe.exe' OR Name='chrome.exe' OR Name='msedge.exe'" -ErrorAction Stop) }
    catch { $failedSamples++; Start-Sleep -Milliseconds 50; continue }
    $tree = New-Object 'System.Collections.Generic.HashSet[uint32]'
    [void]$tree.Add([uint32]$proc.Id)
    do {
      $previous = $tree.Count
      foreach ($row in $rows) { if ($tree.Contains([uint32]$row.ParentProcessId)) { [void]$tree.Add([uint32]$row.ProcessId) } }
    } while ($previous -lt $tree.Count)
    $rss = 0
    foreach ($row in $rows) {
      if (!$tree.Contains([uint32]$row.ProcessId)) { continue }
      $rss += [long]$row.WorkingSetSize
      $cpu["$($row.ProcessId)/$($row.CreationDate.Ticks)"] = ([double]$row.KernelModeTime + [double]$row.UserModeTime) / 10000000
    }
    $peak = [math]::Max($peak, $rss)
    $samples++
    Start-Sleep -Milliseconds 50
  }
  $proc.WaitForExit()
  if ($proc.ExitCode -ne 0) { throw (Get-Content -Raw -LiteralPath "$log.stderr") }
  $data = Get-Content -Raw -LiteralPath $log | ConvertFrom-Json
  $data | Add-Member peakTreeMiB $(if ($samples) { [math]::Round($peak / 1MB, 1) } else { $null })
  $data | Add-Member sampledTreeCpuSeconds $(if ($samples) { [math]::Round(($cpu.Values | Measure-Object -Sum).Sum, 3) } else { $null })
  $data | Add-Member failedSamples $failedSamples
  $data | Add-Member samples $samples
  $data | Add-Member repetition $repetition
  $data | ConvertTo-Json -Compress
}

if ($Backends) {
  $raster = (Resolve-Path -LiteralPath 'bench/path-raster-backends.ts').Path
  foreach ($repetition in 1..$Repeats) {
    foreach ($backend in 'skia', 'chrome') {
      Measure-Node "raster-$backend" @($raster, $backend, (Join-Path $Scratch "$backend-$repetition")) $repetition
    }
  }
  return
}

foreach ($repetition in 1..$Repeats) {
  $runDir = Join-Path $Scratch "run-$repetition"
  Invoke-Node @($demo, 'setup', $runDir)
  foreach ($quality in 'preview', 'full') {
    foreach ($mode in 'cold', 'cached') { Measure-Node "demo-$quality-$mode" @($demo, $mode, $runDir, $quality) $repetition }
    Invoke-Node @($demo, 'verify', $runDir, $quality)
  }
  foreach ($count in 8, 16) {
    foreach ($kind in 'rect', 'path') {
      Invoke-Node @($tiles, 'setup', $runDir, $count, 'animated', $kind)
      foreach ($mode in 'cold', 'cached') { Measure-Node "tiles-$count-$kind-$mode" @($tiles, $mode, $runDir, $count, 'animated', $kind) $repetition }
      Invoke-Node @($tiles, 'verify', $runDir, $count, 'animated', $kind)
    }
  }
}
