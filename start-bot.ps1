param(
  [switch]$NoServe,
  [switch]$SkipPermissions
)

$ProjectDir = "D:\www\ai\remote_ai"
$LogDir = "$env:LOCALAPPDATA\opencode\log"

Write-Host "Проверка и остановка предыдущего экземпляра бота..."
$botProcesses = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -match "src(/|\\)index\.js" }
if ($botProcesses) {
  foreach ($proc in $botProcesses) {
    Write-Host "Останавливаем процесс бота с PID $($proc.ProcessId)..."
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 1
}

if (-not $NoServe) {
  Write-Host "Проверка и остановка предыдущего экземпляра сервиса (порт 4096)..."
  $serverConns = Get-NetTCPConnection -LocalPort 4096 -State Listen -ErrorAction SilentlyContinue
  if ($serverConns) {
    foreach ($conn in $serverConns) {
      if ($conn.OwningProcess -ne 0) {
        Write-Host "Останавливаем процесс сервиса с PID $($conn.OwningProcess)..."
        Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
      }
    }
    Start-Sleep -Seconds 1
  }

  $serveArgs = @("-NoLogo", "-NoProfile", "-File", "$env:APPDATA\npm\opencode.ps1", "serve", "--port", "4096", "--hostname", "127.0.0.1")
  $envArgs = ""
  if ($SkipPermissions) {
    Write-Host "Включен режим автоматического подтверждения команд (--dangerously-skip-permissions)"
    $serveArgs += "--dangerously-skip-permissions"
    $envArgs = "--dangerously-skip-permissions"
  }

  Write-Host "Запускаю opencode serve..."
  $null = New-Item -ItemType Directory -Path $LogDir -Force
  Start-Process -WindowStyle Hidden -FilePath "powershell.exe" `
    -ArgumentList $serveArgs `
    -RedirectStandardOutput "$LogDir\serve.log" `
    -RedirectStandardError "$LogDir\serve-error.log"
  Write-Host "Ожидаю запуск сервера..."
  Start-Sleep -Seconds 4
  
  # Сохраняем аргументы сервера для отображения в боте
  $env:OPENCODE_SERVER_ARGS = $envArgs
}

Set-Location $ProjectDir
Write-Host "Запускаю Telegram бота..."
node src/index.js
