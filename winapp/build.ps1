# Builds the Windows app into winapp/dist: Harmonia.exe (the window) + harmonia-server.exe + the WebView2 DLLs + build.json.
# HARMONIA_VERSION=1.2.3 marks it as a release (the release workflow does).
# Needs bun. Uses the .NET Framework compiler that ships with Windows; fetches the WebView2 NuGet package if missing.
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot; $root = Split-Path $here
$v = "1.0.1823.32"
$pk = "$env:USERPROFILE\.nuget\packages\microsoft.web.webview2\$v"
if (-not (Test-Path $pk)) {
  $z = "$env:TEMP\webview2.zip"
  Invoke-WebRequest "https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/$v" -OutFile $z
  Expand-Archive $z $pk -Force
}
Push-Location $root; bun run build:windows; Pop-Location
$dist = "$here\dist"; New-Item -ItemType Directory -Force $dist | Out-Null
$lib = "$pk\lib\net45"
& "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:winexe /out:$dist\Harmonia.exe `
  /win32icon:$here\assets\harmonia.ico /win32manifest:$here\app.manifest `
  /r:$lib\Microsoft.Web.WebView2.Core.dll /r:$lib\Microsoft.Web.WebView2.WinForms.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll $here\Program.cs
if ($LASTEXITCODE) { throw "compile failed" }
Copy-Item "$lib\Microsoft.Web.WebView2.Core.dll", "$lib\Microsoft.Web.WebView2.WinForms.dll", "$pk\runtimes\win-x64\native\WebView2Loader.dll", "$root\build\windows\harmonia-server.exe" $dist -Force
# What this build is, for over-the-air updates (updates.ts): its release version (empty for a local build, which any
# release then replaces), commit, and the repo and branch to follow.
$git = { param($a) $o = & git -C $root @a 2>$null; if ($LASTEXITCODE) { "" } else { "$o".Trim() } }
$repo = if ($env:HARMONIA_REPO) { $env:HARMONIA_REPO } else { & $git @("remote", "get-url", "origin") }
$branch = if ($env:HARMONIA_BRANCH) { $env:HARMONIA_BRANCH } else { & $git @("rev-parse", "--abbrev-ref", "HEAD") }
$info = [ordered]@{
  version = "$env:HARMONIA_VERSION"; commit = (& $git @("rev-parse", "HEAD")); branch = $branch; repo = $repo
  dirty = [bool](& $git @("status", "--porcelain")); arch = "x64"; builtAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
}
[IO.File]::WriteAllText("$dist\build.json", ($info | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding $false))
"built $dist"
