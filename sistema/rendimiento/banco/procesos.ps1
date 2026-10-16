# Lanza la app y anota, cada ~50 ms, los procesos hijos que aparecen y desaparecen (con su línea de órdenes).
param([string]$Exe, [string]$Label, [int]$Seconds = 10)
$B = $PSScriptRoot
$run = Join-Path $B "run-proc-$Label"
Remove-Item -Recurse -Force $run -ErrorAction SilentlyContinue
Copy-Item -Recurse (Join-Path $B 'base-caliente') $run
$env:DSH_HOME = Join-Path $run 'home'
$env:DSH_LOCAL_SIN_AYUDANTES = '1'
$env:DSH_DESKTOP_OPEN_DEVTOOLS = '0'
$sw = [Diagnostics.Stopwatch]::StartNew()
$p = Start-Process -FilePath $Exe -ArgumentList "--user-data-dir=$(Join-Path $run 'ud')" -PassThru
$seen = @{}
while ($sw.ElapsedMilliseconds -lt $Seconds * 1000) {
  $now = $sw.ElapsedMilliseconds
  $procs = Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe' OR Name='node.exe' OR Name='conhost.exe'" | Where-Object { $_.CommandLine -match [regex]::Escape($run) -or $_.ProcessId -eq $p.Id -or ($_.CommandLine -match ' -e ' -and $_.CommandLine -match 'DeepSeek Harness') }
  $ids = @{}
  foreach ($x in $procs) {
    $ids[$x.ProcessId] = $true
    if (-not $seen.ContainsKey($x.ProcessId)) {
      $kind = if ($x.CommandLine -match '--type=([a-z-]+)') { $Matches[1] } elseif ($x.CommandLine -match ' -e ') { 'node -e (arranque)' } elseif ($x.ProcessId -eq $p.Id) { 'main' } else { ($x.CommandLine -replace '^.*?\.exe"?\s*', '').Substring(0, [Math]::Min(70, ($x.CommandLine -replace '^.*?\.exe"?\s*', '').Length)) }
      $seen[$x.ProcessId] = @{ start = $now; end = $null; kind = $kind; parent = $x.ParentProcessId }
    }
  }
  foreach ($k in @($seen.Keys)) { if (-not $ids.ContainsKey($k) -and $null -eq $seen[$k].end) { $seen[$k].end = $now } }
}
foreach ($k in ($seen.Keys | Sort-Object { $seen[$_].start })) {
  $s = $seen[$k]
  "{0,6} -> {1,6}  pid {2,6} (padre {3,6})  {4}" -f $s.start, $(if ($null -eq $s.end) { 'vivo' } else { $s.end }), $k, $s.parent, $s.kind
}
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match [regex]::Escape($run) -or $_.ProcessId -eq $p.Id } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
