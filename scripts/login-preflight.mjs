#!/usr/bin/env node
// 로그인 사전점검. 크롬 프로필마다 무엇이 준비돼 있는지 본다.
//
//   node scripts/login-preflight.mjs
//   node scripts/login-preflight.mjs instagram.com notion.so
//
// 비밀번호는 읽지 않는다. 저장된 개수와 어느 사이트인지, 쿠키가 있는지만 본다.
// (크롬은 비밀번호와 쿠키 '값' 을 OS 계정 키로 암호화한다. 여기서 보는 건 주소뿐이다.)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const USER_DATA = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData/Local"),
  "Google/Chrome/User Data",
);

// 업무가 실제로 들어가는 곳. 인자로 주면 그걸 본다.
const WATCH = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      "instagram.com",
      "notion.so",
      "figma.com",
      "cafe24.com",
      "docs.google.com",
      "naver.com",
      "coupang.com",
      "tiktok.com",
      "youtube.com",
      "kimjejopharm.xyz",
    ];

const TMP = path.join(os.tmpdir(), "ops-login-preflight");

// 크롬이 물고 있어 못 읽는 상태. null(파일 없음)과 구분한다.
const BUSY = Symbol("busy");

function sqlite(dbPath, query) {
  // 크롬이 파일을 물고 있어 원본은 못 읽는다. 복사해서 연다.
  fs.mkdirSync(TMP, { recursive: true });
  const copy = path.join(TMP, path.basename(dbPath) + "-" + Math.abs(hash(dbPath)));
  // 크롬은 WAL 모드로 쓴다. 본체만 복사하면 최근 것이 통째로 빠져 빈 표로 보인다.
  const sidecars = ["", "-wal", "-shm"];
  try {
    fs.copyFileSync(dbPath, copy);
    for (const ext of sidecars.slice(1)) {
      if (fs.existsSync(dbPath + ext)) fs.copyFileSync(dbPath + ext, copy + ext);
    }
  } catch (e) {
    // 크롬이 지금 쓰고 있는 프로필은 파일을 물고 있어 복사가 안 된다.
    // 이건 실패가 아니라 신호다. 이 프로필이 활성 프로필이라는 뜻이다.
    return e.code === "EBUSY" ? BUSY : null;
  }
  try {
    // sqlite3 가 윈도우 줄바꿈으로 뱉는다. \r 을 안 떼면 도메인 비교가 전부 빗나간다.
    return execFileSync("sqlite3", [copy, query], { encoding: "utf8" }).replace(/\r/g, "").trim();
  } catch {
    return null;
  } finally {
    for (const ext of sidecars) {
      try {
        fs.unlinkSync(copy + ext);
      } catch {}
    }
  }
}

function hash(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h;
}

function profiles() {
  const statePath = path.join(USER_DATA, "Local State");
  let cache = {};
  try {
    cache = JSON.parse(fs.readFileSync(statePath, "utf8")).profile?.info_cache ?? {};
  } catch {}
  return Object.entries(cache)
    .filter(([dir]) => fs.existsSync(path.join(USER_DATA, dir)))
    .map(([dir, info]) => ({
      dir,
      name: info.name || dir,
      account: info.user_name || null,
    }));
}

function savedLogins(dir) {
  const db = path.join(USER_DATA, dir, "Login Data");
  if (!fs.existsSync(db)) return { count: 0, hosts: [] };
  const out = sqlite(db, "select origin_url from logins;");
  if (out === BUSY) return { count: BUSY, hosts: [] };
  if (out === null) return { count: null, hosts: [] };
  const hosts = out
    .split("\n")
    .filter(Boolean)
    .map((u) => {
      try {
        return new URL(u).hostname;
      } catch {
        return u;
      }
    });
  return { count: hosts.length, hosts: [...new Set(hosts)] };
}

function cookieHosts(dir) {
  const db = path.join(USER_DATA, dir, "Network/Cookies");
  if (!fs.existsSync(db)) return null;
  const out = sqlite(db, "select distinct host_key from cookies;");
  if (out === BUSY) return BUSY;
  if (out === null) return null;
  return out.split("\n").filter(Boolean).map((h) => h.replace(/^\./, ""));
}

function has(hosts, domain) {
  return hosts.some((h) => h === domain || h.endsWith("." + domain));
}

const list = profiles();
if (!list.length) {
  console.log("크롬 프로필을 못 찾았다. 크롬이 설치된 경로를 확인해라:", USER_DATA);
  process.exit(1);
}

console.log("크롬 프로필 상태\n");

const seen = list.map((p) => {
  const logins = savedLogins(p.dir);
  const cookies = cookieHosts(p.dir);
  return {
    ...p,
    logins,
    // 쿠키를 못 읽는다 = 크롬이 이 프로필로 떠 있다.
    active: cookies === BUSY,
    live: Array.isArray(cookies) ? WATCH.filter((d) => has(cookies, d)) : null,
  };
});

for (const p of seen) {
  console.log(`[${p.dir}] ${p.name}${p.active ? "   ← 지금 크롬이 이걸로 떠 있다" : ""}`);
  console.log(`  구글 로그인   : ${p.account ?? "안 되어 있음"}`);

  const n = p.logins.count;
  console.log(
    `  저장된 비밀번호: ${n === BUSY ? "크롬이 쓰는 중" : n === null ? "못 읽음" : n + "건"}` +
      (p.logins.hosts.length ? ` (${p.logins.hosts.slice(0, 6).join(", ")})` : ""),
  );

  console.log(
    `  세션 살아있음  : ${
      p.active
        ? "크롬이 열어둬서 못 읽는다. 화면으로 확인해라"
        : p.live === null
          ? "못 읽음"
          : p.live.length
            ? p.live.join(", ")
            : "없음"
    }`,
  );
  console.log();
}

console.log("---");

// 떠 있는 프로필이 곧 업무 프로필이다. 그걸 두고 다른 프로필을 권하면 안 된다.
const active = seen.find((p) => p.active);
const richest = seen.filter((p) => p.live?.length).sort((a, b) => b.live.length - a.live.length)[0];

if (active) {
  console.log(`지금 쓰는 프로필: [${active.dir}] ${active.name}`);
  console.log("L3(크롬 익스텐션)은 이 프로필에 붙는다. 여기 없는 계정은 여기서 로그인해야 한다.");
  if (richest) {
    console.log(
      `참고로 안 떠 있는 프로필 중에는 [${richest.dir}] ${richest.name} 에 세션이 가장 많다 (${richest.live.join(", ")}).`,
    );
  }
} else if (richest) {
  console.log(`크롬이 안 떠 있다. 세션이 가장 많은 프로필: [${richest.dir}] ${richest.name}`);
  console.log(
    `  "/c/Program Files/Google/Chrome/Application/chrome.exe" --profile-directory="${richest.dir}" &`,
  );
} else {
  console.log("어느 프로필에도 업무용 세션이 없다. 사람이 한 번 로그인해야 한다.");
}

const counted = seen.filter((p) => typeof p.logins.count === "number");
const total = counted.reduce((n, p) => n + p.logins.count, 0);
const unknown = seen.length - counted.length;

console.log();
console.log(
  `저장된 비밀번호 합계 ${total}건` + (unknown ? ` (못 읽은 프로필 ${unknown}개 제외)` : ""),
);
if (active && typeof active.logins.count === "number" && active.logins.count < 10) {
  console.log(
    `지금 쓰는 프로필에는 ${active.logins.count}건뿐이다. 로그인 창에서 자동완성이 안 뜬다.`,
  );
  console.log("`scripts/chrome-passwords-export.mjs` 로 CSV 를 만들어 이 프로필에 가져와라.");
}
