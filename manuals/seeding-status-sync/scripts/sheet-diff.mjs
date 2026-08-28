#!/usr/bin/env node

// 시트를 고치기 전과 뒤를 대조해서, 허락한 칸 밖이 바뀌었는지 잡는다.
//
// 이 스크립트가 잡는 사고는 다섯이다.
//   1. 엉뚱한 열을 고쳤다 (열이 밀렸는데 옛 열 번호를 그대로 썼다)
//   2. 값이 있던 칸을 비웠다 (빈 값을 덮어썼다)
//   3. 행이 사라졌다 (붙여넣기가 옆줄을 먹었다, 정렬 중에 날아갔다)
//   4. 머리글이 바뀌었다 (데이터 행인 줄 알고 2행에 썼다)
//   5. 같은 열쇠가 두 줄이 됐다 (새 줄을 만들었는데 이미 있었다)
//
// **행 번호로 대조하지 않는다.** 열쇠 열(계정 핸들 등)의 값으로 짝을 짓는다.
// 그래야 중간에 정렬이 일어나도 헛경보가 안 난다.
//
// 쓰는 법
//   node sheet-diff.mjs --before <폴더> --after <폴더> --allow <allow.json> --out <diff.json>
//   node sheet-diff.mjs --self-test
//
// before/after 폴더에는 탭마다 `<탭이름>.csv` 가 있어야 한다. gviz 로 받은 그대로면 된다.
//
// allow.json 생김새
//   {
//     "중국 진행표": {
//       "keyColumn": "계정",
//       "columns": ["진행 상태", "②응답", "③협상 관련 메모", "④합의 단가", "⑤확정", "배정 건"],
//       "keys": ["@shihyan.s", "@yfh_0822"],
//       "newKeys": ["@newperson"],
//       "deletedKeys": ["@remove-after-user-approval"],
//       "emptyCells": [{"key":"@a","column":"③협상 관련 메모"}],
//       "protectedColumns": ["④합의 단가", "⑥방문 예정일"]
//     }
//   }
//
// `columns` 는 이번에 고쳐도 되는 열, `keys` 는 고쳐도 되는 행,
// `newKeys` 는 이번에 새로 만든 행, `deletedKeys` 는 사용자가 승인한 삭제 행이다.
// `emptyCells` 에 없는 기존 값 삭제는 실패한다. `protectedColumns` 는 다른 허용보다 우선한다.
// 허용값이 없으면 그 탭은 읽기 전용으로 본다.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// ── CSV 파싱 ────────────────────────────────────────────────────────────────
// 따옴표 안의 쉼표와 줄바꿈을 살린다. 직접 split(",") 하면 메모 칸에서 깨진다.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const s = String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const norm = (v) => String(v ?? "").trim();
const normKey = (v) => norm(v).toLowerCase().replace(/^@/, "");
const cellId = (key, column) => `${normKey(key)}\u0000${norm(column)}`;

// 머리글 → 열 번호. 같은 이름이 여러 개면 첫 번째를 쓴다.
export function headerIndex(header) {
  const map = new Map();
  header.forEach((h, i) => {
    const k = norm(h);
    if (k && !map.has(k)) map.set(k, i);
  });
  return map;
}

// 열쇠 값 → 행 배열. 중복을 보려고 배열로 둔다.
function indexByKey(rows, keyIdx) {
  const map = new Map();
  rows.forEach((r, i) => {
    const k = norm(r[keyIdx]);
    if (!k) return;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push({ row: r, at: i });
  });
  return map;
}

export function diffSheet(name, beforeCsv, afterCsv, allow = {}) {
  const out = {
    tab: name,
    headerChanged: [],
    disappearedKeys: [],
    unexpectedNewKeys: [],
    duplicateKeys: [],
    emptiedCells: [],
    outOfScope: [],
    allowedChanges: [],
    allowedDeletedKeys: [],
    rowCountBefore: 0,
    rowCountAfter: 0,
  };

  const b = parseCsv(beforeCsv);
  const a = parseCsv(afterCsv);
  if (!b.length || !a.length) {
    out.outOfScope.push({ why: "CSV 가 비었다" });
    return out;
  }

  const bHead = b[0];
  const aHead = a[0];
  const width = Math.max(bHead.length, aHead.length);
  for (let i = 0; i < width; i++) {
    if (norm(bHead[i]) !== norm(aHead[i])) {
      out.headerChanged.push({ col: i, before: norm(bHead[i]), after: norm(aHead[i]) });
    }
  }

  const bRows = b.slice(1);
  const aRows = a.slice(1);
  out.rowCountBefore = bRows.length;
  out.rowCountAfter = aRows.length;

  const keyName = allow.keyColumn;
  const hi = headerIndex(bHead);
  const keyIdx = keyName != null ? hi.get(norm(keyName)) : undefined;
  if (keyIdx === undefined) {
    out.outOfScope.push({ why: `열쇠 열을 못 찾았다: ${keyName}` });
    return out;
  }

  const allowedCols = new Set();
  for (const c of allow.columns || []) {
    const i = hi.get(norm(c));
    if (i === undefined) out.outOfScope.push({ why: `허용 열이 시트에 없다: ${c}` });
    else allowedCols.add(i);
  }
  const allowedKeys = new Set((allow.keys || []).map(norm));
  const newKeys = new Set((allow.newKeys || []).map(norm));
  const deletedKeys = new Set((allow.deletedKeys || []).map(norm));
  const emptyCells = new Set((allow.emptyCells || []).map((x) => cellId(x.key, x.column)));
  const protectedCols = new Set((allow.protectedColumns || []).map(norm));

  const bIdx = indexByKey(bRows, keyIdx);
  const aIdx = indexByKey(aRows, keyIdx);

  for (const [k, list] of aIdx) if (list.length > 1) out.duplicateKeys.push({ key: k, count: list.length });

  for (const [k] of bIdx) {
    if (aIdx.has(k)) continue;
    if (deletedKeys.has(k)) out.allowedDeletedKeys.push(k);
    else out.disappearedKeys.push(k);
  }
  for (const [k] of aIdx) if (!bIdx.has(k) && !newKeys.has(k)) out.unexpectedNewKeys.push(k);

  for (const [k, bList] of bIdx) {
    const aList = aIdx.get(k);
    if (!aList) continue;
    const before = bList[0].row;
    const after = aList[0].row;
    for (let c = 0; c < width; c++) {
      const bv = norm(before[c]);
      const av = norm(after[c]);
      if (bv === av) continue;

      const colName = norm(bHead[c]) || `col${c}`;
      const hit = { key: k, col: c, colName, before: bv, after: av };

      if (protectedCols.has(colName)) { out.outOfScope.push({ ...hit, why: "보호 열" }); continue; }
      if (bv !== "" && av === "") {
        if (allowedCols.has(c) && allowedKeys.has(k) && emptyCells.has(cellId(k, colName))) {
          out.allowedChanges.push(hit);
        } else out.emptiedCells.push(hit);
        continue;
      }
      if (!allowedCols.has(c)) { out.outOfScope.push({ ...hit, why: "허용하지 않은 열" }); continue; }
      if (!allowedKeys.has(k)) { out.outOfScope.push({ ...hit, why: "허용하지 않은 행" }); continue; }
      out.allowedChanges.push(hit);
    }
  }
  return out;
}

export function isClean(d) {
  return (
    d.headerChanged.length === 0 &&
    d.disappearedKeys.length === 0 &&
    d.unexpectedNewKeys.length === 0 &&
    d.duplicateKeys.length === 0 &&
    d.emptiedCells.length === 0 &&
    d.outOfScope.length === 0
  );
}

// ── 자체 검사 ───────────────────────────────────────────────────────────────
function selfTest() {
  const head = "No,진행 상태,계정,팔로워,③협상 관련 메모,④합의 단가\n";
  const before = head + "1,1차 발송,@a,1000,,\n2,미접촉,@b,2000,메모유지,70000\n";
  const allow = { keyColumn: "계정", columns: ["진행 상태", "③협상 관련 메모"], keys: ["@a"] };

  // 허용한 행, 허용한 열만 바뀌면 통과
  let d = diffSheet("t", before, head + "1,협상중,@a,1000,더 달라고 함,\n2,미접촉,@b,2000,메모유지,70000\n", allow);
  assert.ok(isClean(d), "허용 범위 안 변경은 통과해야 한다");
  assert.equal(d.allowedChanges.length, 2);

  // 엉뚱한 열 (팔로워)
  d = diffSheet("t", before, head + "1,1차 발송,@a,9999,,\n2,미접촉,@b,2000,메모유지,70000\n", allow);
  assert.equal(d.outOfScope.length, 1, "허용 안 한 열 변경을 잡아야 한다");
  assert.equal(d.outOfScope[0].colName, "팔로워");

  // 허용 안 한 행
  d = diffSheet("t", before, head + "1,1차 발송,@a,1000,,\n2,거절,@b,2000,메모유지,70000\n", allow);
  assert.equal(d.outOfScope.length, 1, "허용 안 한 행 변경을 잡아야 한다");
  assert.equal(d.outOfScope[0].key, "@b");

  // 값이 있던 칸을 비움
  d = diffSheet("t", before, head + "1,1차 발송,@a,1000,,\n2,미접촉,@b,2000,,70000\n", allow);
  assert.equal(d.emptiedCells.length, 1, "빈 값 덮어쓰기를 잡아야 한다");

  // 행이 사라짐
  d = diffSheet("t", before, head + "1,1차 발송,@a,1000,,\n", allow);
  assert.deepEqual(d.disappearedKeys, ["@b"], "사라진 행을 잡아야 한다");
  d = diffSheet("t", before, head + "1,1차 발송,@a,1000,,\n", { ...allow, deletedKeys: ["@b"] });
  assert.ok(isClean(d), "승인 목록의 행 삭제는 통과해야 한다");

  // 기존 값을 비우려면 셀 단위 승인 필요
  d = diffSheet("t", before, head + "1,1차 발송,@a,1000,,\n2,미접촉,@b,2000,,70000\n", {
    ...allow, keys: ["@a", "@b"], emptyCells: [{ key: "@b", column: "③협상 관련 메모" }],
  });
  assert.ok(isClean(d), "승인 목록의 셀 비우기는 통과해야 한다");

  // 보호 열은 일반 허용보다 우선
  d = diffSheet("t", before, head + "1,1차 발송,@a,1000,,99999\n2,미접촉,@b,2000,메모유지,70000\n", {
    ...allow, columns: [...allow.columns, "④합의 단가"], protectedColumns: ["④합의 단가"],
  });
  assert.equal(d.outOfScope[0].why, "보호 열");

  // 정렬만 바뀐 것은 헛경보가 아니다
  d = diffSheet("t", before, head + "2,미접촉,@b,2000,메모유지,70000\n1,1차 발송,@a,1000,,\n", allow);
  assert.ok(isClean(d), "행 순서만 바뀐 것은 통과해야 한다");

  // 머리글 변경
  d = diffSheet("t", before, "No,상태,계정,팔로워,③협상 관련 메모,④합의 단가\n1,1차 발송,@a,1000,,\n2,미접촉,@b,2000,메모유지,70000\n", allow);
  assert.equal(d.headerChanged.length, 1, "머리글 변경을 잡아야 한다");

  // 예상 못 한 새 줄
  d = diffSheet("t", before, before + "3,미접촉,@c,300,,\n", allow);
  assert.deepEqual(d.unexpectedNewKeys, ["@c"]);
  d = diffSheet("t", before, before + "3,미접촉,@c,300,,\n", { ...allow, newKeys: ["@c"] });
  assert.ok(isClean(d), "미리 적어 둔 새 줄은 통과해야 한다");

  // 따옴표 안 쉼표
  assert.deepEqual(parseCsv('a,"b,c",d')[0], ["a", "b,c", "d"]);
  assert.deepEqual(parseCsv('a,"두 줄\n메모",c')[0], ["a", "두 줄\n메모", "c"]);

  console.log("sheet-diff self-test: ok");
}

// ── 실행 ────────────────────────────────────────────────────────────────────
function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();

  const beforeDir = arg("--before");
  const afterDir = arg("--after");
  const allowPath = arg("--allow");
  const outPath = arg("--out");

  if (!beforeDir || !afterDir || !allowPath) {
    console.error("쓰는 법: sheet-diff.mjs --before <폴더> --after <폴더> --allow <allow.json> [--out <diff.json>]");
    process.exit(1);
  }

  selfTest();
  const allowAll = JSON.parse(fs.readFileSync(allowPath, "utf8"));
  const tabs = fs.readdirSync(beforeDir).filter((f) => f.endsWith(".csv")).map((f) => f.slice(0, -4));
  const report = { tabs: [], clean: true };

  for (const tab of tabs) {
    const bPath = path.join(beforeDir, `${tab}.csv`);
    const aPath = path.join(afterDir, `${tab}.csv`);
    if (!fs.existsSync(aPath)) {
      report.tabs.push({ tab, outOfScope: [{ why: "고친 뒤 CSV 가 없다" }] });
      report.clean = false;
      continue;
    }
    const d = diffSheet(
      tab,
      fs.readFileSync(bPath, "utf8"),
      fs.readFileSync(aPath, "utf8"),
      allowAll[tab] || {}
    );
    report.tabs.push(d);
    if (!isClean(d)) report.clean = false;
  }

  if (outPath) fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");

  for (const d of report.tabs) {
    const bad =
      d.headerChanged.length + d.disappearedKeys.length + d.unexpectedNewKeys.length +
      d.duplicateKeys.length + d.emptiedCells.length + d.outOfScope.length;
    const mark = bad ? "✗" : "✓";
    console.log(`${mark} ${d.tab}: 허용 변경 ${d.allowedChanges?.length ?? 0}건, 문제 ${bad}건`);
    for (const h of d.headerChanged) console.log(`    머리글 ${h.col}: "${h.before}" → "${h.after}"`);
    for (const k of d.disappearedKeys) console.log(`    행이 사라짐: ${k}`);
    for (const k of d.unexpectedNewKeys) console.log(`    예상 못 한 새 행: ${k}`);
    for (const k of d.duplicateKeys) console.log(`    열쇠 중복: ${k.key} ${k.count}줄`);
    for (const c of d.emptiedCells) console.log(`    칸을 비움: ${c.key} / ${c.colName} = "${c.before}"`);
    for (const c of d.outOfScope) console.log(`    범위 밖: ${c.key ?? ""} / ${c.colName ?? ""} "${c.before}" → "${c.after}" (${c.why})`);
  }

  if (!report.clean) {
    console.error("\n시트가 허용 범위 밖에서 바뀌었다. 자동 복원하지 말고 전후 값을 보고한다.");
    process.exit(1);
  }
  console.log("\nsheet-diff: 허용 범위 밖 변경 0건");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
