#!/usr/bin/env node
// 쇼츠 작업 시작 전 로컬 상태를 한 번에 확인한다.
// 네트워크·브라우저를 건드리지 않으므로 탐색용으로 반복 실행해도 안전하다.
//
//   node shorts-preflight.mjs
//   node shorts-preflight.mjs --dir "<준비 폴더>"   게시 전 9:16 강제 게이트

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const OPS = "C:/dev/ops";
const MACHINE = JSON.parse(fs.readFileSync(path.join(OPS, "machine.json"), "utf8"));
const DEV = MACHINE.dev_root.replace(/\//g, path.sep);
const DRIVE = MACHINE.drive_root.replace(/\//g, path.sep);
const AUTOMATION = path.join(DEV, "n8n-youtube-shorts-automation");
const DEST = path.join(DRIVE, "영상 편집", "AI 크리에이터", "인스타그램 업로드용");

const CHANNELS = [
  ["하루건강약사", "하루건강약사 소재"],
  ["건강장수비결", "건강장수비결 소재"],
];
const IGNORED = new Set([
  "README.txt", "README.md", "줄소재.txt", "queue.txt",
  "used.jsonl", "upload-log.jsonl", "사용기록.jsonl", "업로드기록.jsonl",
]);
const LOCKED = /(?:^|\s)LOCKED_SOURCE_PACK=1(?:\s|$)/;
const EXPECTED_ASPECT = 9 / 16;
const ASPECT_TOLERANCE = 0.01;
const CLI_ARGS = process.argv.slice(2);
const STRICT_DIR_INDEX = CLI_ARGS.indexOf("--dir");
const STRICT_DIR = STRICT_DIR_INDEX >= 0 ? CLI_ARGS[STRICT_DIR_INDEX + 1] : null;

const exists = (p) => fs.existsSync(p);
const readText = (p) => fs.readFileSync(p, "utf8");
const lineJson = (p) => {
  if (!exists(p)) return null;
  const lines = readText(p).split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
};
const fmt = (value) => value ? String(value).replace("T", " ").replace("Z", "") : "-";

function countTopics() {
  for (const [channel, folder] of CHANNELS) {
    const dir = path.join(AUTOMATION, folder);
    if (!exists(dir)) {
      console.log(`  ${channel}: 폴더 없음`);
      continue;
    }
    const files = fs.readdirSync(dir, { withFileTypes: true }).filter((entry) =>
      entry.isFile() && !entry.name.startsWith(".") && !IGNORED.has(entry.name) && /\.(md|txt|json)$/i.test(entry.name),
    );
    const usable = files.filter((entry) => !LOCKED.test(readText(path.join(dir, entry.name))));
    console.log(`  ${channel}: 본편 ${usable.length}개 / 파일 ${files.length}개 / 원본릴스 ${files.length - usable.length}개`);
  }
}

function latestUploads() {
  for (const [, folder] of CHANNELS) {
    const p = path.join(AUTOMATION, folder, "기록", "업로드기록.jsonl");
    const row = lineJson(p);
    if (!row) {
      console.log(`  ${folder}: 기록 없음`);
      continue;
    }
    console.log(`  ${folder}: ${fmt(row.uploaded_at || row.uploadedAt || row.date)} | ${row.title || row.video_title || "제목 없음"} | ${row.video_id || row.youtube_video_id || row.id || "ID 없음"}`);
  }
}

function probeMedia(file) {
  const raw = execFileSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height,duration",
    "-of", "json", file,
  ], { encoding: "utf8" });
  const stream = JSON.parse(raw).streams?.[0] || {};
  const width = Number(stream.width);
  const height = Number(stream.height);
  const duration = Number(stream.duration);
  return {
    width,
    height,
    duration,
    ratio: width > 0 && height > 0 ? width / height : NaN,
  };
}

function mediaText(media) {
  if (!media || !Number.isFinite(media.width) || !Number.isFinite(media.height)) return "ffprobe 실패";
  const ratio = Number.isFinite(media.ratio) ? ` (${media.ratio.toFixed(4)})` : "";
  const duration = Number.isFinite(media.duration) ? `, ${media.duration.toFixed(3)}초` : "";
  return `${media.width}x${media.height}${ratio}${duration}`;
}

function inspectPreparedDir(dir) {
  const prepPath = path.join(dir, "업로드 준비.json");
  if (!exists(prepPath)) return { ok: false, errors: ["업로드 준비.json 없음"] };

  let prep;
  try {
    prep = JSON.parse(readText(prepPath));
  } catch (error) {
    return { ok: false, errors: [`업로드 준비.json 읽기 실패: ${error.message}`] };
  }

  const mp4 = prep.video_path && exists(path.join(dir, prep.video_path))
    ? prep.video_path
    : fs.readdirSync(dir).find((name) => name.toLowerCase().endsWith(".mp4"));
  const errors = [];
  if (prep.target_aspect_ratio !== "9:16") {
    errors.push(`target_aspect_ratio=${prep.target_aspect_ratio || "없음"} (9:16 필요)`);
  }
  if (!mp4) {
    errors.push("MP4 없음");
    return { ok: false, prep, mp4: null, media: null, mediaText: "mp4 없음", errors };
  }

  let media = null;
  try {
    media = probeMedia(path.join(dir, mp4));
  } catch (error) {
    errors.push(`ffprobe 실패: ${error.message}`);
  }
  if (!media || !Number.isFinite(media.ratio) || Math.abs(media.ratio - EXPECTED_ASPECT) > ASPECT_TOLERANCE) {
    errors.push(`MP4 비율=${media?.width || "?"}x${media?.height || "?"} (9:16 필요)`);
  }
  return {
    ok: errors.length === 0,
    prep,
    mp4,
    media,
    mediaText: mediaText(media),
    errors,
  };
}

function preparedFolders() {
  if (!exists(DEST)) {
    console.log("  업로드 준비 폴더 없음");
    return;
  }
  const rows = [];
  // 폴더명은 YYMMDDHHMMSS 로 시작한다. 전체 폴더를 열어 보지 말고 최신 후보만 본다.
  const candidates = fs.readdirSync(DEST, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => b.name.localeCompare(a.name))
    .slice(0, 5);
  for (const entry of candidates) {
    const dir = path.join(DEST, entry.name);
    const prepPath = path.join(dir, "업로드 준비.json");
    if (!exists(prepPath)) continue;
    try {
      const check = inspectPreparedDir(dir);
      rows.push({
        dir: entry.name,
        prepared: check.prep?.prepared_at || fs.statSync(prepPath).mtime.toISOString(),
        source: check.prep?.source_url || "소스 없음",
        target: check.prep?.target_account || "계정 없음",
        aspect: check.prep?.target_aspect_ratio || "비율 없음",
        media: check.mediaText,
        gate: check.ok,
      });
    } catch {}
  }
  rows.sort((a, b) => b.prepared.localeCompare(a.prepared));
  if (!rows.length) {
    console.log("  준비 폴더 없음");
    return;
  }
  for (const row of rows.slice(0, 5)) {
    const state = row.gate ? "PASS" : "WARN";
    console.log(`  [${state}] ${row.dir} | ${row.aspect} | ${row.media} | ${row.target}`);
  }
  console.log("  주의: 게시 직전에는 선택한 폴더를 --dir로 다시 검사한다. 실패하면 업로드하지 않는다.");
}

function strictUploadGate(dirArg) {
  const dir = path.resolve(dirArg);
  console.log("인스타 업로드 9:16 강제 게이트 (게시 전)");
  console.log(`  대상: ${dir}`);
  const check = inspectPreparedDir(dir);
  console.log(`  target_aspect_ratio: ${check.prep?.target_aspect_ratio || "없음"}`);
  console.log(`  영상: ${check.mediaText || "확인 불가"}`);
  if (!check.ok) {
    console.error("  결과: FAIL — 업로드 금지");
    for (const error of check.errors) console.error(`    - ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log("  결과: PASS — 업로드 가능");
}

async function executions() {
  const dbPath = path.join(AUTOMATION, ".n8n", "database.sqlite");
  const sqlitePath = path.join(AUTOMATION, "node_modules", "sqlite3");
  if (!exists(dbPath) || !exists(sqlitePath)) {
    console.log("  n8n DB 확인 불가");
    return;
  }
  try {
    const sqlite3 = loadSQLite(sqlitePath);
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
    await new Promise((resolve) => {
      db.all("select id,status,startedAt,stoppedAt,waitTill from execution_entity order by id desc limit 6", [], (error, rows) => {
        if (error) console.log(`  n8n DB 읽기 실패: ${error.message}`);
        else rows.forEach((row) => console.log(`  #${row.id} ${row.status} | 시작 ${fmt(row.startedAt)} | 종료 ${fmt(row.stoppedAt)} | 대기 ${fmt(row.waitTill)}`));
        db.close(resolve);
      });
    });
  } catch (error) {
    console.log(`  n8n DB 모듈 확인 실패: ${error.message}`);
  }
}

function loadSQLite(modulePath) {
  return require(modulePath);
}

if (STRICT_DIR) {
  strictUploadGate(STRICT_DIR);
} else {
  console.log("쇼츠 빠른 사전 점검 (로컬·읽기 전용)");
  console.log("[1] n8n 최근 실행");
  await executions();
  console.log("[2] 유튜브 업로드 기록 마지막 항목");
  latestUploads();
  console.log("[3] 본편 소재 재고");
  countTopics();
  console.log("[4] 인스타 업로드 준비 파일·원본 비율");
  preparedFolders();
  console.log("[5] 브라우저 고정 규칙");
  console.log("  기존 Chrome 프로필만 선택: 새 Chrome 프로필 우선, 사용 중이면 내 Chrome");
  console.log("  게시 전 --dir 강제 게이트 통과 → 자르기 메뉴 9:16 선택 → 게시 후 릴스 video 비율 확인");
}
