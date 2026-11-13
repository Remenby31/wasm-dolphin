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

# What the machine is, read without CIM/WMI: over ssh this account's logon
# is a network one, and WMI (root\cimv2, the ScheduledTasks and Defender
# cmdlets, which are CIM underneath) refuses it "Remote Enable"
# (0x80041003; first real PC, 2026-11-12). Performance counters are refused
# too. Only what any local account may call: kernel32/ntdll, the registry,
# the task scheduler's COM API, [Environment], files.
#   Cores: per physical core its efficiency class (higher = faster cores)
#     and its logical processors' mask (group 0), GetLogicalProcessorInformationEx.
#   Processes: every process's pid, parent, start time, CPU time and image
#     (NtQuerySystemInformation(SystemProcessInformation), Task Manager's own
#     source: every account's processes, no right needed).
#   CommandLine, OwnerSid: of a process this account may open (its own).
#   Memory, PowerStatus, UptimeMs: GlobalMemoryStatusEx, GetSystemPowerStatus, GetTickCount64.
#   EffectiveMhz: the busiest logical processor's frequency x % performance
#     since the previous call (PDH by English counter names; the sampler,
#     in the account's own desktop session).
$NativeSource = @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Principal;
public static class SalonKitNative {
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetLogicalProcessorInformationEx(int rel, IntPtr buf, ref uint len);
  [DllImport("ntdll.dll")]
  static extern int NtQuerySystemInformation(int cls, IntPtr buf, int len, out int ret);
  [DllImport("ntdll.dll")]
  static extern int NtQueryInformationProcess(IntPtr h, int cls, IntPtr buf, int len, out int ret);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr h);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool OpenProcessToken(IntPtr h, uint access, out IntPtr token);
  [StructLayout(LayoutKind.Sequential)]
  class MemoryStatusEx { public uint dwLength = 64; public uint dwMemoryLoad; public ulong ullTotalPhys; public ulong ullAvailPhys; public ulong ullTotalPageFile; public ulong ullAvailPageFile; public ulong ullTotalVirtual; public ulong ullAvailVirtual; public ulong ullAvailExtendedVirtual; }
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GlobalMemoryStatusEx([In, Out] MemoryStatusEx m);
  [StructLayout(LayoutKind.Sequential)]
  struct SystemPowerStatus { public byte ACLineStatus; public byte BatteryFlag; public byte BatteryLifePercent; public byte SystemStatusFlag; public int BatteryLifeTime; public int BatteryFullLifeTime; }
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetSystemPowerStatus(out SystemPowerStatus s);
  [DllImport("kernel32.dll")]
  static extern ulong GetTickCount64();
  [DllImport("pdh.dll", CharSet = CharSet.Unicode)]
  static extern int PdhOpenQueryW(string src, IntPtr user, out IntPtr q);
  [DllImport("pdh.dll", CharSet = CharSet.Unicode)]
  static extern int PdhAddEnglishCounterW(IntPtr q, string path, IntPtr user, out IntPtr c);
  [DllImport("pdh.dll")]
  static extern int PdhCollectQueryData(IntPtr q);
  [DllImport("pdh.dll", CharSet = CharSet.Unicode)]
  static extern int PdhGetFormattedCounterArrayW(IntPtr c, uint fmt, ref uint size, out uint count, IntPtr items);

  static void Need64() { if (IntPtr.Size != 8) throw new PlatformNotSupportedException("64-bit PowerShell only"); }

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

  // { pid, parent pid, start time (FILETIME, UTC), CPU time (100 ns, kernel + user), session } and the image name
  // (SYSTEM_PROCESS_INFORMATION, x64 offsets)
  public static List<object[]> Processes() {
    Need64();
    int len = 1 << 20;
    while (true) {
      IntPtr buf = Marshal.AllocHGlobal(len);
      try {
        int ret;
        int st = NtQuerySystemInformation(5, buf, len, out ret);
        if (st == unchecked((int)0xC0000004)) { len = Math.Max(len * 2, ret + 65536); continue; }
        if (st != 0) throw new InvalidOperationException("NtQuerySystemInformation: 0x" + st.ToString("x8"));
        var list = new List<object[]>();
        long off = 0;
        while (true) {
          IntPtr p = new IntPtr(buf.ToInt64() + off);
          int next = Marshal.ReadInt32(p, 0);
          long create = Marshal.ReadInt64(p, 0x20);
          long cpu = Marshal.ReadInt64(p, 0x28) + Marshal.ReadInt64(p, 0x30);
          int nameLen = Marshal.ReadInt16(p, 0x38) & 0xffff;
          IntPtr nameBuf = Marshal.ReadIntPtr(p, 0x40);
          string name = (nameBuf == IntPtr.Zero || nameLen == 0) ? null : Marshal.PtrToStringUni(nameBuf, nameLen / 2);
          long pid = Marshal.ReadIntPtr(p, 0x50).ToInt64();
          long ppid = Marshal.ReadIntPtr(p, 0x58).ToInt64();
          int session = Marshal.ReadInt32(p, 0x64);
          list.Add(new object[] { pid, ppid, create, cpu, (long)session, name });
          if (next == 0) break;
          off += next;
        }
        return list;
      } finally { Marshal.FreeHGlobal(buf); }
    }
  }
  const uint QueryLimited = 0x1000;
  // null when this account may not open the process (another account's)
  public static string CommandLine(int pid) {
    Need64();
    IntPtr h = OpenProcess(QueryLimited, false, pid);
    if (h == IntPtr.Zero) return null;
    try {
      int len = 65536;
      for (int i = 0; i < 3; i++) {
        IntPtr buf = Marshal.AllocHGlobal(len);
        try {
          int ret;
          int st = NtQueryInformationProcess(h, 60, buf, len, out ret);
          if (st == unchecked((int)0xC0000004) || st == unchecked((int)0xC0000023) || st == unchecked((int)0x80000005)) { len = Math.Max(len * 2, ret); continue; }
          if (st != 0) return null;
          int n = Marshal.ReadInt16(buf, 0) & 0xffff;
          IntPtr s = Marshal.ReadIntPtr(buf, 8);
          return (s == IntPtr.Zero) ? "" : Marshal.PtrToStringUni(s, n / 2);
        } finally { Marshal.FreeHGlobal(buf); }
      }
      return null;
    } finally { CloseHandle(h); }
  }
  public static string OwnerSid(int pid) {
    IntPtr h = OpenProcess(QueryLimited, false, pid);
    if (h == IntPtr.Zero) return null;
    try {
      IntPtr tok;
      if (!OpenProcessToken(h, 8, out tok)) return null;
      try { using (var id = new WindowsIdentity(tok)) { return id.User == null ? null : id.User.Value; } }
      finally { CloseHandle(tok); }
    } finally { CloseHandle(h); }
  }
  // { total physical, available physical, commit limit } in bytes
  public static ulong[] Memory() {
    var m = new MemoryStatusEx();
    if (!GlobalMemoryStatusEx(m)) throw new System.ComponentModel.Win32Exception();
    return new ulong[] { m.ullTotalPhys, m.ullAvailPhys, m.ullTotalPageFile };
  }
  // { AC line (0 off, 1 on, 255 unknown), battery flag (128: no battery), charge % (255 unknown) }
  public static int[] PowerStatus() {
    SystemPowerStatus s;
    if (!GetSystemPowerStatus(out s)) throw new System.ComponentModel.Win32Exception();
    return new int[] { s.ACLineStatus, s.BatteryFlag, s.BatteryLifePercent };
  }
  public static ulong UptimeMs() { return GetTickCount64(); }

  [StructLayout(LayoutKind.Sequential)]
  struct DevInfoData { public uint cbSize; public Guid ClassGuid; public uint DevInst; public IntPtr Reserved; }
  [DllImport("setupapi.dll", SetLastError = true)]
  static extern IntPtr SetupDiGetClassDevsW(ref Guid cls, IntPtr enumerator, IntPtr hwnd, uint flags);
  [DllImport("setupapi.dll", SetLastError = true)]
  static extern bool SetupDiEnumDeviceInfo(IntPtr set, uint idx, ref DevInfoData data);
  [DllImport("setupapi.dll", SetLastError = true)]
  static extern bool SetupDiGetDeviceRegistryPropertyW(IntPtr set, ref DevInfoData data, uint prop, out uint regType, byte[] buf, uint size, out uint req);
  [DllImport("setupapi.dll")]
  static extern bool SetupDiDestroyDeviceInfoList(IntPtr set);
  [DllImport("cfgmgr32.dll")]
  static extern int CM_Get_DevNode_Status(out uint status, out uint problem, uint devInst, uint flags);
  // The display adapters present now (DIGCF_PRESENT), each as { driver key
  // under Control\Class ("{4d36e968-...}\0001"), started (DN_STARTED),
  // problem code }: SetupAPI, no WMI.
  public static List<object[]> PresentDisplays() {
    Guid cls = new Guid("4d36e968-e325-11ce-bfc1-08002be10318");
    IntPtr set = SetupDiGetClassDevsW(ref cls, IntPtr.Zero, IntPtr.Zero, 2);
    if (set == new IntPtr(-1)) throw new System.ComponentModel.Win32Exception();
    var list = new List<object[]>();
    try {
      for (uint i = 0; ; i++) {
        var d = new DevInfoData(); d.cbSize = (uint)Marshal.SizeOf(typeof(DevInfoData));
        if (!SetupDiEnumDeviceInfo(set, i, ref d)) break;
        byte[] buf = new byte[1024]; uint type, req;
        string key = SetupDiGetDeviceRegistryPropertyW(set, ref d, 9, out type, buf, (uint)buf.Length, out req) ? System.Text.Encoding.Unicode.GetString(buf, 0, (int)req).TrimEnd('\0') : null;
        uint st, prob;
        bool started = false; long problem = -1;
        if (CM_Get_DevNode_Status(out st, out prob, d.DevInst, 0) == 0) { started = (st & 0x8) != 0; problem = prob; }
        list.Add(new object[] { key, started, problem });
      }
    } finally { SetupDiDestroyDeviceInfoList(set); }
    return list;
  }

  static IntPtr pdhQuery = IntPtr.Zero, pdhFreq, pdhPerf;
  static Dictionary<string, double> PdhArray(IntPtr c) {
    uint size = 0, count;
    PdhGetFormattedCounterArrayW(c, 0x200, ref size, out count, IntPtr.Zero);
    var r = new Dictionary<string, double>();
    if (size == 0) return r;
    IntPtr buf = Marshal.AllocHGlobal((int)size);
    try {
      if (PdhGetFormattedCounterArrayW(c, 0x200, ref size, out count, buf) != 0) return r;
      int item = 24;
      for (int i = 0; i < count; i++) {
        IntPtr p = new IntPtr(buf.ToInt64() + i * item);
        string name = Marshal.PtrToStringUni(Marshal.ReadIntPtr(p, 0));
        int cstatus = Marshal.ReadInt32(p, IntPtr.Size);
        double v = BitConverter.Int64BitsToDouble(Marshal.ReadInt64(p, IntPtr.Size + 8));
        if (cstatus == 0 || cstatus == 1) r[name] = v;
      }
    } finally { Marshal.FreeHGlobal(buf); }
    return r;
  }
  // -1 on the first call (a rate needs two readings), then since the previous one
  public static double EffectiveMhz() {
    Need64();
    if (pdhQuery == IntPtr.Zero) {
      IntPtr q;
      if (PdhOpenQueryW(null, IntPtr.Zero, out q) != 0) throw new InvalidOperationException("PdhOpenQuery");
      if (PdhAddEnglishCounterW(q, @"\Processor Information(*)\Processor Frequency", IntPtr.Zero, out pdhFreq) != 0 ||
          PdhAddEnglishCounterW(q, @"\Processor Information(*)\% Processor Performance", IntPtr.Zero, out pdhPerf) != 0) throw new InvalidOperationException("PdhAddEnglishCounter");
      pdhQuery = q;
      PdhCollectQueryData(q);
      return -1;
    }
    if (PdhCollectQueryData(pdhQuery) != 0) return -1;
    var f = PdhArray(pdhFreq); var perf = PdhArray(pdhPerf);
    double best = -1;
    foreach (var kv in perf) {
      if (kv.Key.Contains("_Total") || !f.ContainsKey(kv.Key)) continue;
      double e = f[kv.Key] * kv.Value / 100.0;
      if (e > best) best = e;
    }
    return best;
  }
}
"@
# Throws when the type cannot be built or called here (pwsh off Windows in
# the tests): every caller has a way without it, or reports null.
function Native {
  if (-not ("SalonKitNative" -as [type])) { Add-Type -TypeDefinition $NativeSource }
  return [SalonKitNative]
}
function Core-Map {
  $i = 0
  return @((Native)::Cores() | ForEach-Object {
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

# Every process, as rows: Name (image, "node.exe"), ProcessId,
# ParentProcessId, CreationDate (UTC ticks), Cpu (100 ns), SessionId.
# Every account's processes; command lines and owners are asked only for
# the few that matter (Proc-Owned, Proc-CommandLine).
function Process-Table {
  $epoch = [DateTime]::FromFileTimeUtc(0).Ticks
  @((Native)::Processes() | Where-Object { $_[0] -ne 0 } | ForEach-Object {
    [pscustomobject]@{ ProcessId = [int]$_[0]; ParentProcessId = [int]$_[1]; CreationDate = [int64]$_[2] + $epoch; Cpu = [double]$_[3]; SessionId = [int]$_[4]; Name = [string]$_[5] }
  })
}
$script:MySid = $null
function My-Sid {
  if (-not $script:MySid) { $script:MySid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value }
  return $script:MySid
}
# Owned by the account running this script (another account's process
# cannot even be opened: never ours).
function Proc-Owned([int]$id) {
  $sid = $null
  try { $sid = (Native)::OwnerSid($id) } catch {}
  return ($sid -and $sid -eq (My-Sid))
}
function Proc-CommandLine([int]$id) {
  try { return (Native)::CommandLine($id) } catch { return $null }
}

# Busy CPU of the machine and the processes using it, over $sec seconds:
# every account's processes' CPU time (Process-Table; 100 ns units,
# locale-independent). Get-Process CPU times as a fallback, which a
# standard account only gets for its own processes (then marked partial).
function Cpu-Busy([int]$sec = 3, [string[]]$exclude = @(), [int[]]$excludePids = @()) {
  $partial = $false
  $rows = @()
  try {
    $a = @{}; foreach ($q in (Process-Table)) { $a[$q.ProcessId] = $q }
    $t0 = [Diagnostics.Stopwatch]::StartNew()
    Start-Sleep -Seconds $sec
    $b = Process-Table
    $wall = $t0.Elapsed.Ticks
    if (-not ($wall -gt 0)) { throw "no elapsed time" }
    foreach ($q in $b) {
      $p = $a[$q.ProcessId]
      # same pid AND same start: Windows reuses pids at once
      if (-not $p -or $p.CreationDate -ne $q.CreationDate) { continue }
      $d = $q.Cpu - $p.Cpu
      if ($d -gt 0) { $rows += [pscustomobject]@{ name = ($q.Name -replace '\.exe$', ''); pid = $q.ProcessId; pct = [math]::Round(100 * $d / $wall, 1) } }
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

# One probe of check: its value, or $null and its error kept in
# $script:ProbeErrors (one unreadable item never hides the others).
$script:ProbeErrors = [ordered]@{}
function Probe([string]$name, [scriptblock]$read) {
  try { return (& $read) } catch { $script:ProbeErrors[$name] = "$($_.Exception.Message)"; return $null }
}
# The same for a list: always a list when read (one item, none), $null
# when not (never [null]: an unread list is not one empty item).
function Probe-List([string]$name, [scriptblock]$read) {
  $r = Probe $name $read
  if ($script:ProbeErrors.Contains($name)) { return $null }
  return , @($r | Where-Object { $null -ne $_ })
}
$CurrentVersion = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion"
function Os-Info {
  $b = Reg-Value $CurrentVersion "CurrentBuild"
  $build = $(if ("$b" -match '^\d+$') { [int]$b } else { $null })
  $product = Reg-Value $CurrentVersion "ProductName"
  # ProductName still says "Windows 10" on Windows 11 (Microsoft's own
  # guidance: tell them by the build, 22000 and up)
  $caption = "$product"
  if ($null -ne $build -and $build -ge 22000) { $caption = $caption -replace 'Windows 10', 'Windows 11' }
  $boot = $null
  try { $boot = (Get-Date).AddMilliseconds(-[double]((Native)::UptimeMs())).ToString("o") } catch { $script:ProbeErrors["os.lastBoot"] = "$($_.Exception.Message)" }
  [ordered]@{
    caption = $caption; productName = $product; edition = Reg-Value $CurrentVersion "EditionID"; displayVersion = Reg-Value $CurrentVersion "DisplayVersion"
    version = $(if ($null -ne $build) { "10.0.$build" } else { $null }); build = $(if ($null -ne $build) { "$build" } else { $null }); ubr = Reg-Value $CurrentVersion "UBR"; locale = (Get-Culture).Name
    lastBoot = $boot
  }
}
function Cpu-Info($cores) {
  $k = "HKLM:\HARDWARE\DESCRIPTION\System\CentralProcessor\0"
  [ordered]@{ name = "$(Reg-Value $k 'ProcessorNameString')".Trim(); cores = $(if ($cores) { @($cores).Count } else { $null }); logical = [Environment]::ProcessorCount; maxClockMhz = Reg-Value $k "~MHz"; manufacturer = Reg-Value $k "VendorIdentifier" }
}
function Memory-Info {
  $m = (Native)::Memory()
  [ordered]@{ totalGiB = [math]::Round($m[0] / 1GB, 1); freeGiB = [math]::Round($m[1] / 1GB, 1); commitLimitGiB = [math]::Round($m[2] / 1GB, 1) }
}
# Win32_Battery's shape (BatteryStatus 1 = discharging, 2 = on AC, null =
# unknown): what the preflight reads. No battery: an empty list. 255 is
# "unknown" for both GetSystemPowerStatus fields: a battery flag of 255
# throws (the probe is then null: the preflight blocks), an AC line of 255
# gives BatteryStatus null.
function Battery-Info {
  $s = (Native)::PowerStatus()
  if ($s[1] -eq 255) { throw "battery status unknown (GetSystemPowerStatus BatteryFlag 255)" }
  if ($s[1] -band 128) { return @() }
  @([ordered]@{ BatteryStatus = $(if ($s[0] -eq 0) { 1 } elseif ($s[0] -eq 1) { 2 } else { $null }); EstimatedChargeRemaining = $(if ($s[2] -eq 255) { $null } else { $s[2] }); acLine = $s[0] })
}
# The display adapters from their driver keys (the display class, readable
# by every account), each marked present (SetupAPI's present devices; a
# driver left installed for a card taken out stays in the class key) and
# started; present null when SetupAPI could not be asked. A registry
# failure throws (the list is then null, never empty). The refresh rate is
# Display-Info's.
$DisplayClass = "HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}"
function Gpu-Info {
  $present = $null
  try {
    $present = @{}
    foreach ($d in (Native)::PresentDisplays()) { if ($d[0]) { $present[([string]$d[0]).ToLower()] = @([bool]$d[1], [long]$d[2]) } }
  } catch { $present = $null; $script:ProbeErrors["gpus.present"] = "$($_.Exception.Message)" }
  # the subkeys' names only: Get-ChildItem opens each, and the class's
  # Properties subkey is refused to every account (CI windows-2025)
  $cls = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($DisplayClass.Substring(6))
  if (-not $cls) { throw "cannot open $DisplayClass" }
  try { $names = @($cls.GetSubKeyNames()) } finally { $cls.Close() }
  @($names | Where-Object { $_ -match '^\d{4}$' } | ForEach-Object {
    $dev = "{4d36e968-e325-11ce-bfc1-08002be10318}\$_"
    $p = $null
    try { $p = Get-ItemProperty -LiteralPath (Join-Path $DisplayClass $_) -ErrorAction Stop } catch {}
    if ($p -and ($p.PSObject.Properties.Name -contains "DriverDesc")) {
      $date = $null
      $raw = $(if ($p.PSObject.Properties.Name -contains "DriverDate") { "$($p.DriverDate)" } else { "" })
      if ($raw -match '^(\d{1,2})-(\d{1,2})-(\d{4})$') { $date = "{0}-{1:00}-{2:00}" -f $Matches[3], [int]$Matches[1], [int]$Matches[2] }
      $pr = $(if ($null -eq $present) { $null } else { $present[$dev] })
      [ordered]@{ name = $p.DriverDesc; driver = $(if ($p.PSObject.Properties.Name -contains "DriverVersion") { $p.DriverVersion } else { $null }); driverDate = $date
        present = $(if ($null -eq $present) { $null } else { $null -ne $pr }); started = $(if ($pr) { $pr[0] } else { $null }); problem = $(if ($pr) { $pr[1] } else { $null })
        refreshHz = $null; pnp = $(if ($p.PSObject.Properties.Name -contains "MatchingDeviceId") { $p.MatchingDeviceId } else { $null }) }
    }
  })
}
# The screens' modes from the display configuration the graphics kernel
# keeps (GraphicsDrivers\Configuration: the latest monitor set by its
# Timestamp, one subkey per target, VSyncFreq = refresh rate). The ssh
# session's own screen is a placeholder, EnumDisplaySettings would read
# that. May be refused to a standard account: then null, said in
# probeErrors, and the preflight warns (refresh unknown).
$GfxConfig = "HKLM:\SYSTEM\CurrentControlSet\Control\GraphicsDrivers\Configuration"
function Display-Info {
  $best = $null; $bestTs = [int64]-1
  foreach ($set in @(Get-ChildItem -LiteralPath $GfxConfig -ErrorAction Stop)) {
    $ts = Reg-Value $set.PSPath "Timestamp"
    if ($null -ne $ts -and [int64]$ts -gt $bestTs) { $best = $set; $bestTs = [int64]$ts }
  }
  if (-not $best) { throw "no display configuration with a Timestamp under $GfxConfig" }
  $targets = @(Get-ChildItem -LiteralPath $best.PSPath -ErrorAction Stop | ForEach-Object { Get-ChildItem -LiteralPath $_.PSPath -ErrorAction Stop })
  $r = @($targets | ForEach-Object {
    $num = Reg-Value $_.PSPath "VSyncFreq.Numerator"; $den = Reg-Value $_.PSPath "VSyncFreq.Denominator"
    [ordered]@{ set = $best.PSChildName; target = $_.PSChildName; width = Reg-Value $_.PSPath "PrimSurfSize.cx"; height = Reg-Value $_.PSPath "PrimSurfSize.cy"
      # outside 20-500 Hz: not a screen's rate (a virtual display gives 1)
      refreshHz = $(if ($num -and $den) { $hz = [math]::Round([double]$num / [double]$den, 2); if ($hz -ge 20 -and $hz -le 500) { $hz } else { $null } } else { $null })
      vsync = $(if ($num -and $den) { "$num/$den" } else { $null }) }
  })
  if (-not @($r | Where-Object { $_.refreshHz }).Count) { throw "no screen refresh rate in $($best.PSChildName) (VSyncFreq $(@($r | ForEach-Object { $_.vsync }) -join ', '))" }
  return $r
}
# nvidia-smi when the NVIDIA driver installed it: the dGPU's own reading.
function Nvidia-Info {
  $smi = "$env:SystemRoot\System32\nvidia-smi.exe"
  if (-not (Test-Path -LiteralPath $smi)) { return $null }
  $out = @(& $smi --query-gpu=name,driver_version,display_active,pstate --format=csv,noheader 2>$null)
  if ($LASTEXITCODE -ne 0) { throw "nvidia-smi exit $LASTEXITCODE" }
  @($out | Where-Object { $_ } | ForEach-Object { $f = @("$_" -split ',\s*'); [ordered]@{ name = $f[0]; driver = $f[1]; displayActive = $f[2]; pstate = $f[3] } })
}
# Defender's real-time protection from its registry keys (the cmdlet is
# CIM): off when a key says so, null when neither key can be read (the
# product key may be refused to a standard account: unknown, not "on").
function Defender-Info {
  $keys = @("HKLM:\SOFTWARE\Microsoft\Windows Defender\Real-Time Protection", "HKLM:\SOFTWARE\Policies\Microsoft\Windows Defender\Real-Time Protection")
  $read = 0; $off = $false
  foreach ($k in $keys) {
    try { $p = Get-ItemProperty -LiteralPath $k -ErrorAction Stop; $read++ } catch { continue }
    if (($p.PSObject.Properties.Name -contains "DisableRealtimeMonitoring") -and $p.DisableRealtimeMonitoring -eq 1) { $off = $true }
  }
  [ordered]@{ realTime = $(if ($off) { $false } elseif ($read) { $true } else { $null }); source = "registry" }
}
function Sessions-Info {
  # quser: every session of the machine; "No User exists" on stderr when none
  @((& "$env:SystemRoot\System32\quser.exe" 2>$null) | Select-Object -Skip 1 | ForEach-Object { ($_ -replace '^\s*>?', '') -replace '\s{2,}', '|' })
}

function Check {
  $kitDrive = Probe "disk" { (Split-Path -Qualifier $KitDir).TrimEnd(":") }
  $coreMap = Probe-List "coreMap" { Core-Map }
  $active = Probe "power" { Active-Scheme }
  $affinity = $null
  try { $affinity = Class-Affinity $Cores } catch { $affinity = [ordered]@{ error = "$_" } }
  Out-Result ([ordered]@{
    action = "check"; at = (Get-Date).ToString("o"); host = $env:COMPUTERNAME; user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    os = Probe "os" { Os-Info }
    cpu = Probe "cpu" { Cpu-Info $coreMap }
    coreMap = $coreMap; classAffinity = $affinity
    memory = Probe "memory" { Memory-Info }
    gpus = Probe-List "gpus" { Gpu-Info }
    display = Probe-List "display" { Display-Info }
    nvidia = Probe "nvidia" { Nvidia-Info }
    gpuPreference = Probe "gpuPreference" { Reg-Policies "HKCU:\Software\Microsoft\DirectX\UserGpuPreferences" }
    hags = Reg-Value "HKLM:\SYSTEM\CurrentControlSet\Control\GraphicsDrivers" "HwSchMode"
    gameMode = Reg-Value "HKCU:\Software\Microsoft\GameBar" "AutoGameModeEnabled"
    browsers = [ordered]@{
      chrome = Probe "chrome" { File-Version @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") }
      edge = Probe "edge" { File-Version @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") }
    }
    policies = Probe "policies" { [ordered]@{
      chromeMachine = Reg-Policies "HKLM:\SOFTWARE\Policies\Google\Chrome"; chromeUser = Reg-Policies "HKCU:\SOFTWARE\Policies\Google\Chrome"
      edgeMachine = Reg-Policies "HKLM:\SOFTWARE\Policies\Microsoft\Edge"; edgeUser = Reg-Policies "HKCU:\SOFTWARE\Policies\Microsoft\Edge"
    } }
    power = [ordered]@{
      battery = Probe-List "battery" { Battery-Info }; activeScheme = $active; schemes = Probe-List "schemes" { All-Schemes }; kitSchemeActive = ($active -eq $KitScheme)
      overlayAc = Reg-Value "HKLM:\SYSTEM\CurrentControlSet\Control\Power\User\PowerSchemes" "ActiveOverlayAcPowerScheme"
      processor = $(if ($active) { Probe "processor" { Processor-Settings $active } } else { $null })
    }
    session = [ordered]@{ sessions = Probe-List "sessions" { Sessions-Info }; lockScreenUp = [bool](Get-Process -Name LogonUI -ErrorAction SilentlyContinue); sshSession = [bool]$env:SSH_CLIENT; elevated = (Is-Elevated); user = $env:USERNAME }
    security = [ordered]@{ memoryIntegrity = Reg-Value "HKLM:\SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\HypervisorEnforcedCodeIntegrity" "Enabled"; defender = Probe "defender" { Defender-Info } }
    disk = [ordered]@{ drive = $kitDrive; freeGiB = $(if ($kitDrive) { Probe "disk" { [math]::Round(([IO.DriveInfo]::new($kitDrive)).AvailableFreeSpace / 1GB, 1) } } else { $null }) }
    kit = [ordered]@{ dir = $KitDir; node = Probe "node" { File-Version @((Join-Path $KitDir "node\node.exe")) }; tasks = Probe-List "tasks" { Kit-Tasks }; processes = Probe-List "processes" { Kit-Processes } }
    # OpenSSH's shell for the administrator's commands: cmd.exe must get /d
    # (AutoRun off: HKCU\...\Command Processor\AutoRun would otherwise run
    # elevated before the kit's fixed command)
    sshd = [ordered]@{ defaultShell = Reg-Value "HKLM:\SOFTWARE\OpenSSH" "DefaultShell"; defaultShellCommandOption = Reg-Value "HKLM:\SOFTWARE\OpenSSH" "DefaultShellCommandOption" }
    cpuBusy = Probe "cpuBusy" { Cpu-Busy 3 }
    probeErrors = $script:ProbeErrors
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
    kitProcesses = $null
  }
  # unreadable: null, said so (restore then compares no process list)
  try { $state.kitProcesses = @(Kit-Processes) } catch { $state["kitProcessesError"] = "$_" }
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
  try { $t = Kit-Task $Job; if ($t) { $t.Stop(0) } } catch { $warn += "task not stopped: $_" }
  foreach ($f in @("inner.pid", "node.pid", "sampler.pid")) {
    $p = Read-PidFile (Join-Path $jd $f)
    if ($p) { try { $p.Kill(); $killed += $p.Id } catch {} }
  }
  $still = @()
  try {
    for ($round = 0; $round -lt 5; $round++) {
      $left = @(Job-Processes $jd)
      if (-not $left.Count) { break }
      foreach ($q in $left) { try { Stop-Process -Id $q.ProcessId -Force -ErrorAction Stop; $killed += $q.ProcessId } catch {} }
      Start-Sleep -Milliseconds 500
    }
    $still = @(Job-Processes $jd | ForEach-Object { [ordered]@{ pid = $_.ProcessId; name = $_.Name } })
    if ($still.Count) { $warn += "processes of the job still running: $(($still | ForEach-Object { "$($_.name) $($_.pid)" }) -join ', ')" }
  } catch { $still = $null; $warn += "the process table could not be read (the job's processes not searched): $_" }
  try { if (Kit-Task $Job) { (Kit-Folder).DeleteTask($Job, 0) } } catch { $warn += "task not unregistered: $_" }
  # the job's TEMP (this account's own files; never elevated)
  $tmp = Join-Path $jd "tmp"
  try { Remove-Tree $tmp } catch { $warn += "job tmp not fully removed: $_" }
  return [ordered]@{ killed = @($killed | Select-Object -Unique); still = $still; tmpLeft = (Test-Path -LiteralPath $tmp); warnings = $warn }
}

function Cleanup {
  Need-Job
  $r = Stop-KitJob (Job-Dir)
  $kp = $null
  try { $kp = @(Kit-Processes) } catch { $r.warnings += "kit processes not read: $_" }
  Out-Result ([ordered]@{ action = "cleanup"; job = $Job; killed = $r.killed; jobProcesses = $r.still; jobTmp = $r.tmpLeft; warnings = $r.warnings; power = (Power-State); tasks = @(Kit-Tasks); kitProcesses = $kp })
}

# The power state as this account reads it (the admin commands change it).
function Power-State {
  $active = Active-Scheme
  [ordered]@{ activeScheme = $active; schemes = @(All-Schemes); processor = Processor-Settings $active; kitScheme = $(if (All-Schemes | Where-Object { $_ -eq $KitScheme }) { Processor-Settings $KitScheme } else { $null }) }
}
# The task scheduler through its own COM API (Schedule.Service, an RPC
# to the service any local account may call): the ScheduledTasks cmdlets
# are CIM (root\Microsoft\Windows\TaskScheduler), refused to this
# account's ssh logon like root\cimv2.
$TaskStates = @{ 0 = "Unknown"; 1 = "Disabled"; 2 = "Queued"; 3 = "Ready"; 4 = "Running" }
function Task-Service {
  $svc = New-Object -ComObject Schedule.Service
  $svc.Connect()
  return $svc
}
# \SalonKit\, $null while it does not exist (-Create: made then)
function Kit-Folder([switch]$Create) {
  $svc = Task-Service
  try { return $svc.GetFolder($TaskPath.TrimEnd('\')) } catch {}
  if ($Create) { return $svc.GetFolder("\").CreateFolder($TaskPath.Trim('\')) }
  return $null
}
# the job's registered task, $null when there is none
function Kit-Task([string]$name) {
  $f = Kit-Folder
  if (-not $f) { return $null }
  try { return $f.GetTask($name) } catch { return $null }
}
function Kit-Tasks {
  $f = Kit-Folder
  if (-not $f) { return @() }
  # 1: TASK_ENUM_HIDDEN
  @(foreach ($t in $f.GetTasks(1)) { if ($null -ne $t) { [string]$t.Name } })
}

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
# The kit's images among every process (Process-Table), each with its
# command line: read for these only, and only this account's can be.
# Throws when the table cannot be read: never "no process" by default.
function Kit-Image-Rows {
  @(Process-Table | Where-Object { $KitImages -contains $_.Name } | ForEach-Object {
    Add-Member -InputObject $_ -NotePropertyName CommandLine -NotePropertyValue (Proc-CommandLine $_.ProcessId) -PassThru
  })
}
# The job's processes: node, chrome, msedge, powershell whose command line
# holds the job's folder (its browsers carry --user-data-dir under the
# job's TEMP), and their descendants of those images (a browser helper);
# never this script's own invocations.
function Job-Processes([string]$jd) {
  $me = $PID
  $all = @(Kit-Image-Rows)
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
  @(Kit-Image-Rows | Where-Object {
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
  if (-not (Is-UsersKitProcess ([pscustomobject]@{ Name = "$($p.ProcessName).exe"; ProcessId = $p.Id }))) { return $null }
  return $p
}
# One of the kit's images, owned by the account running this script.
# $q: a row with Name ("node.exe") and ProcessId.
function Is-UsersKitProcess($q) {
  if ($KitImages -notcontains $q.Name) { return $false }
  return (Proc-Owned $q.ProcessId)
}
function Start-Job-Task {
  Need-Job
  $jd = Job-Dir
  if (-not (Test-Path -LiteralPath (Join-Path $jd "spec.json"))) { throw "no $jd\spec.json (pc-run.mjs writes it)" }
  foreach ($f in @("exit", "log", "node.pid", "stop")) { $p = Join-Path $jd $f; if (Test-Path -LiteralPath $p) { throw "job $Job ran already ($p): use a new job id" } }
  $self = $PSCommandPath
  $arg = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$self`" -Action inner -Job $Job -KitDir `"$KitDir`""
  # the logon name as Windows knows it (a local account's domain is the machine, but USERDOMAIN reads WORKGROUP in an ssh session)
  $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $def = (Task-Service).NewTask(0)
  $act = $def.Actions.Create(0)   # TASK_ACTION_EXEC
  $act.Path = "powershell.exe"; $act.Arguments = $arg; $act.WorkingDirectory = $jd
  # Interactive token, least privilege: runs in the logged-on user's
  # desktop session (a browser started from the ssh session would have no
  # screen: session 0 has none), RunLevel 0 (limited token; with pc-run --allow-elevated-host the account itself is an administrator).
  $def.Principal.UserId = $user; $def.Principal.LogonType = 3; $def.Principal.RunLevel = 0
  $def.Settings.DisallowStartIfOnBatteries = $false; $def.Settings.StopIfGoingOnBatteries = $false
  $def.Settings.ExecutionTimeLimit = "PT$($TaskHours)H"; $def.Settings.MultipleInstances = 2   # ignore new
  # 6: create or update; 3: TASK_LOGON_INTERACTIVE_TOKEN (no password)
  [void](Kit-Folder -Create).RegisterTaskDefinition($Job, $def, 6, $user, $null, 3)
  [void](Kit-Task $Job).Run($null)
  Start-Sleep -Seconds 3
  $t = Kit-Task $Job
  Out-Result ([ordered]@{ action = "start"; job = $Job; lastResult = $t.LastTaskResult; state = $TaskStates[[int]$t.State] })
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
  $task = Kit-Task $Job
  $inner = Read-PidFile (Join-Path $jd "inner.pid")
  $state = "missing"
  if ($done) { $state = "done" }
  elseif ($task -and [int]$task.State -eq 4) { $state = "running" }
  elseif ($inner) { $state = "running" }
  elseif ($task -and (Test-Path -LiteralPath (Join-Path $jd "inner.pid"))) {
    # the task ran, its inner is gone and wrote no exit: killed (time limit,
    # logoff, crash). Never "ready" forever with the clamp on.
    $state = "dead"
  } elseif ($task) {
    # never run: LastRunTime is 1899-12-30
    $state = "queued"
    $last = $null; try { $last = [datetime]$task.LastRunTime } catch {}
    if ($last -and $last.Year -gt 2000) { $state = "dead" }
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
    $ours = @($PID)
    try { $ours += @(Job-Processes $jd | ForEach-Object { [int]$_.ProcessId }) } catch {}
    foreach ($f in @("inner.pid", "node.pid")) { $q = Read-PidFile (Join-Path $jd $f); if ($q) { $ours += $q.Id } }
    $b = Cpu-Busy 5 @("Idle") $ours
    $aff = @(Get-Process -Id ($ours | Select-Object -Unique) -ErrorAction SilentlyContinue | Where-Object { @("chrome", "msedge") -contains $_.ProcessName } | Select-Object -First 1 | ForEach-Object { try { "0x{0:x}" -f $_.ProcessorAffinity.ToInt64() } catch { $null } })
    $eff = $null
    try {
      # the busiest core's effective clock: frequency x % performance (a
      # cap the firmware ignores shows here; Microsoft's own check), PDH
      # since the previous loop (-1 the first time: none)
      $e = (Native)::EffectiveMhz()
      if ($e -gt 0) { $eff = $e }
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
  try { (Task-Service).GetFolder("\").DeleteFolder($TaskPath.Trim('\'), 0) } catch {}
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
