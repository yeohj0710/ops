#!/usr/bin/env node

// 시딩 상황 파악과 진행표 갱신 — 완료 검사
//
// 이 검사가 잡는 것은 셋이다.
//   1. 허용 범위 밖 시트 변경. 엉뚱한 열, 지워진 칸, 사라진 행 (diff.json)
//   2. 안 읽음 복원 누락. 이 업무에서 제일 잘 나는 사고다
//   3. 시트가 의도 없이 바뀐 것 (행 수, 합의 단가, 수식 오류)
//
// 쓰는 법
//   node manuals/seeding-status-sync/checks.mjs <진행 중인 task JSON 경로>
//   node manuals/seeding-status-sync/checks.mjs --self-test

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.OPS_ROOT || path.resolve(HERE, "..", "..");

// 방을 가리키는 열쇠. 링크가 있으면 링크, 없으면 방 이름.
export function roomKey(room) {
  if (!room) return "";
  return String(room.링크 || room.link || room.방 || room.room || "").trim();
}

// 복원이 안 된 방을 돌려준다. 빈 배열이면 통과다.
export function missingRestores(before, after) {
  const wasUnread = (before || []).filter((r) => r.안읽음 ?? r.unread);
  const nowUnread = new Set(
    (after || []).filter((r) => r.안읽음 ?? r.unread).map(roomKey).filter(Boolean)
  );
  return wasUnread.map(roomKey).filter((k) => k && !nowUnread.has(k));
}

function selfTest() {
  const before = [
    { 방: "A", 링크: "https://x/1", 안읽음: true },
    { 방: "B", 링크: "https://x/2", 안읽음: true },
    { 방: "C", 링크: "https://x/3", 안읽음: false },
  ];
  assert.deepEqual(missingRestores(before, before), [], "그대로면 누락이 없어야 한다");
  assert.deepEqual(
    missingRestores(before, [{ 링크: "https://x/1", 안읽음: true }]),
    ["https://x/2"],
    "복원 안 된 방을 잡아야 한다"
  );
  assert.deepEqual(
    missingRestores(before, []).sort(),
    ["https://x/1", "https://x/2"],
    "전부 안 돌렸으면 전부 잡아야 한다"
  );
  // 읽기 전에 이미 읽음이던 방은 복원 대상이 아니다
  assert.ok(!missingRestores(before, before).includes("https://x/3"));
  console.log("seeding-status-sync self-test: ok");
}

if (process.argv.includes("--self-test")) {
  selfTest();
  process.exit(0);
}

const taskFile = process.argv[2] || process.env.OPS_TASK;
if (!taskFile || !fs.existsSync(taskFile)) {
  console.error("진행 중인 task JSON 경로가 필요하다");
  process.exit(1);
}

selfTest();
execFileSync(process.execPath, [path.join(HERE, "scripts", "sheet-diff.mjs"), "--self-test"], {
  stdio: "inherit",
});

const task = JSON.parse(fs.readFileSync(taskFile, "utf8"));
const work = path.join(ROOT, "work", task.id);
const read = (name) => {
  const p = path.join(work, name);
  if (!fs.existsSync(p)) {
    console.error(`없다: ${p}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
};

// 1. 허용 범위 밖 시트 변경
const diff = read("diff.json");
assert.ok(Array.isArray(diff.tabs), "diff.tabs 배열이 필요하다. sheet-diff.mjs 를 돌려라");
let sheetProblems = 0;
for (const d of diff.tabs) {
  const buckets = {
    "허용 범위 밖 변경": d.outOfScope,
    "값이 있던 칸을 비움": d.emptiedCells,
    "사라진 행": d.disappearedKeys,
    "예상 못 한 새 행": d.unexpectedNewKeys,
    "열쇠 중복": d.duplicateKeys,
    "머리글 변경": d.headerChanged,
  };
  for (const [label, list] of Object.entries(buckets)) {
    const n = (list || []).length;
    if (!n) continue;
    sheetProblems += n;
    console.error(`${d.tab}: ${label} ${n}건`);
  }
}
assert.equal(
  sheetProblems,
  0,
  "시트가 허용 범위 밖에서 바뀌었다. 버전 기록으로 복원하고 1단계부터 다시 해라"
);
assert.notEqual(diff.clean, false, "diff.clean 이 false 다");

// 2. 안 읽음 복원
const before = read("unread-before.json");
const after = read("unread-after.json");
const channels = new Set([
  ...Object.keys(before || {}),
  ...Object.keys(after || {}),
]);
let restoreProblems = 0;
for (const ch of channels) {
  const missed = missingRestores(before[ch], after[ch]);
  if (missed.length) {
    restoreProblems += missed.length;
    console.error(`${ch}: 안 읽음으로 안 돌아온 방 ${missed.length}개`);
    for (const m of missed) console.error(`  - ${m}`);
  }
}
assert.equal(restoreProblems, 0, "안 읽음 복원이 빠졌다. 되돌리고 다시 검사해라");

// 3. 시트 총량
const result = read("result.json");
assert.ok(Array.isArray(result.sheets), "result.sheets 배열이 필요하다");
assert.ok(result.sheets.length > 0, "검사한 탭이 없다");

for (const s of result.sheets) {
  const added = Array.isArray(s.newRows) ? s.newRows.length : (s.newRows ?? 0);
  assert.equal(
    s.rowCountAfter,
    s.rowCountBefore + added,
    `${s.title}: 행 수가 새로 만든 줄(${added})만큼만 늘어야 한다`
  );
  assert.equal(s.formulaErrors ?? 0, 0, `${s.title}: 수식 오류 ${s.formulaErrors}건`);
  assert.equal(
    s.agreedPricesChangedUnexpectedly ?? 0,
    0,
    `${s.title}: 손대지 않은 합의 단가가 바뀌었다`
  );
}

const touched = result.sheets.reduce(
  (n, s) => n + (Array.isArray(s.touchedRows) ? s.touchedRows.length : 0),
  0
);
const newRows = result.sheets.reduce(
  (n, s) => n + (Array.isArray(s.newRows) ? s.newRows.length : (s.newRows ?? 0)),
  0
);

console.log(
  `seeding-status-sync checks: 탭 ${result.sheets.length}개, 고친 행 ${touched}개, 새 줄 ${newRows}개, ` +
    `허용 범위 밖 변경 0건, 안 읽음 복원 누락 0건`
);
