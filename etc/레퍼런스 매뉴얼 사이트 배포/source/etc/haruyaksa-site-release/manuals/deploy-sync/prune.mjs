#!/usr/bin/env node
// 한 번 쓰고 버린 Vercel 프로젝트를 골라 낸다. 지우는 것은 되돌릴 수 없다.
//
//   node prune.mjs             지울 후보만 보여준다
//   node prune.mjs --apply     실제로 지운다. 사람이 시켰을 때만 쓴다
//
// 고르는 조건을 전부 통과한 것만 후보다. 하나라도 걸리면 뺀다.
//   1. scan 이 "30일 넘게 조용" 으로 센 것
//   2. registry.json 에 없는 것
//   3. links.json 어디에도 주소가 안 걸린 것
//   4. C:\dev 나 C:\dev\etc 에 그 프로젝트로 연결된 폴더가 없는 것
//   5. 이름이 실험 티가 나는 것 (probe, test, 날짜 꼬리표)
//
// 5번이 마지막 관문이다. 이름만 보고 지우지 않는다. 앞의 넷을 먼저 통과해야 한다.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OPS = path.resolve(HERE, "..", "..");
const OUT_DIR = path.join(OPS, "work", "deploy-sync");
const REG = JSON.parse(fs.readFileSync(path.join(HERE, "registry.json"), "utf8").replace(/^﻿/, ""));
const DEV = readDevRoot();
const APPLY = process.argv.includes("--apply");

function readDevRoot() {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(OPS, "machine.json"), "utf8").replace(/^﻿/, ""));
    if (m.dev_root) return m.dev_root.replace(/\//g, path.sep);
  } catch {}
  return path.resolve(OPS, "..");
}

const scanFile = path.join(OUT_DIR, "scan.json");
if (!fs.existsSync(scanFile)) {
  console.error(`scan.json 이 없다. 먼저 scan.mjs 를 돌린다.`);
  process.exit(1);
}
const scan = JSON.parse(fs.readFileSync(scanFile, "utf8").replace(/^﻿/, ""));
if (scan.vercel?.오류) {
  console.error("scan 이 Vercel 조회를 못 했다. 그 상태로는 지울 수 없다.");
  process.exit(1);
}

// 링크판에 걸린 주소는 살아 있어야 한다.
let 링크된주소 = "";
try {
  링크된주소 = fs.readFileSync(path.join(DEV, "dev-hub", "links.json"), "utf8");
} catch {}

// 로컬에 폴더가 연결돼 있으면 아직 쓰는 것으로 본다.
const 연결된이름 = new Set();
for (const root of ["", "etc"]) {
  const base = root ? path.join(DEV, root) : DEV;
  let entries = [];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {}
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const f = path.join(base, e.name, ".vercel", "project.json");
    if (!fs.existsSync(f)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, ""));
      if (j.projectName) 연결된이름.add(j.projectName);
      if (j.name) 연결된이름.add(j.name);
    } catch {}
  }
}

// 이름만 보고 지우면 언젠가 멀쩡한 것을 지운다. 그래서 "그 날 그 실험" 티가
// 분명한 것만 통과시킨다. 날짜 꼬리표가 붙었거나, 알려진 실험 뭉치에 속한 이름이다.
// 260825 에 chatgpt-api-test(274일)가 -test 로 끝난다는 이유만으로 걸렸다. 뺐다.
const 날짜꼬리표 = /(^|[-_])(0714|0716|20260714|20260716)([-_]|$)/;
const 실험뭉치 = /^(kpic|healthkr|repo-path-filter|repo-tree-probe|artifact-upload-probe|protection-probe|vercel-env-probe|schema-test|pharmassist-[a-z-]+-2026071)/i;
const 실험티 = (이름) => 날짜꼬리표.test(이름) || 실험뭉치.test(이름);
const 등록됨 = new Set(Object.keys(REG.프로젝트));

const 후보 = [];
const 뺀것 = [];
for (const v of scan.유휴 ?? []) {
  const 이유 = [];
  if (등록됨.has(v.프로젝트)) 이유.push("registry 에 있다");
  if (링크된주소.includes(v.url)) 이유.push("링크판에 걸려 있다");
  if (연결된이름.has(v.프로젝트)) 이유.push("로컬 폴더가 연결돼 있다");
  if (!실험티(v.프로젝트)) 이유.push("실험 이름이 아니다");
  if (이유.length) 뺀것.push({ ...v, 이유 });
  else 후보.push(v);
}

console.log(`조용한 프로젝트 ${(scan.유휴 ?? []).length}개 중 지울 후보 ${후보.length}개`);
for (const c of 후보) console.log(`  ${String(c.나이).padStart(5)}  ${c.프로젝트}`);
console.log(`\n뺀 것 ${뺀것.length}개 (하나라도 걸리면 안 지운다)`);
const 이유별 = {};
for (const x of 뺀것) for (const r of x.이유) (이유별[r] ??= []).push(x.프로젝트);
for (const [r, list] of Object.entries(이유별)) console.log(`  ${r}: ${list.length}개  ${list.slice(0, 6).join(", ")}${list.length > 6 ? " 외" : ""}`);

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, "prune.json"), JSON.stringify({ 찍은시각: new Date().toISOString(), 후보, 뺀것 }, null, 2), "utf8");

if (!APPLY) {
  console.log(`\n지우려면 --apply 를 붙인다. 되돌릴 수 없으니 사람이 시켰을 때만 쓴다.`);
  process.exit(0);
}

const shell = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "/bin/sh";
const wrap = (cmd) => (process.platform === "win32" ? ["/d", "/s", "/c", cmd + " 2>&1"] : ["-c", cmd + " 2>&1"]);
const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");

let 지움 = 0;
const 실패 = [];
for (const c of 후보) {
  try {
    const out = execFileSync(shell, wrap(`npx vercel remove ${c.프로젝트} --yes`), {
      cwd: DEV,
      encoding: "utf8",
      timeout: 180000,
    }).replace(ANSI, "");
    const 좋음 = /Success|Removed|removed/i.test(out);
    if (좋음) {
      지움 += 1;
      console.log(`  지움 ${c.프로젝트}`);
    } else {
      실패.push({ 이름: c.프로젝트, 꼬리: out.trim().split("\n").slice(-2).join(" | ").slice(0, 200) });
      console.log(`  실패 ${c.프로젝트}`);
    }
  } catch (e) {
    실패.push({ 이름: c.프로젝트, 꼬리: String(e.stdout ?? e.message).slice(-200) });
    console.log(`  실패 ${c.프로젝트}`);
  }
}

console.log(`\n지운 것 ${지움}개, 실패 ${실패.length}개`);
for (const f of 실패) console.log(`  ${f.이름}: ${f.꼬리}`);
fs.writeFileSync(
  path.join(OUT_DIR, "prune.json"),
  JSON.stringify({ 찍은시각: new Date().toISOString(), 후보, 뺀것, 지움, 실패 }, null, 2),
  "utf8"
);
