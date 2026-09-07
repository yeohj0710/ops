#!/usr/bin/env node
// 이번 호출에서 올릴 카드뉴스 한 벌을 정한다. 업로드 앞에 돌린다.
//
//   node cardnews-next.mjs <인스타피드.json>
//   node cardnews-next.mjs <인스타피드.json> --account haruyaksa
//   node cardnews-next.mjs <인스타피드.json> --root "<다른 콘텐츠 폴더>" --account aroundpharm_official
//
// --root 를 주면 그 폴더를 대기 폴더로 본다 (어라운드팜, 미미팜 운영 폴더의 콘텐츠/).
// mp4 가 든 폴더는 릴스로 판정한다. mp4 한 개와 캡션.txt 가 있으면 후보다.
//
// 인스타피드.json 은 로그인된 탭에서 받아 저장한다 (L3).
//   const r = await fetch("/api/v1/feed/user/<숫자id>/?count=30",
//     { headers: { "x-ig-app-id": "936619743392459" } }).then(r => r.json());
//   r.items.map(i => ({ code: i.code, taken: i.taken_at, cap: (i.caption?.text || "").split("\n")[0] }))
//
// 규칙은 릴스와 같다. **가장 오래된 미게시 한 벌**을 올린다. 폴더 이름 앞의 YYMMDDhhmm 이 순서다.
// 만든 순서대로 나가야 소재가 굶지 않는다.
//
// 게시 여부는 캡션 첫 줄로 판정한다. 카드뉴스 캡션 첫 줄은 제목이고, 폴더 이름에도 그 제목이 들어 있다.
// 폴더 이름은 `YYMMDDhhmm 제목 (판이름) (계정)` 꼴이다.

import fs from "node:fs";
import path from "node:path";

const OPS = "C:/dev/ops";
const MACHINE = JSON.parse(fs.readFileSync(path.join(OPS, "machine.json"), "utf8"));
const DRIVE = MACHINE.drive_root.replace(/\//g, path.sep);
const args = process.argv.slice(2);
const accIndex = args.indexOf("--account");
const ACCOUNT = accIndex >= 0 ? args[accIndex + 1] : null;
const rootIndex = args.indexOf("--root");
const ROOT = rootIndex >= 0 ? path.resolve(args[rootIndex + 1]) : path.join(DRIVE, "영상 편집", "AI 크리에이터", "카드뉴스");
const DONE = path.join(ROOT, "업로드 완료");
const skip = new Set([accIndex >= 0 ? accIndex + 1 : -1, rootIndex >= 0 ? rootIndex + 1 : -1]);
const feedPath = args.filter((a, i) => !a.startsWith("--") && !skip.has(i))[0];

if (!feedPath || !fs.existsSync(feedPath)) {
  console.log('사용법: node cardnews-next.mjs "<인스타피드.json>" [--account haruyaksa]');
  console.log("피드는 로그인된 탭에서 받아 저장한다. 파일 머리말의 코드를 보라.");
  process.exit(2);
}
if (!fs.existsSync(ROOT)) {
  console.log(`카드뉴스 폴더가 없다: ${ROOT}`);
  process.exit(2);
}

const norm = (s) => String(s || "").replace(/\s+/g, "").replace(/[.,!?·・…]/g, "").trim();

const feed = JSON.parse(fs.readFileSync(feedPath, "utf8"));
const items = Array.isArray(feed) ? feed : feed.items || [];
const postedCaps = items.map((i) => norm(i.cap ?? i.caption));

// `2608281430 진통제 계열별 선택 (노트판) (haruyaksa)` 를 뜯는다
const parse = (name) => {
  const m = name.match(/^(\d{10})\s+(.+?)(?:\s*\(([^()]*)\))?(?:\s*\(([^()]*)\))?$/);
  if (!m) return null;
  return { stamp: m[1], title: m[2].trim(), design: m[3] || "", account: m[4] || "" };
};

const rows = [];
for (const name of fs.readdirSync(ROOT)) {
  const full = path.join(ROOT, name);
  if (!fs.statSync(full).isDirectory()) continue;
  if (name === "업로드 완료") continue;
  const meta = parse(name);
  if (!meta) {
    rows.push({ name, state: "이름 형식 아님" });
    continue;
  }
  if (ACCOUNT && meta.account && meta.account !== ACCOUNT) continue;

  const files = fs.readdirSync(full);
  const mp4s = files.filter((f) => /\.mp4$/i.test(f));
  const kind = mp4s.length ? "릴스" : "카드뉴스";
  const pngs = kind === "릴스" ? mp4s : files.filter((f) => /\.png$/i.test(f)).sort();
  const capTxt = path.join(full, "캡션.txt");
  const hasCap = fs.existsSync(capTxt);
  // 캡션 첫 줄이 제목이다. 없으면 폴더 이름의 제목으로 견준다
  const capFirst = hasCap ? fs.readFileSync(capTxt, "utf8").split("\n")[0].trim() : "";
  const posted = postedCaps.includes(norm(capFirst)) || postedCaps.includes(norm(meta.title));

  rows.push({
    name,
    dir: full,
    ...meta,
    kind,
    cards: pngs.length,
    hasCap,
    capTxt,
    capFirst,
    posted,
    state: posted ? "게시됨" : "미게시",
  });
}

// 한 번에 여덟 벌을 지으면 시각이 다 같다. 그때는 폴더 이름으로 갈라 순서를 못 박는다.
// 안 그러면 세션마다 readdir 순서에 따라 다른 벌을 골라서 결과가 안 맞는다.
rows.sort(
  (a, b) =>
    String(a.stamp || "").localeCompare(String(b.stamp || "")) || String(a.name).localeCompare(String(b.name), "ko"),
);

console.log("올릴 카드뉴스 고르기 (규칙: 가장 오래된 미게시 한 벌)");
console.log(`  폴더: ${ROOT}`);
if (ACCOUNT) console.log(`  계정 한정: ${ACCOUNT}`);
console.log("");
for (const r of rows) {
  if (!r.dir) {
    console.log(`  [건너뜀] ${r.name}  (${r.state})`);
    continue;
  }
  const warn = r.kind === "릴스" ? (r.cards === 1 ? "" : " ⚠mp4개수") : r.cards < 2 ? " ⚠장수부족" : r.cards > 10 ? " ⚠10장초과" : "";
  const cw = r.hasCap ? "" : " ⚠캡션없음";
  console.log(`  ${r.state.padEnd(6)} ${r.stamp}  ${r.kind === "릴스" ? "릴스 " : String(r.cards).padStart(2) + "장"}  ${r.title} (${r.design})${warn}${cw}`);
}
console.log("");

const done = fs.existsSync(DONE) ? fs.readdirSync(DONE).filter((f) => fs.statSync(path.join(DONE, f)).isDirectory()).length : 0;
console.log(`  업로드 완료 폴더에 ${done}벌`);
console.log("");

const fits = (r) => (r.kind === "릴스" ? r.cards === 1 : r.cards >= 2 && r.cards <= 10) && r.hasCap;
const candidates = rows.filter((r) => r.dir && !r.posted && fits(r));
const broken = rows.filter((r) => r.dir && !r.posted && !fits(r));
if (broken.length) {
  console.log("  아래는 규격이 안 맞아 후보에서 뺐다.");
  broken.forEach((r) => console.log(`    ${r.name} (${r.cards}장, 캡션 ${r.hasCap ? "있음" : "없음"})`));
  console.log("");
}

if (!candidates.length) {
  console.log("미게시 후보 없음 — 이번 호출에서는 올리지 않는다.");
  console.log(JSON.stringify({ pick: null, reason: "no_candidate" }));
  process.exit(3);
}

const pick = candidates[0];
console.log(`고른 벌: ${pick.title} (${pick.design})`);
console.log(`  폴더    ${pick.dir}`);
console.log(`  종류    ${pick.kind}`);
console.log(`  장수    ${pick.cards}`);
console.log(`  계정    ${pick.account || "(폴더 이름에 없음)"}`);
console.log(`  캡션    ${pick.capTxt}`);
console.log(`  남은 후보 ${candidates.length}벌`);
console.log("");
console.log("다음: node <OPS>/manuals/shorts-pipeline/scripts/insta-file-server.mjs \"" + pick.dir + '"');
console.log("");
console.log(JSON.stringify({ pick: { dir: pick.dir, kind: pick.kind, title: pick.title, cards: pick.cards, account: pick.account, capTxt: pick.capTxt }, candidates: candidates.length }));
