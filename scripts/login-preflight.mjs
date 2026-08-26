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
  } catch {
    return null;
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

let best = null;
for (const p of list) {
  const logins = savedLogins(p.dir);
  const cookies = cookieHosts(p.dir);
  const live = cookies ? WATCH.filter((d) => has(cookies, d)) : [];

  if (!best || live.length > best.live.length) best = { ...p, live, logins };

  console.log(`[${p.dir}] ${p.name}`);
  console.log(`  구글 로그인   : ${p.account ?? "안 되어 있음"}`);
  console.log(
    `  저장된 비밀번호: ${logins.count === null ? "못 읽음" : logins.count + "건"}` +
      (logins.hosts.length ? ` (${logins.hosts.slice(0, 6).join(", ")})` : ""),
  );
  console.log(
    `  세션 살아있음  : ${cookies === null ? "못 읽음" : live.length ? live.join(", ") : "없음"}`,
  );
  console.log();
}

console.log("---");
if (best && best.live.length) {
  console.log(`세션이 가장 많이 살아있는 프로필: [${best.dir}] ${best.name}`);
  console.log("크롬을 이 프로필로 띄우고 L3 을 붙여라:");
  console.log(
    `  "/c/Program Files/Google/Chrome/Application/chrome.exe" --profile-directory="${best.dir}" &`,
  );
} else {
  console.log("어느 프로필에도 업무용 세션이 없다. 사람이 한 번 로그인해야 한다.");
}

const total = list.reduce((n, p) => n + (savedLogins(p.dir).count || 0), 0);
if (total < 10) {
  console.log();
  console.log(
    `저장된 비밀번호가 전부 합쳐 ${total}건뿐이다. 로그인 창을 만나면 자동완성이 안 뜬다.`,
  );
  console.log("`scripts/chrome-passwords-export.mjs` 로 CSV 를 만들어 크롬에 가져와라.");
}
