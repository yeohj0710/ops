#!/usr/bin/env node

// 지표 감사 결과에서 반드시 다시 조사할 계정을 만든다.
// 빈칸 보충과 별도로 비율 이상치, 5편 미만 표본, 20만원 이상 1차 제안을 전부 포함한다.

import fs from "node:fs";

const [auditPath, outputPath] = process.argv.slice(2);
if (!auditPath || !outputPath) {
  console.error("쓰는 법: node build-recheck-targets.mjs <metrics-audit.json> <recheck-targets.json>");
  process.exit(2);
}
const audit = JSON.parse(fs.readFileSync(auditPath, "utf8"));
const items = new Map();
function add(rows, reason) {
  for (const row of rows || []) {
    if (!row?.account) continue;
    const item = items.get(row.account) || { ...row, reasons: [] };
    if (!item.reasons.includes(reason)) item.reasons.push(reason);
    items.set(row.account, item);
  }
}
add(audit.ratioOutliers, "조회수/팔로워 비율 이상치");
add(audit.shortMeasured, "실측 표본 5편 미만");
add(audit.highOffers, "1차 제안 20만원 이상");
const rows = [...items.values()];
const output = {
  generatedAt: new Date().toISOString(),
  counts: { all: rows.length, instagram: rows.filter((row) => row.platform === "인스타그램").length, xhs: rows.filter((row) => row.platform === "샤오홍슈").length },
  instagram: rows.filter((row) => row.platform === "인스타그램"),
  xhs: rows.filter((row) => row.platform === "샤오홍슈"),
};
fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output.counts, null, 2));
