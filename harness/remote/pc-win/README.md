# PC kit (Windows, driven from the Mac)

The kit measures a Windows PC over ssh in one command, then puts the machine back as it was.
The full write-up (pitfalls, calibration sources, limits) is in the program's `research/pc-windows-kit.md`.
The protocol is `research/pc-windows-protocol.md`, hashed before any data.

## Two accounts

- **`--host salonkit@pc`**: a **standard** local account, never an administrator. It does all the work:
  - the files, under its `%USERPROFILE%\salon-kit`;
  - node and Playwright;
  - the measurement jobs, in **its own** desktop session;
  - the cleanup;
  - reading the power state.
  
  `salon-pc.ps1` runs only there and never writes a power setting.
- **`--admin-host admin@pc`**: an administrator, used **only** for the closed list below. Every line is checked by `assertAdmin` (`lib/pc-kit.mjs`) before it leaves the Mac.

## The administrator's commands: the complete list

```
C:\Windows\System32\powercfg.exe /getactivescheme
C:\Windows\System32\powercfg.exe /duplicatescheme <GUID> 5a10c0de-0b1d-4c1a-9e2f-12400c1a0001
C:\Windows\System32\powercfg.exe /changename 5a10c0de-0b1d-4c1a-9e2f-12400c1a0001 SalonKitClamp
C:\Windows\System32\powercfg.exe /set{ac|dc}valueindex 5a10c0de-… 54533251-… <one of 5 processor-setting GUIDs> <integer>
C:\Windows\System32\powercfg.exe /setactive {5a10c0de-…|<GUID>}
C:\Windows\System32\powercfg.exe /delete 5a10c0de-0b1d-4c1a-9e2f-12400c1a0001
C:\Windows\System32\schtasks.exe /create /tn SalonKitRestore /sc onstart /ru SYSTEM /rl highest /f /tr "C:\Windows\System32\cmd.exe /d /c C:\Windows\System32\powercfg.exe /setactive <GUID> & C:\Windows\System32\powercfg.exe /delete 5a10c0de-… & C:\Windows\System32\schtasks.exe /delete /tn SalonKitRestore /f"
C:\Windows\System32\schtasks.exe /query /tn SalonKitRestore
C:\Windows\System32\schtasks.exe /delete /tn SalonKitRestore /f
```

- `<GUID>` is the active scheme from the snapshot, matched against `[0-9a-f]{8}-…-[0-9a-f]{12}`.
- The 5 processor-setting GUIDs are `PROCFREQMAX`, `PROCFREQMAX1`, `PROCTHROTTLEMAX`, `PROCTHROTTLEMAX1` and `PERFBOOSTMODE`.
- The admin side runs no kit script, no node, no PowerShell module and no `Add-Type`.

## The PC, once (Baptiste)

1. Create a standard local account `salonkit`.
   - Its public key goes in `C:\Users\salonkit\.ssh\authorized_keys`.
   - The admin key goes in `C:\ProgramData\ssh\administrators_authorized_keys`.
2. Set sshd's shell to `cmd.exe /d`, so it skips AutoRun. As an admin, then restart sshd:
   ```
   reg add HKLM\SOFTWARE\OpenSSH /v DefaultShell /t REG_SZ /d C:\Windows\System32\cmd.exe /f
   reg add HKLM\SOFTWARE\OpenSSH /v DefaultShellCommandOption /t REG_SZ /d "/d /c" /f
   ```
3. To measure, log on as `salonkit`:
   - screen at 60 Hz, sleep off, nothing else open;
   - the disc somewhere `salonkit` can read.

## Commands

```sh
node harness/remote/pc-run.mjs check     --host salonkit@pc --admin-host admin@pc --iso 'C:\Users\salonkit\discs\game.iso'
node harness/remote/pc-run.mjs setup     --host salonkit@pc
node harness/remote/pc-run.mjs smoke     --host salonkit@pc
node harness/remote/pc-run.mjs calibrate --host salonkit@pc --admin-host admin@pc
node harness/remote/pc-run.mjs run       --host salonkit@pc --admin-host admin@pc --iso '…' --film 1p=… --film 2p=… --runs 3 --calibration <job>/calibration.json
```

Every command takes `--dry-run`, which prints each line against a simulated PC without connecting. After a lost Mac, use `restore --job ID`; after a reboot, the boot task has already put the scheme back.

Results go to `$CLAUDE_JOB_DIR/pc-kit/<job>/` (otherwise `../measures/pc-kit/`), as `report.md` and the raw files.
