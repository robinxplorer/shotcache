// Promo screenshot driver. Spawns headless Chrome, drives the demo harness
// (real build output + mocked extension APIs) over the DevTools Protocol,
// seeds realistic tray/pending data, controls theme, draws a sample
// annotation, and captures crisp 2x PNGs into docs/promo-assets/.
//
//   npm run build && node demo/server.mjs   (separate terminal, port 4173)
//   node scripts/shoot.mjs
//
// Zero dependencies: uses Node 24's global WebSocket + fetch.

import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9333;
const BASE = 'http://localhost:4173';
const OUT = new URL('../docs/promo-assets/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const userDataDir = join(tmpdir(), 'shotcache-shoot-' + process.pid);

// ---------------------------------------------------------------- minimal CDP
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      } else if (m.method) {
        for (const h of this.handlers.slice()) h(m);
      }
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  once(method, sessionId) {
    return new Promise((res) => {
      const h = (m) => {
        if (m.method === method && (!sessionId || m.sessionId === sessionId)) {
          this.handlers = this.handlers.filter((x) => x !== h);
          res(m.params);
        }
      };
      this.handlers.push(h);
    });
  }
}

// ----------------------------------------------------------- page-side seeding
// Runs in the browser. Builds a synthetic "captured webpage", writes tray +
// pending records to the same IndexedDB the real bundles read. Returns ids.
async function pageSeed(opts) {
  function rr(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }
  function drawPage() {
    const c = document.createElement('canvas');
    c.width = 1280;
    c.height = 760;
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, 1280, 760);
    const grad = g.createLinearGradient(0, 0, 1280, 0);
    grad.addColorStop(0, '#6d4aff');
    grad.addColorStop(1, '#8b5cff');
    g.fillStyle = grad;
    g.fillRect(0, 0, 1280, 64);
    g.fillStyle = '#fff';
    g.font = 'bold 22px system-ui';
    g.fillText('Example Dev Blog', 32, 40);
    g.font = '14px system-ui';
    g.globalAlpha = 0.9;
    g.fillText('首页      文档      API      关于', 1010, 40);
    g.globalAlpha = 1;
    g.fillStyle = '#16161a';
    g.font = 'bold 30px system-ui';
    g.fillText('MV3 扩展的权限模型：activeTab 与 host_permissions', 64, 150);
    g.fillStyle = '#8b8b96';
    g.font = '13px system-ui';
    g.fillText('2026-06-11 · 阅读 8 分钟 · Example Dev Blog', 64, 180);
    g.fillStyle = '#dadae2';
    for (let i = 0; i < 4; i++) g.fillRect(64, 210 + i * 22, i === 3 ? 420 : 760, 11);
    // credential card (a mosaic-worthy target)
    g.fillStyle = '#fff7e6';
    g.fillRect(64, 320, 470, 58);
    g.strokeStyle = '#ffd591';
    g.strokeRect(64, 320, 470, 58);
    g.fillStyle = '#ad6800';
    g.font = '13px system-ui';
    g.fillText('内部凭据（截图外发前请打码）', 80, 343);
    g.fillStyle = '#16161a';
    g.font = 'bold 15px monospace';
    g.fillText('API_KEY = sk-demo-9f27-SECRET-c41a', 80, 367);
    // bar chart
    g.fillStyle = '#16161a';
    g.font = 'bold 15px system-ui';
    g.fillText('扩展安装量（周）', 760, 300);
    [42, 60, 84, 70, 110, 132, 96].forEach((h, i) => {
      g.fillStyle = i === 5 ? '#22c55e' : '#8b5cff';
      g.fillRect(760 + i * 44, 470 - h, 28, h);
    });
    g.strokeStyle = '#cfd0d8';
    g.beginPath();
    g.moveTo(754, 472);
    g.lineTo(1080, 472);
    g.stroke();
    // CTA
    g.fillStyle = '#22c55e';
    rr(g, 64, 430, 160, 42, 8);
    g.fill();
    g.fillStyle = '#fff';
    g.font = 'bold 15px system-ui';
    g.fillText('下载示例代码', 96, 456);
    g.fillStyle = '#e7e7ee';
    for (let i = 0; i < 3; i++) g.fillRect(64, 520 + i * 22, 660, 10);
    return c;
  }
  function thumbOf(canvas, w) {
    const h = Math.round((canvas.height / canvas.width) * w);
    const t = document.createElement('canvas');
    t.width = w;
    t.height = h;
    t.getContext('2d').drawImage(canvas, 0, 0, w, h);
    return t.toDataURL('image/png');
  }

  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open('shotcache', 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('tray')) d.createObjectStore('tray', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('pending')) d.createObjectStore('pending', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  function put(store, val) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, 'readwrite');
      t.objectStore(store).put(val);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }
  function clear(store) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, 'readwrite');
      t.objectStore(store).clear();
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }
  await clear('tray');
  await clear('pending');

  const page = drawPage();
  const dataUrl = page.toDataURL('image/png');
  const blob = await (await fetch(dataUrl)).blob();
  const thumb = thumbOf(page, 360);
  const now = Date.now();
  const min = 60000;

  const imageId = 'img-' + now;
  await put('tray', {
    id: imageId,
    kind: 'image',
    createdAt: now,
    title: 'MV3 权限模型对比图',
    sourceUrl: 'https://example.com/articles/mv3-permissions',
    thumb,
    blob,
  });
  const linkId = 'lnk-' + now;
  await put('tray', {
    id: linkId,
    kind: 'link',
    createdAt: now - 6 * min,
    title: 'MV3 扩展的权限模型 · Example Dev Blog',
    sourceUrl: 'https://example.com/articles/mv3-permissions',
    text: 'https://example.com/articles/mv3-permissions',
  });
  const codeId = 'code-' + now;
  await put('tray', {
    id: codeId,
    kind: 'code',
    createdAt: now - 22 * min,
    title: 'function injectPaste(file, target)',
    text:
      'function injectPaste(file, target) {\n' +
      '  const dt = new DataTransfer();\n' +
      '  dt.items.add(file);\n' +
      "  target.dispatchEvent(new ClipboardEvent('paste', {\n" +
      '    clipboardData: dt, bubbles: true,\n' +
      '  }));\n' +
      '}',
  });
  const noteId = 'note-' + now;
  await put('tray', {
    id: noteId,
    kind: 'text',
    createdAt: now - 55 * min,
    title: '记得给凭据打码再发给 AI',
    text: '记得给凭据打码再发给 AI；想问 Claude 这个扩展的 host 权限范围是不是开大了。',
  });

  const pendingId = 'pend-' + now;
  await put('pending', {
    id: pendingId,
    createdAt: now,
    dataUrl,
    rect: { x: 40, y: 90, w: 1180, h: 470 },
    dpr: 1,
    sourceUrl: 'https://example.com/articles/mv3-permissions',
    sourceTitle: 'MV3 扩展的权限模型 · Example Dev Blog',
  });

  db.close();
  return { imageId, linkId, codeId, noteId, pendingId, sendOrder: [imageId, noteId] };
}

// --------------------------------------------------------------------- runner
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + userDataDir,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let ws;
try {
  // wait for the debugging endpoint
  let version;
  for (let i = 0; i < 60; i++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      break;
    } catch {
      await sleep(200);
    }
  }
  if (!version) throw new Error('chrome devtools endpoint never came up');

  ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  const cdp = new CDP(ws);

  async function newPage() {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    return { targetId, sessionId };
  }
  async function metrics(sid, w, h) {
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: w, height: h, deviceScaleFactor: 2, mobile: false },
      sid,
    );
  }
  async function media(sid, scheme) {
    await cdp.send(
      'Emulation.setEmulatedMedia',
      { features: [{ name: 'prefers-color-scheme', value: scheme }] },
      sid,
    );
  }
  async function go(sid, url) {
    const loaded = cdp.once('Page.loadEventFired', sid);
    await cdp.send('Page.navigate', { url }, sid);
    await loaded;
  }
  async function evalA(sid, expr) {
    const r = await cdp.send(
      'Runtime.evaluate',
      { expression: expr, awaitPromise: true, returnByValue: true },
      sid,
    );
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
  async function shoot(sid, file, clip) {
    const params = { format: 'png', captureBeyondViewport: true };
    if (clip) params.clip = { ...clip, scale: 1 };
    const { data } = await cdp.send('Page.captureScreenshot', params, sid);
    writeFileSync(new URL(file, OUT), Buffer.from(data, 'base64'));
    console.log('  wrote', file);
  }
  async function mouse(sid, type, x, y) {
    await cdp.send(
      'Input.dispatchMouseEvent',
      { type, x, y, button: 'left', buttons: type === 'mouseMoved' ? 1 : 1, clickCount: 1 },
      sid,
    );
  }
  async function close(targetId) {
    await cdp.send('Target.closeTarget', { targetId });
  }

  const seedExpr = `(${pageSeed.toString()})()`;

  // ---- 1 & 2: tray (popup), dark and light ----
  for (const scheme of ['dark', 'light']) {
    console.log(`scene: tray-${scheme}`);
    const { targetId, sessionId } = await newPage();
    await media(sessionId, scheme);
    await metrics(sessionId, 460, 1000);
    await go(sessionId, `${BASE}/popup.html`);
    await evalA(sessionId, seedExpr);
    await evalA(sessionId, `localStorage.setItem('shotcache.theme','${scheme}'); 1`);
    await go(sessionId, `${BASE}/popup.html`);
    await sleep(700);
    const size = await evalA(
      sessionId,
      `({w: Math.ceil(document.body.scrollWidth), h: Math.ceil(document.body.scrollHeight)})`,
    );
    await shoot(sessionId, `tray-${scheme}.png`, { x: 0, y: 0, width: size.w, height: size.h });
    await close(targetId);
  }

  // ---- 3: editor with a sample annotation ----
  {
    console.log('scene: editor');
    const { targetId, sessionId } = await newPage();
    await media(sessionId, 'dark');
    await metrics(sessionId, 1180, 760);
    await go(sessionId, `${BASE}/popup.html`);
    const ids = await evalA(sessionId, seedExpr);
    await evalA(sessionId, `localStorage.setItem('shotcache.theme','dark'); 1`);
    await go(sessionId, `${BASE}/editor.html?capture=${ids.pendingId}`);
    await sleep(1200);
    // draw a rectangle annotation (default tool) over the credential card area
    try {
      const box = await evalA(
        sessionId,
        `(() => { const r = document.getElementById('canvas').getBoundingClientRect();
          return {l:r.left,t:r.top,w:r.width,h:r.height}; })()`,
      );
      const ax = box.l + box.w * 0.04;
      const ay = box.t + box.h * 0.42;
      const bx = box.l + box.w * 0.42;
      const by = box.t + box.h * 0.6;
      await mouse(sessionId, 'mousePressed', ax, ay);
      await mouse(sessionId, 'mouseMoved', (ax + bx) / 2, (ay + by) / 2);
      await mouse(sessionId, 'mouseMoved', bx, by);
      await mouse(sessionId, 'mouseReleased', bx, by);
      await sleep(300);
    } catch (e) {
      console.log('  annotation skipped:', e.message);
    }
    const size = await evalA(
      sessionId,
      `({w: Math.ceil(document.documentElement.scrollWidth), h: Math.ceil(document.documentElement.scrollHeight)})`,
    );
    await shoot(sessionId, 'editor.png', { x: 0, y: 0, width: size.w, height: size.h });
    await close(targetId);
  }

  // ---- 4: hero (demo台) with composer injected ----
  {
    console.log('scene: hero');
    const { targetId, sessionId } = await newPage();
    await media(sessionId, 'dark');
    await metrics(sessionId, 1440, 880);
    await go(sessionId, `${BASE}/popup.html`);
    const ids = await evalA(sessionId, seedExpr);
    await go(sessionId, `${BASE}/`);
    await sleep(1500); // let the editor iframe + synthetic capture settle
    await evalA(
      sessionId,
      `window.dispatchEvent(new MessageEvent('message',{data:{kind:'runtime',msg:{type:'SEND_ITEMS',target:'claude',itemIds:${JSON.stringify(
        ids.sendOrder,
      )}}}})); 1`,
    );
    await sleep(900);
    await shoot(sessionId, 'hero.png');
    await close(targetId);
  }

  console.log('done.');
} finally {
  try {
    ws?.close();
  } catch {}
  chrome.kill();
  await sleep(300);
  try {
    rmSync(userDataDir, { recursive: true, force: true });
  } catch {}
}
