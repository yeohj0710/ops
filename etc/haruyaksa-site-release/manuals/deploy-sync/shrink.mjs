#!/usr/bin/env node
// 배포 사이트 최신화 3단계의 손. weight 가 찾은 큰 그림을 줄인다.
//
//   node shrink.mjs --only chaenggil            무엇을 얼마나 줄일지만 보여준다
//   node shrink.mjs --only chaenggil --apply    실제로 줄인다
//   node shrink.mjs --only chaenggil --apply --max-width 1600
//
// 파일 이름과 확장자를 그대로 둔다. 이름이 바뀌면 화면에서 그림이 통째로 사라진다.
// 원본은 프로젝트 폴더 안 etc/이미지백업-<날짜>/ 로 옮겨 둔다. 되돌릴 수 있다.
// 줄여도 10% 넘게 안 작아지면 원본을 그대로 둔다. 화질만 깎이고 얻는 게 없다.
//
// ffmpeg 가 있어야 한다. 없으면 무엇을 줄여야 하는지만 알려주고 끝낸다.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OPS = path.resolve(HERE, "..", "..");
const REG = JSON.parse(fs.readFileSync(path.join(HERE, "registry.json"), "utf8").replace(/^﻿/, ""));
const OUT_DIR = path.join(OPS, "work", "deploy-sync");
const DEV = readDevRoot();

const argv = process.argv.slice(2);
const val = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : null;
};
const ONLY = val("--only");
const APPLY = argv.includes("--apply");
const FORCE = argv.includes("--force");
const MAXW = Number(val("--max-width") ?? 1920);
const 한계 = Number(val("--min-kb") ?? 300) * 1024;

function readDevRoot() {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(OPS, "machine.json"), "utf8").replace(/^﻿/, ""));
    if (m.dev_root) return m.dev_root.replace(/\//g, path.sep);
  } catch {}
  return path.resolve(OPS, "..");
}

if (!ONLY) {
  console.error("어느 프로젝트인지 정해야 한다.  node shrink.mjs --only <프로젝트>");
  console.error("이름은 registry.json 의 키다. 무엇이 무거운지는 weight.mjs 가 알려준다.");
  process.exit(1);
}

const spec = REG.프로젝트[ONLY];
if (!spec) {
  console.error(`registry.json 에 ${ONLY} 가 없다. 등록 안 된 프로젝트는 손대지 않는다.`);
  process.exit(1);
}

// 휴면 프로젝트는 건드리지 않는다. 안 쓰는 것을 깨우면 빌드 시간만 나간다.
const scanFile = path.join(OUT_DIR, "scan.json");
if (!FORCE && fs.existsSync(scanFile)) {
  const scan = JSON.parse(fs.readFileSync(scanFile, "utf8").replace(/^﻿/, ""));
  const 판정 = scan.프로젝트?.find((p) => p.프로젝트 === ONLY)?.판정;
  if (판정 === "휴면") {
    console.error(`${ONLY} 는 휴면이다. 안 쓰는 사이트를 줄여도 아무도 덕을 안 본다.`);
    console.error("그래도 하려면 --force 를 붙인다.");
    process.exit(1);
  }
}

let ffmpeg = "ffmpeg";
try {
  execFileSync(ffmpeg, ["-version"], { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "ignore"] });
} catch {
  ffmpeg = null;
}

const dir = path.join(DEV, spec.폴더.replace(/\//g, path.sep));
const outDir = ["dist", "out", "build"].map((d) => path.join(dir, d)).find((d) => fs.existsSync(d));
const publicDir = path.join(dir, "public");
const 뿌리 = fs.existsSync(publicDir) ? publicDir : outDir;
if (!뿌리) {
  console.error(`${ONLY} 에 public 도 dist 도 없다. 줄일 자리가 없다.`);
  process.exit(1);
}

// public 이 원본이고 dist 가 구운 결과인 경우가 많다. 원본만 줄이고 다시 구워야
// 다음 배포에도 남는다. dist 만 줄이면 다음 빌드에 원래대로 돌아온다.
console.log(`대상 폴더: ${path.relative(dir, 뿌리)}  (원본을 줄인다. 줄인 뒤 빌드를 다시 돌려야 화면에 반영된다)`);

const 확장자 = new Set([".png", ".jpg", ".jpeg"]);
const files = [];
(function walk(p) {
  let entries;
  try {
    entries = fs.readdirSync(p, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(p, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      walk(full);
    } else if (확장자.has(path.extname(e.name).toLowerCase())) {
      const size = fs.statSync(full).size;
      if (size > 한계) files.push({ path: full, size });
    }
  }
})(뿌리);

files.sort((a, b) => b.size - a.size);
const KB = (n) => Math.round(n / 1024) + "KB";
const MB = (n) => (n / 1024 / 1024).toFixed(1) + "MB";

if (!files.length) {
  console.log(`${한계 / 1024}KB 넘는 그림이 없다. 줄일 것이 없다.`);
  process.exit(0);
}

console.log(`\n${한계 / 1024}KB 넘는 그림 ${files.length}장, 합쳐서 ${MB(files.reduce((s, f) => s + f.size, 0))}`);
if (!ffmpeg) {
  console.log("\nffmpeg 가 없다. 목록만 적고 끝낸다.");
  for (const f of files) console.log(`  ${KB(f.size).padStart(8)}  ${path.relative(dir, f.path)}`);
  process.exit(0);
}
if (!APPLY) {
  for (const f of files.slice(0, 30)) console.log(`  ${KB(f.size).padStart(8)}  ${path.relative(dir, f.path)}`);
  console.log(`\n실제로 줄이려면 --apply 를 붙인다. 원본은 백업 폴더로 옮긴다.`);
  process.exit(0);
}

const d = new Date();
const 날짜 = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
const 백업 = path.join(dir, "etc", `이미지백업-${날짜}`);
fs.mkdirSync(백업, { recursive: true });

let 줄인수 = 0;
let 아낀바이트 = 0;
let 그대로둔수 = 0;
const 기록 = [];

for (const f of files) {
  const ext = path.extname(f.path).toLowerCase();
  const tmp = f.path + ".shrink" + ext;
  const args = ["-y", "-loglevel", "error", "-i", f.path, "-vf", `scale='min(${MAXW},iw)':-2:flags=lanczos`];
  if (ext === ".png") args.push("-compression_level", "100");
  else args.push("-q:v", "3");
  args.push(tmp);

  let 새크기 = null;
  try {
    execFileSync(ffmpeg, args, { timeout: 180000, stdio: ["ignore", "pipe", "pipe"] });
    새크기 = fs.statSync(tmp).size;
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
    console.log(`  건너뜀 ${path.relative(dir, f.path)}  (ffmpeg 가 못 읽었다)`);
    그대로둔수 += 1;
    continue;
  }

  if (새크기 >= f.size * 0.9) {
    fs.rmSync(tmp, { force: true });
    console.log(`  그대로 ${path.relative(dir, f.path)}  ${KB(f.size)} 에서 ${KB(새크기)} 라 안 바꾼다`);
    그대로둔수 += 1;
    continue;
  }

  // 같은 날 두 번 돌리면 백업 자리에 이미 원본이 있다. 그것을 덮으면
  // 한 번 줄인 것이 원본 행세를 하게 되고, 되돌릴 자리가 사라진다.
  const 백업자리 = path.join(백업, path.relative(뿌리, f.path));
  fs.mkdirSync(path.dirname(백업자리), { recursive: true });
  if (fs.existsSync(백업자리)) fs.unlinkSync(f.path);
  else fs.renameSync(f.path, 백업자리);
  fs.renameSync(tmp, f.path);
  줄인수 += 1;
  아낀바이트 += f.size - 새크기;
  기록.push({ 파일: path.relative(dir, f.path), 전: f.size, 후: 새크기 });
  console.log(`  줄임 ${path.relative(dir, f.path)}  ${KB(f.size)} 에서 ${KB(새크기)}`);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(
  path.join(OUT_DIR, `shrink-${ONLY}.json`),
  JSON.stringify({ 프로젝트: ONLY, 찍은시각: new Date().toISOString(), 백업, 기록 }, null, 2),
  "utf8"
);

console.log(`\n${줄인수}장 줄였다. ${MB(아낀바이트)} 아꼈다. 그대로 둔 것 ${그대로둔수}장`);
console.log(`원본은 여기 있다: ${백업}`);
console.log(`다음: 이 프로젝트를 다시 빌드하고 배포한다. 화면에서 그림이 안 깨졌는지 눈으로 본다`);
