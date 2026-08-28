#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OPS_ROOT = path.resolve(HERE, "..");
const CLOUD_SHORTCUTS = new Set([".gsheet", ".gdoc", ".gslides"]);

function parseArgs(argv) {
  const out = { command: "", root: "", out: "", before: "", selfTest: false };
  for (let i = 0; i < argv.length; i += 1) {
    const v = argv[i];
    if (v === "--root") out.root = argv[++i] ?? "";
    else if (v === "--out") out.out = argv[++i] ?? "";
    else if (v === "--before") out.before = argv[++i] ?? "";
    else if (v === "--self-test") out.selfTest = true;
    else if (!v.startsWith("-") && !out.command) out.command = v;
    else throw new Error(`알 수 없는 인수: ${v}`);
  }
  return out;
}

function defaultRoot() {
  const machine = JSON.parse(fs.readFileSync(path.join(OPS_ROOT, "machine.json"), "utf8"));
  if (!machine.drive_root) throw new Error("machine.json에 drive_root가 없다");
  return machine.drive_root;
}

export function rootShortcuts(root) {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && CLOUD_SHORTCUTS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => {
      const fullPath = path.join(root, entry.name);
      const stat = fs.statSync(fullPath);
      return { name: entry.name, extension: path.extname(entry.name).toLowerCase(), bytes: stat.size };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function snapshot(root) {
  return {
    schemaVersion: 1,
    root: path.resolve(root),
    capturedAt: new Date().toISOString(),
    files: rootShortcuts(root),
  };
}

export function compare(before, after) {
  const known = new Set((before.files || []).map((x) => x.name));
  const newRootFiles = (after.files || []).filter((x) => !known.has(x.name));
  return { ok: newRootFiles.length === 0, newRootFiles };
}

function selfTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "drive-root-guard-"));
  try {
    fs.writeFileSync(path.join(root, "existing.gsheet"), "x");
    const before = snapshot(root);
    fs.writeFileSync(path.join(root, "notes.txt"), "ignored");
    assert.equal(compare(before, snapshot(root)).ok, true);
    fs.writeFileSync(path.join(root, "new.gsheet"), "x");
    const failed = compare(before, snapshot(root));
    assert.equal(failed.ok, false);
    assert.equal(failed.newRootFiles[0].name, "new.gsheet");
    fs.renameSync(path.join(root, "new.gsheet"), path.join(root, "moved.txt"));
    assert.equal(compare(before, snapshot(root)).ok, true);
    console.log("drive-root-guard self-test: ok");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) return selfTest();
  const root = path.resolve(args.root || defaultRoot());
  if (!fs.existsSync(root)) throw new Error(`드라이브 루트가 없다: ${root}`);

  if (args.command === "snapshot") {
    if (!args.out) throw new Error("snapshot에는 --out 경로가 필요하다");
    const value = snapshot(root);
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    fs.writeFileSync(path.resolve(args.out), JSON.stringify(value, null, 2) + "\n", "utf8");
    console.log(`drive-root-guard: 기준 ${value.files.length}개 저장 ${path.resolve(args.out)}`);
    return;
  }

  if (args.command === "check") {
    if (!args.before) throw new Error("check에는 --before 경로가 필요하다");
    const before = JSON.parse(fs.readFileSync(path.resolve(args.before), "utf8"));
    if (path.resolve(before.root) !== root) throw new Error("기준 파일과 검사 루트가 다르다");
    const result = compare(before, snapshot(root));
    if (!result.ok) {
      result.newRootFiles.forEach((file) => console.error(`루트에 새 파일이 남았다: ${file.name}`));
      console.error("관련 업무 폴더로 옮긴 뒤 다시 검사한다");
      process.exit(1);
    }
    console.log("drive-root-guard: 새 클라우드 문서가 루트에 남지 않았다");
    return;
  }

  throw new Error("쓰는 법: drive-root-guard.mjs snapshot --out <before.json> | check --before <before.json>");
}

try {
  main();
} catch (error) {
  console.error(`drive-root-guard 실패: ${error.message}`);
  process.exit(1);
}
