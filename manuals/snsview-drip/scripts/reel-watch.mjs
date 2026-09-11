#!/usr/bin/env node
// 인스타 계정에 새 릴스가 올라오면 조회수 분할 주문(snsview-drip.mjs start)을 알아서 시작한다.
// 윈도우 예약 작업이 정해 둔 시각에 tick 을 부른다. tick 은 로그인 없는 헤드리스 크롬으로
// 프로필 첫 화면을 한 번 읽고, 지난번에 없던 릴스가 있으면 주문을 넣고 윈도우 알림을 띄운다.
//
//   node reel-watch.mjs status                  설정, 예약, 마지막 확인, 오늘 넣은 묶음 수
//   node reel-watch.mjs tick [--dry]            한 번 확인한다. 예약 작업이 부른다
//   node reel-watch.mjs install                 예약을 걸고 곧바로 한 번 확인한다
//   node reel-watch.mjs remove                  예약을 지운다. 상태와 기록은 남긴다
//   node reel-watch.mjs notify [제목] [본문]     알림이 뜨는지 시험한다
//
// 옵션
//   --dry              읽고 판단만 찍는다. 주문, 상태 기록, 알림을 모두 건너뛴다
//   --config <파일>     설정 파일. 안 주면 ../reel-watch.json
//   --root <경로>       ops 저장소 위치. 예약 작업과 시험용
//   --grid-file <파일>  시험용. 프로필을 열지 않고 이 파일의 타일 목록을 읽은 것으로 친다
//
// 설정 파일 칸
//   account         감시할 인스타 계정
//   checkTimes      확인 시각 ("HH:MM" 목록). 바꿨으면 install 을 다시 친다
//   order           릴스 하나에 넣는 주문. qty, runs, every 를 snsview-drip.mjs start 에 그대로 넘긴다
//   dailyMax        하루에 새로 시작하는 묶음 수 한도
//   maxAgeHours     올라온 지 이보다 오래된 릴스는 주문하지 않고 알림만 띄운다
//   failAlertAfter  확인이 이 횟수만큼 연달아 실패하면 알림을 띄운다. 그 뒤로는 하루에 한 번
//
// 상태는 <OPS>/work/reel-watch/<계정>/state.json, 기록은 같은 폴더의 log.txt 다.
// 처음 확인할 때 이미 올라와 있던 릴스는 본 것으로 적고 주문하지 않는다.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const DRIP = path.join(HERE, "snsview-drip.mjs");

// ── 인자 ────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const cmd = argv[0] || "help";
const positional = (() => {
  const out = [];
  for (const a of argv.slice(1)) {
    if (a.startsWith("--")) break;
    out.push(a);
  }
  return out;
})();
const flag = (name, dflt = null) => {
  const i = argv.indexOf("--" + name);
  return i > -1 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const has = (name) => argv.includes("--" + name);

const NATURAL_OPS = path.resolve(HERE, "..", "..", "..");
const OPS = path.resolve(flag("root") || process.env.OPS_ROOT || NATURAL_OPS);
const DEFAULT_CONFIG = path.resolve(HERE, "..", "reel-watch.json");
const CONFIG = path.resolve(flag("config") || DEFAULT_CONFIG);
const DRY = has("dry");
// 저장소 밖 폴더나 다른 설정으로 돌리면 시험이다. 알림 제목에 [시험] 을 붙여 진짜 주문 알림과 가른다
const TEST = OPS !== NATURAL_OPS || CONFIG !== DEFAULT_CONFIG;
const TASK_NAME = "ops-reel-watch";
// 한 번 확인이 이보다 오래 걸리면 스스로 끝낸다. 예약 작업의 시간 제한은 안 먹는다.
// 예약이 띄우는 것은 wscript 이고, wscript 는 node 를 띄우자마자 빠지기 때문이다
const TICK_LIMIT_MS = 8 * 60 * 1000;
const LOCK_STALE_MS = 15 * 60 * 1000;
// 켜기 전에 올라온 릴스를 가르는 여유. 켜던 순간 화면에 아직 안 붙었던 릴스를 놓치지 않으려고 한 시간 봐준다
const ARM_GRACE_MS = 60 * 60 * 1000;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

// ── 공용 ────────────────────────────────────────────────────────────────────────
const p2 = (n) => String(n).padStart(2, "0");
function stamp(d = new Date()) {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}
const ymd = (d = new Date()) => stamp(d).slice(0, 10);
const hm = (ms) => (ms ? stamp(new Date(ms)).slice(0, 16) : "알 수 없음");
const num = (n) => Number(n).toLocaleString("ko-KR");
function ago(ms) {
  const min = Math.max(0, Math.round((Date.now() - ms) / 60000));
  return min < 60 ? `${min}분` : `${Math.floor(min / 60)}시간 ${min % 60}분`;
}

class ExitError extends Error {
  constructor(code, msg = "") {
    super(msg);
    this.code = code;
  }
}
function fail(msg, code = 2) {
  console.error(msg);
  throw new ExitError(code, String(msg).split("\n")[0]);
}
function readJson(f, dflt = null) {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, ""));
  } catch {
    return dflt;
  }
}
function writeJson(f, o) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(o, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, f);
}

function loadConfig() {
  const c = readJson(CONFIG);
  if (!c) fail(`설정 파일을 못 읽었다: ${CONFIG}`);
  const bad = [];
  if (!/^[A-Za-z0-9._]{1,30}$/.test(c.account || "")) bad.push("account");
  if (!Array.isArray(c.checkTimes) || !c.checkTimes.length || !c.checkTimes.every((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)))
    bad.push("checkTimes (HH:MM 목록)");
  const o = c.order || {};
  if (!Number.isInteger(o.qty) || o.qty <= 0 || !Number.isInteger(o.runs) || o.runs <= 0 || !o.every) bad.push("order.qty, order.runs, order.every");
  if (!Number.isInteger(c.dailyMax) || c.dailyMax < 1) bad.push("dailyMax");
  if (!(Number(c.maxAgeHours) > 0)) bad.push("maxAgeHours");
  if (!Number.isInteger(c.failAlertAfter) || c.failAlertAfter < 1) bad.push("failAlertAfter");
  if (bad.length) fail(`설정이 틀렸다 (${CONFIG}): ${bad.join(", ")}`);
  return c;
}
const workDir = (c) => path.join(OPS, "work", "reel-watch", c.account);

function logger(dir) {
  return (line) => {
    const s = `[${stamp()}] ${line}`;
    console.log(s);
    if (DRY) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, "log.txt"), s + "\n", "utf8");
    } catch {}
  };
}

// 예약이 겹쳐 부르거나 사람이 손으로 같이 부르면 같은 릴스에 묶음이 둘 생긴다. 잠금 파일로 하나만 돌린다
function takeLock(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "tick.lock");
  try {
    if (Date.now() - fs.statSync(f).mtimeMs < LOCK_STALE_MS) return null;
    fs.rmSync(f, { force: true }); // 오래된 잠금은 죽은 확인이 남긴 것이다
  } catch {}
  try {
    fs.writeFileSync(f, String(process.pid), { flag: "wx" });
    return f;
  } catch {
    return null;
  }
}

// ── 게시물 코드 ──────────────────────────────────────────────────────────────────
// 게시물 코드는 미디어 id 를 64진수로 적은 것이고, id 의 위쪽 41비트가 올린 시각(ms)이다.
// 1314220021721 은 인스타 id 체계의 기준 시각이다. 260911 에 릴스 페이지의 time[datetime] 두 건과 분까지 맞췄다.
// 이걸 쓰면 요청을 한 번 더 하지 않고 올린 시각을 안다
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const IG_EPOCH = 1314220021721n;
function uploadedAt(code) {
  if (!/^[A-Za-z0-9_-]{10,12}$/.test(code || "")) return null;
  const id = [...code].reduce((n, ch) => n * 64n + BigInt(B64.indexOf(ch)), 0n);
  const ms = Number((id >> 23n) + IG_EPOCH);
  // 말이 안 되는 값이면 버린다 (2016 년 전이거나 하루 넘게 앞날)
  return ms > Date.UTC(2016, 0, 1) && ms < Date.now() + 86400000 ? ms : null;
}
function linkCode(link) {
  const m = String(link || "").match(/\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}
// 사람이 시켜서 이미 넣은 묶음. 코드로 맞춘다. 주소 꼴(/p/, /reel/, 계정명 낀 주소)이 달라도 같은 게시물이다
function dripBatchesFor(code) {
  const dir = path.join(OPS, "work", "snsview-drip");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((d) => readJson(path.join(dir, d, "state.json")))
    .filter((s) => s && linkCode(s.link) === code)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

// ── 프로필 읽기 ──────────────────────────────────────────────────────────────────
const PW_CANDIDATES = [
  path.join(process.env.APPDATA || "", "npm/node_modules/playwright/index.mjs"),
  path.join(os.homedir(), "AppData/Roaming/npm/node_modules/playwright/index.mjs"),
  path.join(process.env.APPDATA || "", "npm/node_modules/playwright-core/index.mjs"),
];
async function loadChromium() {
  try {
    return (await import("playwright")).chromium;
  } catch {}
  for (const p of PW_CANDIDATES) {
    if (p && fs.existsSync(p)) return (await import(pathToFileURL(p).href)).chromium;
  }
  throw new Error("playwright 를 못 찾았다. npm i -g playwright 하고 다시 돌린다. 찾아본 곳: " + PW_CANDIDATES.join(", "));
}

let liveBrowser = null;
// 로그인 없이 프로필 첫 화면을 연다. 타일 주소가 /<계정>/reel/<코드>/ 꼴로 붙어 나와서 협업 게시물을 가를 수 있다.
// 조회 API(web_profile_info)는 쓰지 않는다. 260911 에 로그아웃 요청이 첫 번째부터 429 였다.
// 게시물 페이지를 그냥 받아 오는 것도 안 된다. 스크립트만 든 껍데기라 og 태그도 게시물 목록도 없다
async function readGrid(account) {
  const file = flag("grid-file");
  if (file) {
    const g = readJson(path.resolve(file));
    if (!g) return { ok: false, reason: `시험 타일 파일을 못 읽었다: ${file}`, tiles: [] };
    return { ok: g.ok !== false, reason: g.reason || "", tiles: g.tiles || [] };
  }
  const chromium = await loadChromium();
  const opts = { headless: true, args: ["--disable-blink-features=AutomationControlled"] };
  try {
    liveBrowser = await chromium.launch({ ...opts, channel: "chrome" });
  } catch {
    liveBrowser = await chromium.launch(opts); // 크롬이 없으면 번들 크로미움
  }
  try {
    const ctx = await liveBrowser.newContext({ locale: "ko-KR", viewport: { width: 1280, height: 900 }, userAgent: UA });
    const page = await ctx.newPage();
    const res = await page.goto(`https://www.instagram.com/${encodeURIComponent(account)}/`, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForSelector('a[href*="/reel/"], a[href*="/p/"]', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const url = page.url();
    const hrefs = await page.$$eval("a[href]", (as) => as.map((a) => a.getAttribute("href") || ""));
    const tiles = [];
    const got = new Set();
    for (const raw of hrefs) {
      const h = raw.replace(/^https?:\/\/(www\.)?instagram\.com/, "");
      const m = h.match(/^\/(?:([A-Za-z0-9._]+)\/)?(reel|p)\/([A-Za-z0-9_-]+)\/?/);
      if (!m || got.has(m[3])) continue;
      got.add(m[3]);
      tiles.push({ owner: m[1] || null, kind: m[2], code: m[3] });
    }
    if (/\/accounts\/login|\/challenge\//.test(url)) return { ok: false, reason: `로그인 화면으로 넘어갔다 (${url})`, tiles: [] };
    if (!tiles.length) return { ok: false, reason: `게시물 타일을 못 읽었다 (HTTP ${res?.status() ?? "?"})`, tiles: [] };
    return { ok: true, tiles };
  } finally {
    await liveBrowser?.close().catch(() => {});
    liveBrowser = null;
  }
}

// ── 알림과 보고 ──────────────────────────────────────────────────────────────────
// 윈도우 알림을 띄운다. 창을 안 띄우고, 포커스도 안 뺏는다.
// 한글이 안 깨지게 PowerShell 스크립트를 UTF-16 으로 인코딩해 넘긴다. 앱 id 는 윈도우 PowerShell 것을 빌린다
function notify(title, body, say = console.log) {
  const t = (TEST ? "[시험] " : "") + title;
  if (DRY || process.env.REEL_WATCH_NO_TOAST === "1" || process.platform !== "win32") {
    say(`(알림 생략) ${t}: ${body}`);
    return;
  }
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const xml = `<toast><visual><binding template="ToastGeneric"><text>${esc(t)}</text><text>${esc(body)}</text></binding></visual></toast>`;
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
    "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
    "$x = New-Object Windows.Data.Xml.Dom.XmlDocument",
    `$x.LoadXml('${xml.replace(/'/g, "''")}')`,
    "$n = New-Object Windows.UI.Notifications.ToastNotification $x",
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($n)",
  ].join("\n");
  try {
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(ps, "utf16le").toString("base64")],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 30000 }
    );
    say(`알림 ${t}: ${body}`);
  } catch (e) {
    say(`알림을 못 띄웠다 (${String(e.stderr || e.message).split("\n")[0].slice(0, 120)}). ${t}: ${body}`);
  }
}

// 사람이 보는 보고. 손으로 시킨 주문과 같은 파일(<드라이브>/에이전트/보고/<날짜>-조회수분할.md)에 이어 붙인다
function driveReport(lines) {
  const m = readJson(path.join(OPS, "machine.json"), {});
  if (!m.drive_root) return "machine.json 에 drive_root 가 없어 보고 파일은 건너뛴다";
  const d = new Date();
  const day = `${String(d.getFullYear()).slice(2)}${p2(d.getMonth() + 1)}${p2(d.getDate())}`;
  const f = path.join(m.drive_root.replace(/\//g, path.sep), "에이전트", "보고", `${day}-조회수분할.md`);
  try {
    const head = fs.existsSync(f) ? "\n" : `# ${day} 조회수 분할 주문\n\n`;
    fs.appendFileSync(f, head + lines.join("\n") + "\n", "utf8");
    return "보고 " + f;
  } catch (e) {
    return "보고 파일을 못 썼다: " + e.message;
  }
}

// ── 주문 ────────────────────────────────────────────────────────────────────────
// 주문은 이 스크립트가 직접 넣지 않는다. 잔액 확인, 겹침 방지, 배경 루프, 되살리기 예약을 전부 가진 start 에 넘긴다
function startDrip(c, link) {
  const args = [DRIP, "start", "--link", link, "--qty", String(c.order.qty), "--runs", String(c.order.runs), "--every", String(c.order.every), "--root", OPS];
  const r = spawnSync(process.execPath, args, { encoding: "utf8", windowsHide: true, timeout: 150000, env: { ...process.env, OPS_ROOT: OPS } });
  const out = [r.stdout, r.stderr].filter(Boolean).join("\n").trim() || String(r.error?.message || "");
  return {
    status: r.status ?? -1,
    out,
    batch: (out.match(/^묶음 (\S+)/m) || [])[1] || null,
    orderId: (out.match(/첫 주문 들어감: 주문번호 (\S+?),/) || [])[1] || null,
  };
}

const todayOrders = (st) =>
  Object.values(st.reels || {}).filter((r) => r.status === "ordered" && String(r.orderedAt || "").startsWith(ymd())).length;

// 다시 볼 일이 없는 상태. 이 상태의 릴스는 다음 확인에서 건너뛴다
const FINAL = new Set(["seed", "ordered", "manual", "old", "stale", "error", "unknown-time"]);
const LABEL = {
  new: "새로 봄",
  ordered: "주문 시작",
  manual: "이미 묶음 있음",
  old: "켜기 전 릴스",
  stale: "너무 오래돼 안 넣음",
  "held-cap": "하루 한도로 보류",
  "held-balance": "잔액 부족으로 보류",
  retry: "시작 실패, 다시 시도",
  error: "첫 회차에서 멈춤",
  "unknown-time": "올린 시각 모름",
};

function recordFailure(c, sp, st, reason, say) {
  st.failures = (st.failures || 0) + 1;
  st.lastCheck = { at: stamp(), ok: false, summary: reason };
  say(`확인 실패 (${st.failures}번 연속): ${reason}`);
  const n = st.failures - c.failAlertAfter;
  if (n >= 0 && n % c.checkTimes.length === 0)
    notify(`${c.account} 릴스 확인 ${st.failures}번 연속 실패`, `${reason}. 이대로면 새 릴스를 못 잡습니다. reel-watch.mjs status 로 봐 주세요`, say);
  if (!DRY) writeJson(sp, st);
  process.exitCode = 6;
}

async function tickOnce(c, sp, say) {
  const st = readJson(sp) || { account: c.account, armedAt: null, armedAtMs: null, failures: 0, lastCheck: null, reels: {} };
  st.reels ||= {};
  const save = () => {
    if (!DRY) writeJson(sp, st);
  };

  let grid;
  try {
    grid = await readGrid(c.account);
  } catch (e) {
    grid = { ok: false, reason: "브라우저 오류: " + String(e.message || e).split("\n")[0].slice(0, 160), tiles: [] };
  }
  if (!grid.ok) return recordFailure(c, sp, st, grid.reason, say);

  const recovered = st.failures || 0;
  st.failures = 0;
  const acct = c.account.toLowerCase();
  const ownerKnown = grid.tiles.some((t) => t.owner);
  if (!ownerKnown) say("타일 주소에 계정명이 안 붙어 있다. 협업 게시물을 못 가려서 화면의 릴스를 전부 본인 것으로 본다");
  // 캐러셀과 사진(/p/)은 조회수 상품이 안 맞아서 뺀다. 남의 계정이 올린 협업 게시물도 뺀다
  const mine = grid.tiles.filter((t) => t.kind === "reel" && (!ownerKnown || String(t.owner || "").toLowerCase() === acct));
  const others = grid.tiles.length - mine.length;

  if (!st.armedAt) {
    st.armedAt = stamp();
    st.armedAtMs = Date.now();
    for (const t of mine) st.reels[t.code] = { status: "seed", firstSeenAt: stamp(), uploadedAt: hm(uploadedAt(t.code)) };
    st.lastCheck = { at: stamp(), ok: true, summary: `처음 확인. 타일 ${grid.tiles.length}개 중 본인 릴스 ${mine.length}개를 본 것으로 적었다. 이 릴스들은 주문하지 않는다` };
    say(st.lastCheck.summary + (DRY ? " (--dry 라 실제로는 안 적었다)" : ""));
    save();
    return;
  }

  // 방금 올라온 릴스가 조회수를 더 탄다. 한 번에 여럿이 걸리면 최근 것부터 넣는다
  const todo = mine
    .filter((t) => !FINAL.has(st.reels[t.code]?.status))
    .map((t) => ({ ...t, up: uploadedAt(t.code) }))
    .sort((a, b) => (b.up || 0) - (a.up || 0));

  for (const t of todo) {
    const r = (st.reels[t.code] ||= { status: "new", firstSeenAt: stamp(), uploadedAt: hm(t.up) });
    r.alerted ||= [];
    const link = `https://www.instagram.com/reel/${t.code}/`;
    const once = (key, title, body) => {
      if (r.alerted.includes(key)) return;
      if (!DRY) r.alerted.push(key);
      notify(title, body, say);
    };

    if (!t.up) {
      r.status = "unknown-time";
      say(`${t.code} 는 코드에서 올린 시각을 못 읽었다. 예전 게시물일 수 있어 주문하지 않는다`);
      once("unknown-time", `${c.account} 릴스 확인 필요`, `올린 시각을 못 읽어서 주문하지 않았습니다. 새 릴스가 맞으면 직접 시켜 주세요. ${link}`);
      continue;
    }
    if (t.up < st.armedAtMs - ARM_GRACE_MS) {
      r.status = "old";
      say(`${t.code} 는 감시를 켜기 전(${hm(t.up)})에 올라온 릴스다. 주문하지 않는다`);
      continue;
    }
    const prior = dripBatchesFor(t.code);
    if (prior.length) {
      r.status = "manual";
      r.batch = prior.at(-1).id;
      say(`${t.code} 는 이미 묶음 ${r.batch} 가 있다. 겹쳐 넣지 않는다`);
      continue;
    }
    const ageH = (Date.now() - t.up) / 3600000;
    if (ageH > c.maxAgeHours) {
      r.status = "stale";
      say(`${t.code} 는 올라온 지 ${Math.round(ageH)}시간이 지났다 (한도 ${c.maxAgeHours}시간). 주문하지 않는다`);
      once("stale", `${c.account} 릴스 주문 안 함`, `올라온 지 ${Math.round(ageH)}시간이 지나서 넣지 않았습니다. ${link}`);
      continue;
    }
    const today = todayOrders(st);
    if (today >= c.dailyMax) {
      r.status = "held-cap";
      say(`${t.code} 는 오늘 이미 ${today}묶음을 넣어 하루 한도(${c.dailyMax})에 걸렸다. 내일 확인에서 다시 본다`);
      once(`held-cap-${ymd()}`, `${c.account} 새 릴스 주문 보류`, `오늘 이미 ${today}묶음을 넣어서 하루 한도에 걸렸습니다. 내일 첫 확인에서 넣습니다. ${link}`);
      continue;
    }
    if (DRY) {
      say(`(--dry) ${t.code} 에 주문을 시작할 차례다. ${hm(t.up)} 업로드, ${ago(t.up)} 전`);
      continue;
    }

    say(`새 릴스 ${t.code} (${hm(t.up)} 업로드, ${ago(t.up)} 전). 조회수 ${num(c.order.qty)}회씩 ${num(c.order.runs)}번 주문을 시작한다`);
    const s = startDrip(c, link);
    for (const l of s.out.split("\n")) if (l.trim()) say("  " + l.trim());
    if (s.status === 0 && s.batch) {
      r.status = "ordered";
      r.batch = s.batch;
      r.orderId = s.orderId;
      r.orderedAt = stamp();
      notify(
        `${c.account} 새 릴스 조회수 주문 시작`,
        `${hm(t.up).slice(11)} 에 올라온 릴스에 ${num(c.order.qty)}회씩 ${num(c.order.runs)}번 넣습니다. ` +
          (s.orderId ? `첫 주문번호 ${s.orderId}` : "첫 주문은 아직 확인 못 했습니다") +
          `. ${link}`,
        say
      );
      say(driveReport([`## 자동 감지 (${stamp().slice(11, 16)} 확인)`, "", `릴스   ${link} (${c.account}, ${hm(t.up)} 업로드, ${ago(t.up)} 뒤 감지)`, ...s.out.split("\n")]));
    } else if (s.status === 3 && /모자란다/.test(s.out)) {
      r.status = "held-balance";
      const short = (s.out.match(/잔액이 (₩[\d,]+) 모자란다/) || [])[1];
      once("held-balance", `${c.account} 새 릴스 주문 못 함, 잔액 부족`, (short ? `잔액이 ${short} 모자랍니다` : "잔액이 모자랍니다") + `. 충전하면 다음 확인에서 넣습니다. ${link}`);
    } else if (s.status === 3 && /같은 링크로 이미 돌고 있는 묶음/.test(s.out)) {
      r.status = "manual";
      r.batch = (s.out.match(/묶음이 있다: (\S+)/) || [])[1] || null;
    } else if (s.batch) {
      // 묶음은 생겼는데 첫 회차에서 걸렸다. 다시 start 하면 묶음이 둘이 된다. 사람이 기록을 보고 resume 이나 stop 을 고른다
      r.status = "error";
      r.batch = s.batch;
      notify(`${c.account} 조회수 주문이 첫 회차에서 멈춤`, `묶음 ${s.batch} 기록을 보고 resume 이나 stop 을 골라 주세요. ${link}`, say);
    } else {
      r.status = "retry";
      // 여러 줄 안내에서 사유가 담긴 줄을 고른다. 마지막 줄은 대개 "키는 어디에 들어간다" 같은 뒷말이다
      const lines = s.out.split("\n").map((l) => l.trim()).filter(Boolean);
      r.lastError = lines.find((l) => /없다|실패|오류|못 /.test(l)) || lines.at(-1) || `종료 코드 ${s.status}`;
      once("retry", `${c.account} 새 릴스 주문 시작 실패`, `${r.lastError}. 다음 확인에서 다시 넣습니다. ${link}`);
    }
    save();
  }

  const held = todo.filter((t) => ["held-cap", "held-balance", "retry"].includes(st.reels[t.code]?.status)).length;
  st.lastCheck = {
    at: stamp(),
    ok: true,
    summary:
      `타일 ${grid.tiles.length}개, 본인 릴스 ${mine.length}개` +
      (others ? `, 뺀 게시물 ${others}개` : "") +
      (todo.length ? `, 처리한 릴스 ${todo.length}개` + (held ? ` (보류 ${held}개)` : "") : ", 새 릴스 없음"),
  };
  if (recovered) say(`${recovered}번 실패한 뒤 다시 읽었다`);
  say(st.lastCheck.summary);
  save();
}

async function cmdTick() {
  const c = loadConfig();
  const dir = workDir(c);
  const sp = path.join(dir, "state.json");
  const say = logger(dir);
  let lock = null;
  if (!DRY) {
    lock = takeLock(dir);
    if (!lock) {
      console.log(`[${stamp()}] 다른 확인이 아직 돌고 있다. 이번은 건너뛴다`);
      return;
    }
  }
  const killer = setTimeout(() => {
    say(`확인이 ${TICK_LIMIT_MS / 60000}분을 넘겨 스스로 끝낸다`);
    if (lock) fs.rmSync(lock, { force: true });
    const bye = () => process.exit(5);
    setTimeout(bye, 5000).unref();
    if (liveBrowser) liveBrowser.close().then(bye, bye);
    else bye();
  }, TICK_LIMIT_MS);
  killer.unref();
  try {
    await tickOnce(c, sp, say);
  } catch (e) {
    if (e instanceof ExitError) throw e;
    // 예상 못 한 오류도 실패로 센다. 조용히 죽으면 새 릴스를 놓친 줄도 모른다
    const st = readJson(sp) || { account: c.account, armedAt: null, armedAtMs: null, failures: 0, lastCheck: null, reels: {} };
    recordFailure(c, sp, st, "스크립트 오류: " + String(e.message || e).split("\n")[0].slice(0, 160), say);
  } finally {
    clearTimeout(killer);
    if (lock) fs.rmSync(lock, { force: true });
  }
}

// ── 예약 작업 ────────────────────────────────────────────────────────────────────
// 예약 이름은 ops 폴더 위치로 정한다. 시험용 폴더로 건 예약이 진짜 예약을 덮지 않게 한다
const taskName = () => (OPS === NATURAL_OPS ? TASK_NAME : TASK_NAME + "-" + createHash("sha1").update(OPS).digest("hex").slice(0, 8));

// schtasks 는 파이프로 받으면 한국어 윈도우에서 CP949 로 찍는다. UTF-8 로만 읽으면 "오후" 가 깨진다
function decode(buf) {
  if (!buf || !buf.length) return "";
  const u = Buffer.from(buf).toString("utf8");
  if (!u.includes("�")) return u;
  try {
    return new TextDecoder("euc-kr").decode(buf);
  } catch {
    return u;
  }
}
function schtasks(args) {
  try {
    return { ok: true, out: decode(execFileSync("schtasks", args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })) };
  } catch (e) {
    return { ok: false, out: (decode(e.stdout) + decode(e.stderr)).trim() };
  }
}

function taskXml(c) {
  const now = new Date();
  const user = `${process.env.USERDOMAIN || process.env.COMPUTERNAME}\\${process.env.USERNAME}`;
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const triggers = c.checkTimes.map((t) => {
    const [h, m] = t.split(":").map(Number);
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0);
    // 오늘 이미 지난 시각은 내일부터 건다. 오늘 날짜로 걸면 놓친 실행으로 쳐서 곧바로 한 번 더 돈다
    if (d <= now) d.setDate(d.getDate() + 1);
    return [
      "    <CalendarTrigger>",
      `      <StartBoundary>${ymd(d)}T${p2(h)}:${p2(m)}:00</StartBoundary>`,
      "      <Enabled>true</Enabled>",
      "      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>",
      "    </CalendarTrigger>",
    ].join("\n");
  });
  const args = [
    "//B",
    "//Nologo",
    `"${path.join(HERE, "hidden-run.vbs")}"`,
    `"${process.execPath}"`,
    `"${SELF}"`,
    "tick",
    "--root",
    `"${OPS}"`,
    ...(CONFIG !== DEFAULT_CONFIG ? ["--config", `"${CONFIG}"`] : []),
  ].join(" ");
  const desc = `ops reel-watch: ${c.account} 에 새 릴스가 올라왔는지 하루 ${c.checkTimes.length}번 보고, 새 릴스면 조회수 분할 주문을 시작한다. 끄려면 node reel-watch.mjs remove`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${esc(desc)}</Description>
  </RegistrationInfo>
  <Triggers>
${triggers.join("\n")}
  </Triggers>
  <Principals>
    <Principal id="Author"><UserId>${esc(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT15M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec><Command>wscript.exe</Command><Arguments>${esc(args)}</Arguments></Exec>
  </Actions>
</Task>`;
}

async function cmdInstall() {
  const c = loadConfig();
  if (process.platform !== "win32") fail("예약은 윈도우에서만 건다");
  const dir = workDir(c);
  fs.mkdirSync(dir, { recursive: true });
  const xml = path.join(dir, ".task.xml");
  // schtasks /XML 은 UTF-16LE 만 읽는다
  fs.writeFileSync(xml, "﻿" + taskXml(c), "utf16le");
  const r = schtasks(["/Create", "/TN", taskName(), "/XML", xml, "/F"]);
  if (!r.ok) fail("예약을 못 걸었다: " + r.out.split("\n").slice(0, 3).join(" "));
  console.log(`예약 ${taskName()} 걸었다. 매일 ${c.checkTimes.join(" ")} (하루 ${c.checkTimes.length}번)`);
  console.log("지금 한 번 확인한다");
  await cmdTick();
}

function cmdRemove() {
  const r = schtasks(["/Delete", "/TN", taskName(), "/F"]);
  console.log(r.ok ? `예약 ${taskName()} 지웠다. 상태와 기록은 그대로 둔다` : `지울 예약이 없거나 못 지웠다: ${r.out.split("\n")[0]}`);
}

function cmdStatus() {
  const c = loadConfig();
  const dir = workDir(c);
  const st = readJson(path.join(dir, "state.json"));
  console.log(`감시 계정   ${c.account}`);
  console.log(`확인 시각   ${c.checkTimes.join(" ")} (하루 ${c.checkTimes.length}번)`);
  console.log(`릴스 하나   ${num(c.order.qty)}회 × ${num(c.order.runs)}번, ${c.order.every} 간격. 하루 최대 ${c.dailyMax}묶음, 올라온 지 ${c.maxAgeHours}시간 넘으면 안 넣음`);
  const q = schtasks(["/Query", "/TN", taskName(), "/FO", "CSV", "/V"]);
  if (!q.ok) console.log(`예약        ${taskName()} 안 걸려 있다. install 로 건다`);
  else {
    // CSV 는 열 순서가 언어와 상관없이 같다. 2 가 다음 실행, 5 가 마지막 실행, 6 이 마지막 결과다
    const row = (q.out.split(/\r?\n/)[1] || "").match(/"([^"]*)"/g)?.map((s) => s.slice(1, -1)) || [];
    console.log(`예약        ${taskName()} 걸려 있다` + (row.length > 6 ? `. 다음 확인 ${row[2]}, 마지막 실행 ${row[5]} (결과 ${row[6]})` : ""));
  }
  if (!st?.armedAt) {
    console.log("상태        아직 한 번도 제대로 확인 못 했다" + (st?.lastCheck ? `. 마지막 시도 ${st.lastCheck.at}: ${st.lastCheck.summary}` : ""));
    return;
  }
  console.log(`켠 시각     ${st.armedAt}`);
  console.log(`마지막 확인 ${st.lastCheck?.at} ${st.lastCheck?.ok ? "성공" : "실패"}. ${st.lastCheck?.summary}`);
  console.log(`연속 실패   ${st.failures || 0}번`);
  console.log(`오늘 주문   ${todayOrders(st)}/${c.dailyMax}묶음`);
  const rows = Object.entries(st.reels || {})
    .filter(([, r]) => r.status !== "seed")
    .sort((a, b) => String(a[1].firstSeenAt).localeCompare(String(b[1].firstSeenAt)))
    .slice(-8);
  if (rows.length) {
    console.log("최근 새 릴스");
    for (const [code, r] of rows)
      console.log(`  ${code.padEnd(12)} ${LABEL[r.status] || r.status}, ${r.uploadedAt} 업로드` + (r.batch ? `, 묶음 ${r.batch}` : "") + (r.lastError ? ` (${r.lastError})` : ""));
  }
  const lf = path.join(dir, "log.txt");
  if (fs.existsSync(lf)) {
    console.log("최근 기록");
    for (const l of fs.readFileSync(lf, "utf8").trim().split("\n").slice(-6)) console.log("  " + l);
  }
}

function cmdNotify() {
  notify(positional[0] || "릴스 감시 알림 시험", positional[1] || "이 알림이 보이면 주문 알림도 이렇게 뜹니다");
}

function help() {
  const lines = [];
  for (const l of fs.readFileSync(SELF, "utf8").split("\n").slice(1)) {
    if (!l.startsWith("//")) break;
    lines.push(l.replace(/^\/\/ ?/, ""));
  }
  console.log(lines.join("\n"));
}

const commands = { tick: cmdTick, install: cmdInstall, remove: cmdRemove, status: cmdStatus, notify: cmdNotify, help };
if (!commands[cmd]) {
  help();
  process.exitCode = 2;
} else {
  try {
    await commands[cmd]();
  } catch (e) {
    if (e instanceof ExitError) process.exitCode = e.code;
    else {
      console.error(e.stack || e.message || e);
      process.exitCode = 1;
    }
  }
}
