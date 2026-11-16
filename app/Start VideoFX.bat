@echo off
setlocal
cd /d "%~dp0"
set "LICENSE_API=https://videofx.thecre8iveplace.com"
set "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1"

set "CHROME="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=1"
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=1"
if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "CHROME=1"
if not defined CHROME (
  echo Install Google Chrome, then open Start VideoFX again.
  start "" "https://www.google.com/chrome/"
  pause
  exit /b 1
)

powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing http://127.0.0.1:4177/ -TimeoutSec 2) | Out-Null; exit 0 } catch { exit 1 }"
if not errorlevel 1 (
  start "" "http://127.0.0.1:4177/"
  exit /b 0
)

if not exist "%CD%\.node\node.exe" (
  echo Setting up VideoFX. This first open can take a few minutes.
  set "NODE_ARCH=x64"
  if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "NODE_ARCH=arm64"
  powershell -NoProfile -Command "$ErrorActionPreference='Stop'; $ver='v22.23.5'; $arch=$env:NODE_ARCH; if (-not $arch) { $arch='x64' }; $dest=Join-Path (Get-Location) '.node-tmp'; $zip=Join-Path $env:TEMP 'videofx-node.zip'; Invoke-WebRequest -Uri \"https://nodejs.org/dist/$ver/node-$ver-win-$arch.zip\" -OutFile $zip; if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }; Expand-Archive -Path $zip -DestinationPath $dest -Force; $inner=Get-ChildItem $dest -Directory | Select-Object -First 1; $nodeHome=Join-Path (Get-Location) '.node'; if (Test-Path $nodeHome) { Remove-Item -Recurse -Force $nodeHome }; Move-Item $inner.FullName $nodeHome; Remove-Item -Recurse -Force $dest"
)

if not exist "%CD%\node_modules\playwright" (
  echo Installing the app pieces.
  call "%CD%\.node\npm.cmd" install --omit=dev --cache "%CD%\.npm-cache"
  if errorlevel 1 (
    echo Setup did not finish. Leave this window open and try Start VideoFX again.
    pause
    exit /b 1
  )
)

echo Leave this window open while you use VideoFX.
start "" "http://127.0.0.1:4177/"
"%CD%\.node\node.exe" src\server.js
echo The app stopped.
pause
