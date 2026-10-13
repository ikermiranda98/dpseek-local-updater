# Volver a la versión anterior de DeepSeek Harness local (dpseek-local-updater).
#
# Descarga el instalador de un Release anterior, comprueba su sha512, lo instala
# y anota la versión retirada para que la app no la vuelva a ofrecer (sí la
# siguiente que se publique). Tus chats y ajustes (%USERPROFILE%\.dsh) no se tocan.
#
# Uso: clic derecho → «Ejecutar con PowerShell», o:
#   powershell -ExecutionPolicy Bypass -File volver-a-version-anterior.ps1
#   (con -Probar solo descarga y comprueba el instalador, sin instalar nada)

param([switch]$Probar, [int]$Numero = 0)

$ErrorActionPreference = 'Stop'
$app = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness'
$feedFile = Join-Path $app 'resources\app-update.yml'
if (-not (Test-Path $feedFile)) { throw "No se encuentra la app instalada en $app" }

# El repositorio sale de la propia app: url: https://github.com/<usuario>/<repo>/releases/latest/download
$url = (Get-Content $feedFile | Where-Object { $_ -match '^url:' }) -replace '^url:\s*', ''
if ($url -notmatch '^https://github\.com/([^/]+/[^/]+)/releases/') { throw "La app no se actualiza desde GitHub ($url)" }
$repo = $Matches[1]

$installed = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' |
  Where-Object { $_.DisplayName -like 'DeepSeek Harness*' } | Select-Object -First 1).DisplayVersion
Write-Host "Versión instalada: $installed"

$releases = Invoke-RestMethod "https://api.github.com/repos/$repo/releases?per_page=30" -Headers @{ 'User-Agent' = 'dpseek-local-updater' }
$candidates = @($releases | Where-Object { -not $_.draft } | ForEach-Object {
  $feed = $_.assets | Where-Object { $_.name -eq 'nightly.yml' }
  $exe = $_.assets | Where-Object { $_.name -like '*.exe' } | Select-Object -First 1
  if ($feed -and $exe) {
    $content = (Invoke-WebRequest $feed.browser_download_url -UseBasicParsing).Content
    # PowerShell 5 lo devuelve como bytes (el servidor lo envía como binario).
    $yml = if ($content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($content) } else { [string]$content }
    [pscustomobject]@{
      Tag = $_.tag_name; Fecha = $_.published_at; Exe = $exe
      Version = ([regex]::Match($yml, '(?m)^version:\s*(\S+)')).Groups[1].Value
      Sha512 = ([regex]::Match($yml, '(?m)^sha512:\s*(\S+)')).Groups[1].Value
    }
  }
})
$older = @($candidates | Where-Object { $_.Version -ne $installed })
if ($older.Count -eq 0) { throw 'No hay versiones anteriores publicadas.' }

Write-Host "`nVersiones publicadas (la primera es la más reciente; la instalada no aparece):"
for ($i = 0; $i -lt $older.Count; $i++) { Write-Host ("  [{0}] {1}  ({2})" -f ($i + 1), $older[$i].Tag, $older[$i].Version) }
$choice = if ($Numero -gt 0) { [string]$Numero } else { Read-Host "`nNúmero de la versión a instalar (Intro = 1)" }
if ([string]::IsNullOrWhiteSpace($choice)) { $choice = '1' }
$target = $older[[int]$choice - 1]
if (-not $target) { throw 'Número no válido.' }

if (-not $Probar -and (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)) {
  Read-Host 'Cierra DeepSeek Harness (todas sus ventanas) y pulsa Intro'
  if (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue) { throw 'La app sigue abierta; no se instala nada.' }
}

$tmp = Join-Path $env:TEMP "dsh-$($target.Tag).exe"
Write-Host "Descargando $($target.Exe.name)…"
Invoke-WebRequest $target.Exe.browser_download_url -OutFile $tmp -UseBasicParsing
$sha = [Convert]::ToBase64String([Security.Cryptography.SHA512]::Create().ComputeHash([IO.File]::ReadAllBytes($tmp)))
if ($sha -ne $target.Sha512) { Remove-Item $tmp; throw 'El instalador descargado no coincide con el publicado; no se instala.' }

if ($Probar) { Remove-Item $tmp; Write-Host "Prueba correcta: $($target.Tag) se descarga y su sha512 coincide. No se ha instalado nada."; return }

# La versión de la que se vuelve no se volverá a ofrecer.
$storages = Join-Path $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }) 'storages'
New-Item -ItemType Directory -Force $storages | Out-Null
Set-Content -Path (Join-Path $storages 'local-saltar-version.txt') -Value $installed -Encoding ascii

Write-Host 'Instalando…'
$p = Start-Process $tmp -ArgumentList '/S' -Wait -PassThru
Remove-Item $tmp -ErrorAction SilentlyContinue
if ($p.ExitCode -ne 0) { throw "El instalador ha terminado con código $($p.ExitCode)" }
Write-Host "`nListo: instalada $($target.Tag). La app no volverá a ofrecer la $installed."
Read-Host 'Pulsa Intro para cerrar'
