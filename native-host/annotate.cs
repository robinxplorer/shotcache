// Annotation model + GDI+ rendering for the capture overlay.
//
// Shared by two consumers with one Paint() so preview and final output can
// never drift apart:
//  - OverlayForm draws ops live over the frozen screenshot (dx=dy=0);
//  - Compose() burns the same ops into the cropped result, translated by
//    the selection origin (-sel.X, -sel.Y).
// Style (color / stroke / font size / mosaic cell / emoji size) is stamped
// onto each op at creation time, so changing the style bar never repaints
// what's already drawn and undo stays a plain list pop.
// Mosaic always samples the FROZEN full-screen image (never the composited
// surface), so stacking a mosaic over other annotations does not pixelate
// them — same rule as the browser editor's basePixels cache.
//
// Color emoji: neither GDI+ nor .NET Framework WPF can rasterize COLR fonts
// (verified on this machine — WPF TextBlock renders Segoe UI Emoji
// monochrome). The extension renders the emoji set on a Chrome canvas and
// ships the PNGs over the port ({"cmd":"emoji-sheet"}); EmojiRenderer caches
// those and scales per placement, with a monochrome GDI+ outline as the
// last-resort fallback.
//
// Compiled by the Windows-shipped csc.exe (.NET Framework 4.x) — keep this
// file C# 5 compatible: no interpolation, no null-conditional operators.

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;

namespace Shotcache
{
    public enum AnnoTool { Rect, Ellipse, Arrow, Text, Mosaic, Emoji }

    public class AnnoOp
    {
        public AnnoTool Tool;
        public int X1, Y1, X2, Y2; // screen-bitmap coordinates (virtual screen)
        public string Text;        // Text payload, or the emoji character
        public int Argb;           // color (0 = legacy default accent)
        public int Stroke;         // stroke width, px
        public float FontPx;       // text size, px
        public int Cell;           // mosaic cell, px
        public int EmojiPx;        // emoji edge, px
    }

    /// One LockBits copy of the frozen screenshot; CellColor is then O(1)
    /// per cell, which keeps mosaic drag-previews smooth on large screens.
    public class MosaicSampler : IDisposable
    {
        readonly byte[] px;
        readonly int w, h, stride;

        public MosaicSampler(Bitmap frozen)
        {
            w = frozen.Width;
            h = frozen.Height;
            BitmapData d = frozen.LockBits(
                new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            try
            {
                stride = d.Stride;
                px = new byte[stride * h];
                System.Runtime.InteropServices.Marshal.Copy(d.Scan0, px, 0, px.Length);
            }
            finally
            {
                frozen.UnlockBits(d);
            }
        }

        public Color CellColor(int x, int y)
        {
            if (x < 0) x = 0;
            if (x >= w) x = w - 1;
            if (y < 0) y = 0;
            if (y >= h) y = h - 1;
            int o = y * stride + x * 4; // BGRA
            return Color.FromArgb(px[o + 2], px[o + 1], px[o]);
        }

        public void Dispose() { }
    }

    public static class Annotator
    {
        /// Same accent as the browser editor (#ff4d4f).
        public static readonly Color Accent = Color.FromArgb(255, 0xFF, 0x4D, 0x4F);

        /// Draw every op translated by (dx, dy). Mosaic sampling uses the
        /// untranslated coordinates — it reads the frozen full-screen image.
        public static void Paint(Graphics g, IList<AnnoOp> ops, MosaicSampler sampler, int dx, int dy)
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.AntiAlias;
            for (int i = 0; i < ops.Count; i++)
            {
                AnnoOp op = ops[i];
                if (op == null) continue;
                Color color = op.Argb != 0 ? Color.FromArgb(op.Argb) : Accent;
                int stroke = op.Stroke > 0 ? op.Stroke : 3;
                int x = Math.Min(op.X1, op.X2);
                int y = Math.Min(op.Y1, op.Y2);
                int w = Math.Abs(op.X2 - op.X1);
                int h = Math.Abs(op.Y2 - op.Y1);
                switch (op.Tool)
                {
                    case AnnoTool.Rect:
                        using (Pen pen = new Pen(color, stroke))
                            g.DrawRectangle(pen, x + dx, y + dy, w, h);
                        break;
                    case AnnoTool.Ellipse:
                        using (Pen pen = new Pen(color, stroke))
                            g.DrawEllipse(pen, x + dx, y + dy, Math.Max(1, w), Math.Max(1, h));
                        break;
                    case AnnoTool.Arrow:
                        using (Pen pen = new Pen(color, stroke))
                        using (Brush brush = new SolidBrush(color))
                            PaintArrow(g, pen, brush, op.X1 + dx, op.Y1 + dy, op.X2 + dx, op.Y2 + dy, stroke);
                        break;
                    case AnnoTool.Text:
                        if (!string.IsNullOrEmpty(op.Text))
                        {
                            float fpx = op.FontPx > 0 ? op.FontPx : 20f;
                            using (Font font = new Font("Microsoft YaHei UI", fpx, FontStyle.Regular, GraphicsUnit.Pixel))
                            using (Brush brush = new SolidBrush(color))
                                g.DrawString(op.Text, font, brush, op.X1 + dx, op.Y1 + dy);
                        }
                        break;
                    case AnnoTool.Mosaic:
                        PaintMosaic(g, sampler, x, y, w, h, op.Cell > 0 ? op.Cell : 12, dx, dy);
                        break;
                    case AnnoTool.Emoji:
                        PaintEmoji(g, op, dx, dy);
                        break;
                }
            }
        }

        static void PaintArrow(Graphics g, Pen pen, Brush brush,
                               int x1, int y1, int x2, int y2, int lineWidth)
        {
            double head = Math.Max(10, lineWidth * 4);
            double angle = Math.Atan2(y2 - y1, x2 - x1);
            g.DrawLine(pen, x1, y1, x2, y2);
            PointF[] tri = new PointF[]
            {
                new PointF(x2, y2),
                new PointF((float)(x2 - head * Math.Cos(angle - Math.PI / 6)),
                           (float)(y2 - head * Math.Sin(angle - Math.PI / 6))),
                new PointF((float)(x2 - head * Math.Cos(angle + Math.PI / 6)),
                           (float)(y2 - head * Math.Sin(angle + Math.PI / 6))),
            };
            g.FillPolygon(brush, tri);
        }

        static void PaintMosaic(Graphics g, MosaicSampler sampler,
                                int x, int y, int w, int h, int cell, int dx, int dy)
        {
            if (sampler == null || w <= 0 || h <= 0) return;
            // Anti-aliased fills leave hairline seams between cells.
            SmoothingMode prev = g.SmoothingMode;
            g.SmoothingMode = SmoothingMode.None;
            using (SolidBrush b = new SolidBrush(Color.Black))
            {
                for (int py = y; py < y + h; py += cell)
                {
                    for (int qx = x; qx < x + w; qx += cell)
                    {
                        int cw = Math.Min(cell, x + w - qx);
                        int ch = Math.Min(cell, y + h - py);
                        b.Color = sampler.CellColor(qx, py);
                        g.FillRectangle(b, qx + dx, py + dy, cw, ch);
                    }
                }
            }
            g.SmoothingMode = prev;
        }

        static void PaintEmoji(Graphics g, AnnoOp op, int dx, int dy)
        {
            if (string.IsNullOrEmpty(op.Text)) return;
            int px = op.EmojiPx > 0 ? op.EmojiPx : 36;
            Bitmap bmp = EmojiRenderer.Get(op.Text, px);
            if (bmp != null)
            {
                g.DrawImage(bmp, op.X1 + dx, op.Y1 + dy, bmp.Width, bmp.Height);
                return;
            }
            // Monochrome last resort — at least the shape lands.
            using (Font font = new Font("Segoe UI Emoji", px, FontStyle.Regular, GraphicsUnit.Pixel))
            using (Brush brush = new SolidBrush(Color.Black))
                g.DrawString(op.Text, font, brush, op.X1 + dx, op.Y1 + dy);
        }

        /// Crop the frozen screenshot to sel and burn the ops in.
        /// Caller owns (disposes) the returned bitmap.
        public static Bitmap Compose(Bitmap frozen, Rectangle sel, IList<AnnoOp> ops, MosaicSampler sampler)
        {
            Bitmap outBmp = new Bitmap(sel.Width, sel.Height, PixelFormat.Format32bppArgb);
            using (Graphics g = Graphics.FromImage(outBmp))
            {
                g.DrawImage(frozen, new Rectangle(0, 0, sel.Width, sel.Height), sel, GraphicsUnit.Pixel);
                Paint(g, ops, sampler, -sel.X, -sel.Y);
            }
            return outBmp;
        }
    }

    /// Holds the color emoji glyphs shipped by the extension (64px PNGs,
    /// rendered on a Chrome canvas) and serves per-size scaled copies.
    /// All access happens on the UI thread (command dispatch + paint), so no
    /// locking is needed. Get() returns null until the sheet has arrived —
    /// callers fall back to a monochrome GDI+ outline.
    public static class EmojiRenderer
    {
        static readonly Dictionary<string, Bitmap> source = new Dictionary<string, Bitmap>();
        static readonly Dictionary<string, Bitmap> scaled = new Dictionary<string, Bitmap>();

        public static void SetGlyph(string emoji, Bitmap bmp)
        {
            if (string.IsNullOrEmpty(emoji) || bmp == null) return;
            Bitmap old;
            if (source.TryGetValue(emoji, out old) && old != null) old.Dispose();
            source[emoji] = bmp;
            // Cheap and safe: drop every scaled copy when the sheet updates.
            foreach (KeyValuePair<string, Bitmap> kv in scaled)
                if (kv.Value != null) kv.Value.Dispose();
            scaled.Clear();
        }

        public static Bitmap Get(string emoji, int px)
        {
            if (string.IsNullOrEmpty(emoji) || px <= 0) return null;
            string key = emoji + "@" + px;
            Bitmap hit;
            if (scaled.TryGetValue(key, out hit)) return hit;
            Bitmap src;
            if (!source.TryGetValue(emoji, out src) || src == null)
                return null; // no sheet yet — do NOT cache, it may still arrive
            Bitmap dst = new Bitmap(px, px, PixelFormat.Format32bppArgb);
            using (Graphics g = Graphics.FromImage(dst))
            {
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.DrawImage(src, new Rectangle(0, 0, px, px));
            }
            scaled[key] = dst;
            return dst;
        }
    }
}
