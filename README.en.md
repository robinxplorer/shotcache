# Shotcache

**English** · [简体中文](README.md)

<p align="center">
  <img src="screenshots/shotcache.gif" alt="demostration of ShotCache" width="900">
</p>
<p align="center"><em>Demostration of ShotCache</em></p>

A Chrome extension that gives you WeChat-grade screenshotting, a few-day stash tray, and one-click hand-off to AI chats. It's two halves: a Chrome extension (WXT + TypeScript + MV3) and a tiny Windows companion (C#, compiled on your own machine, **no binaries in the repo**). Press `Ctrl+Alt+A` in any app to frame, annotate, or scroll-capture a long screenshot; every shot lands in both the clipboard and a tray, and the stuff you've stashed can be checked off and injected straight into the composer of **Claude / ChatGPT / Gemini**.

<p align="center">
  <img src="screenshots/hero.png" alt="Capture → stash tray → one-click inject into Claude" width="900">
</p>
<p align="center"><em>Capture &amp; annotate → stash in the tray → tick items → injected into the AI composer in one click.</em></p>
<br>
<p align="center">
  <img src="screenshots/shotcache-01.png" alt="screenshot" width="900">
</p>
<p align="center"><em>ScreenShot Tool Box</em></p>
<br>
<p align="center">
  <img src="screenshots/shotcache-02.png" alt="long-screenshot" width="900">
</p>
<p align="center"><em>Long ScreenShot Tool Box</em></p>

> **Platform:** Windows. The extension itself is cross-platform, but the WeChat-grade capture experience needs the Windows companion; on macOS/Linux the extension still works via the in-browser fallback (see below).

## The problem it solves

The real workflow of feeding screenshots to an AI is fragmented: capture one → switch to the chat tab → paste → switch back to capture the next… your material is scattered across the clipboard and the downloads folder, the clipboard only ever holds the last image, and the chat is gone the moment you close it.

WeChat's screenshot (Alt+W) nailed the experience — instant hotkey, frame right on the screen, hit Enter and you're done — but it keeps no record; shots aren't stashed for later batch use. A pure Chrome extension, meanwhile, *can't* deliver that experience: platform rules force a "choose what to share" dialog, framing can only happen inside a web page, and the hotkey can't leave the browser.

Shotcache moves the capture front-end into a desktop companion to win back the WeChat-grade feel, and keeps storage + injection in the extension to serve the AI workflow — each side doing what it's best at.

## Features

- **WeChat-grade capture, but with a record.** `Ctrl+Alt+A` → overlay 1:1 framing (drag the corners to fine-tune) → annotate from the toolbar beside the selection → Enter and you're out. No dialogs, no extra tabs, focus returns to the original app; the shot is silently stashed in the tray, reachable for 7 days.
- **Two destinations at once.** Every shot goes to both the clipboard (paste immediately, DIB + PNG) and the tray (stash up to batch-send later).
- **Full annotation.** Rectangle / ellipse / arrow / text / mosaic / emoji, an 8-color palette + three stroke weights. The in-browser editor also has a **Select** tool — pick an already-drawn annotation to move / delete / recolor / re-weight / double-click to re-type.
- **Scrolling long capture.** From the overlay's "⇳ Long shot", frame the area, then scroll down by hand while it stitches as you go (image matching auto-dedupes; pinned top/bottom bars are kept only once). Hit "Done" to annotate in the editor, then stash.
- **Built for the AI workflow.** Tick a few tray entries (screenshots / links / notes / code) → one click injects them into the AI composer; code is auto-wrapped in a Markdown code block, reusing the site's own paste-upload pipeline.
- **Dark / light dual theme.** The extension pages (tray / editor) use an "Ink + Violet" palette, following the system by default; tap 🌗 to flip and it remembers your choice. The native overlay is always dark + violet accents (the most reliable contrast floating over any screen); the violet is shared across both halves for a consistent look.
- **Auditable, low-privilege.** The companion is compiled by Windows' built-in csc.exe on your machine (**no binaries shipped in the repo**); it writes only to HKCU in the registry, needs no admin rights, and has no auto-start (it lives and dies with Chrome). The extension's permissions are minimal — no `<all_urls>`, no `activeTab`/`scripting`, just host permissions for the three send targets. It works without the companion too: full-screen capture automatically falls back to Chrome's screen picker, so nothing breaks.

<p align="center">
  <img src="screenshots/editor.png" alt="Annotation editor" width="850">
</p>
<p align="center"><em>The annotation editor: tools, 8-color palette, color emoji sheet, stroke weights, and a Select tool.</em></p>

## Install

```bash
npm install && npm run build      # output in .output/chrome-mv3/
```

`chrome://extensions` → Developer mode → Load unpacked → pick `.output/chrome-mv3`, then install the companion (this is what gives you the WeChat-grade capture):

```powershell
# Copy the extension ID (the 32 lowercase letters on the chrome://extensions card), then in the repo root:
powershell -ExecutionPolicy Bypass -File native-host\install.ps1 -ExtensionId <EXTENSION_ID>
# Reload the extension — no need to restart Chrome. Uninstall: uninstall.ps1
```

## Usage

| Entry point | What it does |
|---|---|
| `Ctrl+Alt+A` (global, any app) | Overlay framing → annotate → Enter = copy + stash |
| Overlay toolbar "⇳ Long shot" | Frame, scroll down by hand to stitch, hit "Done" → annotate in the editor then stash / "Cancel" to discard (any app) |
| popup "⛶ Start capture" / `Alt+Shift+F` | Same as the overlay (triggered from inside Chrome) |
| popup "⚙ Settings" | Customize the global hotkey (record a combo); the Chrome command shortcut gets a jump-out link |
| popup "+Link / +Note / +Code" | Stash non-image material |
| popup / editor "🌗" | Dark / light theme toggle (follows system by default, remembers your choice) |

Overlay shortcuts: `Ctrl+Z` undo, `Esc` cancel, right-click to clear the selection and re-frame, double-click or Enter to finish. Tray (open by clicking the extension icon): search, view originals, tick → choose a target → send; entries auto-expire after 7 days (adjustable in `shared/config.ts`). The extension's own command shortcut is editable at `chrome://extensions/shortcuts`.

A few edges worth knowing: the global hotkey only works while Chrome is running (if it's taken, the popup shows a notice at the top); the overlay long shot is driven by *your* manual scrolling (scroll too fast and you'll drop content — go slower for stability), and animation inside the selection can break stitching; without the companion, full-screen capture falls back to Chrome's screen picker (a confirmation dialog pops once each time).

<p align="center">
  <img src="screenshots/tray.png" alt="Stash tray" width="380">
  &nbsp;&nbsp;
  <img src="screenshots/theme-light.png" alt="Light theme" width="380">
</p>
<p align="center"><em>The stash tray — dark (default) and light themes.</em></p>

## Development

```bash
npm run compile      # tsc --noEmit
npm run build        # wxt build
npm run zip          # store-uploadable zip
npm run dev          # HMR (content-script changes need a manual page reload)
```

Host self-test (no Chrome needed): `powershell -ExecutionPolicy Bypass -File native-host\test-host.ps1`, expect two lines — `PASS v2: ...` (protocol) and `STITCH PASS: ...` (long-capture stitching regression on synthetic frames).

## License

LGPL-2.1 (see [LICENSE](LICENSE)).
