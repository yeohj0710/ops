#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

export const STATUS_GROUP = Object.freeze({
  "확정": 700,
  "협상중": 600,
  "일정 보류": 500,
  "3차 발송": 400,
  "2차 발송": 300,
  "1차 발송": 200,
  "미접촉": 100,
  "": 0,
  "거절": -100,
});

const STAGES = Object.freeze([
  ["paid", 12, "지급", "boolean"],
  ["settlement", 11, "정산자료", "boolean"],
  ["upload", 10, "업로드", "boolean"],
  ["draft", 9, "초안 검수", "boolean"],
  ["shoot", 8, "촬영", "boolean"],
  ["guide", 7, "가이드 전달", "boolean"],
  ["visitDate", 6, "방문 예정일", "value"],
  ["confirmed", 5, "확정", "boolean"],
  ["agreement", 4, "합의 단가", "value"],
  ["response", 2, "응답", "boolean"],
  ["dm", 1, "DM 발송", "boolean"],
]);

const isTrue = (value) => value === true || value === 1 || String(value).toUpperCase() === "TRUE";
const isPresent = (value) => value !== undefined && value !== null && value !== "" && value !== false;

function field(row, name) {
  if (Object.hasOwn(row, name)) return row[name];
  if (row.milestones && Object.hasOwn(row.milestones, name)) return row.milestones[name];
  return "";
}

export function rankProgress(row) {
  const status = String(row.status ?? "").trim();
  const statusGroup = STATUS_GROUP[status] ?? 0;
  let stage = 0;
  let stageLabel = "없음";
  let completed = 0;

  for (const [name, score, label, type] of STAGES) {
    const value = field(row, name);
    const done = type === "boolean" ? isTrue(value) : isPresent(value);
    if (!done) continue;
    completed += 1;
    if (score > stage) {
      stage = score;
      stageLabel = label;
    }
  }

  return {
    status,
    statusGroup,
    stage,
    stageLabel,
    completed,
    rank: statusGroup * 1_000_000 + stage * 10_000 + completed * 100,
  };
}

function inversionCount(values) {
  let count = 0;
  for (let i = 0; i < values.length; i += 1) {
    for (let j = i + 1; j < values.length; j += 1) {
      if (values[i] < values[j]) count += 1;
    }
  }
  return count;
}

export function planSheet(sheet) {
  if (!sheet || !Array.isArray(sheet.rows)) throw new Error("sheet.rows 배열이 필요하다");

  const ranked = sheet.rows.map((row, originalIndex) => ({
    ...row,
    originalIndex,
    ...rankProgress(row),
  }));
  const sorted = [...ranked].sort((a, b) => b.rank - a.rank || a.originalIndex - b.originalIndex);

  return {
    title: sheet.title ?? "",
    rowCount: ranked.length,
    inversionsBefore: inversionCount(ranked.map((row) => row.rank)),
    sortedRowOrder: sorted.map((row) => row.row),
    rows: sorted.map((row) => ({
      row: row.row,
      key: row.key ?? "",
      status: row.status,
      stage: row.stageLabel,
      completed: row.completed,
      rank: row.rank,
    })),
  };
}

export function buildPlan(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.sheets)) throw new Error("snapshot.sheets 배열이 필요하다");
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sheets: snapshot.sheets.map(planSheet),
  };
}

function selfTest() {
  const statuses = ["확정", "협상중", "일정 보류", "3차 발송", "2차 발송", "1차 발송", "미접촉", "", "거절"];
  const statusRanks = statuses.map((status) => rankProgress({ status }).rank);
  for (let i = 1; i < statusRanks.length; i += 1) assert.ok(statusRanks[i - 1] > statusRanks[i]);

  assert.ok(rankProgress({ status: "협상중" }).rank > rankProgress({ status: "일정 보류", agreement: 150000 }).rank);
  assert.ok(rankProgress({ status: "일정 보류", agreement: 150000 }).rank > rankProgress({ status: "3차 발송", paid: true }).rank);
  assert.ok(rankProgress({ status: "미접촉", response: true }).rank > rankProgress({ status: "미접촉", dm: true }).rank);
  assert.ok(rankProgress({ status: "미접촉", dm: true }).rank > rankProgress({ status: "미접촉" }).rank);
  assert.ok(rankProgress({ status: "확정", paid: true }).rank > rankProgress({ status: "확정", confirmed: true }).rank);

  const plan = planSheet({
    title: "fixture",
    rows: [
      { row: 3, key: "hold", status: "일정 보류", agreement: 100000 },
      { row: 4, key: "negotiating", status: "협상중" },
      { row: 5, key: "dm", status: "미접촉", dm: true },
      { row: 6, key: "response", status: "미접촉", dm: true, response: true },
    ],
  });
  assert.deepEqual(plan.sortedRowOrder, [4, 3, 6, 5]);
  assert.ok(plan.inversionsBefore > 0);
  console.log("progress-rank self-test: 6/6 passed");
}

function parseArgs(argv) {
  const args = { input: "", out: "", selfTest: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--self-test") args.selfTest = true;
    else if (argv[i] === "--out") args.out = argv[++i] ?? "";
    else if (!argv[i].startsWith("--") && !args.input) args.input = argv[i];
    else throw new Error(`알 수 없는 인수: ${argv[i]}`);
  }
  return args;
}

if (import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.selfTest) {
      selfTest();
      process.exit(0);
    }
    if (!args.input) throw new Error("snapshot.json 경로가 필요하다");
    const input = JSON.parse(fs.readFileSync(path.resolve(args.input), "utf8"));
    const plan = buildPlan(input);
    const text = JSON.stringify(plan, null, 2) + "\n";
    if (args.out) fs.writeFileSync(path.resolve(args.out), text, "utf8");
    else process.stdout.write(text);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
