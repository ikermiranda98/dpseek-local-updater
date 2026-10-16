# Abre la app de desarrollo con la ultima version: la ultima de DeepSeek mas los cambios
# de este repositorio (los mismos pasos que la compilacion de GitHub).
#
# Si la version de DeepSeek o los cambios de este repositorio han cambiado desde la ultima
# vez, deja la copia de trabajo en la version oficial limpia, aplica los cambios, instala
# las dependencias y genera los tipos. Si no, la abre directamente. Usa sus propios datos
# (no los de la app instalada).
#
# Ojo: al prepararla, la copia de trabajo se limpia (git checkout -f y git clean -fd); lo
# que se haya tocado a mano en ella se pierde.
param(
  [string]$Copia = 'C:\dsh3',
  [string]$Datos = (Join-Path $env:LOCALAPPDATA 'dpseek-local-dev')
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$oficial = 'https://github.com/deepseek-ai/deepseek-harness.git'
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')

function Paso([string]$texto) { Write-Host "`n== $texto" -ForegroundColor Cyan }

# Ultima version de DeepSeek (como la compilacion de GitHub); sin red, la que ya hay.
$actual = (git -C $Copia describe --tags --exact-match 2>$null)
$etiqueta = $actual
try {
  $version = (Invoke-RestMethod 'https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/HEAD/apps/desktop/package.json' -TimeoutSec 10).version
  $candidata = "dsh-v$version"
  git ls-remote --exit-code --tags $oficial "refs/tags/$candidata" *> $null
  if ($LASTEXITCODE -eq 0) { $etiqueta = $candidata }
} catch {
  Write-Host "Sin conexion con GitHub: se usa $actual" -ForegroundColor Yellow
}
if (-not $etiqueta) { throw "No se sabe que version de DeepSeek usar (sin red y $Copia sin etiqueta)" }

# Cambios de este repositorio: el commit y lo que haya sin guardar en sistema/ y config.json.
$commit = (git -C $repo rev-parse HEAD)
$pendiente = (git -C $repo diff HEAD -- sistema config.json | Out-String)
$sello = "$etiqueta|$commit|" + [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($pendiente)))
$ficheroSello = Join-Path $Copia '.dsh-local-sello'
$anterior = if (Test-Path $ficheroSello) { Get-Content $ficheroSello -Raw } else { '' }

if ($anterior.Trim() -ne $sello) {
  Paso "Preparando $Copia con $etiqueta y los cambios de $($commit.Substring(0, 7))"
  git -C $Copia fetch origin tag $etiqueta --no-tags
  if ($LASTEXITCODE) { throw 'git fetch ha fallado' }
  git -C $Copia checkout -q -f $etiqueta
  git -C $Copia clean -fdq
  Paso 'Aplicando los cambios'
  node (Join-Path $repo 'sistema\aplicar-cambios.mjs') $Copia
  if ($LASTEXITCODE) { throw 'aplicar-cambios ha fallado' }
  Copy-Item (Join-Path $repo 'sistema\env.windows') (Join-Path $Copia 'apps\desktop\.env.windows') -Force
  Push-Location $Copia
  try {
    Paso 'Instalando dependencias'
    corepack pnpm install --frozen-lockfile
    if ($LASTEXITCODE) { throw 'pnpm install ha fallado' }
    Paso 'Generando tipos'
    npx tsx scripts/generate-typert.ts
    if ($LASTEXITCODE) { throw 'generate-typert ha fallado' }
  } finally { Pop-Location }
  Set-Content -Path $ficheroSello -Value $sello -Encoding ascii
} else {
  Write-Host "$Copia ya tiene $etiqueta y los cambios de $($commit.Substring(0, 7))"
}

Paso 'Abriendo la app de desarrollo (cerrar esta ventana la cierra)'
$env:DSH_HOME = Join-Path $Datos 'home'
$env:DSH_DESKTOP_USER_DATA_DIR = Join-Path $Datos 'user-data'
$env:DSH_LOCAL_SIN_AYUDANTES = '1'
$env:DSH_DESKTOP_OPEN_DEVTOOLS = '0'
New-Item -ItemType Directory -Force $env:DSH_HOME | Out-Null
Set-Location $Copia
corepack pnpm run dev:desktop
