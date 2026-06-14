# Removes the Shotcache native capture host (registry key + build outputs).
$ErrorActionPreference = 'Stop'
# The v2 host is resident while Chrome runs — stop it before deleting the exe.
Get-Process -Name 'shotcache-host' -ErrorAction SilentlyContinue |
  Stop-Process -Force -ErrorAction SilentlyContinue
$key = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.shotcache.capture'
if (Test-Path $key) {
  Remove-Item -Path $key -Force
  Write-Output "已删除注册表键 $key"
}
foreach ($f in 'shotcache-host.exe', 'com.shotcache.capture.json') {
  $p = Join-Path $PSScriptRoot $f
  if (Test-Path $p) {
    Remove-Item $p -Force
    Write-Output "已删除 $p"
  }
}
Write-Output '卸载完成（host.cs 源文件保留）。'
