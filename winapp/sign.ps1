# Authenticode-signs the given files, so Windows SmartScreen trusts the download.
#   ./winapp/sign.ps1 winapp/dist/Harmonia.exe winapp/dist/harmonia-server.exe
# Needs two repository secrets (Settings > Secrets and variables > Actions):
#   WINDOWS_CERT_PFX_BASE64   a code-signing certificate (.pfx), base64:  [Convert]::ToBase64String([IO.File]::ReadAllBytes("cert.pfx"))
#   WINDOWS_CERT_PASSWORD     its password
# Without them this does nothing and the build stays unsigned (SmartScreen warns on first run until it builds reputation).
param([Parameter(ValueFromRemainingArguments = $true)] [string[]] $Files)
$ErrorActionPreference = "Stop"
if (-not $env:WINDOWS_CERT_PFX_BASE64 -or -not $env:WINDOWS_CERT_PASSWORD) {
  Write-Host "No signing certificate configured; leaving $($Files -join ', ') unsigned."
  return
}
$signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" -ErrorAction SilentlyContinue |
  Sort-Object FullName -Descending | Select-Object -First 1
if (-not $signtool) { throw "signtool.exe not found (needs the Windows SDK)" }
$pfx = Join-Path ([IO.Path]::GetTempPath()) "harmonia-sign.pfx"
[IO.File]::WriteAllBytes($pfx, [Convert]::FromBase64String($env:WINDOWS_CERT_PFX_BASE64))
try {
  foreach ($f in $Files) {
    & $signtool.FullName sign /f $pfx /p $env:WINDOWS_CERT_PASSWORD /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /d "Harmonia" $f
    if ($LASTEXITCODE) { throw "signing $f failed" }
  }
} finally { Remove-Item $pfx -Force -ErrorAction SilentlyContinue }
