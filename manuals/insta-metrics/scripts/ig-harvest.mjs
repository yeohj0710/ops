#!/usr/bin/env node
/* 인스타 지표 수집기 — 셸에서 끝까지 돈다. 에이전트의 브라우저 도구가 필요 없다.
 *
 *   node ig-harvest.mjs --check                                  // 돌 수 있는 상태인지 본다
 *   node ig-harvest.mjs --targets <targets.json> --out <harvest.json>
 *   node ig-harvest.mjs --login                                  // 사람이 한 번 로그인한다 (선택)
 *
 * 왜 이렇게 생겼나.
 * 260830 런이 여기서 섰다. 매뉴얼이 "로그인된 크롬 탭에 harvest.js 를 붙여넣어라" 였는데
 * Codex 의 브라우저 런타임은 evaluate 가 읽기 전용이라 `window.IGM = ...` 이 안 먹었다.
 * 도구가 막히자 런너는 사람에게 붙여넣기를 부탁하고 업무를 차단으로 적었다.
 * 그래서 수집을 에이전트의 브라우저 밖으로 뺐다. 이 스크립트는 자기 크롬을 직접 띄운다.
 * 어느 런너에서 돌리든 셸만 있으면 된다.
 *
 * 로그인이 필요 없다 (260831 실측).
 * - `web_profile_info` 와 `feed/user` 는 로그아웃 상태로도 200 을 준다. 릴스 조회수까지 나온다
 * - 400 스키마 오류가 나는 계정은 프로필 HTML 에서 pk 와 팔로워를 꺼내 우회한다
 * - 로그인이 있으면 그 계정들의 바이오와 연락처까지 더 가져온다. 없어도 업무는 끝난다
 * - 조사 트래픽이 섭외 DM 계정에 안 쌓인다. 그 계정이 잠기면 시딩 업무가 통째로 선다
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

// ── playwright 를 찾는다. 전역 설치라 상대 경로 해석이 안 되니 절대 경로로 부른다 ────────
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
  throw new Error(
    "playwright 를 못 찾았다. `npm i -g playwright` 하고 다시 돌려라.\n찾아본 곳: " +
      PW_CANDIDATES.join(", ")
  );
}

// ── 인자 ──────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name, dflt = null) => {
  const i = argv.indexOf("--" + name);
  return i > -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const has = (name) => argv.includes("--" + name);

const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData/Local");
const OPT = {
  targets: flag("targets"),
  out: flag("out"),
  gap: Number(flag("gap", "1200")),
  limit: Number(flag("limit", "0")),
  // 릴스 탭을 몇 번 굴려 타일을 붙일지. 기본 3 이면 18타일 안팎이다.
  // 이상치를 다시 잴 때는 --scrolls 8 처럼 올려 표본을 늘린다
  scrolls: Math.max(1, Number(flag("scrolls", "3"))),
  profile: flag("profile", path.join(LOCAL, "ops/ig-session")),
  // 사람이 이미 로그인해 둔 크롬에 붙는다. 크롬을 --remote-debugging-port=9222 로 띄워 두면 된다.
  // 좋아요 중앙값, 공개 연락처, 1만 넘는 팔로워는 로그인 없이는 안 나오는데
  // 크롬 151 부터 쿠키가 App-Bound 암호화라 로그인을 다른 프로필로 옮겨 심을 수가 없다(260831 실측)
  cdp: has("cdp") ? flag("cdp", "http://127.0.0.1:9222") : null,
  check: has("check"),
  login: has("login"),
  fresh: has("fresh"), // 이어받지 않고 처음부터 다시
  headed: has("headed"),
  every: Number(flag("every", "10")),
};

if (!Number.isFinite(OPT.gap) || OPT.gap < 1000) {
  console.error(
    "간격을 1초 밑으로 내리지 마라. 260829 에 1.1초로 700회를 돌려도 차단이 없었다. 그 선을 지킨다."
  );
  process.exit(2);
}

// ── 목록 읽기. 절차 1번이 만드는 어떤 모양이든 받는다 ──────────────────────────────
function readHandles(file) {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  const out = [];
  const push = (v) => {
    const h = String(v || "").trim().replace(/^@/, "");
    if (h && !out.includes(h)) out.push(h);
  };
  if (Array.isArray(j)) {
    for (const v of j) push(typeof v === "string" ? v : v.handle || v.account || v.계정);
  } else {
    if (Array.isArray(j.handles)) j.handles.forEach(push);
    for (const box of [j.targets, j.tabs]) {
      if (!box || typeof box !== "object") continue;
      for (const rows of Object.values(box)) {
        if (Array.isArray(rows)) {
          for (const r of rows) push(typeof r === "string" ? r : r.handle || r.account || r.계정);
        } else if (rows && Array.isArray(rows.handles)) {
          rows.handles.forEach(push);
        }
      }
    }
  }
  return out;
}

// ── 저장. 한 건 끝날 때마다 쓴다. 중간에 죽어도 그때까지가 남는다 ──────────────────
function save(file, state) {
  const tmp = file + ".tmp";
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1), "utf8");
  fs.renameSync(tmp, file);
}

// ── 한 계정을 브라우저 안에서 훑는다 ──────────────────────────────────────────────
// 이 함수는 통째로 페이지 안으로 넘어간다. 바깥 변수를 쓰면 안 된다.
async function grabInPage([name, authed, feedDead]) {
  const H = { "x-ig-app-id": "936619743392459" };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const med = (a) => {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
  };
  const cleanUrl = (u) => {
    try {
      const x = new URL(u);
      return (x.origin + x.pathname).replace(/\/$/, "");
    } catch {
      return String(u).split("?")[0];
    }
  };
  const emailIn = (s) => (String(s || "").match(/[\w.+-]+@[\w-]+\.[\w.]{2,}/) || [])[0] || null;
  const jget = async (u) => {
    const r = await fetch(u, { headers: H, credentials: "include" });
    const t = await r.text();
    let j = null;
    try {
      j = JSON.parse(t);
    } catch {}
    return { s: r.status, j };
  };
  // "2,202" "17.1만" "17K" 를 다 숫자로 만든다
  const toNum = (raw) => {
    const s = String(raw || "").replace(/,/g, "").trim();
    const m = s.match(/^([\d.]+)\s*(억|만|천|[KMB])?$/i);
    if (!m) return null;
    const n = parseFloat(m[1]);
    if (!isFinite(n)) return null;
    const mul =
      { 억: 1e8, 만: 1e4, 천: 1e3 }[m[2]] ??
      { K: 1e3, M: 1e6, B: 1e9 }[(m[2] || "").toUpperCase()] ??
      1;
    return Math.round(n * mul);
  };

  // 1. 정문. 로그아웃 상태로도 200 을 준다
  let p = null;
  let soft401 = false;
  const a = await jget("/api/v1/users/web_profile_info/?username=" + encodeURIComponent(name));
  if (a.s === 429) return { st: "차단429", halt: 429 };
  if (a.s === 401) {
    // 로그인해서 도는 중이면 401 은 세션이 죽은 것이다. 거기서 끝낸다.
    // 로그아웃으로 도는 중이면 401 이 간헐로 튄다. 260831 에 같은 계정이 401 이었다가 곧 200 이었다.
    // 한 건으로 판정하지 말고 아래 우회로 내려간다. 연달아 나면 바깥 반복문이 끊는다.
    if (authed) return { st: "차단401", halt: 401 };
    soft401 = true;
  }
  if (a.s === 200 && a.j && a.j.data && a.j.data.user) {
    const u = a.j.data.user;
    p = {
      pk: u.id,
      f: u.edge_followed_by ? u.edge_followed_by.count : null,
      po: u.edge_owner_to_timeline_media ? u.edge_owner_to_timeline_media.count : null,
      priv: !!u.is_private,
      bio: u.biography || "",
      email: u.business_email || u.public_email || null,
      phone: u.business_phone_number || null,
      links: [...(u.bio_links || []).map((l) => l.url), u.external_url].filter(Boolean),
    };
  }

  // 2. 400 은 계정 문제가 아니다.
  //    ig_business_category_subvertical 스키마가 깨져서 나는 인스타 쪽 오류다.
  //    로그인이 있으면 topsearch 로 pk 를 찾아 연락처까지 받아온다
  if (!p && authed) {
    await sleep(600);
    const sr = await jget("/web/search/topsearch/?context=blended&query=" + encodeURIComponent(name));
    if (sr.s === 429) return { st: "차단429", halt: 429 };
    const hit =
      sr.j && Array.isArray(sr.j.users)
        ? sr.j.users.map((x) => x.user).find((u) => u && u.username === name)
        : null;
    if (hit) {
      await sleep(600);
      const ir = await jget("/api/v1/users/" + hit.pk + "/info/");
      if (ir.s === 200 && ir.j && ir.j.user) {
        const u = ir.j.user;
        p = {
          pk: String(hit.pk),
          f: u.follower_count ?? null,
          po: u.media_count ?? null,
          priv: !!(u.is_private ?? hit.is_private),
          bio: u.biography || "",
          email: u.public_email || u.business_email || null,
          phone: u.business_phone_number || null,
          links: [...(u.bio_links || []).map((l) => l.url), u.external_url].filter(Boolean),
          via: 1,
        };
      }
    }
  }

  // 3. 로그인이 없어도 되는 우회.
  //    프로필 HTML 에 pk 가 박혀 있고 og:description 에 팔로워와 게시물 수가 있다
  if (!p) {
    await sleep(400);
    const hr = await fetch("/" + encodeURIComponent(name) + "/", { credentials: "include" });
    if (hr.status === 429) return { st: "차단429", halt: 429 };
    if (hr.status === 404) return { st: "계정없음", soft401 };
    if (!hr.ok) return { st: "프로필" + hr.status, soft401 };
    const t = await hr.text();
    const m =
      t.match(/"profile_id":"(\d+)"/) ||
      t.match(/"user_id":"(\d+)"/) ||
      t.match(/profilePage_(\d+)/);
    if (!m) return { st: "계정없음", soft401 };
    const og = (t.match(/<meta property="og:description" content="([^"]{0,400})"/) || [])[1] || "";
    const dec = og
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"');
    // "팔로워 17,078명, 팔로잉 788명, 게시물 294개 - 이름(@handle)님의 Instagram ..."
    // 숫자 안에 콤마가 들어 있어서 콤마로 자르면 17 이 된다. 이름 앞에서 자르고 숫자만 순서대로 뽑는다
    const head = dec.split(" - ")[0].replace(/,/g, "");
    const tok = head.match(/\d+(?:\.\d+)?\s*[억만천KMB]?/gi) || [];
    const nums = tok.map(toNum);
    // 인스타는 1만이 넘으면 og 를 "17K" 로 줄여 쓴다. 줄인 값을 실측이라고 시트에 넣지 않는다.
    // 팔로워는 비워 두고 참고값만 남긴다. 이 업무의 목적은 릴스 중앙 조회수다
    const rough = /[억만천KMB]/i.test(tok[0] || "");
    p = {
      pk: m[1],
      f: rough ? null : nums[0] ?? null,
      fx: rough ? nums[0] ?? null : null, // 줄여 쓴 참고값. 시트에는 쓰지 않는다
      po: nums[2] ?? null,
      priv: false, // HTML 만으로는 모른다. 피드가 비면 아래에서 비공개로 본다
      bio: "",
      email: null,
      phone: null,
      links: [],
      via: 2,
    };
  }

  const contact = [p.email || emailIn(p.bio), p.phone, ...p.links.map(cleanUrl)]
    .filter(Boolean)
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .slice(0, 3);

  const row = { f: p.f, po: p.po, c: contact };
  if (p.fx) row.fx = p.fx;
  if (p.via) row.via = p.via;
  if (soft401) row.soft401 = 1;
  if (p.priv) {
    row.st = "비공개";
    return row;
  }

  // 4. 게시물. web_profile_info 의 edges 는 빈 배열로 오니 여기서 받는다.
  //    이번 런에서 피드 API 가 이미 죽은 걸로 판명났으면 부르지 않고 바로 릴스 탭으로 간다
  if (feedDead) {
    row.needTab = 1;
    return row;
  }
  await sleep(500);
  const fr = await jget("/api/v1/feed/user/" + p.pk + "/?count=33");
  if (fr.s === 429) {
    row.st = "차단429";
    row.halt = 429;
    return row;
  }
  if (fr.s === 401) {
    if (authed) {
      row.st = "차단401";
      row.halt = 401;
      return row;
    }
    // 로그아웃으로 도는 중이면 피드 API 만 막힌 것이다. 릴스 탭 화면에는 조회수가 그대로 렌더된다.
    // 바깥에서 그 탭을 열어 타일을 읽는다
    row.needTab = 1;
    return row;
  }
  if (fr.s !== 200 || !fr.j) {
    row.st = fr.s === 403 ? "비공개" : "피드" + fr.s;
    if (fr.s >= 500) row.needTab = 1;
    return row;
  }
  const items = fr.j.items || [];
  if (!items.length && p.po > 0) {
    row.st = "비공개";
    return row;
  }
  const isPinned = (i) =>
    i?.is_pinned === true ||
    i?.is_pinned_for_username === true ||
    (Array.isArray(i?.timeline_pinned_user_ids) && i.timeline_pinned_user_ids.length > 0) ||
    (Array.isArray(i?.pinned_for_users) && i.pinned_for_users.length > 0);
  const pinned = items.filter(isPinned);
  const regularItems = items.filter((i) => !isPinned(i));
  const clips = regularItems.filter((i) => i.product_type === "clips");
  // 한 편만 보여도 그 값을 쓴다. 다 보여야 한다는 규칙이 지난 런에서 601행을 빈칸으로 남겼다
  const plays = clips.map((i) => i.play_count).filter((v) => typeof v === "number" && v > 0);
  // like_count 는 좋아요를 숨긴 글에서 -1 이나 0 으로 온다. 그대로 세면 중앙값이 주저앉는다
  const likes = regularItems.map((i) => i.like_count).filter((v) => typeof v === "number" && v > 0);

  row.n = items.length;
  row.pn = pinned.length;
  row.rn = clips.length;
  row.vn = plays.length;
  row.rm = med(plays);
  row.lm = med(likes);
  row.last = items.length
    ? new Date(Math.max(...items.map((i) => i.taken_at)) * 1000).toISOString().slice(0, 10)
    : null;
  row.st = plays.length ? "측정" : clips.length ? "조회수숨김" : "릴스없음";
  row.src = "api";
  return row;
}

// ── 피드 API 가 막혔을 때. 릴스 탭 화면에서 조회수를 읽는다 ────────────────────────
// 로그아웃 상태에서도 타일마다 조회수가 렌더된다 (260821, 260831 실측).
// 이 함수도 통째로 페이지 안으로 넘어간다.
function readReelTiles() {
  const parse = (raw) => {
    const s = String(raw || "").trim().replace(/,/g, "");
    const m = s.match(/^([\d.]+)\s*(억|만|천|[KMB])?$/i);
    if (!m) return null;
    const n = parseFloat(m[1]);
    if (!isFinite(n)) return null;
    const unit = (m[2] || "").toUpperCase();
    const mul = { 억: 1e8, 만: 1e4, 천: 1e3, K: 1e3, M: 1e6, B: 1e9 }[m[2]] ?? { K: 1e3, M: 1e6, B: 1e9 }[unit] ?? 1;
    return Math.round(n * mul);
  };
  const anchors = [...document.querySelectorAll("main a[href]")].filter((a) =>
    /\/reel\/[^/]+\//.test(a.getAttribute("href") || "")
  );
  const pinLabel = /^(?:고정|고정됨|고정 게시물|고정된 게시물|pinned|pinned post)$/i;
  const isPinned = (a) => {
    const box = a.parentElement || a;
    return [...box.querySelectorAll("[aria-label]")].some((n) =>
      pinLabel.test((n.getAttribute("aria-label") || "").trim())
    );
  };
  const regularAnchors = anchors.filter((a) => !isPinned(a));
  const views = regularAnchors
    .map((a) => parse((a.innerText || "").trim().split("\n")[0]))
    .filter((v) => typeof v === "number" && v > 0);
  const txt = (document.body.innerText || "").slice(0, 3000);
  return {
    rn: anchors.length,
    pn: anchors.length - regularAnchors.length,
    views,
    priv: /비공개 계정입니다|This Account is Private|이 계정은 비공개/.test(txt),
    wall: !!document.querySelector('input[name="username"]'),
  };
}

// ── 브라우저를 띄운다 ─────────────────────────────────────────────────────────────
async function openBrowser(chromium, headless) {
  // ── 사람 크롬에 붙는 길. 여기로 오면 로그인이 이미 되어 있다 ──────────────────────
  if (OPT.cdp) {
    let browser;
    try {
      browser = await chromium.connectOverCDP(OPT.cdp, { timeout: 8000 });
    } catch (e) {
      throw new Error(
        `${OPT.cdp} 에 못 붙었다. 크롬을 디버깅 포트로 띄워야 한다.\n` +
          `크롬을 전부 닫고 이걸 친다:\n` +
          `  "C:/Program Files/Google/Chrome/Application/chrome.exe" --remote-debugging-port=9222\n` +
          `원래 오류: ${e.message}`
      );
    }
    const ctx = browser.contexts()[0];
    if (!ctx) throw new Error("붙기는 했는데 컨텍스트가 없다. 크롬 창이 하나는 열려 있어야 한다.");
    const page = await ctx.newPage(); // 사람이 보던 탭은 건드리지 않는다. 새 탭에서 논다
    await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
    const authed = (await ctx.cookies("https://www.instagram.com")).some(
      (c) => c.name === "sessionid" && c.value
    );
    // 브라우저는 사람 것이니 닫지 않는다. 우리가 연 탭만 닫는다
    return { ctx: { close: () => page.close().catch(() => {}), cookies: (u) => ctx.cookies(u) }, page, authed };
  }

  fs.mkdirSync(OPT.profile, { recursive: true });
  const base = {
    headless,
    viewport: { width: 1280, height: 900 },
    args: ["--disable-blink-features=AutomationControlled"],
  };
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(OPT.profile, { channel: "chrome", ...base });
  } catch {
    ctx = await chromium.launchPersistentContext(OPT.profile, base); // 크롬이 없으면 번들 크로미움
  }
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded", timeout: 60000 });

  // 새 프로필의 첫 호출은 csrftoken 과 mid 가 아직 없어서 401 이 튄다. 붙을 때까지 기다린다
  for (let i = 0; i < 6; i++) {
    const names = (await ctx.cookies("https://www.instagram.com")).map((c) => c.name);
    if (names.includes("csrftoken") && names.includes("mid")) break;
    await page.waitForTimeout(1000);
  }

  // ds_user_id 는 로그아웃해도 남는다. 진짜 로그인 표시는 sessionid 다 (260831 실측)
  const authed = (await ctx.cookies("https://www.instagram.com")).some(
    (c) => c.name === "sessionid" && c.value
  );
  return { ctx, page, authed };
}

// 릴스 탭을 열어 타일 조회수를 읽는다. 지연 로딩이라 한 번 굴려야 붙는 계정이 있다
async function tabViews(page, name) {
  await page.goto("https://www.instagram.com/" + encodeURIComponent(name) + "/reels/", {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });
  await page
    .waitForFunction(
      () =>
        [...document.querySelectorAll("main a[href]")].some((a) =>
          /\/reel\/[^/]+\//.test(a.getAttribute("href") || "")
        ) || (document.body.innerText || "").length > 400,
      { timeout: 12000 }
    )
    .catch(() => {});
  // 한 번만 굴리면 12~16 타일에서 멈춘다. 260831 에 yfh_0822 이 12타일 중앙 21,500,
  // 18타일 중앙 14,000 으로 1.5배 벌어졌다. 기본 세 번 굴려 붙는 만큼 받는다.
  // 이상치 재측정 런은 --scrolls 8 로 올려 표본을 더 넓게 잡는다
  for (let s = 0; s < OPT.scrolls; s++) {
    const before = await page.evaluate(
      () => document.querySelectorAll("main a[href*=\"/reel/\"]").length
    );
    await page.mouse.wheel(0, 1400).catch(() => {});
    await page.waitForTimeout(1200);
    const after = await page.evaluate(
      () => document.querySelectorAll("main a[href*=\"/reel/\"]").length
    );
    if (after <= before) break; // 더 안 붙으면 그만 굴린다
  }
  return page.evaluate(readReelTiles);
}

function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

// 한 계정. API 로 먼저 가고, 피드가 막히면 릴스 탭 화면으로 내려간다
async function grabOne(page, name, authed, feedDead = false) {
  let row;
  try {
    row = await page.evaluate(grabInPage, [name, authed, feedDead]);
  } catch (e) {
    return { st: "예외", e: String(e).slice(0, 80) };
  }
  if (!row.needTab) return row;
  delete row.needTab;
  row.tabbed = 1;
  try {
    const t = await tabViews(page, name);
    row.rn = t.rn;
    row.pn = t.pn;
    row.vn = t.views.length;
    row.rm = median(t.views);
    row.src = "tab";
    row.st = t.priv ? "비공개" : t.views.length ? "측정" : t.rn ? "조회수숨김" : "릴스없음";
    if (t.wall) {
      row.st = "차단401";
      row.soft401 = 1;
    }
  } catch (e) {
    row.st = "릴스탭실패";
    row.e = String(e).slice(0, 60);
  }
  return row;
}

function summary(s) {
  const by = {};
  const src = {};
  for (const r of s.rows) {
    by[r.st] = (by[r.st] || 0) + 1;
    if (r.src) src[r.src] = (src[r.src] || 0) + 1;
  }
  const rm = s.rows
    .map((r) => r.rm)
    .filter((v) => typeof v === "number")
    .sort((a, b) => a - b);
  return {
    총: s.총,
    끝난것: s.rows.length,
    멈춤사유: s.halted || null,
    상태분포: by,
    조회수출처: src, // api = 피드 API, tab = 릴스 탭 화면. 둘은 5% 안팎 다르다
    릴스중앙조회수: rm.length
      ? { 개수: rm.length, 최소: rm[0], 중앙: rm[rm.length >> 1], 최대: rm[rm.length - 1] }
      : null,
    연락처있음: s.rows.filter((r) => (r.c || []).length).length,
    파일: OPT.out,
  };
}

// ── 실행 ──────────────────────────────────────────────────────────────────────────
const chromium = await loadChromium();

if (OPT.login) {
  const { ctx, page } = await openBrowser(chromium, false);
  await page.goto("https://www.instagram.com/accounts/login/", { waitUntil: "domcontentloaded" });
  console.error("창이 떴다. 사람이 직접 로그인해라. 비밀번호는 에이전트가 넣지 않는다.");
  console.error("로그인이 끝나면 스크립트가 알아서 알아채고 닫는다. Enter 를 누를 필요 없다.");
  // Enter 를 기다리면 에이전트 세션에서 stdin 이 없어 영영 안 끝난다. 쿠키를 직접 본다
  const 제한초 = Number(flag("wait", "420"));
  let ok = false;
  for (let s = 0; s < 제한초; s += 3) {
    const ck = await ctx.cookies("https://www.instagram.com");
    if (ck.some((c) => c.name === "sessionid" && c.value)) {
      ok = true;
      await page.waitForTimeout(2500); // 남은 쿠키가 다 붙게 잠깐 둔다
      break;
    }
    await page.waitForTimeout(3000);
  }
  console.log(JSON.stringify({ 프로필: OPT.profile, 로그인: ok }, null, 1));
  await ctx.close();
  process.exit(ok ? 0 : 1);
}

if (OPT.check) {
  const t0 = Date.now();
  const { ctx, page, authed } = await openBrowser(chromium, !OPT.headed);
  let probe = { st: "안돌았음" };
  // 첫 호출은 간헐로 401 이 튄다. 계정을 바꿔 한 번 더 본다
  for (const who of ["wellnessbox_global_official", "haruyaksa"]) {
    probe = await grabOne(page, who, authed);
    if (["측정", "릴스없음", "조회수숨김"].includes(probe.st)) break;
    await page.waitForTimeout(1500);
  }
  await ctx.close();
  const ok = ["측정", "릴스없음", "조회수숨김"].includes(probe.st);
  console.log(
    JSON.stringify(
      {
        방식: OPT.cdp ? "사람 크롬에 붙음 " + OPT.cdp : "자기 프로필 " + OPT.profile,
        로그인: authed,
        붙는데걸린초: Math.round((Date.now() - t0) / 100) / 10,
        표본: probe.st,
        조회수출처: probe.src || null,
        판정: ok ? "PASS — 수집 가능" : "FAIL — " + probe.st,
      },
      null,
      1
    )
  );
  process.exit(ok ? 0 : 1);
}

if (!OPT.targets || !OPT.out) {
  console.error("쓰는 법: node ig-harvest.mjs --targets <targets.json> --out <harvest.json>");
  console.error("         node ig-harvest.mjs --check      // 먼저 이걸로 상태를 본다");
  process.exit(2);
}

let handles = readHandles(OPT.targets);
if (!handles.length) {
  console.error("목록이 비었다: " + OPT.targets);
  process.exit(2);
}
if (OPT.limit > 0) handles = handles.slice(0, OPT.limit);

// 이어받기. 같은 out 파일에 이미 있는 계정은 다시 부르지 않는다
let state = {
  createdAt: new Date().toISOString(),
  gap: OPT.gap,
  총: handles.length,
  halted: null,
  rows: [],
};
if (!OPT.fresh && fs.existsSync(OPT.out)) {
  try {
    const prev = JSON.parse(fs.readFileSync(OPT.out, "utf8"));
    const rows = Array.isArray(prev) ? prev : prev.rows || [];
    state.rows = rows;
    if (!Array.isArray(prev) && prev.createdAt) state.createdAt = prev.createdAt;
  } catch {}
}
const done = new Set(state.rows.map((r) => r.u).filter(Boolean));
const todo = handles.filter((h) => !done.has(h));
console.error(`대상 ${handles.length}개, 이미 받은 것 ${done.size}개, 이번에 볼 것 ${todo.length}개`);

if (!todo.length) {
  console.log(JSON.stringify(summary(state), null, 1));
  process.exit(0);
}

const { ctx, page, authed } = await openBrowser(chromium, !OPT.headed);
console.error(
  `브라우저 준비됨. 로그인 ${authed ? "있음" : "없음 (없어도 된다)"}. 간격 ${OPT.gap}ms`
);

const idxOf = new Map(handles.map((h, i) => [h, i]));
const t0 = Date.now();
let dryStreak = 0; // 연달아 아무 값도 못 받으면 그때가 진짜 막힌 것이다
let tabStreak = 0; // 피드 API 가 계속 막히면 아예 부르지 않고 릴스 탭으로 간다
let feedDead = false;

for (let k = 0; k < todo.length; k++) {
  const name = todo[k];
  const row = await grabOne(page, name, authed, feedDead);
  const halt = row.halt;
  delete row.halt;

  // 값이 하나라도 나왔으면 막힌 게 아니다. 계정없음과 비공개도 정상 결과다
  const usable =
    typeof row.rm === "number" ||
    typeof row.f === "number" ||
    ["계정없음", "비공개", "릴스없음", "조회수숨김"].includes(row.st);
  dryStreak = usable ? 0 : dryStreak + 1;

  tabStreak = row.tabbed ? tabStreak + 1 : 0;
  delete row.tabbed;
  if (!feedDead && tabStreak >= 6) {
    feedDead = true;
    console.error("피드 API 가 계속 막힌다. 남은 계정은 릴스 탭 화면에서만 읽는다.");
  }

  state.rows.push({ i: idxOf.get(name), u: name, ...row });

  if (halt || dryStreak >= 5) {
    state.halted = halt ? "차단 " + halt : "연속 5건에서 아무 값도 못 받았다";
    save(OPT.out, { ...state, updatedAt: new Date().toISOString() });
    console.error(
      `${state.halted}. 여기서 끝낸다. 재시도하지 않는다. ${k + 1}/${todo.length} 까지 했다.`
    );
    break;
  }

  save(OPT.out, { ...state, updatedAt: new Date().toISOString() });
  if ((k + 1) % OPT.every === 0 || k + 1 === todo.length) {
    const per = (Date.now() - t0) / (k + 1);
    const left = Math.round((per * (todo.length - k - 1)) / 1000);
    console.error(`${k + 1}/${todo.length}  남은시간 약 ${Math.floor(left / 60)}분 ${left % 60}초`);
  }
  await new Promise((r) => setTimeout(r, OPT.gap));
}

await ctx.close();
save(OPT.out, { ...state, updatedAt: new Date().toISOString() });
console.log(JSON.stringify(summary(state), null, 1));
process.exit(state.halted ? 3 : 0);
