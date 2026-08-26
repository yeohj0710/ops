#!/usr/bin/env node
// 자격증명/계정.md 의 ID·PW 표를 크롬 비밀번호 관리자가 읽는 CSV 로 바꾼다.
//
//   node scripts/chrome-passwords-export.mjs
//   node scripts/chrome-passwords-export.mjs --out "D:/어딘가/크롬가져오기.csv"
//
// 왜 하나: 에이전트는 비밀번호를 창에 못 친다. 대신 크롬이 자동완성으로 채우면 된다.
// 크롬에 한 번 넣어두면 아이디 칸을 누르는 것만으로 두 칸이 함께 찬다.
//
// 이 스크립트는 값을 화면에 찍지 않는다. 몇 건인지와 어느 서비스인지만 말한다.
// 만든 CSV 는 평문이다. 크롬에 가져온 뒤 반드시 지워라.

import fs from "node:fs";
import path from "node:path";

const MACHINE = JSON.parse(
  fs.readFileSync(new URL("../machine.json", import.meta.url), "utf8"),
);
const CRED_DIR = path.join(MACHINE.drive_root, "에이전트/자격증명");
const SRC = path.join(CRED_DIR, "계정.md");

const outArg = process.argv.indexOf("--out");
const OUT =
  outArg > -1 ? process.argv[outArg + 1] : path.join(CRED_DIR, "크롬-가져오기.csv");
// --dry: 몇 건이 나오는지만 세고 파일은 안 만든다. 평문을 디스크에 안 떨어뜨린다.
const DRY = process.argv.includes("--dry");

// 공개 저장소에 평문이 떨어지는 걸 막는다.
const REPO = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
if (path.resolve(OUT).startsWith(REPO)) {
  console.error("저장소 안에는 못 쓴다. --out 으로 드라이브 쪽 경로를 줘라.");
  process.exit(1);
}

// 서비스 이름 → 로그인 주소. 크롬은 주소로 짝을 맞춘다.
const SITES = [
  [/구글|회사 메일|유튜브|YouTube|Claude|OAuth/i, "https://accounts.google.com/"],
  [/인스타/i, "https://www.instagram.com/"],
  [/틱톡|TikTok/i, "https://www.tiktok.com/"],
  [/네이버|마이박스|스마트스토어/i, "https://nid.naver.com/"],
  [/쿠팡|Coupang/i, "https://xauth.coupang.com/"],
  [/Figma/i, "https://www.figma.com/"],
  [/ChatGPT|OpenAI/i, "https://auth.openai.com/"],
  [/카카오클라우드/i, "https://console.kakaocloud.com/"],
  [/Naver Cloud/i, "https://www.ncloud.com/"],
  [/사람인/i, "https://www.saramin.co.kr/"],
  [/레뷰/i, "https://www.revu.net/"],
  [/모두싸인/i, "https://app.modusign.co.kr/"],
  [/인포크/i, "https://inpock.co.kr/"],
  [/Zoho/i, "https://accounts.zoho.com/"],
  [/LinkedIn/i, "https://www.linkedin.com/"],
  [/^X$/i, "https://x.com/"],
  [/아임웹/i, "https://imweb.me/"],
  [/RCMS/i, "https://www.rcms.go.kr/"],
  [/IRIS/i, "https://www.iris.go.kr/"],
  [/청년창업사관학교/i, "https://start.kosmes.or.kr/"],
  [/SNS서포터/i, "https://snssupporter.com/"],
  [/Teams|OneDrive/i, "https://login.microsoftonline.com/"],
  [/김제조/i, "https://www.kimjejopharm.xyz/"],
];

// 사람별 표(| 사람 | 인스타 | 유튜브 | 틱톡 |)는 열 이름이 곧 서비스다.
const COLUMN_SITES = {
  인스타: "https://www.instagram.com/",
  유튜브: "https://accounts.google.com/",
  틱톡: "https://www.tiktok.com/",
};

function siteFor(name) {
  for (const [re, url] of SITES) if (re.test(name)) return url;
  return null;
}

function cells(line) {
  return line
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());
}

// 한 칸에 "@핸들 / 아이디 / 비번" 처럼 붙어 있는 경우가 있다.
function splitPair(cell) {
  const parts = cell.split("/").map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  return { username: parts[parts.length - 2], password: parts[parts.length - 1] };
}

// 비번 칸 뒤에 "(둘 다 같음)" 같은 주석이 붙어 있는 경우가 있다. 그대로 넣으면 로그인이 안 된다.
function stripNote(v) {
  return v.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

// 값이 아니라 설명문인 칸이 섞여 있다("사람이 로그인해야 함" 등).
// 주석을 떼고도 공백이 남으면 비밀번호가 아니다.
function looksLikeSecret(v) {
  return v.length > 0 && !/\s/.test(v);
}

const lines = fs.readFileSync(SRC, "utf8").split(/\r?\n/);
const rows = [];
const unmapped = [];
const notSecret = [];
let header = null;

for (const line of lines) {
  if (!line.startsWith("|")) {
    header = null;
    continue;
  }
  const c = cells(line);
  if (c.every((x) => /^-+$/.test(x))) continue;

  if (!header) {
    header = c;
    continue;
  }

  // 꼴 1: | 무엇 | ID | PW |
  if (header[1] === "ID" && header[2] === "PW") {
    const [name, rawId, rawPw] = c;
    if (!name || !rawId || !rawPw || rawId === "-" || rawPw === "-") continue;
    const url = siteFor(name);
    if (!url) {
      unmapped.push(name);
      continue;
    }
    const id = stripNote(rawId);
    const pw = stripNote(rawPw);
    if (!looksLikeSecret(id) || !looksLikeSecret(pw)) {
      notSecret.push(name);
      continue;
    }
    rows.push({ name, url, username: id, password: pw });
    continue;
  }

  // 꼴 2: | 사람 | 인스타 | 유튜브 | 틱톡 |
  if (header[0] === "사람") {
    const person = c[0];
    for (let i = 1; i < header.length; i++) {
      const url = COLUMN_SITES[header[i]];
      if (!url || !c[i] || c[i] === "-") continue;
      const pair = splitPair(c[i]);
      if (!pair) continue;
      const username = stripNote(pair.username);
      const password = stripNote(pair.password);
      if (!looksLikeSecret(username) || !looksLikeSecret(password)) {
        notSecret.push(`${person} ${header[i]}`);
        continue;
      }
      rows.push({ name: `${person} ${header[i]}`, url, username, password });
    }
  }
}

if (!rows.length) {
  console.log("가져올 게 없다. 계정.md 의 표 꼴이 바뀌었는지 봐라.");
  process.exit(1);
}

const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
const csv =
  "name,url,username,password\n" +
  rows.map((r) => [r.name, r.url, r.username, r.password].map(esc).join(",")).join("\n") +
  "\n";

if (!DRY) fs.writeFileSync(OUT, csv, "utf8");

console.log(
  DRY ? `${rows.length}건이 나온다. (--dry 라 파일은 안 만들었다)` : `${rows.length}건을 CSV 로 만들었다.`,
);
if (!DRY) console.log(OUT);
console.log();

const byUrl = {};
for (const r of rows) byUrl[new URL(r.url).hostname] = (byUrl[new URL(r.url).hostname] || 0) + 1;
console.log("사이트별:", Object.entries(byUrl).map(([h, n]) => `${h} ${n}`).join(", "));

if (notSecret.length) {
  console.log();
  console.log(`비밀번호가 아니라 설명문이라 건너뛴 것 ${notSecret.length}건: ${notSecret.join(", ")}`);
  console.log("이건 사람이 크롬에 직접 넣어야 한다.");
}

if (unmapped.length) {
  console.log();
  console.log(`주소를 몰라 건너뛴 것 ${unmapped.length}건: ${unmapped.join(", ")}`);
  console.log("이 스크립트의 SITES 표에 주소를 추가하면 다음부터 같이 나온다.");
}

console.log();
console.log("크롬에 넣는 법 (사람이 한다, 1분)");
console.log("  1. 주소창에 chrome://password-manager/settings");
console.log("  2. 비밀번호 가져오기 → 위 CSV 선택");
console.log("  3. 넣고 나면 CSV 를 지운다:");
console.log(`     rm "${OUT}"`);
console.log();
console.log("프로필마다 따로 저장된다. 업무용 크롬 프로필에서 해라.");
console.log("어느 프로필인지 모르면: node scripts/login-preflight.mjs");
