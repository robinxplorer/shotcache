// Scrolling long-screenshot of ANY window (WeChat-style), driven by MANUAL
// scrolling.
//
// Flow: the overlay closes and the live screen returns under the SAME framing
// as the capture box — a violet border with the surround dimmed — while
// LongshotSession just watches. On a fast timer it (1) grabs the selected
// rectangle and (2) stitches it against the previous frame by row-signature
// matching. The dim/border/pill are all capture-excluded and click-through,
// so they neither enter the grab nor block scrolling. The USER
// scrolls the window down themselves; the timer is fast enough (GRAB_MS) that
// consecutive grabs keep enough overlap to match at normal scroll speed (a
// fling can outrun it — the pill then hints "滚慢一点"). The session NEVER
// injects input or moves the cursor. Stops on: status-pill click (finish),
// Esc (cancel), or a 30000px height cap. There is no auto-finish on "no
// change" — a pause between scrolls must not end the capture.
//
// Fixed chrome inside the selection (sticky headers / bottom bars) shows up
// as identical leading/trailing rows in every frame pair — those bands are
// excluded from matching and appended once: header from frame 0, footer from
// the final frame.
//
// Stitcher / StitchAccumulator are window-free on purpose: the build is
// verified by a synthetic-frame test (cut a tall image into overlapping
// frames, stitch them back, compare pixels).
//
// Compiled by the Windows-shipped csc.exe (.NET Framework 4.x) — keep this
// file C# 5 compatible: no interpolation, no null-conditional operators.

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace Shotcache
{
    /// Pure row-signature math.
    public static class Stitcher
    {
        /// A match needs at least this many overlapping content rows.
        public const int MIN_OVERLAP = 32;

        /// Per-row signature: sum of B+G+R over every 4th pixel.
        public static long[] RowSignatures(Bitmap bmp)
        {
            int w = bmp.Width, h = bmp.Height;
            long[] sig = new long[h];
            BitmapData d = bmp.LockBits(
                new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            try
            {
                byte[] px = new byte[d.Stride * h];
                Marshal.Copy(d.Scan0, px, 0, px.Length);
                for (int y = 0; y < h; y++)
                {
                    long s = 0;
                    int row = y * d.Stride;
                    for (int x = 0; x < w; x += 4)
                    {
                        int o = row + x * 4;
                        s += px[o] + px[o + 1] + px[o + 2];
                    }
                    sig[y] = s;
                }
            }
            finally
            {
                bmp.UnlockBits(d);
            }
            return sig;
        }

        /// Tolerance for "same row": ~2 units per sampled channel. Screen
        /// grabs are pixel-exact (CopyFromScreen has no cursor), so this only
        /// absorbs rounding-level noise.
        public static long EpsForWidth(int width)
        {
            return ((width + 3) / 4) * 3L * 2L;
        }

        public static int CommonPrefix(long[] a, long[] b, long eps, int cap)
        {
            int n = Math.Min(Math.Min(a.Length, b.Length), cap);
            int i = 0;
            while (i < n && Math.Abs(a[i] - b[i]) <= eps) i++;
            return i;
        }

        public static int CommonSuffix(long[] a, long[] b, long eps, int cap)
        {
            int n = Math.Min(Math.Min(a.Length, b.Length), cap);
            int i = 0;
            while (i < n && Math.Abs(a[a.Length - 1 - i] - b[b.Length - 1 - i]) <= eps) i++;
            return i;
        }

        /// Rows of new content the current frame brings: prev scrolled up by
        /// s lines up with cur over the content band [hdr, H-ftr). Smallest
        /// minimal-cost s wins (repeating patterns then duplicate a little
        /// instead of dropping content). 0 = unchanged, -1 = no trustworthy
        /// match (e.g. mid-animation frame).
        public static int FindShift(long[] prev, long[] cur, int hdr, int ftr, long eps)
        {
            int h = prev.Length;
            int top = hdr, bottom = h - ftr;
            int eff = bottom - top;
            if (eff < MIN_OVERLAP * 2) return -1;
            int bestS = -1;
            double bestCost = double.MaxValue;
            for (int s = 0; s <= eff - MIN_OVERLAP; s++)
            {
                long acc = 0;
                int n = eff - s;
                for (int i = 0; i < n; i++) acc += Math.Abs(prev[top + s + i] - cur[top + i]);
                double cost = (double)acc / n;
                if (cost < bestCost)
                {
                    bestCost = cost;
                    bestS = s;
                }
            }
            return bestCost <= eps ? bestS : -1;
        }
    }

    /// Grows the long screenshot strip by strip. Add() takes ownership of
    /// each frame bitmap; Compose() hands ownership of the result back.
    public class StitchAccumulator : IDisposable
    {
        readonly List<Bitmap> strips = new List<Bitmap>(); // [0] = clone of frame 0
        readonly long eps;
        readonly int width, height;
        Bitmap prev;
        long[] prevSig;
        int ftrLast;

        public int NoChangeStreak;
        public int FailStreak;
        /// Height of the final composition so far.
        public int TotalHeight;

        public StitchAccumulator(Bitmap first)
        {
            width = first.Width;
            height = first.Height;
            eps = Stitcher.EpsForWidth(width);
            strips.Add(new Bitmap(first));
            prev = first;
            prevSig = Stitcher.RowSignatures(first);
            TotalHeight = height;
        }

        /// Returns rows appended: >0 new content, 0 unchanged, -1 unmatchable.
        public int Add(Bitmap frame)
        {
            long[] sig = Stitcher.RowSignatures(frame);
            int cap = height / 3;
            int hdr = Stitcher.CommonPrefix(prevSig, sig, eps, cap);
            int ftr = Stitcher.CommonSuffix(prevSig, sig, eps, cap);
            int s = Stitcher.FindShift(prevSig, sig, hdr, ftr, eps);
            if (s < 0)
            {
                FailStreak++;
                frame.Dispose();
                return -1;
            }
            FailStreak = 0;
            if (s == 0)
            {
                NoChangeStreak++;
                frame.Dispose();
                return 0;
            }
            NoChangeStreak = 0;
            ftrLast = ftr;
            Bitmap strip = new Bitmap(width, s, PixelFormat.Format32bppArgb);
            using (Graphics g = Graphics.FromImage(strip))
            {
                g.DrawImage(frame, new Rectangle(0, 0, width, s),
                    new Rectangle(0, height - ftr - s, width, s), GraphicsUnit.Pixel);
            }
            strips.Add(strip);
            TotalHeight += s;
            prev.Dispose();
            prev = frame;
            prevSig = sig;
            return s;
        }

        /// Frame 0 minus its footer band, every strip, then the LAST frame's
        /// footer band — fixed bottom bars appear once, at the very end.
        public Bitmap Compose()
        {
            if (strips.Count == 1) return new Bitmap(strips[0]);
            int h0 = height - ftrLast;
            Bitmap outBmp = new Bitmap(width, TotalHeight, PixelFormat.Format32bppArgb);
            using (Graphics g = Graphics.FromImage(outBmp))
            {
                g.DrawImage(strips[0], new Rectangle(0, 0, width, h0),
                    new Rectangle(0, 0, width, h0), GraphicsUnit.Pixel);
                int y = h0;
                for (int i = 1; i < strips.Count; i++)
                {
                    g.DrawImage(strips[i], new Rectangle(0, y, width, strips[i].Height),
                        new Rectangle(0, 0, width, strips[i].Height), GraphicsUnit.Pixel);
                    y += strips[i].Height;
                }
                if (ftrLast > 0)
                {
                    g.DrawImage(prev, new Rectangle(0, y, width, ftrLast),
                        new Rectangle(0, height - ftrLast, width, ftrLast), GraphicsUnit.Pixel);
                }
            }
            return outBmp;
        }

        public void Dispose()
        {
            foreach (Bitmap b in strips) b.Dispose();
            strips.Clear();
            if (prev != null)
            {
                prev.Dispose();
                prev = null;
            }
        }
    }

    /// Live scrolling capture of a SCREEN-space rectangle. Runs entirely on
    /// the UI thread (WinForms timer); reports the stitched bitmap — or null
    /// on cancel/empty — through the callback, exactly once.
    public class LongshotSession
    {
        [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vKey);
        [DllImport("user32.dll")] static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint dwAffinity);

        // Per-pixel-alpha layered window: the dim surround + 1px border are
        // painted into ONE bitmap and pushed with UpdateLayeredWindow. A single
        // full-screen window has no thin dimension, so it dodges the ~136x39
        // minimum-window-size floor that bloated the old per-side border windows.
        [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr hWnd);
        [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
        [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr hDC);
        [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr hDC, IntPtr hObj);
        [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr hDC);
        [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr hObj);
        [DllImport("user32.dll")] static extern bool UpdateLayeredWindow(
            IntPtr hwnd, IntPtr hdcDst, ref PT pptDst, ref SZ psize,
            IntPtr hdcSrc, ref PT pptSrc, int crKey, ref BLENDFUNCTION pblend, int dwFlags);

        [StructLayout(LayoutKind.Sequential)] struct PT { public int X, Y; public PT(int x, int y) { X = x; Y = y; } }
        [StructLayout(LayoutKind.Sequential)] struct SZ { public int Cx, Cy; public SZ(int cx, int cy) { Cx = cx; Cy = cy; } }
        [StructLayout(LayoutKind.Sequential, Pack = 1)] struct BLENDFUNCTION { public byte Op, Flags, Alpha, Format; }

        // Win10 2004+: the window shows on screen but is omitted from every
        // capture API (CopyFromScreen included). Lets the chrome/pill stay
        // up while scrolling without ever landing in the stitched image — no
        // flickery hide-on-grab needed.
        const uint WDA_EXCLUDEFROMCAPTURE = 0x00000011;
        const int MAX_HEIGHT = 30000;
        const int VK_ESCAPE = 0x1B;
        /// Overlay teardown + content repaint before the first grab.
        const int FIRST_DELAY_MS = 400;
        /// Grab cadence once capturing — fast enough to keep overlap between
        /// frames while the user scrolls by hand.
        const int GRAB_MS = 150;

        /// Never activates — the scrolled window must keep its state. Also
        /// excluded from screen capture so it never shows in the grab.
        class NoActivateForm : Form
        {
            protected override bool ShowWithoutActivation
            {
                get { return true; }
            }

            protected override CreateParams CreateParams
            {
                get
                {
                    CreateParams cp = base.CreateParams;
                    cp.ExStyle |= 0x08000000; // WS_EX_NOACTIVATE
                    return cp;
                }
            }

            protected override void OnHandleCreated(EventArgs e)
            {
                base.OnHandleCreated(e);
                try { SetWindowDisplayAffinity(Handle, WDA_EXCLUDEFROMCAPTURE); } catch { }
            }
        }

        /// One layered window over the whole virtual screen, carrying the dim
        /// surround + the 1px violet border + a transparent hole on the
        /// selection (painted by RenderChrome via UpdateLayeredWindow).
        /// WS_EX_TRANSPARENT → every mouse/scroll event falls through to the
        /// window being captured; NoActivateForm adds capture-exclusion so it
        /// never lands in the grab.
        class ChromeForm : NoActivateForm
        {
            protected override CreateParams CreateParams
            {
                get
                {
                    CreateParams cp = base.CreateParams;
                    cp.ExStyle |= 0x00080000 | 0x00000020; // WS_EX_LAYERED | WS_EX_TRANSPARENT
                    return cp;
                }
            }
        }

        readonly Rectangle rect; // screen coordinates
        readonly Action<Bitmap> onDone;
        StitchAccumulator acc;
        Timer timer;
        Form status;
        Label statusLabel;
        Button doneBtn;
        Button cancelBtn;
        ChromeForm chrome;
        bool stopped;
        float dpi = 1f;

        public LongshotSession(Rectangle screenRect, Action<Bitmap> onDone)
        {
            rect = screenRect;
            this.onDone = onDone;
        }

        int S(int v) { return (int)Math.Round(v * dpi); }

        public void Start()
        {
            using (Graphics g = Graphics.FromHwnd(IntPtr.Zero)) dpi = g.DpiX / 96f;
            MakeChrome();   // dim surround + 1px border (under the pill)
            MakeStatus();
            // First frame lands after FIRST_DELAY_MS — by then the overlay is
            // gone and the real content has repainted; Tick() then speeds the
            // timer up to GRAB_MS for the manual-scroll grab loop.
            timer = new Timer();
            timer.Interval = FIRST_DELAY_MS;
            timer.Tick += delegate { Tick(); };
            timer.Start();
        }

        void Tick()
        {
            if (stopped) return;
            if ((GetAsyncKeyState(VK_ESCAPE) & 0x8000) != 0)
            {
                Finish(true);
                return;
            }

            Bitmap f = Grab();
            if (acc == null)
            {
                // First frame is the baseline; from here grab fast and let the
                // user drive the scrolling. No input is ever injected.
                acc = new StitchAccumulator(f);
                timer.Interval = GRAB_MS;
                UpdateLabel();
                return;
            }

            // Add() appends new content (s>0), ignores an unchanged pause (s==0),
            // or drops a too-fast/animating frame (s<0) keeping the prev anchor.
            // The user ends the capture explicitly (pill click / Esc); the only
            // automatic stop is the safety height cap.
            acc.Add(f);
            UpdateLabel();
            if (acc.TotalHeight + rect.Height >= MAX_HEIGHT) Finish(false);
        }

        Bitmap Grab()
        {
            // Just copies the selection. The chrome window and pill are marked
            // WDA_EXCLUDEFROMCAPTURE, so they're never in this grab — no hiding,
            // no flicker.
            Bitmap bmp = new Bitmap(rect.Width, rect.Height, PixelFormat.Format32bppArgb);
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.CopyFromScreen(rect.X, rect.Y, 0, 0, rect.Size);
            }
            return bmp;
        }

        // --- chrome (dim surround + 1px border, then the status pill) ---

        /// The capture-box framing during the live scroll: dimmed surround +
        /// a hairline violet border, drawn to read EXACTLY like the capture
        /// overlay. One full-screen layered window carries it all (ChromeForm).
        void MakeChrome()
        {
            chrome = new ChromeForm();
            chrome.FormBorderStyle = FormBorderStyle.None;
            chrome.ShowInTaskbar = false;
            chrome.TopMost = true;
            chrome.StartPosition = FormStartPosition.Manual;
            chrome.Bounds = SystemInformation.VirtualScreen;
            chrome.Show();
            RenderChrome();
        }

        /// Paint dim + 1px border + a transparent selection hole into a
        /// virtual-screen-sized bitmap and push it to the layered window. The
        /// ONLY translucent pixels are pure black (the dim), for which straight
        /// alpha already equals premultiplied — so no manual premultiply is
        /// needed. SourceCopy makes each fill OVERWRITE (alpha included) rather
        /// than blend, so the hole really is punched to alpha 0.
        void RenderChrome()
        {
            Rectangle vs = SystemInformation.VirtualScreen;
            int th = Math.Max(1, S(1)); // 1px (dpi-scaled), same as the overlay pen
            int sx = rect.X - vs.X, sy = rect.Y - vs.Y; // selection in client coords
            using (Bitmap bmp = new Bitmap(vs.Width, vs.Height, PixelFormat.Format32bppArgb))
            {
                using (Graphics g = Graphics.FromImage(bmp))
                {
                    g.CompositingMode = CompositingMode.SourceCopy;
                    using (SolidBrush dim = new SolidBrush(Color.FromArgb(110, 0, 0, 0)))
                        g.FillRectangle(dim, 0, 0, vs.Width, vs.Height);
                    using (SolidBrush edge = new SolidBrush(Color.FromArgb(0xFF, 0x8B, 0x7C, 0xF0)))
                        g.FillRectangle(edge, sx - th, sy - th, rect.Width + 2 * th, rect.Height + 2 * th);
                    using (SolidBrush hole = new SolidBrush(Color.FromArgb(0, 0, 0, 0)))
                        g.FillRectangle(hole, sx, sy, rect.Width, rect.Height);
                }
                PushLayered(chrome, bmp, vs.Location);
            }
        }

        /// Hand a 32bpp PARGB bitmap to a WS_EX_LAYERED window's per-pixel-alpha
        /// surface (no SetLayeredWindowAttributes — that's whole-window only).
        static void PushLayered(Form form, Bitmap bmp, Point screenPos)
        {
            IntPtr screenDc = GetDC(IntPtr.Zero);
            IntPtr memDc = CreateCompatibleDC(screenDc);
            IntPtr hBmp = IntPtr.Zero, old = IntPtr.Zero;
            try
            {
                hBmp = bmp.GetHbitmap(Color.FromArgb(0)); // 32bpp DIB, alpha preserved
                old = SelectObject(memDc, hBmp);
                SZ size = new SZ(bmp.Width, bmp.Height);
                PT src = new PT(0, 0);
                PT dst = new PT(screenPos.X, screenPos.Y);
                BLENDFUNCTION blend = new BLENDFUNCTION();
                blend.Op = 0;      // AC_SRC_OVER
                blend.Flags = 0;
                blend.Alpha = 255; // no extra whole-window fade
                blend.Format = 1;  // AC_SRC_ALPHA → use the bitmap's per-pixel alpha
                UpdateLayeredWindow(form.Handle, screenDc, ref dst, ref size,
                    memDc, ref src, 0, ref blend, 2 /* ULW_ALPHA */);
            }
            finally
            {
                if (old != IntPtr.Zero) SelectObject(memDc, old);
                if (hBmp != IntPtr.Zero) DeleteObject(hBmp);
                DeleteDC(memDc);
                ReleaseDC(IntPtr.Zero, screenDc);
            }
        }

        // The pill is a usage hint + two explicit actions: 完成 (save) and
        // 取消 (cancel). NoActivateForm keeps the scrolled window focused, so
        // its buttons fire on click without stealing focus (like the old label).
        void MakeStatus()
        {
            status = new NoActivateForm();
            status.FormBorderStyle = FormBorderStyle.None;
            status.ShowInTaskbar = false;
            status.TopMost = true;
            status.StartPosition = FormStartPosition.Manual;
            status.BackColor = Color.FromArgb(0x20, 0x1F, 0x25); // ink panel
            Font f = new Font("Microsoft YaHei UI", 13f * dpi, FontStyle.Regular, GraphicsUnit.Pixel);

            statusLabel = new Label();
            statusLabel.AutoSize = true;
            statusLabel.ForeColor = Color.White;
            statusLabel.Font = f;
            statusLabel.Text = "向下滚动以截取长图";
            status.Controls.Add(statusLabel);

            doneBtn = MakeStatusButton("✓ 完成", Color.FromArgb(0x6F, 0x5A, 0xE8), Color.White, f);
            doneBtn.Click += delegate { Finish(false); };
            status.Controls.Add(doneBtn);

            cancelBtn = MakeStatusButton("✕ 取消", Color.FromArgb(0x2A, 0x28, 0x32),
                Color.FromArgb(0xE5, 0x67, 0x5B), f);
            cancelBtn.Click += delegate { Finish(true); };
            status.Controls.Add(cancelBtn);

            LayoutStatus();
            PlaceStatus();
            status.Show();
        }

        Button MakeStatusButton(string text, Color bg, Color fore, Font f)
        {
            Button b = new Button();
            b.Text = text;
            b.Font = f;
            b.ForeColor = fore;
            b.BackColor = bg;
            b.FlatStyle = FlatStyle.Flat;
            b.FlatAppearance.BorderSize = 0;
            b.TabStop = false;
            b.Cursor = Cursors.Hand;
            Size sz = TextRenderer.MeasureText(text, f);
            b.Size = new Size(sz.Width + S(18), S(28));
            return b;
        }

        /// Lay the label + the two buttons out in a row and size the pill.
        void LayoutStatus()
        {
            int pad = S(8), gap = S(8), h = S(28) + 2 * S(7), top = S(7);
            Size lp = statusLabel.PreferredSize;
            statusLabel.Size = lp;
            statusLabel.Location = new Point(pad, (h - lp.Height) / 2);
            int x = pad + lp.Width + gap;
            doneBtn.Location = new Point(x, top);
            x += doneBtn.Width + S(6);
            cancelBtn.Location = new Point(x, top);
            x += cancelBtn.Width + pad;
            status.ClientSize = new Size(x, h);
        }

        void UpdateLabel()
        {
            if (statusLabel == null || acc == null) return;
            string hint = acc.FailStreak >= 2 ? "（滚慢一点）" : "";
            statusLabel.Text = "向下滚动截长图 · 已截 ≈" + acc.TotalHeight + "px" + hint;
            LayoutStatus();
            PlaceStatus();
        }

        void PlaceStatus()
        {
            Rectangle vs = SystemInformation.VirtualScreen;
            int margin = 8;
            int x = Math.Max(vs.Left, Math.Min(rect.Right - status.Width, vs.Right - status.Width));
            // Below the selection by default — same side as the capture overlay's
            // toolbar (使用提示 + 完成 + 取消 hug the box's bottom edge).
            int y = rect.Bottom + margin;
            if (y + status.Height > vs.Bottom)
            {
                y = rect.Top - status.Height - margin; // no room below — flip above
                // Selection fills the screen — sit just inside its bottom edge
                // (capture-excluded, so it still won't show in the grab).
                if (y < vs.Top) y = rect.Bottom - status.Height - margin;
            }
            status.Location = new Point(x, y);
        }

        void Finish(bool cancel)
        {
            if (stopped) return;
            stopped = true;
            if (timer != null)
            {
                timer.Stop();
                timer.Dispose();
                timer = null;
            }
            if (chrome != null)
            {
                chrome.Dispose();
                chrome = null;
            }
            if (status != null)
            {
                status.Dispose();
                status = null;
            }
            Bitmap result = null;
            if (!cancel && acc != null) result = acc.Compose();
            if (acc != null)
            {
                acc.Dispose();
                acc = null;
            }
            onDone(result);
        }
    }
}
