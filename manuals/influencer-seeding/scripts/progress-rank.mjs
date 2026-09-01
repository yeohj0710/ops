#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

export const STATUS_ORDER = Object.freeze([
  "확정", "협상중", "일정 보류", "3차 발송", "2차 발송", "1차 발송",
  "확인 필요", "미접촉", "보류", "반려", "거절", "",
]);
export const STATUS_GROUP = Object.freeze(Object.fromEntries(STATUS_ORDER.map((value, index) => [value, STATUS_ORDER.length - index])));
const LANGUAGE_ORDER = Object.freeze(["중국어권", "일본어권", "국내", "기타", ""]);
const PLATFORM_ORDER = Object.freeze(["인스타그램", "샤오홍슈", "틱톡", ""]);
const SOURCE_ORDER = Object.freeze(["직접 조사", "AI 에이전트", ""]);

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

function firstField(row, names) {
  for (const name of names) {
    const value = field(row, name);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return "";
}

function orderOf(value, order) {
  const index = order.indexOf(String(value ?? "").trim());
  return index === -1 ? order.length : index;
}

/* 줄여 쓴 표기의 배수. 인스타는 K M, 샤오홍슈는 만 w 万 을 쓴다.
 * 이걸 모르면 `9.9만` 이 0 으로 읽혀서 그 행이 정렬 맨 뒤로 밀린다 */
const UNIT_FACTOR = Object.freeze({ k: 1_000, m: 1_000_000, b: 1_000_000_000, w: 10_000, 천: 1_000, 만: 10_000, 억: 100_000_000, 万: 10_000, 亿: 100_000_000 });

function numberValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const raw = String(value ?? "").trim().replace(/[,\s₩¥￦]/g, "");
  const match = raw.match(/^(-?\d+(?:\.\d+)?)\s*([a-zA-Z천만억万亿]?)$/);
  if (!match) return 0;
  const unit = match[2] ? UNIT_FACTOR[match[2].toLowerCase()] ?? UNIT_FACTOR[match[2]] : 1;
  if (!unit) return 0;
  const n = Number(match[1]) * unit;
  return Number.isFinite(n) ? n : 0;
}

function normalizedAccount(value) {
  return String(value ?? "").trim().toLowerCase().replace(/^@/, "");
}

function visitSort(value) {
  if (value === undefined || value === null || value === "") return { present: 1, time: Number.MAX_SAFE_INTEGER, text: "" };
  if (typeof value === "number" && Number.isFinite(value)) return { present: 0, time: value, text: String(value) };
  const text = String(value).trim();
  const match = text.match(/(\d{1,2})\s*[\/-]\s*(\d{1,2})(?:[^\d]+(\d{1,2})(?::(\d{2}))?)?/);
  if (!match) return { present: 0, time: Number.MAX_SAFE_INTEGER - 1, text };
  const [, month, day, hour = "23", minute = "59"] = match;
  return { present: 0, time: Number(month) * 1_000_000 + Number(day) * 10_000 + Number(hour) * 100 + Number(minute), text };
}

function followerFit(value) {
  const followers = numberValue(value);
  if (followers >= 10_000 && followers <= 30_000) return 0;
  if (followers >= 8_000 && followers <= 60_000) return 1;
  return 2;
}

export function rankProgress(row) {
  const status = String(firstField(row, ["status", "진행 상태"])).trim();
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
    rank: statusGroup,
  };
}

export function sortKeys(row) {
  const progress = rankProgress(row);
  const language = firstField(row, ["language", "언어권"]);
  const platform = firstField(row, ["platform", "플랫폼"]);
  const source = firstField(row, ["source", "출처"]);
  const visit = visitSort(firstField(row, ["visitDate", "⑥방문 예정일", "방문 예정일"]));
  const agreement = numberValue(firstField(row, ["agreement", "④합의 단가", "합의 단가"]));
  const followers = numberValue(firstField(row, ["followers", "팔로워"]));
  const account = normalizedAccount(firstField(row, ["key", "account", "계정"]));
  return {
    status: orderOf(progress.status, STATUS_ORDER),
    language: orderOf(language, LANGUAGE_ORDER),
    platform: orderOf(platform, PLATFORM_ORDER),
    source: orderOf(source, SOURCE_ORDER),
    visitPresent: visit.present,
    visitTime: visit.time,
    agreementMissing: agreement > 0 ? 0 : 1,
    followerFit: followerFit(followers),
    followers: -followers,
    account,
  };
}

export function compareRows(a, b) {
  const x = a.sortKeys || sortKeys(a);
  const y = b.sortKeys || sortKeys(b);
  for (const key of ["status", "language", "platform", "source", "visitPresent", "visitTime", "agreementMissing", "followerFit", "followers"]) {
    if (x[key] !== y[key]) return x[key] - y[key];
  }
  return x.account.localeCompare(y.account, "en");
}

function inversionCount(values) {
  let count = 0;
  for (let i = 0; i < values.length; i += 1) {
    for (let j = i + 1; j < values.length; j += 1) {
      if (compareRows(values[i], values[j]) > 0) count += 1;
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
    sortKeys: sortKeys(row),
  }));
  const sorted = [...ranked].sort((a, b) => compareRows(a, b) || a.originalIndex - b.originalIndex);

  return {
    title: sheet.title ?? "",
    rowCount: ranked.length,
    inversionsBefore: inversionCount(ranked),
    sortedRowOrder: sorted.map((row) => row.row),
    rows: sorted.map((row) => ({
      row: row.row,
      key: row.key ?? "",
      status: row.status,
      stage: row.stageLabel,
      completed: row.completed,
      rank: row.rank,
      sortKeys: row.sortKeys,
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
  const statuses = STATUS_ORDER;
  const statusRanks = statuses.map((status) => rankProgress({ status }).rank);
  for (let i = 1; i < statusRanks.length; i += 1) assert.ok(statusRanks[i - 1] > statusRanks[i]);

  assert.ok(rankProgress({ status: "협상중" }).rank > rankProgress({ status: "일정 보류", agreement: 150000 }).rank);
  assert.ok(rankProgress({ status: "일정 보류", agreement: 150000 }).rank > rankProgress({ status: "3차 발송", paid: true }).rank);
  assert.equal(rankProgress({ status: "미접촉", response: true }).rank, rankProgress({ status: "미접촉", dm: true }).rank);
  assert.equal(rankProgress({ status: "미접촉", dm: true }).rank, rankProgress({ status: "미접촉" }).rank);
  assert.equal(rankProgress({ status: "확정", paid: true }).rank, rankProgress({ status: "확정", confirmed: true }).rank);

  assert.ok(compareRows({ status: "미접촉", language: "중국어권" }, { status: "미접촉", language: "일본어권" }) < 0);
  assert.ok(compareRows({ status: "미접촉", language: "중국어권", platform: "인스타그램" }, { status: "미접촉", language: "중국어권", platform: "샤오홍슈" }) < 0);
  assert.ok(compareRows({ status: "미접촉", source: "직접 조사" }, { status: "미접촉", source: "AI 에이전트" }) < 0);
  assert.ok(compareRows({ status: "미접촉", visitDate: "9/1 20:30" }, { status: "미접촉", visitDate: "" }) < 0);
  assert.ok(compareRows({ status: "미접촉", followers: 20_000 }, { status: "미접촉", followers: 70_000 }) < 0);

  const plan = planSheet({
    title: "fixture",
    rows: [
      { row: 3, key: "hold", status: "일정 보류", agreement: 100000 },
      { row: 4, key: "negotiating", status: "협상중" },
      { row: 5, key: "dm", status: "미접촉", dm: true },
      { row: 6, key: "response", status: "미접촉", dm: true, response: true },
    ],
  });
  assert.deepEqual(plan.sortedRowOrder, [4, 3, 5, 6]);
  assert.ok(plan.inversionsBefore > 0);
  console.log("progress-rank self-test: 11/11 passed");
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
