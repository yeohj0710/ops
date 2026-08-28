#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
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
const taskDir = path.join(ROOT, "work", task.id);
const rankScript = path.join(HERE, "scripts", "progress-rank.mjs");
const planScript = path.join(HERE, "scripts", "validate-write-plan.mjs");
const backupScript = path.join(HERE, "scripts", "backup-sheet.mjs");
const diffScript = path.join(ROOT, "manuals", "seeding-status-sync", "scripts", "sheet-diff.mjs");

execFileSync(process.execPath, [rankScript, "--self-test"], { stdio: "inherit" });
execFileSync(process.execPath, [planScript, "--self-test"], { stdio: "inherit" });
execFileSync(process.execPath, [backupScript, "--self-test"], { stdio: "inherit" });
execFileSync(process.execPath, [diffScript, "--self-test"], { stdio: "inherit" });

const mustExist = ["before", "after", "write-plan.json", "write-plan.validated.json", "diff.json"];
for (const name of mustExist) assert.ok(fs.existsSync(path.join(taskDir, name)), `안전 산출물이 없다: ${name}`);

const writePlanPath = path.join(taskDir, "write-plan.json");
const validated = JSON.parse(fs.readFileSync(path.join(taskDir, "write-plan.validated.json"), "utf8"));
const writePlanHash = crypto.createHash("sha256").update(fs.readFileSync(writePlanPath)).digest("hex");
assert.equal(validated.ok, true, "쓰기 계획 검사가 통과하지 않았다");
assert.equal(validated.inputSha256, writePlanHash, "검사 뒤 쓰기 계획이 바뀌었다");

const diff = JSON.parse(fs.readFileSync(path.join(taskDir, "diff.json"), "utf8"));
assert.equal(diff.clean, true, "CSV 전후 대조에 허용 범위 밖 변경이 있다");

const latestPath = path.join(ROOT, "work", "_sheet-backups", "influencer-seeding", "latest.json");
assert.ok(fs.existsSync(latestPath), "일일 전체 백업 기록이 없다");
const latest = JSON.parse(fs.readFileSync(latestPath, "utf8"));
assert.equal(latest.status, "ok", "최근 전체 백업이 실패했다");
assert.ok(Date.now() - Date.parse(latest.createdAt) < 30 * 3_600_000, "전체 백업이 30시간보다 오래됐다");

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
