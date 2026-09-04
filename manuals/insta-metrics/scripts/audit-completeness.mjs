#!/usr/bin/env node

// 인스타 지표 보충 완료 게이트.
// 빈칸을 단순히 세지 않고, 확인 완료된 예외와 아직 조사하지 않은 누락을 구분한다.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseCsv } from "./scan-junk.mjs";

const terminalReason = /계정\s*없음|릴스\s*없음|비공개(?:\s*계정)?|조회수\s*숨김|일반\s*노트\s*없음|일반노트없음/i;
const retryReason = /접근\s*실패|오류|미측정|미확인|재시도/i;
const text = (value) => String(value ?? "").trim();
const blank = (value) => text(value) === "";

function columnIndex(header, name) {
  const exact = header.findIndex((value) => text(value) === name);
  if (exact >= 0) return exact;
  const suffixed = header.findIndex((value) => text(value).endsWith(name));
  if (suffixed >= 0) return suffixed;
  throw new Error(`필수 열이 없다: ${name}`);
}

export function auditRows(rows) {
  assert.ok(rows.length >= 1, "CSV가 비었다");
  const header = rows[0];
  const col = Object.fromEntries([
    "플랫폼", "계정", "팔로워", "릴스 중앙 조회수", "1차 제안", "2차 상향",
    "3차 상향(상한)", "조회수 근거", "노트 중앙 좋아요",
  ].map((name) => [name, columnIndex(header, name)]));

  const report = {
    accountRows: 0,
    followerBlank: 0,
    viewsBlank: 0,
    terminalMetricBlanks: [],
    unhandledMetricBlanks: [],
    retryFailures: [],
    priceBlanks: [],
    xhsLikesWithoutViews: [],
  };

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const sheetRow = i + 2;
    const account = text(row[col["계정"]]);
    if (!account) continue;
    report.accountRows++;
    const platform = text(row[col["플랫폼"]]);
    const reason = text(row[col["조회수 근거"]]);
    const followerMissing = blank(row[col["팔로워"]]);
    const viewsMissing = blank(row[col["릴스 중앙 조회수"]]);
    if (followerMissing) report.followerBlank++;
    if (viewsMissing) report.viewsBlank++;

    if (retryReason.test(reason)) {
      report.retryFailures.push({ row: sheetRow, account, platform, reason });
    }
    if (followerMissing || viewsMissing) {
      const item = {
        row: sheetRow,
        account,
        platform,
        missing: [followerMissing && "팔로워", viewsMissing && "릴스 중앙 조회수"].filter(Boolean),
        reason,
      };
      if (terminalReason.test(reason)) report.terminalMetricBlanks.push(item);
      else report.unhandledMetricBlanks.push(item);
    }

    for (const name of ["1차 제안", "2차 상향", "3차 상향(상한)"]) {
      if (blank(row[col[name]])) report.priceBlanks.push({ row: sheetRow, account, column: name });
    }
    if (platform === "샤오홍슈" && !blank(row[col["노트 중앙 좋아요"]]) && viewsMissing) {
      report.xhsLikesWithoutViews.push({ row: sheetRow, account });
    }
  }

  report.ok = report.unhandledMetricBlanks.length === 0
    && report.retryFailures.length === 0
    && report.priceBlanks.length === 0
    && report.xhsLikesWithoutViews.length === 0;
  return report;
}

function selfTest() {
  const rows = [
    ["플랫폼", "계정", "팔로워", "릴스 중앙 조회수", "1차 제안", "2차 상향", "3차 상향(상한)", "조회수 근거", "노트 중앙 좋아요"],
    ["인스타그램", "@ok", "1000", "2000", "30000", "50000", "100000", "릴스 10편 실측", ""],
    ["인스타그램", "@gone", "", "", "30000", "50000", "100000", "계정 없음(재확인)", ""],
  ];
  assert.equal(auditRows(rows).ok, true, "확인 완료된 삭제 계정은 허용해야 한다");
  rows.push(["샤오홍슈", "bad", "1000", "", "30000", "50000", "100000", "접근실패", "20"]);
  const failed = auditRows(rows);
  assert.equal(failed.ok, false, "접근실패를 완료로 인정하면 안 된다");
  assert.equal(failed.retryFailures.length, 1);
  assert.equal(failed.xhsLikesWithoutViews.length, 1);
  console.log("audit-completeness self-test: ok");
}

if (process.argv.includes("--self-test")) {
  selfTest();
  process.exit(0);
}

const csvPath = process.argv[2];
const outIndex = process.argv.indexOf("--out");
const outPath = outIndex >= 0 ? process.argv[outIndex + 1] : null;
if (!csvPath) {
  console.error("쓰는 법: node audit-completeness.mjs <인플루언서.csv> [--out metrics-audit.json]");
  process.exit(2);
}
const report = auditRows(parseCsv(fs.readFileSync(csvPath, "utf8")));
if (outPath) {
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exit(1);

