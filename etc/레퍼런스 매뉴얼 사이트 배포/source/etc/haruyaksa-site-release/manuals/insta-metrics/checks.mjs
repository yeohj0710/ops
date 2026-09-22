#!/usr/bin/env node

// ops done이 호출하는 최종 차단 장치.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.OPS_ROOT || path.resolve(here, "..", "..");
const auditScript = path.join(here, "scripts", "audit-completeness.mjs");

if (process.argv.includes("--self-test")) {
  execFileSync(process.execPath, [auditScript, "--self-test"], { stdio: "inherit" });
  console.log("insta-metrics checks self-test: ok");
  process.exit(0);
}

const taskFile = process.argv[2] || process.env.OPS_TASK;
assert.ok(taskFile && fs.existsSync(taskFile), "진행 중인 task JSON 경로가 필요하다");
const task = JSON.parse(fs.readFileSync(taskFile, "utf8"));
const taskDir = path.join(root, "work", task.id);
const afterCsv = path.join(taskDir, "after", "인플루언서.csv");
assert.ok(fs.existsSync(afterCsv), `작업 후 시트 스냅샷이 없다: ${afterCsv}`);

const metricsAudit = path.join(taskDir, "metrics-audit.json");
execFileSync(process.execPath, [auditScript, afterCsv, "--out", metricsAudit], { stdio: "inherit" });

const formulaAuditPath = path.join(taskDir, "formula-audit.json");
assert.ok(fs.existsSync(formulaAuditPath), "수식 실데이터 검사가 없다: formula-audit.json");
const formulaAudit = JSON.parse(fs.readFileSync(formulaAuditPath, "utf8"));
assert.equal(formulaAudit.ok, true, "계산 열 수식 검사가 실패했다");
assert.equal(Number(formulaAudit.missingFormulaCells || 0), 0, "계산 열에 수식이 빠졌다");
assert.equal(Number(formulaAudit.formulaErrors || 0), 0, "계산 열 수식 오류가 남았다");

console.log("insta-metrics completion checks: PASS");

