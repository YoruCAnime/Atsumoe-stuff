@echo off
rem Stops the Atsu Voice Reader helper (with its two workers) and takes it out of Windows start.
rem The files stay; nothing is deleted. "Install helper (start with Windows).bat" puts it back.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Stop-ScheduledTask -TaskName 'Atsu Voice Reader helper' -ErrorAction SilentlyContinue;" ^
  "Unregister-ScheduledTask -TaskName 'Atsu Voice Reader helper' -Confirm:$false -ErrorAction SilentlyContinue;" ^
  "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*reader_helper.py*' } | ForEach-Object { taskkill /T /F /PID $_.ProcessId | Out-Null };" ^
  "'Removed: the helper is stopped and will not start with Windows.'"
pause
