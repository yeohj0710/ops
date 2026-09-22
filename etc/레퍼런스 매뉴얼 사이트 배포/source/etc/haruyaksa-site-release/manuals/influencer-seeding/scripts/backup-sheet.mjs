#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsv } from "./sheet-diff.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MANUAL_DIR = path.resolve(HERE, "..");
const OPS_ROOT = process.env.OPS_ROOT || path.resolve(MANUAL_DIR, "..", "..");
const DEFAULT_CONFIG = path.join(MANUAL_DIR, "backup.config.json");

function parseArgs(argv) {
  const args = { config: DEFAULT_CONFIG, force: false, selfTest: false };
  for (let i = 0; i < argv.length; i += 1) {
    const v = argv[i];
    if (v === "--config") args.config = argv[++i] ?? "";
    else if (v === "--force") args.force = true;
    else if (v === "--self-test") args.selfTest = true;
    else throw new Error(`알 수 없는 인수: ${v}`);
  }
  return args;
}

function localStamp(date = new Date()) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(date).reduce((o, x) => ({ ...o, [x.type]: x.value }), {});
  return `${p.year}${p.month}${p.day}-${p.hour}${p.minute}${p.second}`;
}

function safeName(value) {
  return String(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function loadConfig(file) {
  const c = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.match(String(c.spreadsheetId ?? ""), /^[A-Za-z0-9_-]{20,}$/, "spreadsheetId가 잘못됐다");
  assert.ok(Array.isArray(c.tabs) && c.tabs.length > 0, "tabs가 비었다");
  assert.equal(new Set(c.tabs).size, c.tabs.length, "tabs에 중복이 있다");
  return c;
}

function resolveBackupRoot(config) {
  const configured = String(config.backupRoot || "work/_sheet-backups/influencer-seeding");
  return path.isAbsolute(configured) ? configured : path.join(OPS_ROOT, configured);
}

function lastSuccess(root) {
  const p = path.join(root, "latest.json");
  if (!fs.existsSync(p)) return null;
  try {
    const v = JSON.parse(fs.readFileSync(p, "utf8"));
    return v.status === "ok" ? v : null;
  } catch {
    return null;
  }
}

function prune(root, retentionDays, keepPath) {
  const cutoff = Date.now() - Number(retentionDays || 45) * 86_400_000;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d{8}-\d{6}$/.test(entry.name)) continue;
    const p = path.join(root, entry.name);
    if (path.resolve(p) === path.resolve(keepPath)) continue;
    if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true });
  }
}

async function downloadTab(spreadsheetId, tab) {
  const url = new URL(`https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq`);
  url.searchParams.set("tqx", "out:csv");
  url.searchParams.set("headers", "2");
  url.searchParams.set("sheet", tab);
  const response = await fetch(url, { redirect: "follow" });
  const text = await response.text();
  if (!response.ok) throw new Error(`${tab}: HTTP ${response.status}`);
  if (/^\s*<!doctype html/i.test(text) || /<html/i.test(text.slice(0, 500))) {
    throw new Error(`${tab}: CSV 대신 HTML이 왔다. 공개 gviz 접근 또는 로그인 상태를 확인한다`);
  }
  const rows = parseCsv(text);
  if (!rows.length || !rows[0].length || text.length < 8) throw new Error(`${tab}: CSV가 비었다`);
  return { text, rows };
}

function selfTest() {
  assert.equal(safeName("구_중국 진행표"), "구_중국 진행표");
  assert.equal(safeName("a/b:c"), "a_b_c");
  assert.equal(localStamp(new Date("2026-08-28T00:00:00Z")).length, 15);
  assert.equal(sha256("a").length, 64);
  console.log("backup-sheet self-test: ok");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) return selfTest();

  const configPath = path.resolve(args.config);
  const config = loadConfig(configPath);
  const root = resolveBackupRoot(config);
  fs.mkdirSync(root, { recursive: true });

  const previous = lastSuccess(root);
  const minMs = Number(config.minIntervalHours || 20) * 3_600_000;
  if (!args.force && previous && Date.now() - Date.parse(previous.createdAt) < minMs) {
    console.log(`backup-sheet: 최근 백업 재사용 ${previous.snapshotDir}`);
    return;
  }

  const stamp = localStamp();
  const partial = path.join(root, `${stamp}.partial`);
  const complete = path.join(root, stamp);
  fs.mkdirSync(partial, { recursive: false });
  const manifest = {
    schemaVersion: 1,
    status: "running",
    createdAt: new Date().toISOString(),
    spreadsheetId: config.spreadsheetId,
    headers: 2,
    tabs: [],
  };

  try {
    for (const tab of config.tabs) {
      const { text, rows } = await downloadTab(config.spreadsheetId, tab);
      const file = `${safeName(tab)}.csv`;
      fs.writeFileSync(path.join(partial, file), text, "utf8");
      manifest.tabs.push({ tab, file, bytes: Buffer.byteLength(text), csvRows: rows.length, sha256: sha256(text) });
    }
    const influencer = manifest.tabs.find((x) => x.tab === "인플루언서");
    assert.ok(influencer && influencer.csvRows > 100, "인플루언서 CSV 행 수가 비정상이다");
    manifest.status = "ok";
    manifest.completedAt = new Date().toISOString();
    fs.writeFileSync(path.join(partial, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
    fs.renameSync(partial, complete);
    const latest = { status: "ok", createdAt: manifest.createdAt, snapshotDir: complete, manifest: path.join(complete, "manifest.json") };
    fs.writeFileSync(path.join(root, "latest.json"), JSON.stringify(latest, null, 2) + "\n", "utf8");
    prune(root, config.retentionDays, complete);
    console.log(`backup-sheet: ${manifest.tabs.length}개 탭 저장 ${complete}`);
  } catch (error) {
    manifest.status = "failed";
    manifest.error = error.message;
    fs.writeFileSync(path.join(partial, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
    throw error;
  }
}

main().catch((error) => {
  console.error(`backup-sheet 실패: ${error.message}`);
  process.exit(1);
});
