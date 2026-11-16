@echo off
setlocal
cd /d "%~dp0\.."
set "PORT=3000"

if not exist "runtime\node.exe" (
  echo No se encontro Node.js portable. Volve a extraer el ZIP completo.
  pause
  exit /b 1
)

if not exist "node_modules\express\package.json" (
  echo No se encontraron las dependencias del monitor. Volve a extraer el ZIP completo.
  pause
  exit /b 1
)

if not exist "firebase-service-account.json" (
  echo No se encontro la configuracion de Firebase.
  pause
  exit /b 1
)

powershell.exe -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }"
if errorlevel 1 (
  echo El puerto 3000 ya esta en uso. Cierra la otra instancia del monitor e intenta de nuevo.
  pause
  exit /b 1
)

start "Vitalix - servidor (cerrar esta ventana para detener)" /min "%~dp0..\runtime\node.exe" "%~dp0..\server.js"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$end=(Get-Date).AddSeconds(30); do { try { $response=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3000' -TimeoutSec 2; if ($response.StatusCode -eq 200) { exit 0 } } catch {}; Start-Sleep -Milliseconds 500 } while ((Get-Date) -lt $end); exit 1"
if errorlevel 1 (
  echo El monitor no pudo iniciar. Revisa la ventana minimizada del servidor.
  pause
  exit /b 1
)

start "" "http://localhost:3000"
endlocal
