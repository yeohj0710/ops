#!/usr/bin/env node
// 인스타 계정에 팔로워를 잘게 나눠 일정 간격으로 반복 주문한다.
// 주문 루프, 되살리기 예약, stop 과 resume 은 조회수 업무의 snsview-drip.mjs 를 그대로 쓴다.
// 이 스크립트가 더하는 것은 넷이다.
//   1. 한국, 해외를 상품 번호로 바꾼다 (한국 1279, 해외 354)
//   2. 아이디를 맞추고 그 계정이 있는지, 공개인지, 지금 팔로워가 몇 명인지 본다 (로그인 없는 헤드리스 크롬)
//   3. 첫 주문 직전 팔로워 수와 프로필 머리 화면을 묶음 폴더에 남긴다. 1279 상품 설명이 주문 전 수량 캡처를 요구한다
//   4. 돌고 있는 다른 묶음(조회수 묶음 포함)이 앞으로 쓸 돈까지 빼고 잔액이 되는지 본다
//
//   node snsfollow-drip.mjs products                                       팔로워 상품 표. 단가와 최소 수량은 API 에서 그때그때 읽는다
//   node snsfollow-drip.mjs check                                          키, 잔액, 기본 상품 두 개, 팔로워 묶음
//   node snsfollow-drip.mjs profile <아이디> [--shot <png>]                  계정이 있나, 공개인가, 팔로워 몇 명인가
//   node snsfollow-drip.mjs plan  --region kr --handle <아이디> --qty 10 --runs 10 --every 30m     돈 안 쓰고 계산만
//   node snsfollow-drip.mjs start --region kr --handle <아이디> --qty 10 --runs 10 --every 30m     묶음을 만들고 배경에서 돌린다
//   node snsfollow-drip.mjs status [묶음id] [--api] [--profile]            --profile 은 지금 팔로워 수를 시작 전과 비교한다
//   node snsfollow-drip.mjs list                                           팔로워 묶음만
//   node snsfollow-drip.mjs stop <묶음id> --reason "<왜>"                   아래 넷은 snsview-drip.mjs 로 그대로 넘긴다
//   node snsfollow-drip.mjs resume <묶음id>
//   node snsfollow-drip.mjs guard [install|remove]
//   node snsfollow-drip.mjs watch
//
// 옵션
//   --region   kr(한국, 국내) 또는 global(해외, 외국). 기본 kr
//   --service  상품 번호를 직접 고른다. --region 보다 앞선다. 고를 수 있는 것은 products
//   --handle   인스타 아이디. @ 나 프로필 주소를 붙여도 아이디만 남긴다
//   --qty      한 번에 넣을 인원. 안 주면 상품 최소 수량을 10 단위로 올린 값 (한국 10명, 해외 100명)
//   --runs     총 횟수. 기본 10
//   --every    간격. 30m, 1h, 숫자만 쓰면 분. 기본 30m
//   --jitter   간격 흔들기 비율. 0.1 이면 ±10%
//   --force    같은 아이디로 도는 묶음이 있어도 하나 더 건다. 새 지시는 언제나 추가다
//   --allow-short    잔액이 모자라도 시작한다. 모자라는 회차에서 멈춰 충전을 기다린다
//   --allow-private  비공개로 읽혀도 시작한다. 비공개 계정에는 작업이 안 들어가니 공개로 바꾼 뒤에만 쓴다
//   --skip-profile   프로필을 안 읽는다. 크롬이 없는 기계나 시험용
//   --foreground     start 에서 배경으로 띄우지 않고 이 창에서 돈다 (시험용)
//   --root <경로>     ops 저장소 위치. 시험용
//
// 시험용 환경변수
//   SNSSUPPORTER_API_URL     가짜 API 주소. snsview-drip.mjs 도 같은 값을 읽는다
//   SNSFOLLOW_PROFILE_FILE   프로필을 크롬으로 안 읽고 이 JSON 을 읽은 것으로 친다

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);

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
// 루프는 조회수 업무의 것을 쓴다. 묶음도 같은 폴더에 쌓여야 되살리기 예약 하나가 둘 다 살린다
const ENGINE = path.resolve(HERE, "..", "..", "snsview-drip", "scripts", "snsview-drip.mjs");
const BATCHES = path.join(OPS, "work", "snsview-drip");
const API = process.env.SNSSUPPORTER_API_URL || "https://snssupporter.com/api/v2";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

// 한국, 해외 기본 상품. 260917 에 상품 설명을 읽고 골랐다 (MANUAL.md "상품" 절)
const REGIONS = {
  kr: { service: 1279, label: "한국" },
  global: { service: 354, label: "해외" },
};
const REGION_ALIASES = {
  kr: ["kr", "ko", "kor", "korea", "korean", "domestic", "한국", "국내", "한국인"],
  global: ["global", "foreign", "overseas", "world", "intl", "해외", "외국", "외국인", "글로벌"],
};
// 상품 설명에서 옮긴 것 (260917 사이트 주문 화면). 단가와 최소 수량은 여기 적지 않고 API 에서 읽는다
const NOTES = {
  1279: "90일 A/S. 평균 1시간 안에 시작. 비공개 계정은 안 들어감. 주문 전 팔로워 수 캡처를 요구함",
  1230: "A/S 없음. 아주 느리게 들어옴. 비공개 계정은 안 들어감",
  354: "90일 A/S(첫 구매 24시간 뒤부터). 이탈 10~20%. 계정의 '검토를 위해 플래그 지정'이 켜져 있으면 안 들어가고 환불도 없음",
  342: "활동 없는 가계정. 90일 A/S. 이탈 10~20%",
  1246: "일본인. 30일 A/S. 평균 1시간 안에 시작",
};

// ── 공용 ────────────────────────────────────────────────────────────────────────
const p2 = (n) => String(n).padStart(2, "0");
function stamp(d = new Date()) {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}
// 모자랄 때 "₩-97,828" 이 아니라 "-₩97,828" 로 찍는다
const won = (n) => (Math.round(n) < 0 ? "-" : "") + "₩" + Math.abs(Math.round(n)).toLocaleString("ko-KR");
const num = (n) => Number(n).toLocaleString("ko-KR");
const toMs = (t) => new Date(String(t).replace(" ", "T")).getTime();

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
  fs.writeFileSync(f, JSON.stringify(o, null, 2) + "\n", "utf8");
}
function parseEvery(s) {
  const m = String(s ?? "").trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(s|sec|m|min|h|hr)?$/);
  if (!m) return NaN;
  const v = Number(m[1]);
  const unit = m[2] || "m";
  return unit.startsWith("s") ? v : unit.startsWith("h") ? v * 3600 : v * 60;
}

const HANDLE_RE = /^[a-z0-9._]{1,30}$/;
// snsview-drip.mjs 의 normalizeHandle 과 같은 규칙이다. 한쪽을 고치면 다른 쪽도 고친다
function normalizeHandle(raw) {
  let t = String(raw || "").trim();
  const u = t.match(/^(?:https?:\/\/)?(?:www\.|m\.)?instagram\.com\/([^/?#]+)/i);
  if (u) t = u[1];
  t = t.replace(/^@+/, "").replace(/[/?#].*$/, "").toLowerCase();
  if (/^(reel|reels|p|tv|stories|explore|accounts)$/.test(t)) return null;
  return HANDLE_RE.test(t) ? t : null;
}

// ── API (읽기만. 주문은 snsview-drip.mjs 가 넣는다) ──────────────────────────────────
function apiKey() {
  if (process.env.SNSSUPPORTER_API_KEY) return process.env.SNSSUPPORTER_API_KEY.trim();
  const m = readJson(path.join(OPS, "machine.json"), {});
  const f = m.drive_root ? path.join(m.drive_root.replace(/\//g, path.sep), "에이전트", "자격증명", ".env") : null;
  if (f && fs.existsSync(f)) {
    const hit = fs.readFileSync(f, "utf8").match(/^SNSSUPPORTER_API_KEY=(.*)$/m);
    if (hit) return hit[1].trim().replace(/^["']|["']$/g, "");
  }
  return "";
}
async function api(params) {
  const key = apiKey();
  if (!key) fail(`SNSSUPPORTER_API_KEY 가 없다. 넣는 법은 node "${ENGINE}" check 가 알려 준다`);
  if (!["services", "balance", "status"].includes(params.action)) fail(`이 스크립트는 읽기 API 만 부른다 (${params.action})`);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    let r;
    try {
      r = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ key, ...params }),
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new Error(`API 연결 실패 (${e.name === "AbortError" ? "30초 안에 응답 없음" : e.cause?.code || e.message})`);
    }
    const text = await r.text();
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      throw new Error(`응답이 JSON 이 아니다 (HTTP ${r.status}): ${text.slice(0, 160).replace(/\s+/g, " ")}`);
    }
    if (j && !Array.isArray(j) && j.error) throw new Error("API 오류: " + j.error);
    return j;
  } finally {
    clearTimeout(t);
  }
}
let servicesCache = null;
async function services() {
  if (!servicesCache) {
    const list = await api({ action: "services" });
    if (!Array.isArray(list)) throw new Error("services 응답이 배열이 아니다");
    servicesCache = list;
  }
  return servicesCache;
}
// 인스타 팔로워 상품. 쓰레드, 페이스북, 트위터 팔로워는 카테고리 이름이 달라서 빠진다
const isIgFollower = (s) => s.category === "팔로워";
const regionOf = (s) => (/외국인|일본인|해외|global/i.test(s.name) ? "global" : "kr");
async function getProduct(id) {
  const s = (await services()).find((x) => String(x.service) === String(id));
  if (!s) fail(`상품 ${id} 가 목록에 없다. node "${SELF}" products 로 지금 파는 팔로워 상품을 본다`);
  if (!isIgFollower(s)) fail(`상품 ${id} (${s.name}, ${s.category}) 는 인스타 팔로워 상품이 아니다. 인스타 팔로워는 products 에 나오는 것만 받는다. 조회수는 snsview-drip 업무다`);
  return { id: Number(s.service), name: s.name, category: s.category, rate: Number(s.rate), min: Number(s.min), max: Number(s.max), dripfeed: !!s.dripfeed, region: regionOf(s) };
}

// ── 묶음 ────────────────────────────────────────────────────────────────────────
function allBatches() {
  if (!fs.existsSync(BATCHES)) return [];
  return fs
    .readdirSync(BATCHES)
    .map((d) => readJson(path.join(BATCHES, d, "state.json")))
    .filter(Boolean)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}
const followerBatches = () => allBatches().filter((b) => b.kind === "follower");
// 돌고 있는 묶음이 앞으로 더 쓸 돈. stop 한 것과 끝난 것은 뺀다. 조회수 묶음도 같은 잔액을 쓰니 같이 센다
function committedSpend() {
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  return allBatches()
    .filter((b) => !b.done && !b.stopped && toMs(b.lastOrderAt || b.createdAt) > weekAgo)
    .reduce((sum, b) => sum + Math.max(0, b.runs - b.orders.length) * (b.unitCost || 0), 0);
}
function runEngine(args, { timeout = 150000 } = {}) {
  const full = [ENGINE, ...args];
  if (flag("root")) full.push("--root", OPS);
  const r = spawnSync(process.execPath, full, { encoding: "utf8", windowsHide: true, timeout, env: { ...process.env, OPS_ROOT: OPS } });
  return { status: r.status ?? 1, out: (r.stdout || "").trimEnd(), err: (r.stderr || "").trimEnd(), error: r.error };
}
function passEngine(args) {
  const r = runEngine(args);
  if (r.out) console.log(r.out);
  if (r.err) console.error(r.err);
  if (r.error) console.error(String(r.error.message || r.error));
  process.exitCode = r.status;
  return r;
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
  throw new Error("playwright 를 못 찾았다. npm i -g playwright 하고 다시 돌린다");
}

// 로그인 없이 프로필을 연다. 260917 실측으로 페이지 안 JSON 에 follower_count, is_private 가 그대로 들어 있다.
// 메타 설명(og:description)의 팔로워 수는 낡은 값이라 쓰지 않는다 (같은 순간 메타 2,626명, 머리 화면 2,650명)
async function readProfile(handle, { shot = null } = {}) {
  const at = stamp();
  const fake = process.env.SNSFOLLOW_PROFILE_FILE;
  if (fake) {
    const f = readJson(fake);
    if (!f) return { ok: false, handle, at, reason: `시험 프로필 파일을 못 읽었다: ${fake}` };
    return { ok: true, handle, at, source: "test", ...f };
  }
  let browser;
  try {
    const chromium = await loadChromium();
    const opts = { headless: true, args: ["--disable-blink-features=AutomationControlled"] };
    try {
      browser = await chromium.launch({ ...opts, channel: "chrome" });
    } catch {
      browser = await chromium.launch(opts);
    }
    const ctx = await browser.newContext({ locale: "ko-KR", viewport: { width: 1280, height: 900 }, userAgent: UA });
    const page = await ctx.newPage();
    const res = await page.goto(`https://www.instagram.com/${encodeURIComponent(handle)}/`, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForSelector("header", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const url = page.url();
    if (/\/accounts\/login|\/challenge\//.test(url)) return { ok: false, handle, at, reason: `로그인 화면으로 넘어갔다 (${url})` };
    const info = await page.evaluate((h) => {
      const seen = new Set();
      const walk = (o, depth) => {
        if (!o || typeof o !== "object" || depth > 60 || seen.has(o)) return null;
        seen.add(o);
        if (o.username === h && typeof o.follower_count === "number") return o;
        for (const v of Array.isArray(o) ? o : Object.values(o)) {
          const r = walk(v, depth + 1);
          if (r) return r;
        }
        return null;
      };
      let hit = null;
      for (const s of document.querySelectorAll('script[type="application/json"]')) {
        if (!s.textContent.includes(`"${h}"`)) continue;
        try {
          hit = walk(JSON.parse(s.textContent), 0);
        } catch {}
        if (hit) break;
      }
      const body = document.body ? document.body.innerText : "";
      const titled = [...document.querySelectorAll("header [title]")].map((e) => e.getAttribute("title") || "").find((t) => /^[\d,]+$/.test(t));
      return {
        followers: hit ? hit.follower_count : titled ? Number(titled.replace(/,/g, "")) : null,
        following: hit && typeof hit.following_count === "number" ? hit.following_count : null,
        isPrivate: hit ? !!hit.is_private : /비공개 계정입니다|This Account is Private|이 계정은 비공개/i.test(body),
        fullName: hit ? hit.full_name || "" : null,
        verified: hit ? !!hit.is_verified : null,
        source: hit ? "json" : titled ? "header" : "none",
        header: !!document.querySelector("header"),
        notFound: /이용할 수 없습니다|사용할 수 없습니다|isn't available|not available/i.test(`${document.title} ${body.slice(0, 500)}`),
      };
    }, handle);
    if (info.notFound) return { ok: true, handle, at, exists: false, isPrivate: null, followers: null, source: "page" };
    if (!info.header && info.followers === null) return { ok: false, handle, at, reason: `프로필 머리 화면을 못 읽었다 (HTTP ${res?.status() ?? "?"}, ${url})` };
    let shotSaved = null;
    if (shot) {
      // 로그인 권유 창이 머리 화면을 가린다. Esc 로 닫고 머리 부분만 찍는다
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(700);
      const hd = await page.$("header");
      if (hd) {
        fs.mkdirSync(path.dirname(shot), { recursive: true });
        await hd.screenshot({ path: shot }).then(() => (shotSaved = shot)).catch(() => {});
      }
    }
    return { ok: true, handle, at, exists: true, ...info, shot: shotSaved };
  } catch (e) {
    return { ok: false, handle, at, reason: String(e.message || e).split("\n")[0].slice(0, 200) };
  } finally {
    await browser?.close().catch(() => {});
  }
}
function profileLine(pr) {
  if (!pr) return "계정   프로필 확인 건너뜀 (--skip-profile)";
  if (!pr.ok) return `계정   @${pr.handle} 프로필을 못 읽었다: ${pr.reason}`;
  if (pr.exists === false) return `계정   @${pr.handle} 없는 계정이다 (프로필을 이용할 수 없다고 나온다)`;
  const followers = pr.followers === null || pr.followers === undefined ? "팔로워 수 모름" : `팔로워 ${num(pr.followers)}명`;
  return `계정   @${pr.handle} ${pr.isPrivate ? "비공개" : "공개"}, ${followers} (${pr.at.slice(5, 16)} 로그인 없이 읽음)`;
}

// ── 입력 ────────────────────────────────────────────────────────────────────────
function readRegion() {
  const raw = flag("region");
  if (raw === null) return { region: "kr", defaulted: true };
  const t = String(raw).trim().toLowerCase();
  for (const [k, words] of Object.entries(REGION_ALIASES)) if (words.includes(t)) return { region: k, defaulted: false };
  fail(`--region 은 kr(한국) 또는 global(해외)다. "${raw}" 는 모른다`);
}
async function readOrderArgs() {
  const handleRaw = flag("handle") ?? positional[0] ?? null;
  if (!handleRaw) fail("--handle 에 인스타 아이디를 넣는다. 예: --handle kimjejo_pharma");
  const handle = normalizeHandle(handleRaw);
  if (!handle) fail(`"${handleRaw}" 는 인스타 아이디 꼴이 아니다. 영문, 숫자, 점, 밑줄로 30자까지다. 게시물 주소가 아니라 계정 아이디를 준다`);
  const { region, defaulted } = readRegion();
  const serviceId = Number(flag("service", REGIONS[region].service));
  const product = await getProduct(serviceId);
  const qtyRaw = flag("qty");
  const qty = qtyRaw === null ? Math.max(10, Math.ceil(product.min / 10) * 10) : Number(qtyRaw);
  const runs = Number(flag("runs", 10));
  const every = flag("every", "30m");
  const jitter = flag("jitter");
  if (!Number.isInteger(qty) || qty <= 0) fail("--qty 는 양의 정수다. 예: --qty 10");
  if (!Number.isInteger(runs) || runs <= 0) fail("--runs 는 양의 정수다. 예: --runs 10");
  if (!Number.isFinite(parseEvery(every))) fail("--every 는 30m, 1h, 90 같은 꼴이다. 숫자만 쓰면 분이다");
  if (qty < product.min) fail(`상품 ${product.id} (${product.name}) 는 한 번에 최소 ${num(product.min)}명부터 넣는다. --qty ${qty} 로는 못 넣는다` +
    (product.region === "global" ? `. 해외를 ${qty}명씩 넣으려면 --service 1246 (일본인, 최소 10명) 처럼 최소 수량이 작은 상품을 고른다` : ""));
  const defaults = [];
  if (defaulted && flag("service") === null) defaults.push("지역 한국");
  if (qtyRaw === null) defaults.push(`한 번 ${qty}명`);
  if (flag("runs") === null) defaults.push("횟수 10번");
  if (flag("every") === null) defaults.push("간격 30분");
  return { handle, region: product.region, product, qty, runs, every, jitter, defaults };
}
function engineOrderArgs(o) {
  const args = ["--handle", o.handle, "--service", String(o.product.id), "--qty", String(o.qty), "--runs", String(o.runs), "--every", String(o.every)];
  if (o.jitter !== null) args.push("--jitter", String(o.jitter));
  return args;
}
function warnLines(o) {
  const out = [];
  if (o.defaults.length) out.push(`기본값 안 준 값은 이렇게 잡았다: ${o.defaults.join(", ")}`);
  if (o.product.region === "global")
    out.push("주의   해외 상품은 대상 계정의 설정 및 활동 > 친구 팔로우 및 초대 > '검토를 위해 플래그 지정'이 꺼져 있어야 들어간다. 켜져 있으면 작업도 환불도 없다");
  out.push("참고   같은 아이디의 앞 주문이 서버에서 안 끝나면 다음 회차는 끝날 때까지 기다렸다 들어간다. 끝나는 시각은 늦어질 수 있다");
  return out;
}

// ── 명령 ────────────────────────────────────────────────────────────────────────
async function cmdProducts() {
  const list = (await services()).filter(isIgFollower);
  const defaults = new Set(Object.values(REGIONS).map((r) => r.service));
  for (const region of ["kr", "global"]) {
    console.log(`${REGIONS[region].label} (--region ${region})`);
    for (const s of list.filter((x) => regionOf(x) === region).sort((a, b) => Number(a.rate) - Number(b.rate))) {
      const mark = defaults.has(Number(s.service)) ? " [기본]" : "";
      console.log(`  ${s.service}${mark} ${s.name}  1명 ${won(Number(s.rate) / 1000)}, 최소 ${num(s.min)}명, 최대 ${num(s.max)}명${s.dripfeed ? ", 사이트 예약주문 됨" : ""}`);
      if (NOTES[s.service]) console.log(`       ${NOTES[s.service]}`);
    }
  }
  console.log("\n상품 설명은 260917 사이트 주문 화면에서 옮겼다. 단가와 최소 수량은 방금 API 에서 읽었다");
}

async function cmdCheck() {
  const key = apiKey();
  console.log("키     " + (key ? `있음 (${key.length}자)` : "없음"));
  if (!key) fail(`키가 없다. node "${ENGINE}" check 가 넣는 법을 알려 준다`);
  const bal = await api({ action: "balance" });
  const committed = committedSpend();
  console.log(`잔액   ${won(Number(bal.balance))}` + (committed ? ` (돌고 있는 묶음이 앞으로 ${won(committed)} 더 쓴다, 실제 여유 ${won(Number(bal.balance) - committed)})` : ""));
  for (const [region, r] of Object.entries(REGIONS)) {
    const p = await getProduct(r.service);
    console.log(`${r.label}   ${p.id} ${p.name}, 1명 ${won(p.rate / 1000)}, 최소 ${num(p.min)}명`);
  }
  const running = followerBatches().filter((b) => !b.done && !b.stopped);
  console.log(`팔로워 묶음 진행 ${running.length}개` + (running.length ? ": " + running.map((b) => `${b.id} ${b.orders.length}/${b.runs}`).join(", ") : ""));
  console.log(`playwright ${await loadChromium().then(() => "있음").catch(() => "없음 (프로필 확인을 못 한다. npm i -g playwright)")}`);
}

async function cmdProfile() {
  const handle = normalizeHandle(positional[0] || flag("handle"));
  if (!handle) fail("인스타 아이디를 준다. 예: node snsfollow-drip.mjs profile kimjejo_pharma");
  const pr = await readProfile(handle, { shot: flag("shot") });
  console.log(profileLine(pr));
  if (pr.ok && pr.exists) console.log(`출처   ${pr.source === "json" ? "페이지 안 JSON" : pr.source === "header" ? "머리 화면 숫자" : pr.source}` + (pr.shot ? `, 캡처 ${pr.shot}` : ""));
  if (!pr.ok) process.exitCode = 4;
}

async function prepare(o, { shot = null } = {}) {
  const pr = has("skip-profile") ? null : await readProfile(o.handle, { shot });
  const bal = Number((await api({ action: "balance" })).balance);
  const committed = committedSpend();
  const total = (o.qty * o.product.rate * o.runs) / 1000;
  return { pr, bal, committed, total, free: bal - committed };
}
function shortLine(x) {
  return `잔액 ${won(x.bal)}, 돌고 있는 묶음 몫 ${won(x.committed)}, 남는 돈 ${won(x.free)}. 이 묶음 총액 ${won(x.total)} 에 ${won(x.total - x.free)} 모자란다. 충전은 사람이 한다`;
}

async function cmdPlan() {
  const o = await readOrderArgs();
  const x = await prepare(o);
  console.log(profileLine(x.pr));
  const r = runEngine(["plan", ...engineOrderArgs(o)]);
  if (r.out) console.log(r.out);
  if (r.status !== 0) {
    if (r.err) console.error(r.err);
    process.exitCode = r.status;
    return;
  }
  if (x.total > x.free) console.log("부족   " + shortLine(x));
  for (const l of warnLines(o)) console.log(l);
  if (x.pr?.ok && x.pr.exists === false) console.log("막힘   없는 계정이라 start 가 거절한다. 아이디를 다시 본다");
  if (x.pr?.ok && x.pr.isPrivate) console.log("막힘   비공개 계정이라 start 가 거절한다. 공개로 바꾼 뒤 넣는다");
}

async function cmdStart() {
  const o = await readOrderArgs();
  const pendingDir = path.join(OPS, "work", "snsfollow-drip", "_before");
  const tag = `${stamp().replace(/[-: ]/g, "").slice(2, 12)}-${o.handle}`;
  const shot = path.join(pendingDir, `${tag}.png`);
  const x = await prepare(o, { shot });
  console.log(profileLine(x.pr));
  if (x.pr?.ok && x.pr.exists === false) fail(`@${o.handle} 는 없는 계정이다. 주문하지 않았다`, 3);
  if (x.pr?.ok && x.pr.isPrivate && !has("allow-private"))
    fail(`@${o.handle} 는 비공개 계정이다. 비공개 계정에는 작업이 안 들어가서 주문하지 않았다. 공개로 바꾼 뒤 다시 넣는다`, 3);
  if (x.total > x.free && !has("allow-short")) fail("부족   " + shortLine(x) + ". 주문하지 않았다", 3);

  const args = ["start", ...engineOrderArgs(o), "--dup-poll", "1m", "--dup-retry", "5m", "--dup-max", "6h"];
  for (const f of ["force", "allow-short", "foreground"]) if (has(f)) args.push("--" + f);
  const r = runEngine(args, { timeout: has("foreground") ? 0 : 150000 });
  if (r.out) console.log(r.out);
  if (r.err) console.error(r.err);
  const batch = (r.out.match(/^묶음 (\S+)/m) || [])[1] || null;
  const orderId = (r.out.match(/첫 주문 들어감: 주문번호 (\S+?),/) || [])[1] || null;
  if (batch) {
    // 시작 전 기록을 묶음 폴더로 옮긴다. state.json 은 배경 루프가 계속 고쳐 쓰니 거기에 끼워 넣지 않고 따로 둔다
    const dir = path.join(BATCHES, batch);
    const before = { ...(x.pr || { ok: false, reason: "건너뜀 (--skip-profile)" }), balance: x.bal, committed: x.committed };
    if (before.shot && fs.existsSync(before.shot)) {
      const dest = path.join(dir, "profile-before.png");
      fs.renameSync(before.shot, dest);
      before.shot = dest;
    }
    writeJson(path.join(dir, "profile-before.json"), before);
    for (const l of warnLines(o)) console.log(l);
    console.log("보고   " + driveReport(batch, orderId, x));
  } else if (x.pr?.shot) {
    try {
      fs.unlinkSync(x.pr.shot);
    } catch {}
  }
  process.exitCode = r.status;
}

// 사람이 보는 보고. <드라이브>/에이전트/보고/<날짜>-팔로워분할.md 에 이어 붙인다
function driveReport(batch, orderId, x) {
  if (flag("root")) return "시험이라 보고 파일은 건너뛴다";
  const m = readJson(path.join(OPS, "machine.json"), {});
  if (!m.drive_root) return "machine.json 에 drive_root 가 없어 보고 파일은 건너뛴다";
  const d = new Date();
  const day = `${String(d.getFullYear()).slice(2)}${p2(d.getMonth() + 1)}${p2(d.getDate())}`;
  const f = path.join(m.drive_root.replace(/\//g, path.sep), "에이전트", "보고", `${day}-팔로워분할.md`);
  const plan = fs.readFileSync(path.join(BATCHES, batch, "plan.txt"), "utf8").trim();
  const lines = [`## ${stamp().slice(11, 16)} ${batch}`, "", "```", profileLine(x.pr), plan, "```", "", `- 첫 주문번호 ${orderId || "(안 찍힘, log.txt 를 본다)"}`, ""];
  try {
    const head = fs.existsSync(f) ? "\n" : `# ${day} 팔로워 분할 주문\n\n`;
    fs.appendFileSync(f, head + lines.join("\n"), "utf8");
    return f;
  } catch (e) {
    return "보고 파일을 못 썼다: " + e.message;
  }
}

async function cmdStatus() {
  const id = positional[0] || followerBatches().at(-1)?.id;
  if (!id) fail("팔로워 묶음이 없다. start 로 만든다");
  const r = passEngine(["status", id, ...(has("api") ? ["--api"] : [])]);
  if (r.status !== 0) return;
  const s = readJson(path.join(BATCHES, id, "state.json"));
  const before = readJson(path.join(BATCHES, id, "profile-before.json"));
  if (before?.ok && before.followers !== null && before.followers !== undefined) console.log(`시작전 팔로워 ${num(before.followers)}명 (${before.at})` + (before.shot ? `, 캡처 ${before.shot}` : ""));
  if (has("api") && s?.orders?.length) {
    // 3시간 넘게 한 명도 안 들어온 주문을 짚는다. 해외 상품이면 플래그 설정, 아니면 비공개 전환을 먼저 의심한다
    const st = await api({ action: "status", orders: s.orders.slice(-100).map((o) => o.orderId).join(",") }).catch(() => null);
    const one = s.orders.length === 1 && st && st.status !== undefined ? { [s.orders[0].orderId]: st } : st || {};
    const stuck = s.orders.filter((o) => {
      const v = one[o.orderId];
      return v && /pending|in progress|processing/i.test(v.status || "") && Number(v.remains) >= s.qty && Date.now() - toMs(o.at) > 3 * 3600 * 1000;
    });
    if (stuck.length)
      console.log(`주의   3시간 넘게 한 명도 안 들어온 주문 ${stuck.length}건 (#${stuck.map((o) => o.orderId).join(", #")}). ` +
        (regionOf({ name: s.serviceName || "" }) === "global" ? "계정의 '검토를 위해 플래그 지정'이 켜져 있는지 본다" : "계정이 비공개로 바뀌었는지 본다"));
  }
  if (has("profile") && s) {
    const now = await readProfile(s.link);
    console.log(profileLine(now).replace(/^계정 {3}/, "지금   "));
    if (now.ok && before?.ok && Number.isFinite(now.followers) && Number.isFinite(before.followers)) {
      const diff = now.followers - before.followers;
      console.log(`변화   시작 전 ${num(before.followers)}명 → 지금 ${num(now.followers)}명 (${diff >= 0 ? "+" : ""}${num(diff)}명, 넣은 주문 ${num(s.orders.length * s.qty)}명)`);
    }
  }
}

function cmdList() {
  const all = followerBatches();
  if (!all.length) return console.log("팔로워 묶음이 없다");
  for (const b of all) {
    const st = b.done ? "완료" : b.stopped ? "멈춤" : b.paused ? `멈춤(${b.paused})` : "진행 또는 끊김 (status 로 본다)";
    console.log(`${b.id}  ${st}  ${b.orders.length}/${b.runs} × ${num(b.qty)}명  @${b.link}  상품 ${b.service}`);
  }
}

function help() {
  const lines = [];
  for (const l of fs.readFileSync(SELF, "utf8").split("\n").slice(1)) {
    if (!l.startsWith("//")) break;
    lines.push(l.replace(/^\/\/ ?/, ""));
  }
  console.log(lines.join("\n"));
}

const passthrough = (name) => () => passEngine([name, ...argv.slice(1).filter((a, i, arr) => !(a === "--root" || arr[i - 1] === "--root"))]);
const commands = {
  products: cmdProducts,
  check: cmdCheck,
  profile: cmdProfile,
  plan: cmdPlan,
  start: cmdStart,
  status: cmdStatus,
  list: cmdList,
  stop: passthrough("stop"),
  resume: passthrough("resume"),
  guard: passthrough("guard"),
  watch: passthrough("watch"),
  help,
};
if (!commands[cmd]) {
  help();
  process.exitCode = 2;
} else {
  try {
    await commands[cmd]();
  } catch (e) {
    if (e instanceof ExitError) process.exitCode = e.code;
    else {
      console.error(e.message || e);
      process.exitCode = 1;
    }
  }
}
