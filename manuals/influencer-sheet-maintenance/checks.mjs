#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.OPS_ROOT || path.resolve(HERE, "..", "..");
const taskFile = process.argv[2] || process.env.OPS_TASK;

if (!taskFile || !fs.existsSync(taskFile)) {
  console.error("진행 중인 task JSON 경로가 필요하다");
  process.exit(1);
}

const task = JSON.parse(fs.readFileSync(taskFile, "utf8"));
const resultPath = path.join(ROOT, "work", task.id, "result.json");
const rankScript = path.join(HERE, "scripts", "progress-rank.mjs");

execFileSync(process.execPath, [rankScript, "--self-test"], { stdio: "inherit" });

if (!fs.existsSync(resultPath)) {
  console.error(`검사 결과가 없다: ${resultPath}`);
  process.exit(1);
}

const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
assert.ok(Array.isArray(result.sheets), "result.sheets 배열이 필요하다");
assert.ok(result.sheets.length > 0, "검사한 시트가 없다");

const mustBeZero = [
  "inversionsAfter",
  "blankOfferRows",
  "formulaErrors",
  "missingStatusValidations",
  "missingCheckboxValidations",
  "helperValues",
  "manualOverridesChanged",
  "agreedPricesChanged",
];

for (const sheet of result.sheets) {
  assert.equal(sheet.rowCountAfter, sheet.rowCountBefore, `${sheet.title}: 행 수가 바뀌었다`);
  assert.deepEqual(sheet.statusCountsAfter, sheet.statusCountsBefore, `${sheet.title}: 상태별 건수가 바뀌었다`);
  for (const key of mustBeZero) assert.equal(sheet[key] ?? 0, 0, `${sheet.title}: ${key}=${sheet[key]}`);
}

console.log(`influencer-sheet-maintenance checks: ${result.sheets.length} sheets passed`);
