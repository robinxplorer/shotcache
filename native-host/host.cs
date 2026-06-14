// Shotcache native capture host v2 — resident WeChat-style capture frontend.
//
// v1 was a dumb one-shot screen grabber; v2 owns the whole capture UX:
// the extension keeps a persistent native-messaging port open (our 20s pings
// reset the MV3 service worker's 30s idle timer, so the port lives forever),
// and a GLOBAL hotkey (default Ctrl+Alt+A, user-configurable via set-hotkey)
// is registered here — capture works from any application while Chrome runs.
//
// Protocol (4-byte little-endian length prefix + UTF-8 JSON, both ways):
//   ext -> host: {"cmd":"hello"}
//                {"cmd":"capture"}                  full overlay flow
//                {"cmd":"capture","headless":true}  protocol test: full screen,
//                                                   no overlay, no clipboard
//                {"cmd":"emoji-sheet","entries":[{"ch":"👍","data":"<b64 png>"}]}
//                                                   color emoji glyphs rendered
//                                                   by the extension (GDI+ has
//                                                   no COLR support)
//                {"cmd":"set-hotkey","mods":N,"vk":N,"label":"Ctrl+Alt+A"}
//                                                   re-register the global
//                                                   hotkey (Win32 fsModifiers
//                                                   bitmask + virtual-key code)
//   host -> ext: {"type":"hello","version":2}
//                {"type":"ping"}                        every 20s
//                {"type":"shot-meta",width,height,chunks[,"spool":true][,"edit":true]}
//                                                   edit:true = open in the
//                                                   browser editor (longshot),
//                                                   not straight to the tray
//                {"type":"shot-chunk",seq,data} * N     base64, ~512KB each
//                {"type":"shot-done"}
//                {"type":"cancelled"}                   user pressed Esc
//                {"type":"error","message":...}
//                {"type":"hotkey-failed","message":...} after hello, if any
//                {"type":"hotkey-set","ok":bool[,"message":...]} reply to set-hotkey
//
// Flow per capture: freeze the virtual screen (GDI+), show OverlayForm
// (select + annotate), then ship the composed PNG BOTH to the clipboard
// (DIB + PNG formats) and over the port for the silent tray save. If the pipe
// is gone (Chrome quit mid-overlay), the PNG is spooled to
// %LOCALAPPDATA%\shotcache\spool and delivered on the next hello.
//
// Threading: [STAThread] UI thread runs Application.Run (overlay, clipboard,
// hotkey WndProc, ping timer); a background thread blocks on stdin and posts
// each command to the UI thread. stdout writes are serialized by a lock.
// stdin EOF = Chrome closed the port -> exit (after the overlay finishes).
//
// Built locally by install.ps1 with the csc.exe that ships in Windows
// (.NET Framework 4.x — keep this file C# 5 compatible: no interpolation,
// no null-conditional operators).

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace Shotcache
{
    static class ShotcacheHost
    {
        [DllImport("user32.dll")] static extern IntPtr SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
        [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr hWnd, int id);

        const uint MOD_ALT = 0x1, MOD_CONTROL = 0x2;
        const int HOTKEY_ID = 1;
        const int CHUNK = 512 * 1024; // chars per message, well under Chrome's 1 MB cap

        static Stream stdin, stdout;
        static readonly object writeLock = new object();
        static volatile bool pipeAlive = true;
        static bool busy;          // overlay open (UI thread only)
        static bool exitPending;   // pipe died while busy (UI thread only)
        static string hotkeyError;
        static bool owner;         // this process holds the single-instance mutex
        static int curMods = -1;   // currently registered hotkey (-1 = none)
        static int curVk = -1;
        static string curLabel = "Ctrl+Alt+A";
        static Form pump;          // hidden window: invoke anchor + WM_HOTKEY sink

        /// Hidden message window. Never shown; its handle carries the hotkey.
        class PumpForm : Form
        {
            protected override void WndProc(ref Message m)
            {
                if (m.Msg == 0x0312 /* WM_HOTKEY */)
                {
                    TriggerCapture();
                    return;
                }
                base.WndProc(ref m);
            }
        }

        [STAThread]
        static void Main()
        {
            // Without DPI awareness the captured bitmap comes back scaled
            // (blurry) on >100% displays. Per-Monitor V2, else system DPI.
            try
            {
                if (SetProcessDpiAwarenessContext(new IntPtr(-4)) == IntPtr.Zero) SetProcessDPIAware();
            }
            catch { try { SetProcessDPIAware(); } catch { } }

            stdin = Console.OpenStandardInput();
            stdout = Console.OpenStandardOutput();

            Application.EnableVisualStyles();
            pump = new PumpForm();
            IntPtr handle = pump.Handle; // force handle creation on this thread

            // One hotkey owner per machine. The 2s wait covers the exit race
            // when Chrome reloads the extension (old instance still closing).
            Mutex mutex = new Mutex(false, "Local\\shotcache-host");
            try { owner = mutex.WaitOne(2000); }
            catch (AbandonedMutexException) { owner = true; }

            if (!owner)
            {
                hotkeyError = "另一个 shotcache-host 实例已在运行";
            }
            else
            {
                // Register the user's saved hotkey (file cache, else Ctrl+Alt+A)
                // so it's live immediately; the extension re-pushes it on hello.
                int mods, vk; string label;
                LoadHotkey(out mods, out vk, out label);
                ApplyHotkey(mods, vk, label);
            }

            Thread reader = new Thread(ReadLoop);
            reader.IsBackground = true;
            reader.Start();

            // Message traffic resets the MV3 service worker's 30s idle timer;
            // a dead pipe is how we learn Chrome is gone when idle.
            System.Windows.Forms.Timer ping = new System.Windows.Forms.Timer();
            ping.Interval = 20000;
            ping.Tick += delegate
            {
                if (!Send("{\"type\":\"ping\"}")) OnPipeClosed();
            };
            ping.Start();

            Application.Run();

            if (owner)
            {
                try { UnregisterHotKey(handle, HOTKEY_ID); mutex.ReleaseMutex(); } catch { }
            }
        }

        // --- stdin (background thread) ---

        static void ReadLoop()
        {
            bool firstFrame = true;
            while (true)
            {
                byte[] header = ReadExact(stdin, 4);
                if (header == null) break; // pipe closed
                // Some launchers (e.g. a .NET StreamWriter test harness) push
                // a UTF-8 BOM down the pipe before the first frame; Chrome
                // never does. Skip it so the length prefix lines up.
                if (firstFrame && header[0] == 0xEF && header[1] == 0xBB && header[2] == 0xBF)
                {
                    byte[] rest = ReadExact(stdin, 3);
                    if (rest == null) break;
                    header = new byte[] { header[3], rest[0], rest[1], rest[2] };
                }
                firstFrame = false;
                int len = BitConverter.ToInt32(header, 0);
                if (len <= 0 || len > 64 * 1024) break; // commands are tiny; bail on nonsense
                byte[] payload = ReadExact(stdin, len);
                if (payload == null) break;

                string json = Encoding.UTF8.GetString(payload);
                try
                {
                    pump.BeginInvoke((MethodInvoker)delegate { HandleCommand(json); });
                }
                catch { break; } // pump disposed — already exiting
            }
            pipeAlive = false;
            try
            {
                pump.BeginInvoke((MethodInvoker)delegate { OnPipeClosed(); });
            }
            catch { }
        }

        // --- command dispatch (UI thread) ---

        static void HandleCommand(string json)
        {
            Dictionary<string, object> cmd = null;
            try
            {
                cmd = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(json);
            }
            catch { }
            string name = cmd != null && cmd.ContainsKey("cmd") ? Convert.ToString(cmd["cmd"]) : null;

            if (name == "hello")
            {
                Send("{\"type\":\"hello\",\"version\":2}");
                if (hotkeyError != null)
                {
                    Send("{\"type\":\"hotkey-failed\",\"message\":\"" + JsonEscape(hotkeyError) + "\"}");
                }
                FlushSpool();
            }
            else if (name == "capture")
            {
                bool headless = cmd.ContainsKey("headless") && cmd["headless"] is bool && (bool)cmd["headless"];
                if (headless) CaptureHeadless();
                else TriggerCapture();
            }
            else if (name == "emoji-sheet")
            {
                LoadEmojiSheet(cmd); // cosmetic-only; never answer, never throw
            }
            else if (name == "set-hotkey")
            {
                int mods = cmd.ContainsKey("mods") ? Convert.ToInt32(cmd["mods"]) : 0;
                int vk = cmd.ContainsKey("vk") ? Convert.ToInt32(cmd["vk"]) : 0;
                string label = cmd.ContainsKey("label") ? Convert.ToString(cmd["label"]) : "";
                if (mods == 0 || vk == 0)
                {
                    Send("{\"type\":\"hotkey-set\",\"ok\":false,\"message\":\"无效快捷键\"}");
                }
                else if (ApplyHotkey(mods, vk, label))
                {
                    SaveHotkey(mods, vk, label);
                    Send("{\"type\":\"hotkey-set\",\"ok\":true}");
                }
                else
                {
                    string why = hotkeyError != null ? hotkeyError : "注册失败";
                    Send("{\"type\":\"hotkey-set\",\"ok\":false,\"message\":\"" + JsonEscape(why) + "\"}");
                }
            }
            else
            {
                Send("{\"type\":\"error\",\"message\":\"unknown command\"}");
            }
        }

        /// {"entries":[{"ch":"👍","data":"<base64 png>"}]} -> EmojiRenderer.
        /// JavaScriptSerializer maps JSON arrays to ArrayList/object[] —
        /// accept any IEnumerable of dictionaries.
        static void LoadEmojiSheet(Dictionary<string, object> cmd)
        {
            try
            {
                object entriesObj;
                if (!cmd.TryGetValue("entries", out entriesObj)) return;
                System.Collections.IEnumerable list = entriesObj as System.Collections.IEnumerable;
                if (list == null || entriesObj is string) return;
                foreach (object item in list)
                {
                    Dictionary<string, object> en = item as Dictionary<string, object>;
                    if (en == null || !en.ContainsKey("ch") || !en.ContainsKey("data")) continue;
                    string ch = Convert.ToString(en["ch"]);
                    byte[] bytes = Convert.FromBase64String(Convert.ToString(en["data"]));
                    using (MemoryStream ms = new MemoryStream(bytes))
                    using (Bitmap fromStream = new Bitmap(ms))
                    {
                        EmojiRenderer.SetGlyph(ch, new Bitmap(fromStream)); // detach from stream
                    }
                }
            }
            catch { }
        }

        static void OnPipeClosed()
        {
            pipeAlive = false;
            if (busy) { exitPending = true; return; } // let the overlay finish; result spools
            Application.Exit();
        }

        // --- capture flows (UI thread) ---

        /// Full overlay flow: freeze screen -> select/annotate -> clipboard +
        /// port. A 「⇳ 长截图」 pick detaches into a LongshotSession, which
        /// finishes the capture asynchronously (busy stays true meanwhile).
        static void TriggerCapture()
        {
            if (busy)
            {
                Send("{\"type\":\"error\",\"message\":\"busy\"}");
                return;
            }
            busy = true;
            Bitmap frozen = null;
            bool detached = false; // a LongshotSession now owns completion
            try
            {
                frozen = GrabVirtualScreen();
                using (OverlayForm overlay = new OverlayForm(frozen))
                {
                    DialogResult r = overlay.ShowDialog();
                    if (r == DialogResult.OK && overlay.ResultBitmap != null)
                    {
                        FinishShot(overlay.ResultBitmap);
                    }
                    else if (overlay.LongshotRect.HasValue)
                    {
                        // Overlay client coords -> screen coords (the virtual
                        // screen's origin is negative with a left/top monitor).
                        Rectangle sel = overlay.LongshotRect.Value;
                        Rectangle vs = SystemInformation.VirtualScreen;
                        LongshotSession session = new LongshotSession(
                            new Rectangle(sel.X + vs.X, sel.Y + vs.Y, sel.Width, sel.Height),
                            delegate(Bitmap shot)
                            {
                                if (shot != null) FinishLongshot(shot);
                                else Send("{\"type\":\"cancelled\"}");
                                EndCapture();
                            });
                        detached = true;
                        session.Start();
                    }
                    else
                    {
                        Send("{\"type\":\"cancelled\"}");
                    }
                }
            }
            catch (Exception e)
            {
                Send("{\"type\":\"error\",\"message\":\"" + JsonEscape(e.Message) + "\"}");
            }
            finally
            {
                if (frozen != null) frozen.Dispose();
                if (!detached) EndCapture();
            }
        }

        /// Shared finish: clipboard + port (or spool). Takes ownership.
        static void FinishShot(Bitmap shot)
        {
            SetClipboard(shot);
            bool sent = pipeAlive && SendShot(shot, false, false);
            if (!sent) SpoolShot(shot);
            shot.Dispose();
        }

        /// Long screenshots can't be annotated during the live scroll, so hand
        /// the stitched image to the browser editor (edit=true) instead of the
        /// tray — same flow as a page capture. No clipboard yet; the editor's
        /// 复制 / 存入托盘 finish it. Fallback if Chrome is gone: clipboard + spool.
        static void FinishLongshot(Bitmap shot)
        {
            bool sent = pipeAlive && SendShot(shot, false, true);
            if (!sent)
            {
                SetClipboard(shot);
                SpoolShot(shot);
            }
            shot.Dispose();
        }

        static void EndCapture()
        {
            busy = false;
            if (exitPending || !pipeAlive) Application.Exit();
        }

        /// Protocol-test path: full virtual screen, no overlay, no clipboard.
        static void CaptureHeadless()
        {
            try
            {
                using (Bitmap bmp = GrabVirtualScreen())
                {
                    SendShot(bmp, false, false);
                }
            }
            catch (Exception e)
            {
                Send("{\"type\":\"error\",\"message\":\"" + JsonEscape(e.Message) + "\"}");
            }
        }

        /// VirtualScreen spans every monitor (origin can be negative when a
        /// secondary display sits left of / above the primary).
        static Bitmap GrabVirtualScreen()
        {
            Rectangle vs = SystemInformation.VirtualScreen;
            Bitmap bmp = new Bitmap(vs.Width, vs.Height, PixelFormat.Format32bppArgb);
            try
            {
                using (Graphics g = Graphics.FromImage(bmp))
                {
                    g.CopyFromScreen(vs.X, vs.Y, 0, 0, vs.Size);
                }
            }
            catch
            {
                bmp.Dispose();
                throw;
            }
            return bmp;
        }

        // --- result delivery ---

        /// Clipboard gets BOTH the classic bitmap format (legacy apps) and a
        /// PNG stream (modern apps keep transparency / exact pixels).
        /// Failure here must never kill the tray delivery — swallow it.
        static void SetClipboard(Bitmap bmp)
        {
            try
            {
                DataObject d = new DataObject();
                d.SetData(DataFormats.Bitmap, true, bmp);
                MemoryStream png = new MemoryStream();
                bmp.Save(png, ImageFormat.Png);
                d.SetData("PNG", false, png);
                Clipboard.SetDataObject(d, true, 5, 100);
            }
            catch { }
        }

        static bool SendShot(Bitmap bmp, bool spool, bool edit)
        {
            string b64;
            using (MemoryStream ms = new MemoryStream())
            {
                bmp.Save(ms, ImageFormat.Png);
                b64 = Convert.ToBase64String(ms.ToArray());
            }
            return SendShotB64(b64, bmp.Width, bmp.Height, spool, edit);
        }

        static bool SendShotB64(string b64, int w, int h, bool spool, bool edit)
        {
            int total = (b64.Length + CHUNK - 1) / CHUNK;
            string meta = "{\"type\":\"shot-meta\",\"width\":" + w + ",\"height\":" + h
                + ",\"chunks\":" + total + (spool ? ",\"spool\":true" : "")
                + (edit ? ",\"edit\":true" : "") + "}";
            if (!Send(meta)) return false;
            for (int i = 0; i < total; i++)
            {
                string part = b64.Substring(i * CHUNK, Math.Min(CHUNK, b64.Length - i * CHUNK));
                if (!Send("{\"type\":\"shot-chunk\",\"seq\":" + i + ",\"data\":\"" + part + "\"}")) return false;
            }
            return Send("{\"type\":\"shot-done\"}");
        }

        // --- global hotkey (configurable; storage in the extension is the
        //     source of truth, this file is just a boot-time cache) ---

        /// (Re)register the global hotkey on the pump window (UI thread only).
        /// Sets hotkeyError + returns false on failure, clears it on success.
        static bool ApplyHotkey(int mods, int vk, string label)
        {
            if (!owner) { hotkeyError = "另一个 shotcache-host 实例已在运行"; return false; }
            if (curMods >= 0)
            {
                try { UnregisterHotKey(pump.Handle, HOTKEY_ID); } catch { }
                curMods = -1; curVk = -1;
            }
            if (RegisterHotKey(pump.Handle, HOTKEY_ID, (uint)mods, (uint)vk))
            {
                curMods = mods; curVk = vk; curLabel = label;
                hotkeyError = null;
                return true;
            }
            hotkeyError = (label != null && label.Length > 0 ? label : "快捷键") + " 已被其他程序占用";
            return false;
        }

        static string HotkeyFile()
        {
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                Path.Combine("shotcache", "hotkey.json"));
        }

        /// Boot-time hotkey: the cached file, else the Ctrl+Alt+A default.
        static void LoadHotkey(out int mods, out int vk, out string label)
        {
            mods = (int)(MOD_CONTROL | MOD_ALT); vk = (int)'A'; label = "Ctrl+Alt+A";
            try
            {
                string f = HotkeyFile();
                if (!File.Exists(f)) return;
                Dictionary<string, object> d =
                    new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(f));
                if (d == null) return;
                if (d.ContainsKey("mods")) mods = Convert.ToInt32(d["mods"]);
                if (d.ContainsKey("vk")) vk = Convert.ToInt32(d["vk"]);
                if (d.ContainsKey("label")) label = Convert.ToString(d["label"]);
            }
            catch { }
        }

        static void SaveHotkey(int mods, int vk, string label)
        {
            try
            {
                string f = HotkeyFile();
                Directory.CreateDirectory(Path.GetDirectoryName(f));
                File.WriteAllText(f,
                    "{\"mods\":" + mods + ",\"vk\":" + vk + ",\"label\":\"" + JsonEscape(label) + "\"}");
            }
            catch { }
        }

        // --- spool: shots that outlived their pipe ---

        static string SpoolDir()
        {
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                Path.Combine("shotcache", "spool"));
        }

        static void SpoolShot(Bitmap bmp)
        {
            try
            {
                string dir = SpoolDir();
                Directory.CreateDirectory(dir);
                string name = DateTime.Now.ToString("yyyyMMdd-HHmmss-fff") + "-"
                    + Guid.NewGuid().ToString("N").Substring(0, 6) + ".png";
                bmp.Save(Path.Combine(dir, name), ImageFormat.Png);
            }
            catch { } // the clipboard copy still has the shot
        }

        /// Deliver spooled shots (marked "spool":true so the protocol test can
        /// skip them) and delete each one once its shot-done went through.
        static void FlushSpool()
        {
            try
            {
                string dir = SpoolDir();
                if (!Directory.Exists(dir)) return;
                string[] files = Directory.GetFiles(dir, "*.png");
                Array.Sort(files);
                foreach (string f in files)
                {
                    bool corrupt = false;
                    try
                    {
                        byte[] bytes = File.ReadAllBytes(f);
                        int w, h;
                        if (!ReadPngSize(bytes, out w, out h)) corrupt = true;
                        else if (!SendShotB64(Convert.ToBase64String(bytes), w, h, true, false)) break;
                    }
                    catch { corrupt = true; }
                    try { File.Delete(f); } catch { }
                    if (corrupt) continue;
                }
            }
            catch { }
        }

        /// IHDR width/height live at fixed offsets right after the signature.
        static bool ReadPngSize(byte[] b, out int w, out int h)
        {
            w = 0; h = 0;
            if (b.Length < 24 || b[0] != 0x89 || b[1] != 0x50 || b[2] != 0x4E || b[3] != 0x47) return false;
            w = (b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19];
            h = (b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23];
            return w > 0 && h > 0;
        }

        // --- framing ---

        /// Never throws; a failed write marks the pipe dead and returns false.
        static bool Send(string json)
        {
            if (!pipeAlive) return false;
            try
            {
                byte[] body = Encoding.UTF8.GetBytes(json);
                lock (writeLock)
                {
                    stdout.Write(BitConverter.GetBytes(body.Length), 0, 4);
                    stdout.Write(body, 0, body.Length);
                    stdout.Flush();
                }
                return true;
            }
            catch
            {
                pipeAlive = false;
                return false;
            }
        }

        /// Read exactly n bytes; null on EOF.
        static byte[] ReadExact(Stream s, int n)
        {
            byte[] buf = new byte[n];
            int off = 0;
            while (off < n)
            {
                int read;
                try { read = s.Read(buf, off, n - off); }
                catch { return null; }
                if (read <= 0) return null;
                off += read;
            }
            return buf;
        }

        static string JsonEscape(string s)
        {
            if (s == null) return "";
            StringBuilder sb = new StringBuilder(s.Length);
            foreach (char c in s)
            {
                if (c == '"' || c == '\\') sb.Append('\\').Append(c);
                else if (c < ' ') sb.Append(' ');
                else sb.Append(c);
            }
            return sb.ToString();
        }
    }
}
