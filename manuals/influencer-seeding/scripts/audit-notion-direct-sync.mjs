#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseCsv } from "./sheet-diff.mjs";
import { offer } from "./build-notion-direct-sync-plan.mjs";

const txt = (v) => String(v ?? "").trim();
const norm = (v) => txt(v).toLowerCase().replace(/^@/, "").replace(/[\s\u200b-\u200d\ufeff]/g, "").replace(/\/$/, "");
const platform = (v) => txt(v).includes("샤오") ? "샤오홍슈" : "인스타그램";
const key = (p, a) => `${platform(p)}|${norm(a)}`;
const num = (v) => {
  const n = Number(txt(v).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const formulaError = (v) => /^#(?:REF!|N\/A|VALUE!|DIV\/0!|NAME\?|NUM!|NULL!)/i.test(txt(v));

function headerIndex(header, wanted) {
  const exact = header.findIndex((h) => txt(h) === wanted);
  if (exact >= 0) return exact;
  const suffix = header.map((h, i) => [txt(h), i]).filter(([h]) => h.endsWith(wanted));
  return suffix.length === 1 ? suffix[0][1] : -1;
}

function loadSheet(file) {
  const csv = parseCsv(fs.readFileSync(file, "utf8"));
  const header = csv[0] || [];
  const required = ["플랫폼", "계정"];
  const hi = {};
  for (const name of required) {
    hi[name] = headerIndex(header, name);
    if (hi[name] < 0) throw new Error(`${file}: ${name} 머리글을 못 찾았다`);
  }
  const rows = csv.slice(1).filter((r) => txt(r[hi["계정"]]));
  const byKey = new Map();
  for (const row of rows) {
    const k = key(row[hi["플랫폼"]], row[hi["계정"]]);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(row);
  }
  return { file, header, hi, rows, byKey, at: (name) => headerIndex(header, name) };
}

export function audit({ payload, beforeInfluencer, afterIntake, afterInfluencer }) {
  const before = loadSheet(beforeInfluencer);
  const intake = loadSheet(afterIntake);
  const influencers = loadSheet(afterInfluencer);
  const issues = [];
  const warnings = [];
  const checked = [];

  const iu = Object.fromEntries(["팔로워", "릴스 중앙 조회수", "처리", "중복"].map((n) => [n, intake.at(n)]));
  const ii = Object.fromEntries([
    "진행 상태", "팔로워", "릴스 중앙 조회수", "1차 제안", "2차 상향", "3차 상향(상한)",
    "단가 산정 근거", "예상 조회수", "조회수 근거", "조회당 단가", "추천 액션",
    "계정 정규화(비교용)", "품질·운영 메모",
  ].map((n) => [n, influencers.at(n)]));
  for (const [name, index] of [...Object.entries(iu), ...Object.entries(ii)]) {
    if (index < 0) issues.push({ type: "missing-header", name });
  }

  for (const item of payload.items || []) {
    const k = key(item.platform, item.account);
    const u = intake.byKey.get(k) || [];
    if (u.length !== 1) {
      issues.push({ type: "intake-row-count", key: k, count: u.length });
      continue;
    }
    const ur = u[0];
    if (txt(ur[iu["처리"]]) !== txt(item.processing)) issues.push({ type: "intake-status", key: k, expected: item.processing, actual: ur[iu["처리"]] });
    if (!(num(ur[iu["팔로워"]]) > 0) || !(num(ur[iu["릴스 중앙 조회수"]]) > 0)) issues.push({ type: "intake-metric-blank", key: k });

    const rows = influencers.byKey.get(k) || [];
    if (item.promotion) {
      if (rows.length !== 1) {
        issues.push({ type: "influencer-row-count", key: k, count: rows.length });
        continue;
      }
      if ((before.byKey.get(k) || []).length) issues.push({ type: "not-new", key: k });
      const r = rows[0];
      const views = num(r[ii["릴스 중앙 조회수"]]);
      const expectedViews = num(r[ii["예상 조회수"]]);
      const p1 = num(r[ii["1차 제안"]]);
      const p2 = num(r[ii["2차 상향"]]);
      const p3 = num(r[ii["3차 상향(상한)"]]);
      const required = ["팔로워", "릴스 중앙 조회수", "1차 제안", "2차 상향", "3차 상향(상한)", "단가 산정 근거", "예상 조회수", "조회수 근거", "조회당 단가", "계정 정규화(비교용)"];
      const missing = required.filter((name) => !txt(r[ii[name]]));
      if (missing.length) issues.push({ type: "influencer-required-blank", key: k, missing });
      if (views !== expectedViews) issues.push({ type: "expected-view-mismatch", key: k, views, expectedViews });
      const expectedPrices = [offer(views, 5, 30000), offer(views, 9, 50000), offer(views, 15, 100000)];
      if (p1 !== expectedPrices[0] || p2 !== Math.max(expectedPrices[1], p1) || p3 !== Math.max(expectedPrices[2], p2)) {
        issues.push({ type: "offer-mismatch", key: k, actual: [p1, p2, p3], expected: expectedPrices });
      }
      if (p1 >= 200000 && !/재조사 완료|재확인 전 발송 금지/.test(txt(r[ii["추천 액션"]]))) {
        issues.push({ type: "high-offer-not-gated", key: k, firstOffer: p1 });
      }
      checked.push({ key: k, firstOffer: p1, basis: r[ii["조회수 근거"]] });
    } else if (rows.length && !(before.byKey.get(k) || []).length) {
      issues.push({ type: "non-promotion-added", key: k, processing: item.processing });
    }
  }

  for (const alias of payload.aliases || []) {
    const oldKey = key(alias.platform, alias.oldAccount);
    const currentKey = key(alias.platform, alias.currentAccount);
    if ((influencers.byKey.get(oldKey) || []).length) issues.push({ type: "obsolete-handle-added", oldKey, currentKey });
    if ((influencers.byKey.get(currentKey) || []).length !== 1) issues.push({ type: "current-handle-missing", oldKey, currentKey });
  }

  for (const [k, rows] of influencers.byKey) {
    const beforeCount = (before.byKey.get(k) || []).length;
    if (rows.length > Math.max(1, beforeCount)) issues.push({ type: "new-duplicate", key: k, beforeCount, afterCount: rows.length });
    else if (rows.length > 1) warnings.push({ type: "preexisting-duplicate", key: k, count: rows.length });
    for (const r of rows) {
      const missing = ["팔로워", "릴스 중앙 조회수", "1차 제안", "2차 상향", "3차 상향(상한)"].filter((name) => !txt(r[ii[name]]));
      if (missing.length) issues.push({ type: "all-row-required-blank", key: k, missing });
      r.forEach((v, column) => { if (formulaError(v)) issues.push({ type: "formula-error", key: k, column, value: v }); });
    }
  }

  const report = {
    ok: issues.length === 0,
    candidates: (payload.items || []).length,
    promoted: (payload.items || []).filter((x) => x.promotion).length,
    intakeRows: intake.rows.length,
    influencerRows: influencers.rows.length,
    highOffers: checked.filter((x) => x.firstOffer >= 200000),
    issues,
    warnings,
    auditedAt: new Date().toISOString(),
  };
  return report;
}

function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; }

if (process.argv.includes("--self-test")) {
  assert.equal(norm("@Ab.C "), "ab.c");
  assert.equal(key("샤오홍슈", "@ABC"), "샤오홍슈|abc");
  assert.equal(num("₩30,000"), 30000);
  assert.equal(formulaError("#REF!"), true);
  assert.equal(formulaError("#하자매"), false);
  console.log("audit-notion-direct-sync self-test: 5/5 passed");
} else {
  const candidates = arg("--candidates"), beforeDir = arg("--before"), afterDir = arg("--after"), out = arg("--out");
  if (!candidates || !beforeDir || !afterDir || !out) throw new Error("쓰는 법: --candidates <json> --before <폴더> --after <폴더> --out <json>");
  const report = audit({
    payload: JSON.parse(fs.readFileSync(candidates, "utf8")),
    beforeInfluencer: path.join(beforeDir, "인플루언서.csv"),
    afterIntake: path.join(afterDir, "유입.csv"),
    afterInfluencer: path.join(afterDir, "인플루언서.csv"),
  });
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ ok: report.ok, candidates: report.candidates, promoted: report.promoted, intakeRows: report.intakeRows, influencerRows: report.influencerRows, highOffers: report.highOffers.length, issues: report.issues.length, warnings: report.warnings.length }, null, 2));
  if (!report.ok) process.exit(1);
}
