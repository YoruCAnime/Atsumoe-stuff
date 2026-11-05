@echo off
rem Atsu Voice Reader helper: starts it with Windows (at logon) and starts it now.
rem It listens on this PC only (127.0.0.1:8795), runs at low priority with no window, keeps running on battery,
rem and gives all its memory back after 5 minutes without reading. Undo: "Remove helper from Windows start.bat".
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$dir = '%~dp0'.TrimEnd('\');" ^
  "$a = New-ScheduledTaskAction -Execute (Join-Path $dir '.venv_vision\Scripts\pythonw.exe') -Argument '\"reader_helper.py\"' -WorkingDirectory $dir;" ^
  "$t = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME;" ^
  "$s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Priority 7 -MultipleInstances IgnoreNew;" ^
  "Register-ScheduledTask -TaskName 'Atsu Voice Reader helper' -Action $a -Trigger $t -Settings $s -Description 'Reads atsu.moe speech bubbles aloud for the Atsu Voice Reader userscript (127.0.0.1:8795).' -Force | Out-Null;" ^
  "Start-ScheduledTask -TaskName 'Atsu Voice Reader helper';" ^
  "Start-Sleep -Seconds 4;" ^
  "try { $h = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 http://127.0.0.1:8795/health; 'Helper is running: ' + $h.Content } catch { 'The helper did not answer yet - look in reader_helper.log' }"
echo.
echo Done. It will also start by itself whenever you log in.
pause
