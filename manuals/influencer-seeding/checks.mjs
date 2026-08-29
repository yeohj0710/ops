#!/usr/bin/env node

// 인플루언서 시딩 진행 갱신 — 완료 검사
//
// 이 검사가 잡는 것은 다섯이다.
//   1. 안전 게이트 산출물 누락. 백업, 전후 CSV, 검증된 쓰기 계획
//   2. 허용 범위 밖 시트 변경. 엉뚱한 열, 지워진 칸, 사라진 행 (diff.json)
//   3. 남의 받은함을 보고 "회신 0건" 으로 끝낸 것 (unread-*-meta.json)
//   4. 안 읽음 복원 누락. 이 업무에서 제일 잘 나는 사고다
//   5. 시트가 의도 없이 바뀐 것 (행 수, 상태별 건수, 합의 단가, 수식, 정렬 역전)
//
// 쓰는 법
//   node manuals/influencer-seeding/checks.mjs <진행 중인 task JSON 경로>
//   node manuals/influencer-seeding/checks.mjs --self-test

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.OPS_ROOT || path.resolve(HERE, "..", "..");

// 채널마다 이 계정이어야 한다. 계정이 실제로 바뀌면 매뉴얼과 여기를 같이 고친다.
// 세션이 적어 낸 expectedAccount 를 믿지 않는다. 기대값까지 베껴 쓰면 검사가 의미를 잃는다.
export const CHANNELS = {
  instagram: "wellnessbox_global_official",
  gmail: "wellnessbox.global@gmail.com",
};

function normAccount(v) {
  return String(v || "")
    .trim()
    .toLowerCase()
    .replace(/^@/, "");
}

// 방이나 메일 스레드를 가리키는 열쇠. 링크가 있으면 링크, 없으면 스레드 id, 없으면 이름.
export function roomKey(room) {
  if (!room) return "";
  return String(
    room.링크 || room.link || room.스레드 || room.threadId || room.id || room.방 || room.room || ""
  ).trim();
}

// 복원이 안 된 방을 돌려준다. 빈 배열이면 통과다.
export function missingRestores(before, after) {
  const wasUnread = (before || []).filter((r) => r.안읽음 ?? r.unread);
  const nowUnread = new Set(
    (after || []).filter((r) => r.안읽음 ?? r.unread).map(roomKey).filter(Boolean)
  );
  return wasUnread.map(roomKey).filter((k) => k && !nowUnread.has(k));
}

// 읽은 받은함이 우리 것이었는지 본다. 빈 목록은 회신이 없다는 뜻도 되고 남의 받은함이라는 뜻도 된다.
export function accountProblems(meta, label) {
  const out = [];
  const where = label ? `${label} ` : "";
  for (const [channel, expected] of Object.entries(CHANNELS)) {
    const m = (meta || {})[channel];
    if (!m) {
      out.push(`${where}${channel}: 계정 확인 기록이 없다`);
      continue;
    }
    const observed = normAccount(m.observedAccount);
    if (!observed) {
      out.push(`${where}${channel}: observedAccount 가 비었다`);
      continue;
    }
    if (observed !== normAccount(expected)) {
      out.push(`${where}${channel}: ${expected} 를 봐야 하는데 ${m.observedAccount} 를 봤다`);
    }
    const status = String(m.status || "").trim();
    if (status !== "ok") {
      out.push(`${where}${channel}: status 가 ok 가 아니다 (${status || "빈칸"})`);
    }
  }
  return out;
}

function selfTest() {
  // 열쇠
  assert.equal(roomKey({ 링크: "https://x/1" }), "https://x/1");
  assert.equal(roomKey({ 스레드: "thread-a7" }), "thread-a7", "메일은 스레드 id 로 잡힌다");
  assert.equal(roomKey({ 방: "이름만" }), "이름만");
  assert.equal(roomKey(null), "");

  // 안 읽음 복원
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
  // 메일 스레드도 같은 규칙으로 잡힌다
  assert.deepEqual(
    missingRestores([{ 스레드: "t1", 안읽음: true }], [{ 스레드: "t1", 안읽음: false }]),
    ["t1"],
    "안 읽음으로 안 돌아온 메일을 잡아야 한다"
  );

  // 계정 확인
  const goodMeta = {
    instagram: { observedAccount: "@wellnessbox_global_official", status: "ok" },
    gmail: { observedAccount: "wellnessbox.global@gmail.com", userIndex: "u/6", status: "ok" },
  };
  assert.deepEqual(accountProblems(goodMeta), [], "맞는 계정이면 통과해야 한다");
  assert.equal(accountProblems({ instagram: goodMeta.instagram }).length, 1, "빠진 채널을 잡아야 한다");
  // 260827 사고 재현: 남의 지메일을 보고 회신 0건으로 끝냈다
  const wrongMeta = {
    instagram: goodMeta.instagram,
    gmail: { observedAccount: "wellnessbox.me@gmail.com", status: "wrong-account" },
  };
  assert.equal(accountProblems(wrongMeta).length, 2, "엉뚱한 계정과 ok 아닌 status 를 둘 다 잡아야 한다");
  // 기대값만 베껴 적어도 통과하지 않는다
  assert.ok(
    accountProblems({
      instagram: goodMeta.instagram,
      gmail: { expectedAccount: "wellnessbox.me@gmail.com", observedAccount: "wellnessbox.me@gmail.com", status: "ok" },
    }).length > 0,
    "expectedAccount 를 낮춰 적어도 상수와 대조해 잡아야 한다"
  );

  console.log("influencer-seeding self-test: ok");
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
for (const name of ["progress-rank.mjs", "validate-write-plan.mjs", "backup-sheet.mjs", "sheet-diff.mjs"]) {
  execFileSync(process.execPath, [path.join(HERE, "scripts", name), "--self-test"], { stdio: "inherit" });
}

const task = JSON.parse(fs.readFileSync(taskFile, "utf8"));
const taskDir = path.join(ROOT, "work", task.id);
const read = (name) => {
  const p = path.join(taskDir, name);
  if (!fs.existsSync(p)) {
    console.error(`없다: ${p}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
};

// 0. 안전 게이트 산출물
for (const name of ["before", "after", "write-plan.json", "write-plan.validated.json", "diff.json", "result.json"]) {
  assert.ok(fs.existsSync(path.join(taskDir, name)), `안전 산출물이 없다: ${name}`);
}

const writePlanHash = crypto
  .createHash("sha256")
  .update(fs.readFileSync(path.join(taskDir, "write-plan.json")))
  .digest("hex");
const validated = read("write-plan.validated.json");
assert.equal(validated.ok, true, "쓰기 계획 검사가 통과하지 않았다");
assert.equal(validated.inputSha256, writePlanHash, "검사 뒤 쓰기 계획이 바뀌었다");

// 1. 전체 백업
const latestPath = path.join(ROOT, "work", "_sheet-backups", "influencer-seeding", "latest.json");
assert.ok(fs.existsSync(latestPath), "일일 전체 백업 기록이 없다");
const latest = JSON.parse(fs.readFileSync(latestPath, "utf8"));
assert.equal(latest.status, "ok", "최근 전체 백업이 실패했다");
assert.ok(Date.now() - Date.parse(latest.createdAt) < 30 * 3_600_000, "전체 백업이 30시간보다 오래됐다");

// 2. 허용 범위 밖 시트 변경
const diff = read("diff.json");
let sheetProblems = 0;
for (const d of diff.tabs || []) {
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
assert.equal(sheetProblems, 0, "시트가 허용 범위 밖에서 바뀌었다. 버전 기록으로 복원하고 2단계부터 다시 해라");
assert.notEqual(diff.clean, false, "diff.clean 이 false 다");

const result = read("result.json");
const mode = String(result.mode || "갱신").trim();
assert.ok(["갱신", "정비"].includes(mode), `result.mode 가 갱신이나 정비여야 한다 (지금 ${mode})`);

// 3-4. 계정 확인과 안 읽음 복원. 정비 갈래는 받은함을 안 열었으니 건너뛴다.
if (mode === "갱신") {
  const beforeMeta = read("unread-before-meta.json");
  const afterMeta = read("unread-after-meta.json");
  const problems = [
    ...accountProblems(beforeMeta, "읽을 때"),
    ...accountProblems(afterMeta, "되돌릴 때"),
  ];
  for (const p of problems) console.error(p);
  assert.equal(
    problems.length,
    0,
    "우리 받은함을 본 기록이 없다. 계정을 갈아타고 4단계부터 다시 해라"
  );

  const unreadBefore = read("unread-before.json");
  const unreadAfter = read("unread-after.json");
  let restoreProblems = 0;
  for (const ch of new Set([...Object.keys(unreadBefore), ...Object.keys(unreadAfter)])) {
    const missed = missingRestores(unreadBefore[ch], unreadAfter[ch]);
    if (!missed.length) continue;
    restoreProblems += missed.length;
    console.error(`${ch}: 안 읽음으로 안 돌아온 것 ${missed.length}개`);
    for (const m of missed) console.error(`  - ${m}`);
  }
  assert.equal(restoreProblems, 0, "안 읽음 복원이 빠졌다. 되돌리고 다시 검사해라");
}

// 5. 시트 총량과 품질
assert.ok(Array.isArray(result.sheets), "result.sheets 배열이 필요하다");
assert.ok(result.sheets.length > 0, "검사한 탭이 없다");

const mustBeZero = [
  "inversionsAfter",
  "blankOfferRows",
  "formulaErrors",
  "missingStatusValidations",
  "missingCheckboxValidations",
  "helperValues",
  "manualOverridesChanged",
];

for (const s of result.sheets) {
  const added = Array.isArray(s.newRows) ? s.newRows.length : (s.newRows ?? 0);
  if (mode === "정비") {
    assert.equal(added, 0, `${s.title}: 정비 갈래는 줄을 만들지 않는다`);
    assert.equal(s.rowCountAfter, s.rowCountBefore, `${s.title}: 행 수가 바뀌었다`);
    assert.deepEqual(
      s.statusCountsAfter,
      s.statusCountsBefore,
      `${s.title}: 정비 갈래인데 상태별 건수가 바뀌었다`
    );
  } else {
    assert.equal(
      s.rowCountAfter,
      s.rowCountBefore + added,
      `${s.title}: 행 수가 새로 만든 줄(${added})만큼만 늘어야 한다`
    );
  }
  for (const key of mustBeZero) assert.equal(s[key] ?? 0, 0, `${s.title}: ${key}=${s[key]}`);
  assert.equal(
    s.agreedPricesChangedUnexpectedly ?? s.agreedPricesChanged ?? 0,
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
  `influencer-seeding checks(${mode}): 탭 ${result.sheets.length}개, 고친 행 ${touched}개, ` +
    `새 줄 ${newRows}개, 허용 범위 밖 변경 0건, ` +
    (mode === "갱신" ? "계정 어긋남 0건, 안 읽음 복원 누락 0건" : "행 수와 상태별 건수 그대로")
);
