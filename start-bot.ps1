param(
  [switch]$NoServe,
  [switch]$SkipPermissions
)

# Тонкая обёртка над Node-супервизором (scripts/start.js).
# Сохранена для совместимости со старыми ярлыками; вся логика — в Node.
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Supervisor = Join-Path $ScriptDir "scripts\start.js"

$nodeArgs = @($Supervisor)
if ($NoServe)         { $nodeArgs += "--no-serve" }
if ($SkipPermissions) { $nodeArgs += "--skip-permissions" }

Write-Host "Запускаю node $($nodeArgs -join ' ')"
Set-Location $ScriptDir
& node @nodeArgs
exit $LASTEXITCODE
