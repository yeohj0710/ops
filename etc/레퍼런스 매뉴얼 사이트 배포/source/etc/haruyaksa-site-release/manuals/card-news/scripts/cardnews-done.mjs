#!/usr/bin/env node
// 올린 카드뉴스 폴더를 `업로드 완료` 로 옮기고 게시 기록을 남긴다. 게시 확인 뒤에 돌린다.
//
//   node cardnews-done.mjs "<폴더 경로>" --url https://www.instagram.com/p/XXXX/
//   node cardnews-done.mjs "<폴더 경로>" --url ... --dry-run
//
// **게시를 눈으로 확인하기 전에 돌리지 마라.** 옮기고 나면 다음 세션은 올린 것으로 본다.
// 판정은 화면이 아니라 API 다. `/api/v1/media/<pk>/info/` 의 `carousel_media` 길이와
// `caption.text` 길이가 맞는지 보고 나서 돌린다.
//
// 구글 드라이브(G:) 위에서는 한글 폴더를 `rename` 으로 옮기면 깨질 때가 있다.
// 그래서 복사 → 파일 수와 크기 대조 → 원본 삭제 순으로 간다.

import fs from "node:fs";
import path from "node:path";

const OPS = "C:/dev/ops";
const MACHINE = JSON.parse(fs.readFileSync(path.join(OPS, "machine.json"), "utf8"));
const DRIVE = MACHINE.drive_root.replace(/\//g, path.sep);
const ROOT = path.join(DRIVE, "영상 편집", "AI 크리에이터", "카드뉴스");
const DONE = path.join(ROOT, "업로드 완료");
const LOG = path.join(ROOT, "게시기록.jsonl");

const args = process.argv.slice(2);
const urlIndex = args.indexOf("--url");
const URL_ = urlIndex >= 0 ? args[urlIndex + 1] : null;
const DRY = args.includes("--dry-run");
const src = args.filter((a, i) => !a.startsWith("--") && i !== urlIndex + 1)[0];

if (!src || !URL_) {
  console.log('사용법: node cardnews-done.mjs "<폴더 경로>" --url <게시물 주소> [--dry-run]');
  process.exit(2);
}
if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
  console.log(`폴더가 없다: ${src}`);
  process.exit(2);
}
if (!/^https:\/\/www\.instagram\.com\/(p|reel)\/[A-Za-z0-9_-]+\/?$/.test(URL_)) {
  console.log(`게시물 주소 모양이 아니다: ${URL_}`);
  process.exit(2);
}

const name = path.basename(src);
const dest = path.join(DONE, name);

const listFiles = (dir) =>
  fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase() !== "desktop.ini")
    .map((f) => ({ f, size: fs.statSync(path.join(dir, f)).size }))
    .sort((a, b) => a.f.localeCompare(b.f));

const before = listFiles(src);
console.log(`옮길 폴더: ${name}`);
console.log(`  원본  ${src}`);
console.log(`  대상  ${dest}`);
console.log(`  파일  ${before.length}개`);
console.log(`  주소  ${URL_}`);

if (fs.existsSync(dest)) {
  console.log("이미 대상에 같은 이름이 있다. 손으로 확인해라.");
  process.exit(4);
}
if (DRY) {
  console.log("\n--dry-run 이라 아무것도 안 했다.");
  process.exit(0);
}

// 구글 드라이브(G:)에서 `fs.cpSync` 는 오류 메시지도 없이 프로세스를 죽인다(종료 코드 127).
// 한 파일씩 읽어 쓰면 멀쩡하다. 카드뉴스 폴더는 깊이가 1이라 재귀도 필요 없다.
fs.mkdirSync(DONE, { recursive: true });
fs.mkdirSync(dest, { recursive: true });
for (const f of fs.readdirSync(src)) {
  const from = path.join(src, f);
  if (fs.statSync(from).isDirectory()) {
    fs.mkdirSync(path.join(dest, f), { recursive: true });
    for (const g of fs.readdirSync(from)) {
      fs.writeFileSync(path.join(dest, f, g), fs.readFileSync(path.join(from, g)));
    }
    continue;
  }
  fs.writeFileSync(path.join(dest, f), fs.readFileSync(from));
}

const after = listFiles(dest);
const same =
  before.length === after.length && before.every((b, i) => b.f === after[i].f && b.size === after[i].size);
if (!same) {
  console.log("\n복사본이 원본과 다르다. 원본을 지우지 않았다. 손으로 확인해라.");
  console.log(`  원본 ${before.length}개 / 복사본 ${after.length}개`);
  process.exit(5);
}

// `fs.rmSync({recursive:true})` 도 G: 에서 똑같이 프로세스를 죽인다. 하나씩 지운다.
for (const f of fs.readdirSync(src)) {
  const p = path.join(src, f);
  if (fs.statSync(p).isDirectory()) {
    for (const g of fs.readdirSync(p)) fs.unlinkSync(path.join(p, g));
    fs.rmdirSync(p);
    continue;
  }
  fs.unlinkSync(p);
}
fs.rmdirSync(src);

const rec = { name, url: URL_, files: after.length, movedAt: new Date().toISOString() };
fs.appendFileSync(LOG, JSON.stringify(rec) + "\n", "utf8");

console.log("\n옮겼다. 파일 수와 크기가 원본과 같은 것을 확인하고 지웠다.");
console.log(`  기록  ${LOG}`);
