#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const norm = (v) => String(v ?? "").trim();
const cellId = (key, column) => `${norm(key).toLowerCase()}\u0000${norm(column)}`;

export function validatePlan(plan) {
  const errors = [];
  const operations = Array.isArray(plan?.operations) ? plan.operations : [];
  const allowedColumns = new Set((plan?.allowedColumns || []).map(norm));
  const protectedColumns = new Set((plan?.protectedColumns || []).map(norm));
  const allowedClears = new Set((plan?.allowedClears || []).map((x) => cellId(x.key, x.column)));
  const seen = new Set();

  if (!norm(plan?.sheet)) errors.push("sheet가 없다");
  if (!norm(plan?.keyColumn)) errors.push("keyColumn이 없다");
  if (!norm(plan?.beforeSnapshot)) errors.push("beforeSnapshot 경로가 없다");
  if (!Array.isArray(plan?.allowedColumns)) errors.push("allowedColumns 배열이 없다");

  operations.forEach((op, index) => {
    const at = `operations[${index}]`;
    const type = norm(op.type || "set");
    const key = norm(op.key);
    const column = norm(op.column);

    if (Object.hasOwn(op, "row") || Object.hasOwn(op, "rowNumber") || Object.hasOwn(op, "columnIndex")) {
      errors.push(`${at}: 고정 행·열 번호를 쓰지 마라. 계정 키와 헤더 이름을 쓴다`);
    }
    if (Object.hasOwn(op, "range")) errors.push(`${at}: 넓은 range 쓰기 금지. 셀 단위 작업으로 나눈다`);
    if (!key) errors.push(`${at}: key가 없다`);

    if (type === "deleteRow") {
      if (!op.authorized || !norm(op.reason) || !norm(op.expectedRowHash)) {
        errors.push(`${at}: 행 삭제에는 authorized=true, reason, expectedRowHash가 모두 필요하다`);
      }
      return;
    }

    if (!["set", "formula", "clear"].includes(type)) errors.push(`${at}: 알 수 없는 type ${type}`);
    if (!column) errors.push(`${at}: column이 없다`);
    if (column && !allowedColumns.has(column)) errors.push(`${at}: 허용하지 않은 열 ${column}`);
    if (protectedColumns.has(column)) errors.push(`${at}: 보호 열 ${column}은 이 계획에서 수정할 수 없다`);

    const id = cellId(key, column);
    if (seen.has(id)) errors.push(`${at}: 같은 셀을 두 번 쓴다 ${key}/${column}`);
    seen.add(id);

    const clearing = type === "clear" || (type === "set" && (op.value === "" || op.value === null));
    if (clearing && (!allowedClears.has(id) || !norm(op.reason))) {
      errors.push(`${at}: 빈칸 쓰기는 allowedClears와 reason이 모두 필요하다 ${key}/${column}`);
    }
    if (type === "formula" && !/^=/.test(String(op.value ?? ""))) errors.push(`${at}: formula 값은 =로 시작해야 한다`);
  });

  return { ok: errors.length === 0, errors, operationCount: operations.length };
}

function digest(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function selfTest() {
  const base = {
    sheet: "인플루언서", keyColumn: "계정", beforeSnapshot: "before/인플루언서.csv",
    allowedColumns: ["진행 상태", "③협상 관련 메모"], protectedColumns: ["④합의 단가"],
    allowedClears: [{ key: "@a", column: "③협상 관련 메모" }],
  };
  assert.equal(validatePlan({ ...base, operations: [{ type: "set", key: "@a", column: "진행 상태", value: "확정" }] }).ok, true);
  assert.equal(validatePlan({ ...base, operations: [{ type: "set", rowNumber: 3, key: "@a", column: "진행 상태", value: "확정" }] }).ok, false);
  assert.equal(validatePlan({ ...base, operations: [{ type: "clear", key: "@a", column: "③협상 관련 메모", reason: "조사 메모로 이동" }] }).ok, true);
  assert.equal(validatePlan({ ...base, operations: [{ type: "clear", key: "@b", column: "③협상 관련 메모" }] }).ok, false);
  assert.equal(validatePlan({ ...base, operations: [{ type: "set", key: "@a", column: "④합의 단가", value: 1 }] }).ok, false);
  assert.equal(validatePlan({ ...base, operations: [{ type: "set", key: "@a", column: "진행 상태", range: "C3:AG3", value: "확정" }] }).ok, false);
  console.log("validate-write-plan self-test: 6/6 passed");
}

if (process.argv.includes("--self-test")) {
  selfTest();
  process.exit(0);
}

const input = process.argv[2];
const outArg = process.argv.indexOf("--out");
const output = outArg >= 0 ? process.argv[outArg + 1] : "";
if (!input) {
  console.error("쓰는 법: validate-write-plan.mjs <write-plan.json> [--out write-plan.validated.json]");
  process.exit(1);
}

const inputPath = path.resolve(input);
const plan = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const result = { ...validatePlan(plan), input: inputPath, inputSha256: digest(inputPath), validatedAt: new Date().toISOString() };
if (output) fs.writeFileSync(path.resolve(output), JSON.stringify(result, null, 2) + "\n", "utf8");
if (!result.ok) {
  result.errors.forEach((e) => console.error(`- ${e}`));
  process.exit(1);
}
console.log(`validate-write-plan: PASS (${result.operationCount} operations)`);
