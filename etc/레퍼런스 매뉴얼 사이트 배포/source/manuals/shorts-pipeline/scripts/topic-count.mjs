#!/usr/bin/env node
// 본편 회로가 실제로 쓸 수 있는 소재만 센다.
//
//   node topic-count.mjs
//
// 폴더의 파일 수를 그냥 세면 틀린다. 본편의 `Load Config` 노드가 파일을 열어 보고
// `LOCKED_SOURCE_PACK=1` 이 있으면 건너뛴다. `*-instagram_*.md` 가 전부 그렇고,
// 그건 `원본 릴스` 회로가 쓰는 소재라 본편 재고가 아니다.
// 두 회로가 같은 폴더와 같은 `사용완료/` 를 쓰기 때문에 폴더만 봐서는 구분이 안 된다.

import fs from "node:fs";
import path from "node:path";

const ROOT = "C:/dev/n8n-youtube-shorts-automation";
const CHANNELS = [
  ["하루건강약사", "하루건강약사 소재"],
  ["건강장수비결", "건강장수비결 소재"],
];

// Load Config 의 listPendingFiles 와 같은 목록이다. 바뀌면 여기도 맞춰야 한다.
const IGNORED = new Set([
  "README.txt", "README.md", "줄소재.txt", "queue.txt",
  "used.jsonl", "upload-log.jsonl", "사용기록.jsonl", "업로드기록.jsonl",
]);
const LOCKED = /(?:^|\s)LOCKED_SOURCE_PACK=1(?:\s|$)/;

for (const [name, dir] of CHANNELS) {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) { console.log(`${name}: 폴더 없음 (${full})`); continue; }

  const files = fs.readdirSync(full, { withFileTypes: true }).filter(
    (e) => e.isFile() && !e.name.startsWith(".") && !IGNORED.has(e.name) && /\.(md|txt|json)$/i.test(e.name),
  );
  const usable = files.filter((e) => {
    try { return !LOCKED.test(fs.readFileSync(path.join(full, e.name), "utf8")); }
    catch { return true; }
  });

  console.log(`${name}: 본편 ${usable.length}개 (파일 ${files.length}, 원본릴스 몫 ${files.length - usable.length})`);
  for (const u of usable) console.log(`  - ${u.name}`);
}
