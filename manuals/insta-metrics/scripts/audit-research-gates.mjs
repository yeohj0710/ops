#!/usr/bin/env node

// 이상치·고액 제안 재조사가 실제 값과 맞는지 확인하는 완료 게이트.
// 단순히 숫자가 채워졌는지만 보지 않고 조사 대상 전수 포함, 고정 게시물 제외,
// 조사 원장과 시트 값 일치, 샤오홍슈 x50, 가격 공식을 함께 검사한다.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseCsv } from "./scan-junk.mjs";

const text = (value) => String(value ?? "").trim();
const key = (value) => text(value).toLowerCase().replace(/^@+/, "").replace(/\/$/, "");
const number = (value) => {
  const source = text(value).replace(/[^0-9.-]/g, "");
  return source === "" ? null : Number(source);
};
const median = (values) => {
  const sorted = values.filter(Number.isFinite).toSorted((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const estimate = (followers) => Math.round(followers * (followers < 3000 ? 1.4 : followers < 5000 ? 1.2 : followers < 10000 ? 0.76 : followers < 30000 ? 0.69 : followers < 50000 ? 0.6 : 0.55));
const mround = (value) => Math.round(value / 10000) * 10000;
const prices = (views) => {
  const first = Math.min(300000, Math.max(30000, mround(views * 5)));
  const second = Math.max(first, Math.min(300000, Math.max(50000, mround(views * 9))));
  const third = Math.max(second, Math.min(300000, Math.max(100000, mround(views * 15))));
  return [first, second, third];
};

function columnIndex(header, name) {
  const index = header.findIndex((value) => text(value) === name || text(value).endsWith(name));
  if (index < 0) throw new Error(`필수 열이 없다: ${name}`);
  return index;
}

function rowsFromCsv(csvRows) {
  const header = csvRows[0] ?? [];
  const names = ["플랫폼", "계정", "팔로워", "릴스 중앙 조회수", "1차 제안", "2차 상향", "3차 상향(상한)", "조회수 근거", "노트 중앙 좋아요"];
  const col = Object.fromEntries(names.map((name) => [name, columnIndex(header, name)]));
  return csvRows.slice(1).map((row, index) => ({
    row: index + 2,
    platform: text(row[col["플랫폼"]]),
    account: text(row[col["계정"]]),
    followers: number(row[col["팔로워"]]),
    views: number(row[col["릴스 중앙 조회수"]]),
    offers: [number(row[col["1차 제안"]]), number(row[col["2차 상향"]]), number(row[col["3차 상향(상한)"]])],
    evidence: text(row[col["조회수 근거"]]),
    noteMedianLikes: number(row[col["노트 중앙 좋아요"]]),
  })).filter((row) => row.account);
}

export function auditResearch({ csvRows, targets, instagramRows, xhsRows }) {
  const sheetRows = rowsFromCsv(csvRows);
  const allowedEvidence = new Set(["릴스 조회수 중앙값", "릴스 좋아요x40", "노트 좋아요x50", "틱톡 조회수", "팔로워 추정"]);
  const byAccount = new Map(sheetRows.map((row) => [key(row.account), row]));
  const ig = new Map(instagramRows.map((row) => [key(row.account), row]));
  const xhs = new Map(xhsRows.map((row) => [key(row.user_id || row.display_id), row]));
  const failures = [];
  const warnings = [];
  const checked = new Set();

  for (const row of sheetRows) {
    if (!allowedEvidence.has(row.evidence)) failures.push({ account: row.account, row: row.row, code: "invalid_evidence_value", value: row.evidence });
  }

  const targetRows = [...(targets.instagram || []), ...(targets.xhs || [])];
  for (const target of targetRows) {
    const accountKey = key(target.account);
    const platform = target.platform;
    const sheet = byAccount.get(accountKey);
    const research = platform === "샤오홍슈" ? xhs.get(accountKey) : ig.get(accountKey);
    if (!sheet) { failures.push({ account: target.account, code: "sheet_row_missing" }); continue; }
    if (!research) { failures.push({ account: target.account, code: "research_record_missing" }); continue; }
    checked.add(accountKey);

    if (platform === "인스타그램") {
      const measured = research.status === "측정" && Number.isFinite(research.median) && research.median > 0;
      if (measured) {
        const samples = Array.isArray(research.samples) ? research.samples : [];
        const pinned = Array.isArray(research.pinnedSamples) ? research.pinnedSamples : [];
        const recalculated = Math.round(median(samples));
        if (samples.length !== research.regularCount) failures.push({ account: target.account, code: "ig_sample_count_mismatch" });
        if (pinned.length !== (research.pinnedCount || 0)) failures.push({ account: target.account, code: "ig_pinned_count_mismatch" });
        if (recalculated !== research.median) failures.push({ account: target.account, code: "ig_median_bad", recalculated, recorded: research.median });
        if (sheet.views !== research.median) failures.push({ account: target.account, code: "ig_sheet_value_mismatch", sheet: sheet.views, recorded: research.median });
        if (sheet.evidence !== "릴스 조회수 중앙값") failures.push({ account: target.account, code: "ig_evidence_bad", value: sheet.evidence });
        if (research.regularCount < 5) warnings.push({ account: target.account, code: "all_visible_reels_under_5", count: research.regularCount });
      } else {
        const expected = estimate(sheet.followers);
        if (sheet.evidence !== "팔로워 추정" || sheet.views !== expected) failures.push({ account: target.account, code: "ig_fallback_bad", expected, actual: sheet.views, evidence: sheet.evidence });
      }
    } else if (platform === "샤오홍슈") {
      const measured = research.status === "측정" && Number.isFinite(research.estimated_views) && research.estimated_views > 0;
      if (measured) {
        const likes = Array.isArray(research.note_likes) ? research.note_likes : [];
        const pinned = Array.isArray(research.pinned_likes) ? research.pinned_likes : [];
        const likeMedian = median(likes);
        const expectedViews = Math.round(likeMedian * 50);
        if (likes.length !== research.note_count) failures.push({ account: target.account, code: "xhs_sample_count_mismatch" });
        if (pinned.length !== (research.pinned_count || 0)) failures.push({ account: target.account, code: "xhs_pinned_count_mismatch" });
        if (likeMedian !== research.note_likes_median || expectedViews !== research.estimated_views) failures.push({ account: target.account, code: "xhs_x50_bad" });
        // 노트 중앙 좋아요 열은 정수 서식이라 1.5가 CSV에서 2로 보일 수 있다.
        if (Math.round(sheet.noteMedianLikes) !== Math.round(likeMedian) || sheet.views !== expectedViews) failures.push({ account: target.account, code: "xhs_sheet_value_mismatch", expectedViews, actual: sheet.views });
        if (sheet.evidence !== "노트 좋아요x50") failures.push({ account: target.account, code: "xhs_evidence_bad", value: sheet.evidence });
      } else {
        const expected = estimate(sheet.followers);
        if (sheet.evidence !== "팔로워 추정" || sheet.views !== expected) failures.push({ account: target.account, code: "xhs_fallback_bad", expected, actual: sheet.views, evidence: sheet.evidence });
      }
    }
  }

  // 값 수정 뒤 새로 생긴 이상치나 고액 제안도 조사 원장 없이 통과시키지 않는다.
  for (const row of sheetRows) {
    const ratio = row.followers > 0 && row.views >= 0 ? row.views / row.followers : null;
    const needsResearch = ratio !== null && (ratio < 0.05 || ratio > 20) || (row.offers[0] ?? 0) >= 200000;
    if (needsResearch && !checked.has(key(row.account)) && !ig.has(key(row.account)) && !xhs.has(key(row.account))) {
      failures.push({ account: row.account, row: row.row, code: "current_outlier_without_research", ratio, firstOffer: row.offers[0] });
    }
    const expected = prices(row.views);
    if (row.offers.some((value, index) => value !== expected[index])) {
      failures.push({ account: row.account, row: row.row, code: "price_formula_result_bad", expected, actual: row.offers });
    }
  }

  return {
    ok: failures.length === 0,
    counts: {
      targetRows: targetRows.length,
      checkedTargets: checked.size,
      instagramRecords: instagramRows.length,
      xhsRecords: xhsRows.length,
      limitedSamples: warnings.length,
      failures: failures.length,
    },
    failures,
    warnings,
  };
}

function selfTest() {
  const header = ["플랫폼", "계정", "팔로워", "릴스 중앙 조회수", "1차 제안", "2차 상향", "3차 상향(상한)", "조회수 근거", "노트 중앙 좋아요"];
  const csvRows = [header, ["인스타그램", "@ok", "1000", "2000", "30000", "50000", "100000", "릴스 조회수 중앙값", ""]];
  const targets = { instagram: [{ account: "@ok", platform: "인스타그램" }], xhs: [] };
  const instagramRows = [{ account: "@ok", status: "측정", median: 2000, regularCount: 3, pinnedCount: 1, samples: [1000, 2000, 3000], pinnedSamples: [99000] }];
  assert.equal(auditResearch({ csvRows, targets, instagramRows, xhsRows: [] }).ok, true);
  instagramRows[0].samples.push(99000);
  assert.equal(auditResearch({ csvRows, targets, instagramRows, xhsRows: [] }).ok, false, "원장 중앙값 불일치를 차단해야 한다");
  instagramRows[0].samples.pop();
  csvRows[1][7] = "릴스 3편 실측";
  assert.equal(auditResearch({ csvRows, targets, instagramRows, xhsRows: [] }).ok, false, "드롭다운 밖의 상세 근거 문구를 차단해야 한다");
  console.log("audit-research-gates self-test: ok");
}

if (process.argv.includes("--self-test")) {
  selfTest();
  process.exit(0);
}

const args = process.argv.slice(2);
const flag = (name, required = true) => {
  const index = args.indexOf(`--${name}`);
  const value = index >= 0 ? args[index + 1] : null;
  if (required && !value) throw new Error(`--${name} 경로가 필요하다`);
  return value;
};
const csvPath = flag("csv");
const targetsPath = flag("targets");
const instagramPath = flag("instagram");
const xhsPath = flag("xhs");
const outPath = flag("out", false);
const jsonLines = (file) => fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse);
const report = auditResearch({
  csvRows: parseCsv(fs.readFileSync(csvPath, "utf8")),
  targets: JSON.parse(fs.readFileSync(targetsPath, "utf8")),
  instagramRows: JSON.parse(fs.readFileSync(instagramPath, "utf8")).rows || [],
  xhsRows: jsonLines(xhsPath),
});
if (outPath) {
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exit(1);
