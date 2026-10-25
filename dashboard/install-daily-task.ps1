param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$digest = [System.Security.Cryptography.SHA256]::Create()
$suffix = ([BitConverter]::ToString($digest.ComputeHash([Text.Encoding]::UTF8.GetBytes($projectRoot.ToLowerInvariant())))).Replace('-', '').Substring(0, 8)
$taskName = 'BitIndex-DailyForecast-' + $suffix
if ($Remove) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  $configuration = Join-Path $projectRoot 'predictions/schedule.json'
  if (Test-Path -LiteralPath $configuration) { Remove-Item -LiteralPath $configuration }
  Write-Output ('Removed: ' + $taskName)
  exit 0
}
$nodeExecutable = (Get-Command node -ErrorAction Stop).Source
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$runner = Join-Path $PSScriptRoot 'run-daily.ps1'
$arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $runner + '" -NodePath "' + $nodeExecutable + '"'
$action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe') -Argument $arguments -WorkingDirectory $projectRoot
$nextHour = (Get-Date).Date.AddHours((Get-Date).Hour + 1)
# The Node runner gates by America/New_York, so DST and OS timezone changes do not shift 09:00.
$hourly = New-ScheduledTaskTrigger -Once -At $nextHour -RepetitionInterval (New-TimeSpan -Hours 1)
$logon = New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$legacyDescription = 'BitIndex daily forward forecast archive; New York 09:00 with hourly retry; ' + $projectRoot
$description = 'BitIndex actual-price comparison only; no new forecasts; New York 09:00 with hourly retry; ' + $projectRoot
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing -and $existing.Description -notin @($description, $legacyDescription)) { throw 'Task name is occupied by another configuration.' }
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($hourly, $logon) -Settings $settings -Principal $principal -Description $description -Force | Out-Null
$configuration = @{ taskName=$taskName; mode='comparison-only'; newForecastsEnabled=$false; timeZone='America/New_York'; dailyHour=9; retry='hourly'; logon='current user must be signed in'; installedAt=[DateTime]::UtcNow.ToString('o'); projectRoot=$projectRoot }
$folder = Join-Path $projectRoot 'predictions'
New-Item -ItemType Directory -Path $folder -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $folder 'schedule.json'), ($configuration | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName,State
Get-ScheduledTaskInfo -TaskName $taskName | Select-Object NextRunTime,LastTaskResult
