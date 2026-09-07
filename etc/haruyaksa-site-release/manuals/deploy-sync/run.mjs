#!/usr/bin/env node
// 배포 사이트 최신화 2단계. scan 이 뽑은 할 일을 그대로 실행한다.
//
//   node run.mjs                          scan.json 의 할 일을 전부 민다
//   node run.mjs --dry-run                무엇을 칠지만 보여준다
//   node run.mjs --only chaenggil         한 프로젝트만
//   node run.mjs --max 3                  앞에서 3개만
//   node run.mjs --only <이름> --force    scan 이 뺀 것을 그래도 민다
//
// --force 는 scan 이 "소스 미커밋" 이나 "사람이 부를 때만" 으로 뺀 것을 미는 문이다.
// 쓰기 전에 그 폴더에서 git status 를 눈으로 보고, 지금 올려도 되는 상태인지 확인한다.
//
// 한 프로젝트가 실패해도 멈추지 않는다. 그 줄만 실패로 적고 다음으로 간다.
// 중간에 사람에게 묻지 않는다. 물어야 하는 것은 scan 이 미리 "사람이 부를 때만" 으로 뺀다.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OPS = path.resolve(HERE, "..", "..");
const OUT_DIR = path.join(OPS, "work", "deploy-sync");
const SCAN = path.join(OUT_DIR, "scan.json");

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : null;
};

const DRY = has("--dry-run");
const ONLY = val("--only");
const FORCE = has("--force");
const MAX = val("--max") ? Number(val("--max")) : Infinity;

if (!fs.existsSync(SCAN)) {
  console.error(`scan.json 이 없다. 먼저 이것을 돌린다:\n  node "${path.join(HERE, "scan.mjs")}"`);
  process.exit(1);
}
const scan = JSON.parse(fs.readFileSync(SCAN, "utf8").replace(/^﻿/, ""));

const 나이시간 = (Date.now() - new Date(scan.찍은시각).getTime()) / 3600000;
if (나이시간 > 6) {
  console.log(`scan.json 이 ${나이시간.toFixed(1)}시간 전 것이다. 다시 세고 오는 게 낫다.`);
}

let 대상 = scan.프로젝트.filter((p) => p.할일?.length);
if (ONLY) 대상 = 대상.filter((p) => p.프로젝트 === ONLY || p.폴더 === ONLY);

// scan 이 뺀 것을 사람이 확인하고 미는 자리. registry 에서 명령을 다시 짠다.
if (FORCE && ONLY && !대상.length) {
  const REG = JSON.parse(
    fs.readFileSync(path.join(HERE, "registry.json"), "utf8").replace(/^﻿/, "")
  );
  const spec = REG.프로젝트[ONLY];
  const row = scan.프로젝트.find((p) => p.프로젝트 === ONLY);
  if (!spec) {
    console.error(`registry.json 에 ${ONLY} 가 없다.`);
    process.exit(1);
  }
  if (spec.배포 === "github") {
    console.error(`${ONLY} 는 push 로만 배포한다. 여기서 밀면 커밋 안 한 것까지 올라간다.`);
    process.exit(1);
  }
  const cwd = row?.경로 ?? path.join(path.resolve(scan.dev_root), spec.폴더.replace(/\//g, path.sep));
  const 할일 = [];
  if (spec.동기화) 할일.push({ 종류: "동기화", 명령: spec.동기화, cwd });
  if (spec.빌드 && !String(spec.배포명령 || "").includes("run deploy")) 할일.push({ 종류: "빌드", 명령: spec.빌드, cwd });
  if (spec.배포명령) 할일.push({ 종류: "배포", 명령: spec.배포명령, cwd });
  if (!할일.length) {
    console.error(`${ONLY} 에 적힌 배포 명령이 없다. registry.json 을 본다.`);
    process.exit(1);
  }
  console.log(`--force 로 민다: ${ONLY}`);
  if (row?.경고?.length) for (const w of row.경고) console.log("  경고: " + w);
  대상 = [{ 프로젝트: ONLY, 폴더: spec.폴더, url: spec.url, 할일 }];
}

대상 = 대상.slice(0, MAX);

if (!대상.length) {
  console.log("밀 것이 없다.");
  process.exit(0);
}

const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");
const shell = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "/bin/sh";
const wrap = (cmd) => (process.platform === "win32" ? ["/d", "/s", "/c", cmd + " 2>&1"] : ["-c", cmd + " 2>&1"]);

// cwd 를 반드시 따로 넘긴다. cd 를 명령에 이어 붙이면 vercel 이 엉뚱한 폴더를
// 프로젝트로 잡아 새 프로젝트를 만들어 버린다. 260805 에 실제로 그렇게 됐다.
function run(cmd, cwd, timeout) {
  const started = Date.now();
  try {
    const out = execFileSync(shell, wrap(cmd), { cwd, encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024 });
    return { ok: true, out: out.replace(ANSI, ""), 초: Math.round((Date.now() - started) / 1000) };
  } catch (e) {
    const out = String(e.stdout ?? e.message ?? e).replace(ANSI, "");
    return { ok: false, out, 초: Math.round((Date.now() - started) / 1000) };
  }
}

const 결과 = [];
const 시작 = new Date();
console.log(`\n밀 것 ${대상.length}개` + (DRY ? "  (dry-run, 실제로 치지 않는다)" : ""));

for (const p of 대상) {
  console.log(`\n=== ${p.프로젝트}  (${p.폴더}) ===`);
  const 항목 = { 프로젝트: p.프로젝트, 폴더: p.폴더, url: p.url, 단계: [], 결과: "성공" };

  for (const t of p.할일) {
    const timeout = t.종류 === "배포" ? 900000 : 600000;
    console.log(`  ${t.종류}: ${t.명령}`);
    if (DRY) {
      항목.단계.push({ 종류: t.종류, 명령: t.명령, 상태: "dry-run" });
      continue;
    }
    const r = run(t.명령, t.cwd, timeout);
    const 꼬리 = r.out.trim().split("\n").slice(-3).join(" | ").slice(0, 300);
    항목.단계.push({ 종류: t.종류, 명령: t.명령, 상태: r.ok ? "성공" : "실패", 초: r.초, 꼬리 });
    console.log(`    ${r.ok ? "성공" : "실패"} ${r.초}초  ${꼬리}`);
    const 주소 = r.out.match(/https:\/\/[a-z0-9-]+\.vercel\.app/gi);
    if (주소) 항목.배포주소 = 주소[주소.length - 1];
    if (!r.ok) {
      항목.결과 = "실패";
      항목.실패단계 = t.종류;
      console.log(`    ${t.종류} 에서 막혔다. 이 프로젝트는 여기서 멈추고 다음으로 간다.`);
      break;
    }
  }
  결과.push(항목);
}

const 성공 = 결과.filter((r) => r.결과 === "성공").length;
const 실패 = 결과.filter((r) => r.결과 === "실패");

const log = {
  시작: 시작.toISOString(),
  끝: new Date().toISOString(),
  dry_run: DRY,
  성공,
  실패: 실패.length,
  항목: 결과,
};
// dry-run 은 run.json 을 덮지 않는다. 덮으면 실제로 민 기록이 사라져서
// scan 이 다 밀어 놓은 것을 다시 밀라고 한다.
const 적을곳 = path.join(OUT_DIR, DRY ? "run-dry.json" : "run.json");
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(적을곳, JSON.stringify(log, null, 2), "utf8");

console.log(`\n끝. 성공 ${성공}개, 실패 ${실패.length}개`);
for (const f of 실패) console.log(`  실패 ${f.프로젝트}: ${f.실패단계} 에서 막혔다`);
console.log(`적었다: ${적을곳}`);
if (!DRY) console.log(`다음: node "${path.join(HERE, "scan.mjs")}" 로 다시 세서 최신이 됐는지 본다`);
