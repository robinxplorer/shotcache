# Protocol-level self test for shotcache-host.exe v2 — no Chrome required.
# Exercises the resident-host protocol:
#   {"cmd":"hello"}                    -> {"type":"hello","version":2}
#   {"cmd":"capture","headless":true}  -> shot-meta / shot-chunk*N / shot-done
# then verifies the reassembled payload is a real PNG matching the meta.
# Headless capture skips the overlay UI and the clipboard, so this is safe to
# run while you work. Noise frames are tolerated: ping (20s keepalive),
# hotkey-failed (Chrome's resident instance may already own Ctrl+Alt+A), and
# spooled shots flushed on hello (marked "spool":true).
# Usage: powershell -ExecutionPolicy Bypass -File test-host.ps1
$ErrorActionPreference = 'Stop'

$exe = Join-Path $PSScriptRoot 'shotcache-host.exe'
if (-not (Test-Path $exe)) { throw "未找到 $exe —— 先运行 install.ps1（或手动用 csc 编译三个 .cs）" }

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $exe
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$p = [System.Diagnostics.Process]::Start($psi)

function Read-Frame([System.IO.Stream]$s) {
  $head = New-Object byte[] 4
  $off = 0
  while ($off -lt 4) {
    $n = $s.Read($head, $off, 4 - $off)
    if ($n -le 0) { throw 'stream closed before frame header' }
    $off += $n
  }
  $len = [BitConverter]::ToInt32($head, 0)
  $buf = New-Object byte[] $len
  $off = 0
  while ($off -lt $len) {
    $n = $s.Read($buf, $off, $len - $off)
    if ($n -le 0) { throw 'stream closed mid-frame' }
    $off += $n
  }
  [System.Text.Encoding]::UTF8.GetString($buf) | ConvertFrom-Json
}

function Read-NonPing([System.IO.Stream]$s) {
  while ($true) {
    $m = Read-Frame $s
    if ($m.type -ne 'ping') { return $m }
  }
}

# Skip hotkey-failed and whole spooled-shot sequences as well.
function Read-Interesting([System.IO.Stream]$s) {
  while ($true) {
    $m = Read-NonPing $s
    if ($m.type -eq 'hotkey-failed') { continue }
    if ($m.type -eq 'shot-meta' -and $m.spool) {
      do { $x = Read-NonPing $s } while ($x.type -ne 'shot-done')
      continue
    }
    return $m
  }
}

$in = $p.StandardInput.BaseStream
$out = $p.StandardOutput.BaseStream

function Send-Cmd([string]$json) {
  $b = [System.Text.Encoding]::UTF8.GetBytes($json)
  $in.Write([BitConverter]::GetBytes($b.Length), 0, 4)
  $in.Write($b, 0, $b.Length)
  $in.Flush()
}

# 1) hello handshake
Send-Cmd '{"cmd":"hello"}'
$hello = Read-Interesting $out
if ($hello.type -eq 'error') { throw "host 是 v1（回了 error: $($hello.message)）—— 重新运行 install.ps1 升级" }
if ($hello.type -ne 'hello') { throw "expected hello, got $($hello.type)" }
if ($hello.version -lt 2) { throw "host version $($hello.version) < 2" }

# 2) emoji-sheet is accepted silently (cosmetic command, no reply expected);
#    the capture below succeeding proves the host survived the parse.
Add-Type -AssemblyName System.Drawing
$px = New-Object System.Drawing.Bitmap(1, 1)
$pms = New-Object System.IO.MemoryStream
$px.Save($pms, [System.Drawing.Imaging.ImageFormat]::Png)
$pxB64 = [Convert]::ToBase64String($pms.ToArray())
$px.Dispose(); $pms.Dispose()
Send-Cmd ('{"cmd":"emoji-sheet","entries":[{"ch":"T","data":"' + $pxB64 + '"}]}')

# 3) headless capture (no overlay, no clipboard)
Send-Cmd '{"cmd":"capture","headless":true}'
$meta = Read-Interesting $out
if ($meta.type -eq 'error') { throw "host error: $($meta.message)" }
if ($meta.type -ne 'shot-meta') { throw "expected shot-meta, got $($meta.type)" }
if ($meta.width -le 0 -or $meta.height -le 0) { throw "bad meta size $($meta.width)x$($meta.height)" }

$sb = New-Object System.Text.StringBuilder
for ($i = 0; $i -lt $meta.chunks; $i++) {
  $c = Read-NonPing $out
  if ($c.type -ne 'shot-chunk' -or $c.seq -ne $i) { throw "bad chunk at index $i (type=$($c.type) seq=$($c.seq))" }
  [void]$sb.Append($c.data)
}
$done = Read-NonPing $out
if ($done.type -ne 'shot-done') { throw "expected shot-done, got $($done.type)" }

# 3) stdin EOF -> resident host exits
$in.Close()

# 4) payload verification: PNG magic + decodable + dimensions match meta
$bytes = [Convert]::FromBase64String($sb.ToString())
if ($bytes.Length -lt 8 -or $bytes[0] -ne 0x89 -or $bytes[1] -ne 0x50 -or $bytes[2] -ne 0x4E -or $bytes[3] -ne 0x47) {
  throw 'payload is not a PNG'
}
Add-Type -AssemblyName System.Drawing
$ms = New-Object System.IO.MemoryStream(, $bytes)
$img = [System.Drawing.Image]::FromStream($ms)
if ($img.Width -ne $meta.width -or $img.Height -ne $meta.height) {
  throw "size mismatch: meta $($meta.width)x$($meta.height) vs png $($img.Width)x$($img.Height)"
}
Write-Output "PASS v2: $($meta.width)x$($meta.height), $($meta.chunks) chunks, $([math]::Round($bytes.Length / 1MB, 2)) MB PNG"
$img.Dispose(); $ms.Dispose()
if (-not $p.WaitForExit(3000)) { $p.Kill(); throw 'host did not exit on stdin EOF' }

# 5) long-screenshot stitching math (synthetic frames, no UI, no scrolling)
$cscCandidates = @(
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$csc = $cscCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $csc) { throw '未找到 csc.exe，无法编译拼接自测' }
$stitchExe = Join-Path $env:TEMP 'shotcache-stitch-test.exe'
& $csc /nologo /out:"$stitchExe" /r:System.Drawing.dll /r:System.Windows.Forms.dll `
  (Join-Path $PSScriptRoot 'longshot.cs') (Join-Path $PSScriptRoot 'stitch-test.cs')
if ($LASTEXITCODE -ne 0) { throw '拼接自测编译失败' }
& $stitchExe
if ($LASTEXITCODE -ne 0) { throw '拼接自测失败' }
