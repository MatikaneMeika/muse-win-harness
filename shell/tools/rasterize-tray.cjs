/**
 * Rasterize frontend/public/favicon.svg -> shell/resources/tray-icon.png (32x32).
 *
 * Run from the repo root: `node shell/tools/rasterize-tray.cjs`
 * Uses the Electron binary bundled in shell/node_modules (no extra deps):
 * a hidden BrowserWindow renders the SVG onto a transparent 32x32 canvas
 * and returns the PNG data URL; the main process writes the file.
 *
 * Logo source of truth is frontend/public/favicon.svg — after editing the
 * logo, re-run this script to refresh the tray PNG.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const svgPath = path.join(repoRoot, 'frontend', 'public', 'favicon.svg');
const outDir = path.join(repoRoot, 'shell', 'resources');
const outPath = path.join(outDir, 'tray-icon.png');
const electronExe = path.join(repoRoot, 'shell', 'node_modules', 'electron', 'dist', 'electron.exe');

// Electron main-process script, written to a temp file (extension .js so
// Electron's default app treats it as the main script) and executed with
// the bundled electron.exe. SVG/IO paths are passed via environment vars.
const ELECTRON_MAIN = `
const { app, BrowserWindow } = require('electron');
const fs = require('fs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  try {
    const svgPath = process.env.RASTER_SVG_PATH;
    const outPath = process.env.RASTER_OUT_PATH;
    const size = 32;

    // Give the SVG explicit pixel size (keep viewBox/gradient/paths as-is).
    let svg = fs.readFileSync(svgPath, 'utf8');
    svg = svg.replace('<svg width="120" height="120"', '<svg width="32" height="32"');

    const win = new BrowserWindow({
      show: false,
      transparent: true,
      frame: false,
      width: size,
      height: size,
      webPreferences: { sandbox: false },
    });

    const html = [
      '<!doctype html><html><head><style>html,body{margin:0;padding:0;background:transparent}</style></head><body>',
      '<script>',
      'window.__done = false; window.__result = null; window.__error = null;',
      'window.__start = (svg) => {',
      '  const img = new Image();',
      '  img.onload = () => {',
      '    try {',
      '      const c = document.createElement("canvas");',
      '      c.width = 32; c.height = 32;',
      '      const ctx = c.getContext("2d");',
      '      ctx.drawImage(img, 0, 0, 32, 32);',
      '      window.__result = c.toDataURL("image/png");',
      '    } catch (e) { window.__error = String(e); }',
      '    window.__done = true;',
      '  };',
      '  img.onerror = (e) => { window.__error = "image load error: " + String(e); window.__done = true; };',
      '  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);',
      '};',
      '<\\/script>',
      '</body></html>',
    ].join('\\n');

    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await win.webContents.executeJavaScript('window.__start(' + JSON.stringify(svg) + '); void 0;', true);

    for (let i = 0; i < 200; i += 1) {
      const done = await win.webContents.executeJavaScript('window.__done', true);
      if (done) break;
      await sleep(50);
    }

    const res = await win.webContents.executeJavaScript(
      '({ result: window.__result, error: window.__error })',
      true,
    );
    if (!res.result) {
      console.error('RASTER_FAILED: ' + (res.error || 'canvas result missing'));
      app.exit(1);
      return;
    }

    const base64 = res.result.slice(res.result.indexOf(',') + 1);
    fs.writeFileSync(outPath, Buffer.from(base64, 'base64'));
    win.destroy();
    console.log('RASTER_OK ' + outPath);
    app.exit(0);
  } catch (err) {
    console.error('RASTER_FAILED: ' + (err && err.stack ? err.stack : String(err)));
    app.exit(1);
  }
});

// Hard timeout so the electron child never hangs forever.
setTimeout(() => {
  console.error('RASTER_FAILED: timed out after 20s');
  app.exit(1);
}, 20000).unref();
`;

function main() {
  if (!fs.existsSync(svgPath)) {
    console.error(`RASTER_FAILED: SVG not found: ${svgPath}`);
    process.exit(1);
  }
  if (!fs.existsSync(electronExe)) {
    console.error(`RASTER_FAILED: electron.exe not found: ${electronExe}`);
    process.exit(1);
  }

  fs.mkdirSync(outDir, { recursive: true });

  const tmpMain = path.join(os.tmpdir(), 'mwh-raster-electron-main.js');
  fs.writeFileSync(tmpMain, ELECTRON_MAIN, 'utf8');

  const child = spawn(electronExe, [tmpMain], {
    cwd: repoRoot,
    windowsHide: true,
    stdio: 'inherit',
    env: {
      ...process.env,
      RASTER_SVG_PATH: svgPath,
      RASTER_OUT_PATH: outPath,
      // keep devtools/GPU noise out of the smoke run
      ELECTRON_ENABLE_LOGGING: '0',
    },
  });

  child.on('exit', (code) => {
    try { fs.unlinkSync(tmpMain); } catch { /* best effort */ }
    if (code === 0 && fs.existsSync(outPath)) {
      process.exit(0);
    }
    process.exit(code === 0 ? 1 : code);
  });

  child.on('error', (err) => {
    console.error(`RASTER_FAILED: spawn error: ${err}`);
    process.exit(1);
  });
}

main();
