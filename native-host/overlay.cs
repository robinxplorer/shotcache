// OverlayForm — the WeChat-style capture surface.
//
// A borderless TopMost form covering the whole virtual screen, painted with
// the frozen screenshot 1:1 (client coordinates ARE bitmap coordinates, so
// there is no coordinate mapping anywhere). Interaction states:
//   None      dimmed full screen, crosshair — drag to start a selection
//   Dragging  rubber-band selection
//   Selected  toolbar shown; selection can be moved/resized by its 8 handles
//             until the first annotation, then it locks (WeChat behavior)
// Keys: Esc cancel (closes the inline text box first if one is open),
// Enter / double-click confirm, Ctrl+Z undo.
//
// ShowDialog() returns OK with ResultBitmap = cropped selection with the
// annotations burned in (caller disposes), or Cancel.
//
// Compiled by the Windows-shipped csc.exe — keep C# 5 compatible.

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace Shotcache
{
    public class OverlayForm : Form
    {
        enum Stage { None, Dragging, Selected }
        enum Hit { None, Inside, NW, N, NE, E, SE, S, SW, W }

        const int MIN_SEL = 4;

        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
        [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
        [DllImport("user32.dll")] static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

        readonly Bitmap frozen;
        readonly MosaicSampler sampler;
        readonly float dpi;

        Stage stage = Stage.None;
        Rectangle sel;
        Point dragStart;
        Rectangle dragOrigin;     // sel when a move/resize drag started
        Hit adjust = Hit.None;

        AnnoTool? tool = null;    // null = adjust mode
        readonly List<AnnoOp> ops = new List<AnnoOp>();
        AnnoOp cur;               // op being dragged out right now

        // Style-bar state, stamped onto each op at creation (sticky within
        // this overlay session; changing it never repaints existing ops).
        int styleTier = 1;        // 0 thin / 1 medium / 2 thick
        Color curColor = Annotator.Accent;
        string curEmoji = "👍";

        Panel toolbar;
        Panel styleBar;
        Panel emojiBar;
        readonly Dictionary<AnnoTool, Button> toolButtons = new Dictionary<AnnoTool, Button>();
        readonly List<Button> widthButtons = new List<Button>();
        readonly List<Button> swatchButtons = new List<Button>();
        readonly List<Button> emojiButtons = new List<Button>();
        TextBox textInput;
        Point textPos;
        bool committingText;      // LostFocus re-fires during Controls.Remove

        /// Set when DialogResult == OK; caller owns (disposes) it.
        public Bitmap ResultBitmap;

        /// Set instead of ResultBitmap when the user picked 「⇳ 长截图」:
        /// the selection in CLIENT coordinates (the caller converts to screen
        /// space and hands it to LongshotSession). A property — field access
        /// on a MarshalByRefObject subclass trips CS1690.
        public Rectangle? LongshotRect { get; set; }

        public OverlayForm(Bitmap frozenShot)
        {
            frozen = frozenShot;
            sampler = new MosaicSampler(frozen);

            SetStyle(ControlStyles.AllPaintingInWmPaint
                   | ControlStyles.UserPaint
                   | ControlStyles.OptimizedDoubleBuffer, true);
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            StartPosition = FormStartPosition.Manual;
            Bounds = SystemInformation.VirtualScreen;
            Cursor = Cursors.Cross;
            KeyPreview = true;

            using (Graphics g = CreateGraphics()) dpi = g.DpiX / 96f;
            BuildToolbar();
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing && sampler != null) sampler.Dispose();
            base.Dispose(disposing);
        }

        // --- style tiers (physical px; one knob drives every tool) ---

        static readonly int[] STROKE_TIERS = { 2, 4, 7 };
        static readonly int[] FONT_TIERS = { 16, 20, 28 };
        static readonly int[] CELL_TIERS = { 8, 12, 18 };
        static readonly int[] EMOJI_TIERS = { 24, 36, 52 };
        static readonly Color[] PALETTE = {
            Color.FromArgb(0xFF, 0x4D, 0x4F), Color.FromArgb(0xFF, 0x9F, 0x1A),
            Color.FromArgb(0xFF, 0xD2, 0x1E), Color.FromArgb(0x2E, 0xA0, 0x43),
            Color.FromArgb(0x11, 0x80, 0xFF), Color.FromArgb(0x89, 0x57, 0xE5),
            Color.FromArgb(0x1F, 0x1F, 0x1F), Color.FromArgb(0xFF, 0xFF, 0xFF),
        };
        // Kept in sync with the browser editor's EMOJIS list.
        static readonly string[] EMOJIS = {
            "😂", "😍", "😮", "😡", "😢", "👍", "👎", "🙏",
            "❤️", "💔", "🎉", "🔥", "✅", "❌", "❓", "⚠️",
        };

        int Scale(int v) { return (int)Math.Round(v * dpi); }
        int StrokePx() { return Scale(STROKE_TIERS[styleTier]); }
        float FontPxTier() { return FONT_TIERS[styleTier] * dpi; }
        int CellPx() { return Scale(CELL_TIERS[styleTier]); }
        int EmojiPx() { return Scale(EMOJI_TIERS[styleTier]); }

        /// New op pre-stamped with the current style.
        AnnoOp NewOp(AnnoTool t)
        {
            AnnoOp op = new AnnoOp();
            op.Tool = t;
            op.Argb = curColor.ToArgb();
            op.Stroke = StrokePx();
            op.FontPx = FontPxTier();
            op.Cell = CellPx();
            op.EmojiPx = EmojiPx();
            return op;
        }

        // --- foreground (port-triggered captures start in a background process) ---

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            ForceForeground();
        }

        void ForceForeground()
        {
            Activate();
            if (GetForegroundWindow() == Handle) return;
            IntPtr fg = GetForegroundWindow();
            uint pid;
            uint fgThread = GetWindowThreadProcessId(fg, out pid);
            uint cur2 = GetCurrentThreadId();
            if (fgThread != cur2)
            {
                // Classic workaround: a background process may not steal
                // foreground, but the foreground thread's input queue may.
                AttachThreadInput(cur2, fgThread, true);
                SetForegroundWindow(Handle);
                Activate();
                AttachThreadInput(cur2, fgThread, false);
            }
        }

        // --- toolbar ---

        void BuildToolbar()
        {
            toolbar = new Panel();
            toolbar.Visible = false;
            toolbar.BackColor = Color.FromArgb(0x20, 0x1F, 0x25); // ink panel

            Font f = new Font("Microsoft YaHei UI", 13f * dpi, FontStyle.Regular, GraphicsUnit.Pixel);
            int x = Scale(4);
            x = AddToolButton(f, x, "□ 矩形", AnnoTool.Rect);
            x = AddToolButton(f, x, "○ 椭圆", AnnoTool.Ellipse);
            x = AddToolButton(f, x, "↗ 箭头", AnnoTool.Arrow);
            x = AddToolButton(f, x, "T 文字", AnnoTool.Text);
            x = AddToolButton(f, x, "▦ 马赛克", AnnoTool.Mosaic);
            x = AddToolButton(f, x, "😀 表情", AnnoTool.Emoji);
            x = AddButton(f, x, "⇳ 长截图", Color.White, delegate { RequestLongshot(); });
            x = AddButton(f, x, "↶ 撤销", Color.White, delegate { Undo(); });
            x = AddButton(f, x, "✕", Color.FromArgb(0xFF, 0x6B, 0x6B), delegate { CancelOverlay(); });
            x = AddButton(f, x, "✓ 完成", Color.FromArgb(0x4C, 0xD9, 0x64), delegate { Confirm(); });
            toolbar.Size = new Size(x + Scale(4), Scale(36));
            Controls.Add(toolbar);
            BuildStyleBar(f);
            BuildEmojiBar();
        }

        void BuildStyleBar(Font f)
        {
            styleBar = new Panel();
            styleBar.Visible = false;
            styleBar.BackColor = toolbar.BackColor;
            int x = Scale(6);
            string[] widthLabels = { "细", "中", "粗" };
            for (int i = 0; i < widthLabels.Length; i++)
            {
                int tier = i;
                Button b = new Button();
                b.Text = widthLabels[i];
                b.Font = f;
                b.ForeColor = Color.White;
                b.BackColor = styleBar.BackColor;
                b.FlatStyle = FlatStyle.Flat;
                b.FlatAppearance.BorderSize = 0;
                b.FlatAppearance.MouseOverBackColor = Color.FromArgb(0x35, 0x33, 0x3D);
                b.TabStop = false;
                b.Size = new Size(Scale(34), Scale(24));
                b.Location = new Point(x, Scale(5));
                b.Click += delegate { styleTier = tier; UpdateStyleBar(); ActiveControl = null; };
                styleBar.Controls.Add(b);
                widthButtons.Add(b);
                x += b.Width + Scale(2);
            }
            x += Scale(8);
            for (int i = 0; i < PALETTE.Length; i++)
            {
                Color c = PALETTE[i];
                Button b = new Button();
                b.BackColor = c;
                b.FlatStyle = FlatStyle.Flat;
                b.FlatAppearance.BorderColor = Color.FromArgb(90, 92, 98);
                b.FlatAppearance.BorderSize = 1;
                b.TabStop = false;
                b.Size = new Size(Scale(20), Scale(20));
                b.Location = new Point(x, Scale(7));
                b.Click += delegate { curColor = c; UpdateStyleBar(); ActiveControl = null; };
                styleBar.Controls.Add(b);
                swatchButtons.Add(b);
                x += b.Width + Scale(4);
            }
            styleBar.Size = new Size(x + Scale(4), Scale(34));
            Controls.Add(styleBar);
            UpdateStyleBar();
        }

        void BuildEmojiBar()
        {
            emojiBar = new Panel();
            emojiBar.Visible = false;
            emojiBar.BackColor = toolbar.BackColor;
            int cellW = Scale(30), pad = Scale(4);
            for (int i = 0; i < EMOJIS.Length; i++)
            {
                string e = EMOJIS[i];
                Button b = new Button();
                b.FlatStyle = FlatStyle.Flat;
                b.FlatAppearance.BorderSize = 0;
                b.BackColor = emojiBar.BackColor;
                b.FlatAppearance.MouseOverBackColor = Color.FromArgb(0x35, 0x33, 0x3D);
                b.TabStop = false;
                b.Size = new Size(cellW, cellW);
                b.Location = new Point(pad + (i % 8) * (cellW + pad), pad + (i / 8) * (cellW + pad));
                // WinForms text rendering draws emoji monochrome — use the
                // WPF-rasterized color glyph as the button image instead.
                Bitmap glyph = EmojiRenderer.Get(e, Scale(20));
                if (glyph != null)
                {
                    b.Image = glyph;
                    b.ImageAlign = ContentAlignment.MiddleCenter;
                }
                else
                {
                    b.Text = e;
                    b.Font = new Font("Segoe UI Emoji", 12f * dpi, FontStyle.Regular, GraphicsUnit.Pixel);
                    b.ForeColor = Color.White;
                }
                b.Click += delegate { curEmoji = e; UpdateEmojiBar(); ActiveControl = null; };
                emojiBar.Controls.Add(b);
                emojiButtons.Add(b);
            }
            emojiBar.Size = new Size(pad + 8 * (cellW + pad), pad + 2 * (cellW + pad));
            Controls.Add(emojiBar);
            UpdateEmojiBar();
        }

        void UpdateStyleBar()
        {
            for (int i = 0; i < widthButtons.Count; i++)
                widthButtons[i].BackColor =
                    i == styleTier ? Color.FromArgb(0x6F, 0x5A, 0xE8) : styleBar.BackColor;
            for (int i = 0; i < swatchButtons.Count; i++)
            {
                bool selected = PALETTE[i].ToArgb() == curColor.ToArgb();
                swatchButtons[i].FlatAppearance.BorderColor =
                    selected ? Color.White : Color.FromArgb(90, 92, 98);
                swatchButtons[i].FlatAppearance.BorderSize = selected ? 2 : 1;
            }
        }

        void UpdateEmojiBar()
        {
            for (int i = 0; i < emojiButtons.Count; i++)
            {
                emojiButtons[i].FlatAppearance.BorderColor = Color.White;
                emojiButtons[i].FlatAppearance.BorderSize = EMOJIS[i] == curEmoji ? 2 : 0;
            }
        }

        int AddButton(Font f, int x, string text, Color fore, EventHandler onClick)
        {
            Button b = new Button();
            b.Text = text;
            b.Font = f;
            b.ForeColor = fore;
            b.BackColor = toolbar.BackColor;
            b.FlatStyle = FlatStyle.Flat;
            b.FlatAppearance.BorderSize = 0;
            b.FlatAppearance.MouseOverBackColor = Color.FromArgb(0x35, 0x33, 0x3D);
            b.TabStop = false;
            Size sz = TextRenderer.MeasureText(text, f);
            b.Size = new Size(sz.Width + Scale(14), Scale(28));
            b.Location = new Point(x, Scale(4));
            b.Click += onClick;
            b.Click += delegate { ActiveControl = null; }; // keep key events on the form
            toolbar.Controls.Add(b);
            return x + b.Width + Scale(2);
        }

        int AddToolButton(Font f, int x, string text, AnnoTool t)
        {
            int nx = AddButton(f, x, text, Color.White, delegate { SelectTool(t); });
            toolButtons[t] = (Button)toolbar.Controls[toolbar.Controls.Count - 1];
            return nx;
        }

        void SelectTool(AnnoTool t)
        {
            CommitText();
            tool = t;
            foreach (KeyValuePair<AnnoTool, Button> kv in toolButtons)
                kv.Value.BackColor = kv.Key == t ? Color.FromArgb(0x6F, 0x5A, 0xE8) : toolbar.BackColor;
            styleBar.Visible = true;
            emojiBar.Visible = t == AnnoTool.Emoji;
            PositionToolbar();
            Invalidate();
        }

        void ResetToolHighlight()
        {
            tool = null;
            foreach (KeyValuePair<AnnoTool, Button> kv in toolButtons)
                kv.Value.BackColor = toolbar.BackColor;
            if (styleBar != null) styleBar.Visible = false;
            if (emojiBar != null) emojiBar.Visible = false;
        }

        void Undo()
        {
            CommitText();
            if (ops.Count > 0)
            {
                ops.RemoveAt(ops.Count - 1);
                Invalidate();
            }
        }

        void PositionToolbar()
        {
            int margin = Scale(8);
            int x = sel.Right - toolbar.Width;
            if (x < 0) x = sel.Left;
            x = Math.Max(0, Math.Min(x, ClientSize.Width - toolbar.Width));
            int y = sel.Bottom + margin;
            if (y + toolbar.Height > ClientSize.Height)
            {
                y = sel.Top - margin - toolbar.Height;
                if (y < 0) y = sel.Bottom - margin - toolbar.Height; // hug the inside edge
            }
            y = Math.Max(0, Math.Min(y, ClientSize.Height - toolbar.Height));
            toolbar.Location = new Point(x, y);

            // Stack the style bar (and the emoji grid) under the toolbar;
            // flip the whole stack above it when there is no room below.
            if (styleBar == null) return;
            int gap = Scale(4);
            int stackH = styleBar.Height + (emojiBar.Visible ? emojiBar.Height + gap : 0);
            int by = toolbar.Bottom + gap;
            if (by + stackH > ClientSize.Height)
            {
                by = toolbar.Top - gap - stackH;
                if (by < 0) by = toolbar.Bottom + gap; // give up; clamp below
            }
            int bx = Math.Max(0, Math.Min(toolbar.Left, ClientSize.Width - styleBar.Width));
            styleBar.Location = new Point(bx, Math.Max(0, by));
            int ex = Math.Max(0, Math.Min(toolbar.Left, ClientSize.Width - emojiBar.Width));
            emojiBar.Location = new Point(ex, Math.Max(0, by + styleBar.Height + gap));
            styleBar.BringToFront();
            emojiBar.BringToFront();
        }

        // --- mouse ---

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button == MouseButtons.Right) { OnRightClick(); return; }
            if (e.Button != MouseButtons.Left) return;

            if (textInput != null) { CommitText(); return; } // click-away commits

            if (stage == Stage.None)
            {
                stage = Stage.Dragging;
                dragStart = e.Location;
                sel = Rectangle.Empty;
                Invalidate();
                return;
            }

            if (stage != Stage.Selected) return;

            if (tool == null)
            {
                if (ops.Count > 0) return; // locked once annotated
                Hit h = HitTest(e.Location);
                if (h == Hit.None) return;
                adjust = h;
                dragStart = e.Location;
                dragOrigin = sel;
                return;
            }

            if (!sel.Contains(e.Location)) return;
            if (tool.Value == AnnoTool.Text) { OpenTextInput(e.Location); return; }
            if (tool.Value == AnnoTool.Emoji)
            {
                // Click-to-place, centered on the click point.
                AnnoOp op = NewOp(AnnoTool.Emoji);
                op.Text = curEmoji;
                op.X1 = e.X - op.EmojiPx / 2;
                op.Y1 = e.Y - op.EmojiPx / 2;
                op.X2 = op.X1; op.Y2 = op.Y1;
                ops.Add(op);
                Invalidate();
                return;
            }
            cur = NewOp(tool.Value);
            cur.X1 = e.X; cur.Y1 = e.Y; cur.X2 = e.X; cur.Y2 = e.Y;
        }

        void OnRightClick()
        {
            if (stage == Stage.Selected && ops.Count == 0 && textInput == null)
            {
                // Back to square one — same as WeChat.
                stage = Stage.None;
                sel = Rectangle.Empty;
                adjust = Hit.None;
                toolbar.Visible = false;
                ResetToolHighlight();
                Invalidate();
            }
            else if (stage == Stage.None)
            {
                CancelOverlay();
            }
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            if (stage == Stage.Dragging)
            {
                sel = NormRect(dragStart, e.Location);
                Invalidate();
                return;
            }
            if (adjust != Hit.None)
            {
                ApplyAdjust(e.Location);
                PositionToolbar();
                Invalidate();
                return;
            }
            if (cur != null)
            {
                cur.X2 = Clamp(e.X, sel.Left, sel.Right);
                cur.Y2 = Clamp(e.Y, sel.Top, sel.Bottom);
                Invalidate();
                return;
            }
            UpdateCursor(e.Location);
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            if (e.Button != MouseButtons.Left) return;
            if (stage == Stage.Dragging)
            {
                if (sel.Width >= MIN_SEL && sel.Height >= MIN_SEL)
                {
                    stage = Stage.Selected;
                    toolbar.Visible = true;
                    toolbar.BringToFront();
                    PositionToolbar();
                }
                else
                {
                    // Accidental click — keep selecting.
                    stage = Stage.None;
                    sel = Rectangle.Empty;
                }
                Invalidate();
                return;
            }
            if (adjust != Hit.None) { adjust = Hit.None; return; }
            if (cur != null)
            {
                if (Math.Abs(cur.X2 - cur.X1) > 3 || Math.Abs(cur.Y2 - cur.Y1) > 3) ops.Add(cur);
                cur = null;
                Invalidate();
            }
        }

        protected override void OnMouseDoubleClick(MouseEventArgs e)
        {
            base.OnMouseDoubleClick(e);
            if (e.Button == MouseButtons.Left && stage == Stage.Selected && sel.Contains(e.Location))
                Confirm();
        }

        // --- selection adjust ---

        void ApplyAdjust(Point p)
        {
            int dx = p.X - dragStart.X, dy = p.Y - dragStart.Y;
            int l = dragOrigin.Left, t = dragOrigin.Top, r = dragOrigin.Right, b = dragOrigin.Bottom;
            switch (adjust)
            {
                case Hit.Inside:
                    l += dx; r += dx; t += dy; b += dy;
                    if (l < 0) { r -= l; l = 0; }
                    if (t < 0) { b -= t; t = 0; }
                    if (r > ClientSize.Width) { l -= r - ClientSize.Width; r = ClientSize.Width; }
                    if (b > ClientSize.Height) { t -= b - ClientSize.Height; b = ClientSize.Height; }
                    break;
                case Hit.NW: l += dx; t += dy; break;
                case Hit.N: t += dy; break;
                case Hit.NE: r += dx; t += dy; break;
                case Hit.E: r += dx; break;
                case Hit.SE: r += dx; b += dy; break;
                case Hit.S: b += dy; break;
                case Hit.SW: l += dx; b += dy; break;
                case Hit.W: l += dx; break;
            }
            sel = NormEdges(l, t, r, b);
        }

        Rectangle NormEdges(int l, int t, int r, int b)
        {
            Rectangle rc = Rectangle.FromLTRB(
                Math.Min(l, r), Math.Min(t, b), Math.Max(l, r), Math.Max(t, b));
            rc.Intersect(ClientRectangle);
            if (rc.Width < 1) rc.Width = 1;
            if (rc.Height < 1) rc.Height = 1;
            return rc;
        }

        Rectangle NormRect(Point a, Point b) { return NormEdges(a.X, a.Y, b.X, b.Y); }

        static int Clamp(int v, int lo, int hi) { return Math.Max(lo, Math.Min(hi, v)); }

        Rectangle HandleRect(int cx, int cy)
        {
            int s = Scale(10);
            return new Rectangle(cx - s / 2, cy - s / 2, s, s);
        }

        Hit HitTest(Point p)
        {
            int mx = sel.Left + sel.Width / 2, my = sel.Top + sel.Height / 2;
            if (HandleRect(sel.Left, sel.Top).Contains(p)) return Hit.NW;
            if (HandleRect(mx, sel.Top).Contains(p)) return Hit.N;
            if (HandleRect(sel.Right, sel.Top).Contains(p)) return Hit.NE;
            if (HandleRect(sel.Right, my).Contains(p)) return Hit.E;
            if (HandleRect(sel.Right, sel.Bottom).Contains(p)) return Hit.SE;
            if (HandleRect(mx, sel.Bottom).Contains(p)) return Hit.S;
            if (HandleRect(sel.Left, sel.Bottom).Contains(p)) return Hit.SW;
            if (HandleRect(sel.Left, my).Contains(p)) return Hit.W;
            if (sel.Contains(p)) return Hit.Inside;
            return Hit.None;
        }

        void UpdateCursor(Point p)
        {
            if (stage == Stage.Selected && tool == null && ops.Count == 0)
            {
                switch (HitTest(p))
                {
                    case Hit.NW: case Hit.SE: Cursor = Cursors.SizeNWSE; return;
                    case Hit.NE: case Hit.SW: Cursor = Cursors.SizeNESW; return;
                    case Hit.N: case Hit.S: Cursor = Cursors.SizeNS; return;
                    case Hit.E: case Hit.W: Cursor = Cursors.SizeWE; return;
                    case Hit.Inside: Cursor = Cursors.SizeAll; return;
                }
            }
            Cursor = Cursors.Cross;
        }

        // --- painting ---

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.DrawImageUnscaled(frozen, 0, 0);

            using (SolidBrush dim = new SolidBrush(Color.FromArgb(110, 0, 0, 0)))
            {
                if (stage == Stage.None || sel.Width <= 0)
                {
                    g.FillRectangle(dim, ClientRectangle);
                    return;
                }
                g.FillRectangle(dim, 0, 0, ClientSize.Width, sel.Top);
                g.FillRectangle(dim, 0, sel.Top, sel.Left, sel.Height);
                g.FillRectangle(dim, sel.Right, sel.Top, ClientSize.Width - sel.Right, sel.Height);
                g.FillRectangle(dim, 0, sel.Bottom, ClientSize.Width, ClientSize.Height - sel.Bottom);
            }

            Annotator.Paint(g, ops, sampler, 0, 0);
            if (cur != null)
                Annotator.Paint(g, new AnnoOp[] { cur }, sampler, 0, 0);

            using (Pen border = new Pen(Color.FromArgb(0x8B, 0x7C, 0xF0), Math.Max(1f, dpi)))
                g.DrawRectangle(border, sel);

            if (stage == Stage.Selected && tool == null && ops.Count == 0) DrawHandles(g);
            DrawSizeLabel(g);
        }

        void DrawHandles(Graphics g)
        {
            int mx = sel.Left + sel.Width / 2, my = sel.Top + sel.Height / 2;
            Point[] pts = new Point[]
            {
                new Point(sel.Left, sel.Top), new Point(mx, sel.Top), new Point(sel.Right, sel.Top),
                new Point(sel.Right, my), new Point(sel.Right, sel.Bottom), new Point(mx, sel.Bottom),
                new Point(sel.Left, sel.Bottom), new Point(sel.Left, my),
            };
            using (SolidBrush b = new SolidBrush(Color.FromArgb(0x8B, 0x7C, 0xF0)))
            {
                foreach (Point p in pts)
                {
                    Rectangle r = HandleRect(p.X, p.Y);
                    r.Inflate(-Scale(2), -Scale(2));
                    g.FillRectangle(b, r);
                }
            }
        }

        void DrawSizeLabel(Graphics g)
        {
            string s = sel.Width + " × " + sel.Height;
            using (Font f = new Font("Microsoft YaHei UI", 12f * dpi, FontStyle.Regular, GraphicsUnit.Pixel))
            {
                Size sz = TextRenderer.MeasureText(s, f);
                int pad = Scale(4);
                int x = Math.Min(sel.Left, ClientSize.Width - sz.Width - pad * 2);
                int y = sel.Top - sz.Height - pad * 2 - Scale(4);
                if (y < 0) y = sel.Top + Scale(4);
                using (SolidBrush bg = new SolidBrush(Color.FromArgb(200, 20, 20, 24)))
                    g.FillRectangle(bg, x, y, sz.Width + pad * 2, sz.Height + pad * 2);
                TextRenderer.DrawText(g, s, f, new Point(x + pad, y + pad), Color.White);
            }
        }

        // --- inline text annotation ---

        void OpenTextInput(Point p)
        {
            CommitText();
            textPos = p;
            textInput = new TextBox();
            textInput.Font = new Font("Microsoft YaHei UI", FontPxTier(), FontStyle.Regular, GraphicsUnit.Pixel);
            textInput.ForeColor = curColor;
            textInput.BackColor = Color.White;
            textInput.BorderStyle = BorderStyle.FixedSingle;
            int w = Math.Max(Scale(80), Math.Min(Scale(320), sel.Right - p.X));
            textInput.Width = w;
            textInput.Location = new Point(
                Math.Min(p.X, ClientSize.Width - w),
                Math.Min(p.Y, ClientSize.Height - textInput.Height));
            textInput.LostFocus += delegate { CommitText(); };
            Controls.Add(textInput);
            textInput.BringToFront();
            textInput.Focus();
        }

        void CommitText()
        {
            if (textInput == null || committingText) return;
            committingText = true;
            string s = textInput.Text.Trim();
            TextBox tb = textInput;
            textInput = null;
            Controls.Remove(tb);
            tb.Dispose();
            if (s.Length > 0)
            {
                AnnoOp op = NewOp(AnnoTool.Text);
                op.X1 = textPos.X; op.Y1 = textPos.Y;
                op.X2 = textPos.X; op.Y2 = textPos.Y;
                op.Text = s;
                ops.Add(op);
            }
            committingText = false;
            Invalidate();
        }

        void DiscardText()
        {
            if (textInput == null) return;
            committingText = true;
            TextBox tb = textInput;
            textInput = null;
            Controls.Remove(tb);
            tb.Dispose();
            committingText = false;
            Invalidate();
        }

        // --- keyboard ---

        protected override void OnKeyDown(KeyEventArgs e)
        {
            base.OnKeyDown(e);
            if (e.KeyCode == Keys.Escape)
            {
                e.Handled = true; e.SuppressKeyPress = true;
                if (textInput != null) DiscardText();
                else CancelOverlay();
                return;
            }
            if (e.KeyCode == Keys.Enter)
            {
                e.Handled = true; e.SuppressKeyPress = true;
                if (textInput != null) CommitText();
                else if (stage == Stage.Selected) Confirm();
                return;
            }
            if (e.Control && e.KeyCode == Keys.Z && textInput == null)
            {
                e.Handled = true; e.SuppressKeyPress = true;
                Undo();
            }
        }

        // --- terminal actions ---

        void Confirm()
        {
            if (stage != Stage.Selected) return;
            CommitText();
            ResultBitmap = Annotator.Compose(frozen, sel, ops, sampler);
            DialogResult = DialogResult.OK;
        }

        void CancelOverlay()
        {
            DialogResult = DialogResult.Cancel;
        }

        /// Longshot scrolls LIVE content — annotations belong to a static
        /// selection, so only an unannotated selection can start one.
        void RequestLongshot()
        {
            if (stage != Stage.Selected || ops.Count > 0 || textInput != null) return;
            LongshotRect = sel;
            DialogResult = DialogResult.Yes;
        }
    }
}
