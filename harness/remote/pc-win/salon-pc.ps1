# Copyright 2026 wasm-dolphin contributors
# SPDX-License-Identifier: MIT
#
# The Windows side of the PC kit (harness/remote/pc-run.mjs drives it over
# ssh; research/pc-windows-kit.md). Windows PowerShell 5.1, no module, no
# install. Everything it creates is the kit's own and is listed in the
# snapshot it takes first, so `restore` puts the machine back:
#   - a power scheme with the fixed GUID $KitScheme, a copy of the scheme
#     that was active, carrying the CPU clamp; the original is re-activated
#     and the copy deleted on restore (the user's schemes are never edited);
#   - scheduled tasks under \SalonKit\ (one per job, removed on restore);
#   - files under $KitDir only.
# The core-count clamp is a process affinity of the job's own process tree
# (inherited by node and the browser it starts): nothing to undo.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File salon-pc.ps1 -Action check
#   ... -Action snapshot -Job ID | clamp -Job ID -MaxMhz 4400 [-StatePct 100] [-BoostMode N]
#   ... -Action unclamp -Job ID | restore -Job ID | start -Job ID | status -Job ID
#   ... -Action inner -Job ID   (the scheduled task itself, in the user's session)
#   ... -Action sampler -Job ID (started by inner: other processes' CPU every 5 s)
#   ... -Action stat -Path FILE (does the disc exist on the PC; never read)
# Every action prints one line "SALONKIT-JSON {...}" (its result) last.
# -ExecutionPolicy Bypass on the command line holds for this process only.

param(
  [Parameter(Mandatory = $true)][ValidateSet("check", "snapshot", "clamp", "unclamp", "restore", "start", "status", "inner", "sampler", "affinity", "stat")][string]$Action,
  [string]$Job = "",
  [int]$MaxMhz = 0,
  [int]$StatePct = 0,
  [int]$BoostMode = -1,
  [int]$Cores = 6,
  [string]$Path = "",
  [string]$KitDir = "C:\salon-kit"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2

# The kit's power scheme: fixed, so a restore finds it even without a state file.
$KitScheme = "5a10c0de-0b1d-4c1a-9e2f-12400c1a0001"
$KitSchemeName = "Salon kit (CPU clamp, temporary)"
$Balanced = "381b4222-f694-41f0-9685-ff5bb260df2e"
$SubProcessor = "54533251-82be-4824-96c1-47b60b740d00"
$Settings = [ordered]@{
  PROCFREQMAX     = "75b0ae3f-bce0-45a7-8c89-c9611c25e100"   # maximum processor frequency, MHz (0 = no cap); efficiency class 0
  PROCFREQMAX1    = "75b0ae3f-bce0-45a7-8c89-c9611c25e101"   # the same, efficiency class 1 (P-cores of a hybrid CPU)
  PROCTHROTTLEMAX = "bc5038f7-23e0-4960-96da-33abaf5935ec"   # maximum processor state, %
  PROCTHROTTLEMAX1 = "bc5038f7-23e0-4960-96da-33abaf5935ed"
  PERFBOOSTMODE   = "be337238-0d82-4146-a960-4f3749d470c7"   # processor performance boost mode (0 = disabled)
}
$TaskPath = "\SalonKit\"

function Out-Result($obj) {
  Write-Output ("SALONKIT-JSON " + ($obj | ConvertTo-Json -Depth 8 -Compress))
}
function Need-Job {
  if ($Job -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') { throw "-Job: 1-64 letters, digits, . _ - (got '$Job')" }
}
function Job-Dir { Join-Path (Join-Path $KitDir "jobs") $Job }
function State-File { Join-Path (Join-Path $KitDir "state") "$Job.json" }

# powercfg prints localized labels; the GUIDs and the 0x values are not.
function Active-Scheme {
  $out = (powercfg /getactivescheme) -join " "
  if ($out -match '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})') { return $Matches[1].ToLower() }
  throw "powercfg /getactivescheme: no GUID in '$out'"
}
function All-Schemes {
  $guids = @()
  foreach ($l in (powercfg /list)) {
    if ($l -match '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})') { $guids += $Matches[1].ToLower() }
  }
  return $guids
}
# AC and DC index of a processor setting in a scheme: the last two 0x values
# of `powercfg /qh` (/query hides the hidden settings, PROCFREQMAX among
# them: CI windows-2025, 2026-11-08), after the possible-values lines;
# $null when the setting does not exist on this machine.
function Setting-Values($scheme, $setting) {
  $out = & powercfg /qh $scheme $SubProcessor $setting 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $out) { $out = & powercfg /query $scheme $SubProcessor $setting 2>$null }
  if ($LASTEXITCODE -ne 0 -or -not $out) { return $null }
  $hex = @([regex]::Matches(($out -join "`n"), '0x[0-9a-fA-F]{8}') | ForEach-Object { [Convert]::ToInt64($_.Value, 16) })
  if ($hex.Count -lt 2) { return $null }
  return [ordered]@{ ac = $hex[$hex.Count - 2]; dc = $hex[$hex.Count - 1] }
}
function Processor-Settings($scheme) {
  $r = [ordered]@{}
  foreach ($k in $Settings.Keys) { $r[$k] = Setting-Values $scheme $Settings[$k] }
  return $r
}

# Per physical core: its efficiency class (higher = faster cores) and its
# logical processors' mask (group 0). From GetLogicalProcessorInformationEx.
$CoreInfoSource = @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class SalonKitCores {
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetLogicalProcessorInformationEx(int rel, IntPtr buf, ref uint len);
  public static List<long[]> Cores() {
    uint len = 0;
    GetLogicalProcessorInformationEx(0, IntPtr.Zero, ref len);
    IntPtr buf = Marshal.AllocHGlobal((int)len);
    var list = new List<long[]>();
    try {
      if (!GetLogicalProcessorInformationEx(0, buf, ref len)) throw new System.ComponentModel.Win32Exception();
      long off = 0;
      while (off < len) {
        IntPtr p = new IntPtr(buf.ToInt64() + off);
        int size = Marshal.ReadInt32(p, 4);
        byte flags = Marshal.ReadByte(p, 8);
        byte eff = Marshal.ReadByte(p, 9);
        short groups = Marshal.ReadInt16(p, 30);
        long mask = Marshal.ReadInt64(p, 32);
        short group = Marshal.ReadInt16(p, 40);
        list.Add(new long[] { eff, mask, group, flags, groups });
        off += size;
      }
    } finally { Marshal.FreeHGlobal(buf); }
    return list;
  }
}
"@
function Core-Map {
  if (-not ("SalonKitCores" -as [type])) { Add-Type -TypeDefinition $CoreInfoSource }
  $i = 0
  return @([SalonKitCores]::Cores() | ForEach-Object {
    $m = [uint64]$_[1]
    $threads = 0; for ($b = 0; $b -lt 64; $b++) { if ($m -band ([uint64]1 -shl $b)) { $threads++ } }
    [ordered]@{ core = $i++; efficiencyClass = [int]$_[0]; mask = ("0x{0:x}" -f $m); threads = $threads; group = [int]$_[2] }
  })
}
# The affinity of the i5-12400 class: $Cores physical cores of the fastest
# class, in enumeration order, with their SMT siblings.
function Class-Affinity([int]$n) {
  $cores = Core-Map
  if (@($cores | Where-Object { $_.group -ne 0 }).Count) { throw "more than one processor group: the kit handles group 0 only" }
  # plain loops: Measure-Object -Property does not read dictionaries in 5.1
  $top = -1; $classes = @{}
  foreach ($c in $cores) { $classes[$c.efficiencyClass] = 1; if ($c.efficiencyClass -gt $top) { $top = $c.efficiencyClass } }
  $pick = @($cores | Where-Object { $_.efficiencyClass -eq $top } | Select-Object -First $n)
  if ($pick.Count -lt $n) { throw "only $($pick.Count) cores of the fastest class (asked $n)" }
  [uint64]$mask = 0; $threads = 0
  foreach ($c in $pick) { $mask = $mask -bor [Convert]::ToUInt64($c.mask.Substring(2), 16); $threads += $c.threads }
  return [ordered]@{ mask = ("0x{0:x}" -f $mask); cores = $n; threads = $threads; efficiencyClass = $top; hybrid = ($classes.Count -gt 1) }
}

function File-Version($paths) {
  foreach ($p in $paths) { if ($p -and (Test-Path -LiteralPath $p)) { return [ordered]@{ path = $p; version = (Get-Item -LiteralPath $p).VersionInfo.ProductVersion } } }
  return $null
}
function Reg-Value($path, $name) {
  try { return (Get-ItemProperty -LiteralPath $path -Name $name -ErrorAction Stop).$name } catch { return $null }
}
function Reg-Policies($path) {
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  $p = Get-ItemProperty -LiteralPath $path
  $r = [ordered]@{}
  foreach ($prop in $p.PSObject.Properties) { if ($prop.Name -notmatch '^PS') { $r[$prop.Name] = $prop.Value } }
  return $r
}

# Busy CPU of the machine and the processes using it, over $sec seconds
# (CPU time deltas: locale-independent, unlike the perf counters' names).
function Cpu-Busy([int]$sec = 3, [string[]]$exclude = @()) {
  $a = @{}; foreach ($p in Get-Process) { try { $a[$p.Id] = $p.TotalProcessorTime.TotalMilliseconds } catch {} }
  $t0 = Get-Date
  Start-Sleep -Seconds $sec
  $wall = ((Get-Date) - $t0).TotalMilliseconds
  $rows = @()
  foreach ($p in Get-Process) {
    try {
      if (-not $a.ContainsKey($p.Id) -or $p.Id -eq 0) { continue }
      $d = $p.TotalProcessorTime.TotalMilliseconds - $a[$p.Id]
      if ($d -gt 0) { $rows += [pscustomobject]@{ name = $p.ProcessName; pid = $p.Id; pct = [math]::Round(100 * $d / $wall, 1) } }
    } catch {}
  }
  $others = @($rows | Where-Object { $exclude -notcontains $_.name })
  $sum = ($others | Measure-Object -Property pct -Sum).Sum
  if (-not $sum) { $sum = 0 }
  return [ordered]@{ seconds = $sec; otherPctOfOneCore = [math]::Round($sum, 1); top = @($others | Sort-Object pct -Descending | Select-Object -First 5) }
}

function Check {
  $os = Get-CimInstance Win32_OperatingSystem
  $cs = Get-CimInstance Win32_ComputerSystem
  $cpu = @(Get-CimInstance Win32_Processor)[0]
  $active = Active-Scheme
  $battery = @(Get-CimInstance Win32_Battery | Select-Object BatteryStatus, EstimatedChargeRemaining)
  $kitDrive = (Split-Path -Qualifier $KitDir).TrimEnd(":")
  $chrome = File-Version @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe")
  $edge = File-Version @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe")
  $sessions = @()
  try { $sessions = @((quser 2>$null) | Select-Object -Skip 1 | ForEach-Object { ($_ -replace '^\s*>?', '') -replace '\s{2,}', '|' }) } catch {}
  $locked = [bool](Get-Process -Name LogonUI -ErrorAction SilentlyContinue)
  $screens = @()
  try { Add-Type -AssemblyName System.Windows.Forms; $screens = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object { [ordered]@{ primary = $_.Primary; width = $_.Bounds.Width; height = $_.Bounds.Height } }) } catch {}
  $hvci = Reg-Value "HKLM:\SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\HypervisorEnforcedCodeIntegrity" "Enabled"
  $defender = $null
  try { $mp = Get-MpComputerStatus; $defender = [ordered]@{ realTime = $mp.RealTimeProtectionEnabled } } catch {}
  $node = File-Version @((Join-Path $KitDir "node\node.exe"))
  $affinity = $null
  try { $affinity = Class-Affinity $Cores } catch { $affinity = [ordered]@{ error = "$_" } }
  Out-Result ([ordered]@{
    action = "check"; at = (Get-Date).ToString("o"); host = $env:COMPUTERNAME; user = "$env:USERDOMAIN\$env:USERNAME"
    os = [ordered]@{ caption = $os.Caption; version = $os.Version; build = $os.BuildNumber; locale = (Get-Culture).Name; lastBoot = $os.LastBootUpTime.ToString("o") }
    cpu = [ordered]@{ name = $cpu.Name.Trim(); cores = $cpu.NumberOfCores; logical = $cpu.NumberOfLogicalProcessors; maxClockMhz = $cpu.MaxClockSpeed; manufacturer = $cpu.Manufacturer }
    coreMap = @(Core-Map); classAffinity = $affinity
    memory = [ordered]@{ totalGiB = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1); freeGiB = [math]::Round($os.FreePhysicalMemory * 1KB / 1GB, 1); commitLimitGiB = [math]::Round($os.TotalVirtualMemorySize * 1KB / 1GB, 1) }
    gpus = @(Get-CimInstance Win32_VideoController | ForEach-Object { [ordered]@{ name = $_.Name; driver = $_.DriverVersion; driverDate = $(if ($_.DriverDate) { $_.DriverDate.ToString("yyyy-MM-dd") } else { $null }); refreshHz = $_.CurrentRefreshRate; mode = "$($_.CurrentHorizontalResolution)x$($_.CurrentVerticalResolution)"; pnp = $_.PNPDeviceID } })
    screens = $screens
    gpuPreference = Reg-Policies "HKCU:\Software\Microsoft\DirectX\UserGpuPreferences"
    hags = Reg-Value "HKLM:\SYSTEM\CurrentControlSet\Control\GraphicsDrivers" "HwSchMode"
    gameMode = Reg-Value "HKCU:\Software\Microsoft\GameBar" "AutoGameModeEnabled"
    browsers = [ordered]@{ chrome = $chrome; edge = $edge }
    policies = [ordered]@{
      chromeMachine = Reg-Policies "HKLM:\SOFTWARE\Policies\Google\Chrome"; chromeUser = Reg-Policies "HKCU:\SOFTWARE\Policies\Google\Chrome"
      edgeMachine = Reg-Policies "HKLM:\SOFTWARE\Policies\Microsoft\Edge"; edgeUser = Reg-Policies "HKCU:\SOFTWARE\Policies\Microsoft\Edge"
    }
    power = [ordered]@{
      battery = $battery; activeScheme = $active; schemes = @(All-Schemes); kitSchemeActive = ($active -eq $KitScheme)
      overlayAc = Reg-Value "HKLM:\SYSTEM\CurrentControlSet\Control\Power\User\PowerSchemes" "ActiveOverlayAcPowerScheme"
      processor = Processor-Settings $active
    }
    session = [ordered]@{ sessions = $sessions; lockScreenUp = $locked; sshSession = [bool]$env:SSH_CLIENT }
    security = [ordered]@{ memoryIntegrity = $hvci; defender = $defender }
    disk = [ordered]@{ drive = $kitDrive; freeGiB = [math]::Round((Get-PSDrive -Name $kitDrive).Free / 1GB, 1) }
    kit = [ordered]@{ dir = $KitDir; node = $node; tasks = @(Get-ScheduledTask -TaskPath $TaskPath -ErrorAction SilentlyContinue | ForEach-Object { $_.TaskName }) }
    cpuBusy = Cpu-Busy 3
  })
}

function Snapshot {
  Need-Job
  $sf = State-File
  New-Item -ItemType Directory -Force -Path (Split-Path $sf) | Out-Null
  if (Test-Path -LiteralPath $sf) {
    # Never overwrite: the first snapshot of a job is the machine before it.
    Out-Result ([ordered]@{ action = "snapshot"; job = $Job; existing = $true; state = (Get-Content -Raw -LiteralPath $sf | ConvertFrom-Json) })
    return
  }
  $active = Active-Scheme
  if ($active -eq $KitScheme) { throw "the kit's scheme is active already: run -Action restore for the job that set it first" }
  $state = [ordered]@{
    job = $Job; at = (Get-Date).ToString("o"); activeScheme = $active; schemes = @(All-Schemes)
    processor = Processor-Settings $active
    tasks = @(Get-ScheduledTask -TaskPath $TaskPath -ErrorAction SilentlyContinue | ForEach-Object { $_.TaskName })
  }
  ($state | ConvertTo-Json -Depth 8) | Set-Content -LiteralPath $sf -Encoding UTF8
  Out-Result ([ordered]@{ action = "snapshot"; job = $Job; existing = $false; state = $state })
}

function Read-State {
  $sf = State-File
  if (-not (Test-Path -LiteralPath $sf)) { throw "no snapshot for job $Job ($sf): run -Action snapshot first" }
  return Get-Content -Raw -LiteralPath $sf | ConvertFrom-Json
}

function Set-Index($scheme, $name, [int64]$value) {
  & powercfg /setacvalueindex $scheme $SubProcessor $Settings[$name] $value 2>$null | Out-Null
  $ac = $LASTEXITCODE
  & powercfg /setdcvalueindex $scheme $SubProcessor $Settings[$name] $value 2>$null | Out-Null
  return ($ac -eq 0 -and $LASTEXITCODE -eq 0)
}

function Clamp {
  Need-Job
  $state = Read-State
  if ($MaxMhz -lt 0 -or ($MaxMhz -gt 0 -and $MaxMhz -lt 800)) { throw "-MaxMhz: 0 (no cap) or at least 800" }
  if ($StatePct -ne 0 -and ($StatePct -lt 30 -or $StatePct -gt 100)) { throw "-StatePct: 30-100" }
  if (-not (All-Schemes | Where-Object { $_ -eq $KitScheme })) {
    & powercfg /duplicatescheme $state.activeScheme $KitScheme | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "powercfg /duplicatescheme failed ($LASTEXITCODE)" }
    & powercfg /changename $KitScheme $KitSchemeName | Out-Null
  }
  $applied = [ordered]@{}
  $applied.PROCFREQMAX = Set-Index $KitScheme "PROCFREQMAX" $MaxMhz
  $applied.PROCFREQMAX1 = Set-Index $KitScheme "PROCFREQMAX1" $MaxMhz
  if ($StatePct -gt 0) {
    $applied.PROCTHROTTLEMAX = Set-Index $KitScheme "PROCTHROTTLEMAX" $StatePct
    $applied.PROCTHROTTLEMAX1 = Set-Index $KitScheme "PROCTHROTTLEMAX1" $StatePct
  }
  if ($BoostMode -ge 0) { $applied.PERFBOOSTMODE = Set-Index $KitScheme "PERFBOOSTMODE" $BoostMode }
  & powercfg /setactive $KitScheme | Out-Null
  $now = Active-Scheme
  if ($now -ne $KitScheme) { throw "the kit's scheme did not become active (active: $now)" }
  Out-Result ([ordered]@{ action = "clamp"; job = $Job; scheme = $KitScheme; maxMhz = $MaxMhz; statePct = $StatePct; boostMode = $BoostMode; applied = $applied; processor = Processor-Settings $KitScheme })
}

# Back to the snapshot's scheme, the kit's scheme deleted. Idempotent.
function Restore-Power($state) {
  $target = $Balanced
  if ($state) { $target = $state.activeScheme }
  if (-not (All-Schemes | Where-Object { $_ -eq $target })) { throw "the snapshot's scheme $target no longer exists" }
  if ((Active-Scheme) -ne $target) { & powercfg /setactive $target | Out-Null }
  if (All-Schemes | Where-Object { $_ -eq $KitScheme }) { & powercfg /delete $KitScheme | Out-Null }
  return Active-Scheme
}

function Unclamp {
  Need-Job
  $active = Restore-Power (Read-State)
  Out-Result ([ordered]@{ action = "unclamp"; job = $Job; activeScheme = $active })
}

function Restore {
  Need-Job
  $state = $null; $warn = @()
  try { $state = Read-State } catch { $warn += "no snapshot: the Balanced scheme is activated if the kit's was active" }
  $jd = Job-Dir
  # the job's processes only: a pid it wrote down AND that process's start
  # time (Windows reuses pids at once: a pid alone once named the CI step's
  # own shell); one process each, never its tree
  $killed = @()
  foreach ($f in @("node.pid", "sampler.pid")) {
    $p = Read-PidFile (Join-Path $jd $f)
    if ($p) { try { $p.Kill(); $killed += $p.Id } catch {} }
  }
  $task = Get-ScheduledTask -TaskPath $TaskPath -TaskName $Job -ErrorAction SilentlyContinue
  if ($task) { Unregister-ScheduledTask -TaskPath $TaskPath -TaskName $Job -Confirm:$false }
  if ($state -or (Active-Scheme) -eq $KitScheme -or (All-Schemes | Where-Object { $_ -eq $KitScheme })) { $active = Restore-Power $state } else { $active = Active-Scheme }
  $after = [ordered]@{ activeScheme = $active; schemes = @(All-Schemes); processor = Processor-Settings $active; tasks = @(Get-ScheduledTask -TaskPath $TaskPath -ErrorAction SilentlyContinue | ForEach-Object { $_.TaskName }) }
  # a job's profiles are throwaway (the browser's own profile dirs live under the job dir)
  Out-Result ([ordered]@{ action = "restore"; job = $Job; before = $state; after = $after; killed = $killed; warnings = $warn })
}

# "pid start-time-ticks": a process is the job's only if both match.
function Write-PidFile($file, $proc) {
  "$($proc.Id) $($proc.StartTime.ToUniversalTime().Ticks)" | Set-Content -LiteralPath $file
}
function Read-PidFile($file) {
  if (-not (Test-Path -LiteralPath $file)) { return $null }
  $f = "$(Get-Content -Raw -LiteralPath $file)".Trim() -split '\s+'
  if ($f.Count -ne 2) { return $null }
  $p = Get-Process -Id ([int]$f[0]) -ErrorAction SilentlyContinue
  if (-not $p) { return $null }
  try { if ($p.StartTime.ToUniversalTime().Ticks -ne [int64]$f[1]) { return $null } } catch { return $null }
  return $p
}

function Start-Job-Task {
  Need-Job
  $jd = Job-Dir
  if (-not (Test-Path -LiteralPath (Join-Path $jd "spec.json"))) { throw "no $jd\spec.json (pc-run.mjs writes it)" }
  foreach ($f in @("exit", "log", "node.pid")) { $p = Join-Path $jd $f; if (Test-Path -LiteralPath $p) { throw "job $Job ran already ($p): use a new job id" } }
  $self = $PSCommandPath
  $arg = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$self`" -Action inner -Job $Job -KitDir `"$KitDir`""
  $act = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arg -WorkingDirectory $jd
  # Interactive: runs in the logged-on user's desktop session (a browser
  # started from the ssh session would have no screen: session 0 has none).
  $prin = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
  $set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 6) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskPath $TaskPath -TaskName $Job -Action $act -Principal $prin -Settings $set -Force | Out-Null
  Start-ScheduledTask -TaskPath $TaskPath -TaskName $Job
  Start-Sleep -Seconds 3
  $info = Get-ScheduledTaskInfo -TaskPath $TaskPath -TaskName $Job
  Out-Result ([ordered]@{ action = "start"; job = $Job; lastResult = $info.LastTaskResult; state = "$((Get-ScheduledTask -TaskPath $TaskPath -TaskName $Job).State)" })
}

function Status {
  Need-Job
  $jd = Job-Dir
  $exit = $null; $tail = @(); $done = $false
  $done = Test-Path -LiteralPath (Join-Path $jd "exit")
  if ($done) {
    $raw = "$(Get-Content -Raw -LiteralPath (Join-Path $jd "exit"))".Trim()
    $n = 0
    if ([int]::TryParse($raw, [ref]$n)) { $exit = $n } else { $exit = -1 }
  }
  if (Test-Path -LiteralPath (Join-Path $jd "log")) { $tail = @(Get-Content -LiteralPath (Join-Path $jd "log") -Tail 15) }
  $task = Get-ScheduledTask -TaskPath $TaskPath -TaskName $Job -ErrorAction SilentlyContinue
  $state = "missing"; if ($done) { $state = "done" } elseif ($task) { $state = "$($task.State)".ToLower() }
  Out-Result ([ordered]@{ action = "status"; job = $Job; state = $state; exit = $exit; logTail = $tail })
}

# The scheduled task: the job's spec (written by pc-run.mjs) run in the
# user's session under the class affinity, the display kept awake, a CPU
# sampler beside it; exit code in jobs\ID\exit.
$ExecStateSource = @"
using System;
using System.Runtime.InteropServices;
public static class SalonKitAwake {
  [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);
}
"@
function Inner {
  Need-Job
  $jd = Job-Dir
  $log = Join-Path $jd "log"
  $code = 1
  $spec = $null
  try {
    $spec = Get-Content -Raw -LiteralPath (Join-Path $jd "spec.json") | ConvertFrom-Json
    Add-Type -TypeDefinition $ExecStateSource
    # ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED, for this thread's life only
    [void][SalonKitAwake]::SetThreadExecutionState([uint32]2147483651)
    $me = [System.Diagnostics.Process]::GetCurrentProcess()
    if ($spec.affinity) { $me.ProcessorAffinity = [IntPtr][Convert]::ToInt64($spec.affinity.Substring(2), 16) }
    "[$((Get-Date).ToString('o'))] job $Job, affinity $("0x{0:x}" -f $me.ProcessorAffinity.ToInt64()), session $($me.SessionId)" | Out-File -LiteralPath $log -Encoding UTF8
    $sampler = Start-Process -FilePath "powershell.exe" -ArgumentList "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`" -Action sampler -Job $Job -KitDir `"$KitDir`"" -WindowStyle Hidden -PassThru
    Write-PidFile (Join-Path $jd "sampler.pid") $sampler
    $code = 0
    foreach ($step in $spec.steps) {
      foreach ($p in $spec.env.PSObject.Properties) { [Environment]::SetEnvironmentVariable($p.Name, [string]$p.Value, "Process") }
      if ($step.env) { foreach ($p in $step.env.PSObject.Properties) { [Environment]::SetEnvironmentVariable($p.Name, [string]$p.Value, "Process") } }
      "[$((Get-Date).ToString('o'))] step $($step.name): node $($step.args -join ' ')" | Out-File -LiteralPath $log -Append -Encoding UTF8
      $out = Join-Path $jd "$($step.name).out"; $err = Join-Path $jd "$($step.name).err"
      $argLine = ($step.args | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join " "
      $node = Start-Process -FilePath (Join-Path $KitDir "node\node.exe") -ArgumentList $argLine -WorkingDirectory $spec.cwd -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden -PassThru
      # the handle cached now, or ExitCode stays empty once the process is
      # gone (Start-Process -PassThru; seen on CI windows-2025)
      $null = $node.Handle
      Write-PidFile (Join-Path $jd "node.pid") $node
      $node.WaitForExit()
      $rc = $node.ExitCode
      if ($null -eq $rc -or "$rc" -eq "") { $rc = 98 }
      "[$((Get-Date).ToString('o'))] step $($step.name): exit $rc" | Out-File -LiteralPath $log -Append -Encoding UTF8
      Get-Content -LiteralPath $err -Tail 20 -ErrorAction SilentlyContinue | Out-File -LiteralPath $log -Append -Encoding UTF8
      if ($rc -ne 0) { $code = $rc; if (-not $step.continueOnError) { break } }
    }
  } catch {
    "[$((Get-Date).ToString('o'))] inner failed: $_" | Out-File -LiteralPath $log -Append -Encoding UTF8
    $code = 99
  } finally {
    if ($spec -and $spec.restoreAtEnd) {
      try { $a = Restore-Power (Read-State); "[$((Get-Date).ToString('o'))] power restored: $a" | Out-File -LiteralPath $log -Append -Encoding UTF8 } catch { "power restore failed: $_" | Out-File -LiteralPath $log -Append -Encoding UTF8 }
    }
    "$code" | Set-Content -LiteralPath (Join-Path $jd "exit")
  }
}

# Every 5 s until the job's exit file: the other processes' CPU (browser,
# node and the kit excluded), the busiest core's effective clock, the
# browser's affinity, the active scheme, the lock screen.
function Sampler {
  Need-Job
  $jd = Job-Dir
  $csv = Join-Path $jd "sampler.jsonl"
  $mine = @("node", "chrome", "msedge", "powershell", "conhost", "Idle")
  while (-not (Test-Path -LiteralPath (Join-Path $jd "exit"))) {
    $b = Cpu-Busy 5 $mine
    $aff = @(Get-Process -Name chrome, msedge -ErrorAction SilentlyContinue | Select-Object -First 1 | ForEach-Object { try { "0x{0:x}" -f $_.ProcessorAffinity.ToInt64() } catch { $null } })
    $eff = $null
    try {
      # the busiest core's effective clock: frequency x % performance (a
      # cap the firmware ignores shows here; Microsoft's own check)
      $eff = (Get-CimInstance Win32_PerfFormattedData_Counters_ProcessorInformation | Where-Object { $_.Name -notmatch '_Total' } |
        ForEach-Object { [double]$_.ProcessorFrequency * [double]$_.PercentProcessorPerformance / 100 } | Measure-Object -Maximum).Maximum
    } catch {}
    $row = [ordered]@{ t = (Get-Date).ToString("o"); otherPct = $b.otherPctOfOneCore; top = $b.top; maxEffMhz = $(if ($eff) { [math]::Round($eff) } else { $null }); browserAffinity = $(if ($aff.Count) { $aff[0] } else { $null }); scheme = Active-Scheme; locked = [bool](Get-Process -Name LogonUI -ErrorAction SilentlyContinue) }
    ($row | ConvertTo-Json -Depth 4 -Compress) | Out-File -LiteralPath $csv -Append -Encoding UTF8
  }
}

switch ($Action) {
  "check" { Check }
  "snapshot" { Snapshot }
  "clamp" { Clamp }
  "unclamp" { Unclamp }
  "restore" { Restore }
  "start" { Start-Job-Task }
  "status" { Status }
  "inner" { Inner }
  "sampler" { Sampler }
  "stat" { $i = Get-Item -LiteralPath $Path -ErrorAction SilentlyContinue; Out-Result ([ordered]@{ action = "stat"; path = $Path; exists = [bool]$i; bytes = $(if ($i) { $i.Length } else { $null }) }) }
  "affinity" { Out-Result ([ordered]@{ action = "affinity"; coreMap = @(Core-Map); classAffinity = (Class-Affinity $Cores) }) }
}
