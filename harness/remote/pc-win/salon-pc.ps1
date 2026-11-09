# Copyright 2026 wasm-dolphin contributors
# SPDX-License-Identifier: MIT
#
# The Windows side of the PC kit (harness/remote/pc-run.mjs drives it over
# ssh; research/pc-windows-kit.md). Windows PowerShell 5.1, no module, no
# install. It runs ONLY as the kit's standard (non-administrator) account,
# never elevated: check refuses to go on in an elevated session.
# Everything it creates belongs to that account:
#   - files under $KitDir (default %USERPROFILE%\salon-kit): node,
#     Playwright, the trees, the films, the jobs (each job's TEMP/TMP, i.e.
#     its browser profiles, in jobs\<job>\tmp, deleted at the job's end and
#     by cleanup);
#   - scheduled tasks under \SalonKit\: one per job, in the account's own
#     desktop session (a browser started from ssh would have no screen).
# The CPU clamp's power scheme is NOT this script's: the only elevated
# operations of the kit are a closed list of powercfg.exe / schtasks.exe
# command lines sent by pc-run.mjs over the administrator's ssh
# (lib/pc-kit.mjs ADMIN). This script only reads the power state.
# cleanup stops a job: stop file (inner runs no further step), the task
# stopped, the job's processes killed (written down by pid AND start time,
# or holding the job's folder on their command line; only node, chrome,
# msedge, powershell, only the account's own), its TEMP deleted without
# following any reparse point.
# The core-count clamp is a process affinity of the job's own process tree
# (inherited by node and the browser it starts): nothing to undo.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File salon-pc.ps1 -Action check
#   ... -Action snapshot -Job ID | power | start -Job ID | status -Job ID | cleanup -Job ID
#   ... -Action inner -Job ID   (the scheduled task itself, in the account's session)
#   ... -Action sampler -Job ID (started by inner: other processes' CPU every 5 s)
#   ... -Action stat -Path FILE (does the disc exist; never read) | affinity | uninstall
#   ... -Action sshd (OpenSSH's shell for the admin's commands, read before any)
# Every action prints one line "SALONKIT-JSON {...}" (its result) last.
# -ExecutionPolicy Bypass on the command line holds for this process only.

param(
  [Parameter(Mandatory = $true)][ValidateSet("check", "snapshot", "power", "start", "status", "inner", "sampler", "affinity", "stat", "uninstall", "cleanup", "sshd")][string]$Action,
  [string]$Job = "",
  [int]$Cores = 6,
  [string]$Path = "",
  [string]$KitDir = (Join-Path $env:USERPROFILE "salon-kit")
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
# A job's task is stopped by Windows past this; pc-run refuses a job whose
# steps could last longer (parcours --max-sec per run, benches).
$TaskHours = 8

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

# Busy CPU of the machine and the processes using it, over $sec seconds.
# The raw per-process counters (Win32_PerfRawData_PerfProc_Process: 100 ns
# of CPU per process, every account's, readable by a standard account and
# locale-independent); Get-Process CPU times as a fallback, which a standard
# account only gets for its own processes (then marked partial).
function Cpu-Busy([int]$sec = 3, [string[]]$exclude = @(), [int[]]$excludePids = @()) {
  $partial = $false
  $read = {
    $m = @{}; $ts = $null
    foreach ($q in @(Get-CimInstance Win32_PerfRawData_PerfProc_Process -ErrorAction Stop)) {
      if ($q.Name -eq '_Total' -or $q.Name -eq 'Idle') { continue }
      $m[[int]$q.IDProcess] = @([double]$q.PercentProcessorTime, ($q.Name -replace '#\d+$', ''))
      $ts = [double]$q.Timestamp_Sys100NS
    }
    @{ m = $m; ts = $ts }
  }
  $rows = @()
  try {
    $a = & $read
    Start-Sleep -Seconds $sec
    $b = & $read
    $wall = $b.ts - $a.ts
    if (-not ($wall -gt 0)) { throw "no timestamp" }
    foreach ($id in $b.m.Keys) {
      if (-not $a.m.ContainsKey($id) -or $id -eq 0) { continue }
      $d = $b.m[$id][0] - $a.m[$id][0]
      if ($d -gt 0) { $rows += [pscustomobject]@{ name = $b.m[$id][1]; pid = $id; pct = [math]::Round(100 * $d / $wall, 1) } }
    }
  } catch {
    $partial = $true
    $rows = @()
    $a = @{}; foreach ($p in Get-Process) { try { $a[$p.Id] = $p.TotalProcessorTime.TotalMilliseconds } catch {} }
    $t0 = Get-Date
    Start-Sleep -Seconds $sec
    $wallMs = ((Get-Date) - $t0).TotalMilliseconds
    foreach ($p in Get-Process) {
      try {
        if (-not $a.ContainsKey($p.Id) -or $p.Id -eq 0) { continue }
        $d = $p.TotalProcessorTime.TotalMilliseconds - $a[$p.Id]
        if ($d -gt 0) { $rows += [pscustomobject]@{ name = $p.ProcessName; pid = $p.Id; pct = [math]::Round(100 * $d / $wallMs, 1) } }
      } catch {}
    }
  }
  $others = @($rows | Where-Object { $exclude -notcontains $_.name -and $excludePids -notcontains $_.pid })
  # a plain sum: Measure-Object on an empty list has no .Sum under StrictMode
  $sum = 0.0; foreach ($o in $others) { $sum += $o.pct }
  return [ordered]@{ seconds = $sec; otherPctOfOneCore = [math]::Round($sum, 1); partial = $partial; top = @($others | Sort-Object pct -Descending | Select-Object -First 5) }
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
  # OpenSSH's shell for the administrator's commands: cmd.exe must get /d
  # (AutoRun off: HKCU\...\Command Processor\AutoRun would otherwise run
  # elevated before the kit's fixed command)
  $sshd = [ordered]@{ defaultShell = Reg-Value "HKLM:\SOFTWARE\OpenSSH" "DefaultShell"; defaultShellCommandOption = Reg-Value "HKLM:\SOFTWARE\OpenSSH" "DefaultShellCommandOption" }
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
    session = [ordered]@{ sessions = $sessions; lockScreenUp = $locked; sshSession = [bool]$env:SSH_CLIENT; elevated = (Is-Elevated); user = $env:USERNAME }
    security = [ordered]@{ memoryIntegrity = $hvci; defender = $defender }
    disk = [ordered]@{ drive = $kitDrive; freeGiB = [math]::Round((Get-PSDrive -Name $kitDrive).Free / 1GB, 1) }
    kit = [ordered]@{ dir = $KitDir; node = $node; tasks = @(Kit-Tasks) }
    sshd = $sshd
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
  if ($active -eq $KitScheme) { throw "the kit's scheme is active already: pc-run.mjs restore --job <the job that set it> first" }
  $state = [ordered]@{
    job = $Job; at = (Get-Date).ToString("o"); activeScheme = $active; schemes = @(All-Schemes)
    processor = Processor-Settings $active
    tasks = @(Kit-Tasks)
    kitProcesses = @(Kit-Processes)
  }
  ($state | ConvertTo-Json -Depth 8) | Set-Content -LiteralPath $sf -Encoding UTF8
  Out-Result ([ordered]@{ action = "snapshot"; job = $Job; existing = $false; state = $state })
}

function Read-State {
  $sf = State-File
  if (-not (Test-Path -LiteralPath $sf)) { throw "no snapshot for job $Job ($sf): run -Action snapshot first" }
  return Get-Content -Raw -LiteralPath $sf | ConvertFrom-Json
}

# check refuses to go on elevated: this script is the standard account's.
function Is-Elevated {
  # tests only (pwsh on macOS has no WindowsPrincipal): SALONKIT_TEST_ELEVATED=1|0
  if ($env:SALONKIT_TEST_ELEVATED) { return $env:SALONKIT_TEST_ELEVATED -eq "1" }
  ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Stop a job and remove what it left, power untouched: the stop file
# (inner runs no further step), the task stopped and unregistered, the
# processes written down (pid AND start time: Windows reuses pids at once)
# and every kit image whose command line holds the job's folder, the job's
# TEMP removed without following any reparse point.
function Stop-KitJob([string]$jd) {
  $killed = @(); $warn = @()
  if (Test-Path -LiteralPath $jd) { "stop $((Get-Date).ToString('o'))" | Set-Content -LiteralPath (Join-Path $jd "stop") }
  if (Get-ScheduledTask -TaskPath $TaskPath -TaskName $Job -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskPath $TaskPath -TaskName $Job -ErrorAction SilentlyContinue }
  foreach ($f in @("inner.pid", "node.pid", "sampler.pid")) {
    $p = Read-PidFile (Join-Path $jd $f)
    if ($p) { try { $p.Kill(); $killed += $p.Id } catch {} }
  }
  for ($round = 0; $round -lt 5; $round++) {
    $left = @(Job-Processes $jd)
    if (-not $left.Count) { break }
    foreach ($q in $left) { try { Stop-Process -Id $q.ProcessId -Force -ErrorAction Stop; $killed += $q.ProcessId } catch {} }
    Start-Sleep -Milliseconds 500
  }
  $still = @(Job-Processes $jd | ForEach-Object { [ordered]@{ pid = $_.ProcessId; name = $_.Name } })
  if ($still.Count) { $warn += "processes of the job still running: $(($still | ForEach-Object { "$($_.name) $($_.pid)" }) -join ', ')" }
  if (Get-ScheduledTask -TaskPath $TaskPath -TaskName $Job -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskPath $TaskPath -TaskName $Job -Confirm:$false }
  # the job's TEMP (this account's own files; never elevated)
  $tmp = Join-Path $jd "tmp"
  try { Remove-Tree $tmp } catch { $warn += "job tmp not fully removed: $_" }
  return [ordered]@{ killed = @($killed | Select-Object -Unique); still = $still; tmpLeft = (Test-Path -LiteralPath $tmp); warnings = $warn }
}

function Cleanup {
  Need-Job
  $r = Stop-KitJob (Job-Dir)
  Out-Result ([ordered]@{ action = "cleanup"; job = $Job; killed = $r.killed; jobProcesses = $r.still; jobTmp = $r.tmpLeft; warnings = $r.warnings; power = (Power-State); tasks = @(Kit-Tasks); kitProcesses = @(Kit-Processes) })
}

# The power state as this account reads it (the admin commands change it).
function Power-State {
  $active = Active-Scheme
  [ordered]@{ activeScheme = $active; schemes = @(All-Schemes); processor = Processor-Settings $active; kitScheme = $(if (All-Schemes | Where-Object { $_ -eq $KitScheme }) { Processor-Settings $KitScheme } else { $null }) }
}
function Kit-Tasks { @(Get-ScheduledTask -TaskPath $TaskPath -ErrorAction SilentlyContinue | ForEach-Object { [string]$_.TaskName }) }

# A folder deleted without ever following a reparse point (junction,
# symlink): such an entry is removed itself, never what it points to.
# Remove-Item -Recurse in 5.1 can follow a junction.
function Remove-Tree([string]$dir) {
  $item = Get-Item -LiteralPath $dir -Force -ErrorAction SilentlyContinue
  if (-not $item) { return }
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { [IO.Directory]::Delete($item.FullName, $false); return }
  foreach ($c in @(Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue)) {
    if ($c.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      if ($c.PSIsContainer) { [IO.Directory]::Delete($c.FullName, $false) } else { [IO.File]::Delete($c.FullName) }
    } elseif ($c.PSIsContainer) { Remove-Tree $c.FullName }
    else { $c.Attributes = 'Normal'; [IO.File]::Delete($c.FullName) }
  }
  [IO.Directory]::Delete($item.FullName, $false)
}

# The kit's own executables: only these are ever killed by command line.
$KitImages = @("node.exe", "chrome.exe", "msedge.exe", "powershell.exe")
# $path as a whole path element on a command line: followed by \ or a quote
# (C:\salon-kit\jobs\a must not match ...\jobs\ab, nor a log file's name
# typed after it in an editor: only the kit's images count anyway).
function Holds-Path([string]$line, [string]$path) {
  if (-not $line) { return $false }
  $p = [regex]::Escape($path.TrimEnd('\'))
  return [regex]::IsMatch($line, "$p(\\|`"|')", 'IgnoreCase')
}
# The job's processes: node, chrome, msedge, powershell whose command line
# holds the job's folder (its browsers carry --user-data-dir under the
# job's TEMP), and their descendants of those images (a browser helper);
# never this script's own invocations.
function Job-Processes([string]$jd) {
  $me = $PID
  $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $KitImages -contains $_.Name })
  $ids = @{}
  foreach ($q in $all) {
    if ((Holds-Path $q.CommandLine $jd) -and $q.ProcessId -ne $me -and $q.CommandLine -notmatch 'salon-pc\.ps1' -and (Is-UsersKitProcess $q)) { $ids[[int]$q.ProcessId] = $true }
  }
  # a child is born after its parent (else the parent pid was reused)
  $born = @{}; foreach ($q in $all) { $born[[int]$q.ProcessId] = $q.CreationDate }
  do {
    $grew = $false
    foreach ($q in $all) {
      $pp = [int]$q.ParentProcessId
      if (-not $ids.ContainsKey([int]$q.ProcessId) -and $ids.ContainsKey($pp) -and $q.ProcessId -ne $me -and $q.CreationDate -ge $born[$pp] -and (Is-UsersKitProcess $q)) { $ids[[int]$q.ProcessId] = $true; $grew = $true }
    }
  } while ($grew)
  @($all | Where-Object { $ids.ContainsKey([int]$_.ProcessId) })
}
# Any process of the kit (one of its images, its command line under
# $KitDir), but this script's short actions.
function Kit-Processes {
  $me = $PID
  @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $KitImages -contains $_.Name -and (Holds-Path $_.CommandLine $KitDir) -and $_.ProcessId -ne $me -and $_.CommandLine -notmatch 'salon-pc\.ps1 .*-Action (restore|cleanup|status|check|snapshot|uninstall)'
  } | ForEach-Object { [ordered]@{ pid = $_.ProcessId; name = $_.Name } })
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
  # the pid file is the user's to write: it counts only for one of the
  # kit's images owned by the user (never csrss, never another account's)
  $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $($p.Id)" -ErrorAction SilentlyContinue
  if (-not $cim -or -not (Is-UsersKitProcess $cim)) { return $null }
  return $p
}
# One of the kit's images, owned by the account running this script.
function Is-UsersKitProcess($cim) {
  if ($KitImages -notcontains $cim.Name) { return $false }
  try { $o = Invoke-CimMethod -InputObject $cim -MethodName GetOwner -ErrorAction Stop } catch { return $false }
  return ($o.ReturnValue -eq 0 -and $o.User -eq $env:USERNAME -and $o.Domain -eq $env:USERDOMAIN)
}
function Start-Job-Task {
  Need-Job
  $jd = Job-Dir
  if (-not (Test-Path -LiteralPath (Join-Path $jd "spec.json"))) { throw "no $jd\spec.json (pc-run.mjs writes it)" }
  foreach ($f in @("exit", "log", "node.pid", "stop")) { $p = Join-Path $jd $f; if (Test-Path -LiteralPath $p) { throw "job $Job ran already ($p): use a new job id" } }
  $self = $PSCommandPath
  $arg = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$self`" -Action inner -Job $Job -KitDir `"$KitDir`""
  $act = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arg -WorkingDirectory $jd
  # Interactive: runs in the logged-on user's desktop session (a browser
  # started from the ssh session would have no screen: session 0 has none).
  $prin = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
  $set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours $TaskHours) -MultipleInstances IgnoreNew
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
  # plain strings: Get-Content's lines carry PSProvider & co., which
  # ConvertTo-Json -Depth 8 walks for minutes (CI windows-2025)
  if (Test-Path -LiteralPath (Join-Path $jd "log")) { $tail = @(Get-Content -LiteralPath (Join-Path $jd "log") -Tail 15 | ForEach-Object { [string]$_ }) }
  $task = Get-ScheduledTask -TaskPath $TaskPath -TaskName $Job -ErrorAction SilentlyContinue
  $inner = Read-PidFile (Join-Path $jd "inner.pid")
  $state = "missing"
  if ($done) { $state = "done" }
  elseif ($task -and "$($task.State)" -eq "Running") { $state = "running" }
  elseif ($inner) { $state = "running" }
  elseif ($task -and (Test-Path -LiteralPath (Join-Path $jd "inner.pid"))) {
    # the task ran, its inner is gone and wrote no exit: killed (time limit,
    # logoff, crash). Never "ready" forever with the clamp on.
    $state = "dead"
  } elseif ($task) {
    $info = Get-ScheduledTaskInfo -TaskPath $TaskPath -TaskName $Job -ErrorAction SilentlyContinue
    $state = "queued"
    if ($info -and $info.LastRunTime -and $info.LastRunTime.Year -gt 2000) { $state = "dead" }
  }
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
    Write-PidFile (Join-Path $jd "inner.pid") $me
    # everything the job writes stays in its folder: TEMP/TMP (browser
    # profiles, Playwright), npm's cache
    $tmp = Join-Path $jd "tmp"
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    foreach ($v in @("TEMP", "TMP")) { [Environment]::SetEnvironmentVariable($v, $tmp, "Process") }
    [Environment]::SetEnvironmentVariable("npm_config_cache", (Join-Path $KitDir "npm-cache"), "Process")
    if ($spec.affinity) { $me.ProcessorAffinity = [IntPtr][Convert]::ToInt64($spec.affinity.Substring(2), 16) }
    "[$((Get-Date).ToString('o'))] job $Job, affinity $("0x{0:x}" -f $me.ProcessorAffinity.ToInt64()), session $($me.SessionId)" | Out-File -LiteralPath $log -Encoding UTF8
    $sampler = Start-Process -FilePath "powershell.exe" -ArgumentList "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`" -Action sampler -Job $Job -KitDir `"$KitDir`"" -WindowStyle Hidden -PassThru
    Write-PidFile (Join-Path $jd "sampler.pid") $sampler
    $code = 0
    foreach ($step in $spec.steps) {
      if (Test-Path -LiteralPath (Join-Path $jd "stop")) { "[$((Get-Date).ToString('o'))] stop file: no further step" | Out-File -LiteralPath $log -Append -Encoding UTF8; $code = 97; break }
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
    # its own TEMP, deleted by the job itself
    try { Remove-Tree (Join-Path $jd "tmp") } catch { "tmp not removed: $_" | Out-File -LiteralPath $log -Append -Encoding UTF8 }
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
  while (-not (Test-Path -LiteralPath (Join-Path $jd "exit"))) {
    # the job's own processes by command line (its browsers carry the job's
    # profile folder): Baptiste's own Chrome counts as "other", as it should
    $ours = @(Job-Processes $jd | ForEach-Object { [int]$_.ProcessId }) + @($PID)
    foreach ($f in @("inner.pid", "node.pid")) { $q = Read-PidFile (Join-Path $jd $f); if ($q) { $ours += $q.Id } }
    $b = Cpu-Busy 5 @("Idle") $ours
    $aff = @(Get-Process -Id ($ours | Select-Object -Unique) -ErrorAction SilentlyContinue | Where-Object { @("chrome", "msedge") -contains $_.ProcessName } | Select-Object -First 1 | ForEach-Object { try { "0x{0:x}" -f $_.ProcessorAffinity.ToInt64() } catch { $null } })
    $eff = $null
    try {
      # the busiest core's effective clock: frequency x % performance (a
      # cap the firmware ignores shows here; Microsoft's own check)
      $eff = (Get-CimInstance Win32_PerfFormattedData_Counters_ProcessorInformation | Where-Object { $_.Name -notmatch '_Total' } |
        ForEach-Object { [double]$_.ProcessorFrequency * [double]$_.PercentProcessorPerformance / 100 } | Measure-Object -Maximum).Maximum
    } catch {}
    $row = [ordered]@{ t = (Get-Date).ToString("o"); otherPct = $b.otherPctOfOneCore; otherPartial = $b.partial; top = $b.top; maxEffMhz = $(if ($eff) { [math]::Round($eff) } else { $null }); browserAffinity = $(if ($aff.Count) { $aff[0] } else { $null }); scheme = Active-Scheme; locked = [bool](Get-Process -Name LogonUI -ErrorAction SilentlyContinue) }
    ($row | ConvertTo-Json -Depth 4 -Compress) | Out-File -LiteralPath $csv -Append -Encoding UTF8
  }
}

# $KitDir and the \SalonKit\ task folder gone; refused while a job runs or
# the kit's power scheme exists (pc-run restore first).
function Uninstall {
  $tasks = @(Kit-Tasks)
  if ($tasks.Count) { throw "kit tasks still registered ($($tasks -join ', ')): restore their jobs first" }
  if ((Active-Scheme) -eq $KitScheme -or (All-Schemes | Where-Object { $_ -eq $KitScheme })) { throw "the kit's power scheme exists: pc-run.mjs restore first" }
  $procs = @(Kit-Processes)
  if ($procs.Count) { throw "kit processes running: $(($procs | ForEach-Object { "$($_.name) $($_.pid)" }) -join ', ')" }
  if ((Split-Path -Leaf $KitDir) -ne "salon-kit") { throw "refused: -KitDir $KitDir is not a salon-kit folder" }
  try { $svc = New-Object -ComObject Schedule.Service; $svc.Connect(); $svc.GetFolder("\").DeleteFolder("SalonKit", 0) } catch {}
  Remove-Tree $KitDir
  Out-Result ([ordered]@{ action = "uninstall"; kitDir = $KitDir; removed = -not (Test-Path -LiteralPath $KitDir) })
}

switch ($Action) {
  "check" { Check }
  "snapshot" { Snapshot }
  "power" { Out-Result ([ordered]@{ action = "power"; power = (Power-State); tasks = @(Kit-Tasks) }) }
  "start" { Start-Job-Task }
  "status" { Status }
  "inner" { Inner }
  "sampler" { Sampler }
  "uninstall" { Uninstall }
  "cleanup" { Cleanup }
  "stat" { $i = Get-Item -LiteralPath $Path -ErrorAction SilentlyContinue; Out-Result ([ordered]@{ action = "stat"; path = $Path; exists = [bool]$i; bytes = $(if ($i) { $i.Length } else { $null }) }) }
  "sshd" { Out-Result ([ordered]@{ action = "sshd"; sshd = [ordered]@{ defaultShell = Reg-Value "HKLM:\SOFTWARE\OpenSSH" "DefaultShell"; defaultShellCommandOption = Reg-Value "HKLM:\SOFTWARE\OpenSSH" "DefaultShellCommandOption" } }) }
  "affinity" { Out-Result ([ordered]@{ action = "affinity"; coreMap = @(Core-Map); classAffinity = (Class-Affinity $Cores) }) }
}
