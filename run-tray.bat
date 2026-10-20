@echo off
setlocal DisableDelayedExpansion
set "proxyShell="
for /f "delims=" %%P in ('where.exe pwsh.exe 2^>nul') do if not defined proxyShell set "proxyShell=%%P"
if not defined proxyShell if exist "%ProgramFiles%\PowerShell\7\pwsh.exe" set "proxyShell=%ProgramFiles%\PowerShell\7\pwsh.exe"
if not defined proxyShell if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe" set "proxyShell=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe"
if defined proxyShell (
    start "" "%proxyShell%" -NoLogo -NoProfile -STA -WindowStyle Hidden -File "%~dp0windows\ProxyTray.ps1"
    exit /b
)
echo PowerShell 7 was not found. Trying Windows PowerShell with the existing execution policy.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -STA -File "%~dp0windows\ProxyTray.ps1"
if errorlevel 1 (
    echo The tray could not launch. Install PowerShell 7 or ask your administrator about the script execution policy.
    pause
)
exit /b
