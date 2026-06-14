# Regenerates the extension icon (public/icon/{16,32,48,128}.png) so its colours
# track the app theme. The brand mark is a white "capture frame" (four rounded
# corner brackets + a centre dot) on the Ink + Violet accent gradient — matching
# popup/style.css --accent (#8b7cf0) / --accent-strong (#6f5ae8). No SVG toolchain
# on Windows, so we draw it with GDI+ (the same stack the native host renders with).
#
#   powershell -ExecutionPolicy Bypass -File scripts\gen-icon.ps1
#
# Renders one antialiased master and downscales it to each size. Also refreshes
# .output\chrome-mv3\icon when a build is present, so a reloaded unpacked
# extension shows the new icon without a full rebuild.

Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'

$S = 512  # master render size; the shipped sizes are downscaled from this

function New-RoundedRectPath([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

function Draw-Corner($g, $pen, [single]$cx, [single]$cy, [single]$hx, [single]$vy) {
  # L-bracket: horizontal endpoint -> corner -> vertical endpoint (round cap/join).
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddLine($hx, $cy, $cx, $cy)
  $path.AddLine($cx, $cy, $cx, $vy)
  $g.DrawPath($pen, $path)
  $path.Dispose()
}

$master = New-Object System.Drawing.Bitmap($S, $S, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($master)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.Clear([System.Drawing.Color]::Transparent)

# Card: violet gradient rounded square (full bleed), light top-left -> deep bottom-right.
$r = [single]($S * 0.225)
$card = New-RoundedRectPath 0 0 $S $S $r
$c1 = [System.Drawing.Color]::FromArgb(255, 0x96, 0x85, 0xF5)  # light violet
$c2 = [System.Drawing.Color]::FromArgb(255, 0x6A, 0x54, 0xE6)  # accent-strong
$rect = New-Object System.Drawing.RectangleF(0, 0, $S, $S)
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $c1, $c2, [single]45)
$g.FillPath($brush, $card)

# Glyph: white capture frame — four corner brackets + a centre dot.
$white = [System.Drawing.Color]::White
$side = [single]($S * 0.44)
$left = [single](($S - $side) / 2)
$top = $left
$right = [single]($left + $side)
$bottom = [single]($top + $side)
$arm = [single]($side * 0.32)
$t = [single]($S * 0.073)

$pen = New-Object System.Drawing.Pen($white, $t)
$pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

Draw-Corner $g $pen $left  $top    ($left + $arm)  ($top + $arm)
Draw-Corner $g $pen $right $top    ($right - $arm) ($top + $arm)
Draw-Corner $g $pen $right $bottom ($right - $arm) ($bottom - $arm)
Draw-Corner $g $pen $left  $bottom ($left + $arm)  ($bottom - $arm)

$dot = [single]($S * 0.135)
$dx = [single](($S - $dot) / 2)
$dotPath = New-RoundedRectPath $dx $dx $dot $dot ([single]($dot * 0.28))
$wb = New-Object System.Drawing.SolidBrush($white)
$g.FillPath($wb, $dotPath)
$g.Dispose()

# Export downscaled PNGs into public/icon and (if present) the build output.
$root = Split-Path -Parent $PSScriptRoot
$targets = @((Join-Path $root 'public\icon'))
$built = Join-Path $root '.output\chrome-mv3\icon'
if (Test-Path $built) { $targets += $built }

foreach ($size in 16, 32, 48, 128) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $bg = [System.Drawing.Graphics]::FromImage($bmp)
  $bg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $bg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $bg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $bg.Clear([System.Drawing.Color]::Transparent)
  $bg.DrawImage($master, (New-Object System.Drawing.Rectangle(0, 0, $size, $size)))
  $bg.Dispose()
  foreach ($dir in $targets) {
    $path = Join-Path $dir ("{0}.png" -f $size)
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Host ("wrote {0}" -f $path)
  }
  $bmp.Dispose()
}
$master.Dispose()
