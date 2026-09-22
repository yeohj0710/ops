import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const PW = [
  path.join(process.env.APPDATA || "", "npm/node_modules/playwright/index.mjs"),
  path.join(os.homedir(), "AppData/Roaming/npm/node_modules/playwright/index.mjs"),
];
async function loadChromium() {
  try { return (await import("playwright")).chromium; } catch {}
  for (const p of PW) if (p && fs.existsSync(p)) return (await import(pathToFileURL(p).href)).chromium;
  throw new Error("no playwright");
}

const NAMES = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const OUT = process.argv[3];
const PROFILE = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData/Local"), "ops", "ig-session");

function readTiles() {
  const anchors = [...document.querySelectorAll('main a[href]')].filter(a => /\/reel\/[^/]+\//.test(a.getAttribute('href') || ''));
  const pin = /^(?:고정|고정됨|고정 게시물|고정된 게시물|pinned|pinned post)$/i;
  return {
    priv: /비공개 계정입니다|This Account is Private/.test((document.body.innerText || '').slice(0, 3000)),
    wall: !!document.querySelector('input[name="username"]'),
    tiles: anchors.map(a => ({
      code: (a.getAttribute('href') || '').split('/reel/')[1].split('/')[0],
      views: (a.innerText || '').trim().split('\n')[0],
      pinned: [...(a.parentElement || a).querySelectorAll('[aria-label]')].some(n => pin.test((n.getAttribute('aria-label') || '').trim())),
    })),
  };
}

const chromium = await loadChromium();
fs.mkdirSync(PROFILE, { recursive: true });
let ctx;
try { ctx = await chromium.launchPersistentContext(PROFILE, { headless: true, channel: "chrome", viewport: { width: 1280, height: 900 }, args: ["--disable-blink-features=AutomationControlled"] }); }
catch { ctx = await chromium.launchPersistentContext(PROFILE, { headless: true, viewport: { width: 1280, height: 900 } }); }
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(2500);

const res = {};
for (const name of NAMES) {
  try {
    await page.goto("https://www.instagram.com/" + encodeURIComponent(name) + "/reels/", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(2500);
    for (let s = 0; s < 3; s++) {
      const before = await page.evaluate(() => document.querySelectorAll('main a[href*="/reel/"]').length);
      await page.mouse.wheel(0, 1400).catch(() => {});
      await page.waitForTimeout(1400);
      const after = await page.evaluate(() => document.querySelectorAll('main a[href*="/reel/"]').length);
      if (after <= before && after > 0) break;
    }
    res[name] = await page.evaluate(readTiles);
  } catch (e) { res[name] = { err: String(e).slice(0, 120) }; }
  console.log(name, res[name].err ? "ERR" : (res[name].tiles || []).length, res[name].wall ? "WALL" : "", res[name].priv ? "PRIV" : "");
  fs.writeFileSync(OUT, JSON.stringify(res, null, 1));
  await page.waitForTimeout(900);
}
await ctx.close();
console.log("done");
