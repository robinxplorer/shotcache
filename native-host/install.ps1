# Installs the Shotcache native capture host for the current user (no admin).
# Usage:
#   powershell -ExecutionPolicy Bypass -File install.ps1 -ExtensionId <32位扩展ID>
# 扩展 ID 在 chrome://extensions（开发者模式）的「截存」卡片上，形如 abcdefghijklmnopabcdefghijklmnop。
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-p]{32}$')]
  [string]$ExtensionId
)
$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot

# The C# compiler that ships with every Windows 10/11 (.NET Framework 4.x).
$cscCandidates = @(
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$csc = $cscCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $csc) { throw '未找到 Windows 自带的 csc.exe（.NET Framework 4.x）' }

# Compile locally — no shipped binaries, the source is right here to audit.
# A resident instance is usually running AND the extension reconnects within
# ~1s of a kill, so compiling straight onto the exe races a respawned lock.
# Instead: build to a temp name, rename the (possibly running) old exe away
# — NTFS allows renaming a mapped image — swap the new one in, then kill any
# instance still running off the old image; Chrome respawns onto the new exe.
$exe = Join-Path $dir 'shotcache-host.exe'
Get-ChildItem -Path "$exe.old-*" -ErrorAction SilentlyContinue |
  Remove-Item -Force -ErrorAction SilentlyContinue   # stale images from prior installs
$sources = @('host.cs', 'overlay.cs', 'annotate.cs', 'longshot.cs') | ForEach-Object { Join-Path $dir $_ }
& $csc /nologo /out:"$exe.new" /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll $sources
if ($LASTEXITCODE -ne 0) { throw 'native host 编译失败' }
if (Test-Path $exe) {
  try { Remove-Item $exe -Force -ErrorAction Stop }
  catch { Rename-Item $exe ($exe + '.old-' + (Get-Random)) }
}
Move-Item "$exe.new" $exe -Force
Get-Process -Name 'shotcache-host' -ErrorAction SilentlyContinue |
  Stop-Process -Force -ErrorAction SilentlyContinue

# Native messaging host manifest; allowed_origins pins it to this extension.
$manifestPath = Join-Path $dir 'com.shotcache.capture.json'
$manifest = [ordered]@{
  name            = 'com.shotcache.capture'
  description     = 'Shotcache desktop capture host'
  path            = $exe
  type            = 'stdio'
  allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json
[System.IO.File]::WriteAllText($manifestPath, $manifest, (New-Object System.Text.UTF8Encoding($false)))

# Register for Chrome (per-user key, takes effect immediately — no restart).
$key = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.shotcache.capture'
New-Item -Path $key -Force | Out-Null
Set-Item -Path $key -Value $manifestPath

Write-Output "已编译：$exe"
Write-Output "已注册：$key"
Write-Output '完成。在 chrome://extensions 重新加载扩展后即可无弹窗全屏截图。'
Write-Output '排障自测：powershell -ExecutionPolicy Bypass -File test-host.ps1'
