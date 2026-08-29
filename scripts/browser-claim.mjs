#!/usr/bin/env node
// 크롬 프로필을 세션끼리 나눠 쓴다.
//
//   node scripts/browser-claim.mjs status            지금 프로필이 몇 개고 누가 쓰는지
//   node scripts/browser-claim.mjs claim <업무id>     비어 있는 프로필 하나를 잡는다
//   node scripts/browser-claim.mjs release <업무id>   놓는다
//
// 왜 있나. 세션 여러 개가 한 크롬을 두고 부딪히면 서로의 탭을 닫고 로그인을 갈아친다.
// 그래서 "브라우저를 누가 쓰고 있어서 못 한다" 로 줄줄이 멈췄다.
// 크롬은 프로필마다 따로 도니까 나눠 쓰면 된다. 이 파일이 누가 뭘 잡았는지만 적어 둔다.
//
// 이건 자물쇠가 아니라 표지판이다. 잡을 게 없다고 일을 멈추지 마라.
// 화면이 필요 없는 일부터 하고, 그것도 다 끝나면 그때 사람에게 알린다.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.OPS_ROOT || path.resolve(HERE, "..");
const CLAIMS = path.join(ROOT, "etc", "browser-claims.json");
const TTL_MIN = 45; // 세션이 죽어도 프로필이 영영 묶이지 않게 저절로 풀린다

const CHROME_DIR = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "Google",
  "Chrome",
  "User Data"
);
const CLAUDE_EXT = "fcoeoabgfenejglbffodgkkbkcdhcgfn"; // Claude in Chrome

const nowIso = () => new Date().toISOString();

function readClaims() {
  try {
    const j = JSON.parse(fs.readFileSync(CLAIMS, "utf8"));
    const cut = Date.now() - TTL_MIN * 60_000;
    // 오래된 것은 읽는 김에 털어낸다
    for (const [k, v] of Object.entries(j)) {
      if (!v || Date.parse(v.at) < cut) delete j[k];
    }
    return j;
  } catch {
    return {};
  }
}

function writeClaims(j) {
  fs.mkdirSync(path.dirname(CLAIMS), { recursive: true });
  fs.writeFileSync(CLAIMS, JSON.stringify(j, null, 2) + "\n", "utf8");
}

// 크롬이 파일을 물고 있으면 그 프로필은 실행 중이다.
function isRunning(dir) {
  const cookie = path.join(CHROME_DIR, dir, "Network", "Cookies");
  if (!fs.existsSync(cookie)) return false;
  try {
    fs.closeSync(fs.openSync(cookie, "r+"));
    return false;
  } catch {
    return true;
  }
}

function displayName(dir) {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(CHROME_DIR, dir, "Preferences"), "utf8"));
    return p?.profile?.name || "";
  } catch {
    return ""; // 실행 중이면 못 읽는다. 문제가 아니다
  }
}

function hasClaudeExt(dir) {
  return fs.existsSync(path.join(CHROME_DIR, dir, "Extensions", CLAUDE_EXT));
}

function profiles() {
  if (!fs.existsSync(CHROME_DIR)) return [];
  return fs
    .readdirSync(CHROME_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && (e.name === "Default" || e.name === "Profile" || /^Profile( \d+)?$/.test(e.name)))
    .map((e) => e.name)
    .filter((d) => fs.existsSync(path.join(CHROME_DIR, d, "Preferences")))
    .map((dir) => ({
      dir,
      name: displayName(dir),
      running: isRunning(dir),
      ext: hasClaudeExt(dir),
    }));
}

function table(rows, claims) {
  const line = (a, b, c, d, e) =>
    `  ${String(a).padEnd(11)} ${String(b).padEnd(18)} ${String(c).padEnd(8)} ${String(d).padEnd(8)} ${e}`;
  console.log(line("프로필", "이름", "실행중", "확장", "잡은 업무"));
  for (const p of rows) {
    const who = Object.entries(claims).find(([, v]) => v.dir === p.dir);
    console.log(
      line(
        p.dir,
        p.name || "(실행 중이라 못 읽음)",
        p.running ? "예" : "아니오",
        p.ext ? "있다" : "없다",
        who ? `${who[0]} (${who[1].at.slice(11, 16)})` : "-"
      )
    );
  }
}

const [cmd, jobId] = process.argv.slice(2);
const list = profiles();
const claims = readClaims();

if (!cmd || cmd === "status") {
  if (!list.length) {
    console.log("크롬 프로필을 못 찾았다: " + CHROME_DIR);
    process.exit(1);
  }
  table(list, claims);
  const usable = list.filter((p) => p.ext);
  console.log(
    `\n프로필 ${list.length}개, Claude 확장 있는 것 ${usable.length}개, 잡혀 있는 것 ${Object.keys(claims).length}개`
  );
  console.log(
    "\n확장이 깔려 있어도 그 프로필에서 확장에 로그인해야 list_connected_browsers 에 뜬다.\n" +
      "목록에 뜨는 개수가 여기 '확장 있다' 개수보다 적으면 로그인 안 된 프로필이 있는 것이다.\n" +
      "사람에게 이렇게 부탁해라. 크롬을 그 프로필로 띄우고 Claude 확장에 로그인한 뒤\n" +
      "확장 설정에서 브라우저 이름을 프로필 이름과 같게 바꿔 달라고."
  );
  process.exit(0);
}

if (cmd === "claim") {
  if (!jobId) {
    console.error("업무 id 가 필요하다: claim <업무id>");
    process.exit(1);
  }
  if (claims[jobId]) {
    console.log(`이미 잡고 있다: ${claims[jobId].dir}`);
    process.exit(0);
  }
  const taken = new Set(Object.values(claims).map((v) => v.dir));
  // 이미 떠 있는 프로필을 먼저 준다. 새로 띄우는 것보다 빠르고 사람 화면을 덜 건드린다.
  const free = list
    .filter((p) => p.ext && !taken.has(p.dir))
    .sort((a, b) => Number(b.running) - Number(a.running))[0];
  if (!free) {
    console.log("지금 잡을 수 있는 프로필이 없다.");
    table(list, claims);
    console.log(
      "\n멈추지 마라. 화면이 필요 없는 일부터 해라.\n" +
        "파일 정리, 검증, 시트 읽기, 보고서 쓰기는 브라우저 없이 된다.\n" +
        "그것까지 다 끝났으면 그때 사람에게 프로필을 하나 더 열어 달라고 적어라."
    );
    process.exit(2);
  }
  claims[jobId] = { dir: free.dir, name: free.name, at: nowIso() };
  writeClaims(claims);
  console.log(`잡았다: ${free.dir}${free.name ? ` (${free.name})` : ""}`);
  if (!free.running) {
    console.log(
      `\n안 떠 있다. 먼저 띄워라.\n  "/c/Program Files/Google/Chrome/Application/chrome.exe" --profile-directory="${free.dir}" about:blank &`
    );
  }
  console.log(
    `\n그다음 list_connected_browsers 로 목록을 보고 이 프로필에 맞는 것을 select_browser 로 고른다.\n` +
      `${TTL_MIN}분 지나면 저절로 풀린다. 끝나면 release ${jobId} 해라.`
  );
  process.exit(0);
}

if (cmd === "release") {
  if (!jobId) {
    console.error("업무 id 가 필요하다: release <업무id>");
    process.exit(1);
  }
  if (!claims[jobId]) {
    console.log("잡은 게 없다.");
    process.exit(0);
  }
  const dir = claims[jobId].dir;
  delete claims[jobId];
  writeClaims(claims);
  console.log(`놓았다: ${dir}`);
  process.exit(0);
}

console.error("쓰는 법: browser-claim.mjs status | claim <업무id> | release <업무id>");
process.exit(1);
