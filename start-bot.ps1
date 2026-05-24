param(
  [switch]$NoServe
)

$ProjectDir = "D:\www\ai\remote_ai"
$LogDir = "$env:LOCALAPPDATA\opencode\log"

if (-not $NoServe) {
  $serving = Get-Process -Name "opencode" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match "serve" }

  if (-not $serving) {
    Write-Host "Запускаю opencode serve..."
    $null = New-Item -ItemType Directory -Path $LogDir -Force
    Start-Process -NoNewWindow -FilePath "opencode" `
      -ArgumentList "serve", "--port", "4096", "--hostname", "127.0.0.1" `
      -RedirectStandardOutput "$LogDir\serve.log" `
      -RedirectStandardError "$LogDir\serve-error.log"
    Write-Host "Ожидаю запуск сервера..."
    Start-Sleep -Seconds 3
  } else {
    Write-Host "opencode serve уже запущен"
  }
}

Set-Location $ProjectDir
Write-Host "Запускаю Telegram бота..."
node src/index.js
