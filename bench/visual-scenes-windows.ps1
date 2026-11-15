# Run from the repository root with a fresh scratch directory.
param([Parameter(Mandatory)][string]$Scratch, [ValidateRange(1, 10)][int]$Repeats = 3)
$ErrorActionPreference = 'Stop'
$runner = (Resolve-Path -LiteralPath 'bench/visual-scenes.ts').Path
$node = (Get-Command node -CommandType Application | Select-Object -First 1).Source
$Scratch = [IO.Path]::GetFullPath($Scratch)
if (Test-Path -LiteralPath $Scratch) { throw 'Benchmark scratch directory already exists' }
New-Item -Path $Scratch -ItemType Directory | Out-Null

function Measure-Render($mode, $count, $variant, $runDir, $repetition) {
  $log = Join-Path $runDir "$variant-$count-$mode.json"
  $errLog = "$log.stderr"
  $proc = Start-Process -FilePath $node -ArgumentList @(
    ('"{0}"' -f $runner), $mode, ('"{0}"' -f $runDir), $count, $variant
  ) -RedirectStandardOutput $log -RedirectStandardError $errLog -WindowStyle Hidden -PassThru
  $cpu = @{}
  $ffmpegCpu = @{}
  $peak = 0
  $samples = 0
  while (!$proc.HasExited) {
    $rows = @(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='ffmpeg.exe' OR Name='ffprobe.exe'")
    $tree = [Collections.Generic.HashSet[uint32]]::new()
    [void]$tree.Add($proc.Id)
    do {
      $previous = $tree.Count
      foreach ($row in $rows) {
        if ($tree.Contains($row.ParentProcessId)) { [void]$tree.Add($row.ProcessId) }
      }
    } while ($previous -lt $tree.Count)
    $rss = 0
    foreach ($row in $rows) {
      if (!$tree.Contains($row.ProcessId)) { continue }
      $id = "$($row.ProcessId)/$($row.CreationDate.Ticks)"
      $rss += [long]$row.WorkingSetSize
      $cpu[$id] = ([double]$row.KernelModeTime + [double]$row.UserModeTime) / 10000000
      if ($row.Name -eq 'ffmpeg.exe') { $ffmpegCpu[$id] = $cpu[$id] }
    }
    $peak = [math]::Max($peak, $rss)
    $samples++
    Start-Sleep -Milliseconds 50
  }
  $proc.WaitForExit()
  if ($proc.ExitCode -ne 0) { throw (Get-Content -Raw -LiteralPath $errLog) }
  # Query the exited root directly when available. Children contribute their last sample.
  try {
    $rootCpu = $proc.TotalProcessorTime.TotalSeconds
    $rootKey = $cpu.Keys | Where-Object { $_.StartsWith("$($proc.Id)/") } | Select-Object -First 1
    if ($rootKey) { $cpu[$rootKey] = [math]::Max($rootCpu, $cpu[$rootKey]) }
    else { $cpu["$($proc.Id)/exit"] = $rootCpu }
  } catch {}
  $data = Get-Content -Raw -LiteralPath $log | ConvertFrom-Json -AsHashtable
  $data.peakTreeMiB = [math]::Round($peak / 1MB, 1)
  $data.sampledTreeCpuSeconds = [math]::Round(($cpu.Values | Measure-Object -Sum).Sum, 3)
  $data.sampledFfmpegCpuSeconds = [math]::Round(($ffmpegCpu.Values | Measure-Object -Sum).Sum, 3)
  $data.samples = $samples
  $data.repetition = $repetition
  [pscustomobject]$data | ConvertTo-Json -Compress
}

foreach ($repetition in 1..$Repeats) {
  $runDir = Join-Path $Scratch "run-$repetition"
  foreach ($count in 8, 16) {
    foreach ($variant in 'static', 'translate', 'opacity', 'animated') {
      & $node $runner setup $runDir $count $variant
      if ($LASTEXITCODE -ne 0) { throw 'Benchmark setup failed' }
      Measure-Render cold $count $variant $runDir $repetition
      Measure-Render cached $count $variant $runDir $repetition
      & $node $runner verify $runDir $count $variant
      if ($LASTEXITCODE -ne 0) { throw 'Output verification failed' }
    }
  }
}
