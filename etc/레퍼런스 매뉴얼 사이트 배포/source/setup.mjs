#!/usr/bin/env node
// 새 기계 세팅. clone 한 다음 한 번만 돌린다.
//   node setup.mjs [--name 기계이름] [--dev C:/dev]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf("--" + k);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d;
};

const name = opt("name", os.hostname().toLowerCase());

// 구글 드라이브. 컴마다 드라이브 문자가 다르니 찾아본다.
function findDrive() {
  const given = opt("drive", null);
  if (given) return given.replace(/\\/g, "/");
  const roots = [];
  for (const L of "GHIJKDEF") roots.push(`${L}:/내 드라이브`, `${L}:/My Drive`);
  roots.push(path.join(os.homedir(), "Google Drive", "My Drive"));
  for (const r of roots) {
    try {
      if (fs.existsSync(r) && fs.statSync(r).isDirectory()) return r.replace(/\\/g, "/");
    } catch {}
  }
  return null;
}
const driveRoot = findDrive();

let devRoot = opt("dev", null);
if (!devRoot) {
  for (const c of ["C:/dev", path.join(os.homedir(), "dev")]) {
    if (fs.existsSync(c)) { devRoot = c; break; }
  }
  devRoot = devRoot || path.dirname(ROOT);
}

// 1. 이 기계 정보
const machinePath = path.join(ROOT, "machine.json");
fs.writeFileSync(
  machinePath,
  JSON.stringify(
    { name, dev_root: devRoot.replace(/\\/g, "/"), drive_root: driveRoot, os: process.platform },
    null,
    2
  ) + "\n",
  "utf8"
);
console.log("기계 등록: " + name + "  (프로젝트 폴더 " + devRoot + ")");
console.log(driveRoot ? "구글 드라이브: " + driveRoot : "구글 드라이브를 못 찾았다. --drive 로 알려주면 된다");

// 2. 폴더
for (const d of ["tasks/queue", "tasks/doing", "tasks/done", "work"]) {
  fs.mkdirSync(path.join(ROOT, d), { recursive: true });
  const keep = path.join(ROOT, d, ".gitkeep");
  if (!fs.existsSync(keep)) fs.writeFileSync(keep, "");
}

// 3. 커밋 전 검사 훅
try {
  execFileSync("git", ["rev-parse", "--git-dir"], { cwd: ROOT, stdio: "ignore" });
  const hookDir = path.join(ROOT, ".git", "hooks");
  fs.mkdirSync(hookDir, { recursive: true });
  fs.writeFileSync(
    path.join(hookDir, "pre-commit"),
    "#!/bin/sh\nexec node \"$(dirname \"$0\")/../../scripts/scan-secrets.mjs\"\n",
    "utf8"
  );
  try { fs.chmodSync(path.join(hookDir, "pre-commit"), 0o755); } catch {}
  console.log("커밋 전 검사 훅 설치");
} catch {
  console.log("아직 git 저장소가 아니다. git init 하고 다시 돌려라");
}

// 4. 전역 설정이 이 저장소를 가리키게
const BEGIN = "<!-- ops:begin -->";
const END = "<!-- ops:end -->";
// 여기는 매 세션 상시 컨텍스트다. 짧게 유지한다. 실제 지침은 ops 스킬 본문에 있고,
// 그건 스킬이 불릴 때만 로드된다.
const OPS = ROOT.replace(/\\/g, "/");
const block = [
  BEGIN,
  "회사 업무(카톡, 제안서, 시딩 등 반복 업무)는 `" + OPS + "` 가 관장한다.",
  "그런 일을 시키거나 새 업무를 등록하라고 하면 **ops 스킬**을 쓴다. 절차는 그 안에 있다.",
  END,
].join("\n");

for (const target of [
  path.join(os.homedir(), ".claude", "CLAUDE.md"),
  path.join(os.homedir(), ".codex", "AGENTS.md"),
]) {
  if (!fs.existsSync(target)) {
    console.log("건너뜀 (파일 없음): " + target);
    continue;
  }
  let text = fs.readFileSync(target, "utf8");
  const re = new RegExp(BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[\\s\\S]*?" + END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  text = re.test(text) ? text.replace(re, block) : text.trimEnd() + "\n\n" + block + "\n";
  fs.writeFileSync(target, text, "utf8");
  console.log("전역 설정 갱신: " + target);
}

// 5. ops 스킬 설치 (Claude 와 Codex 양쪽)
try {
  execFileSync(process.execPath, [path.join(ROOT, "ops.mjs"), "sync"], {
    cwd: ROOT,
    stdio: "inherit",
  });
} catch {
  console.log("스킬 설치 실패. node ops.mjs sync 를 직접 돌려라");
}

console.log("\n확인:  node \"" + path.join(ROOT, "ops.mjs") + "\" doctor");
