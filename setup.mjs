#!/usr/bin/env node
// 새 기계 세팅 — clone 한 다음 한 번만 돌린다.
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
  JSON.stringify({ name, dev_root: devRoot.replace(/\\/g, "/"), os: process.platform }, null, 2) + "\n",
  "utf8"
);
console.log("기계 등록: " + name + "  (프로젝트 폴더 " + devRoot + ")");

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
  console.log("아직 git 저장소가 아니다 — git init 하고 다시 돌려라");
}

// 4. 전역 설정이 이 저장소를 가리키게
const BEGIN = "<!-- ops:begin -->";
const END = "<!-- ops:end -->";
const block = [
  BEGIN,
  "",
  "# 회사 업무 관제탑",
  "",
  "회사 업무는 `" + ROOT.replace(/\\/g, "/") + "` 에서 굴린다.",
  "사람이 업무 이름을 말하면 (\"카톡 봐줘\", \"제안서 만들어줘\") 먼저 그 폴더의 `AGENTS.md` 를 읽고,",
  "`node \"" + path.join(ROOT, "ops.mjs").replace(/\\/g, "/") + "\" manuals \"<말한 업무>\"` 로 매뉴얼을 찾아 그대로 한다.",
  "매뉴얼이 없으면 `manuals/_new-manual/MANUAL.md` 를 펴고 기록 모드로 진행한다.",
  "",
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

console.log("\n확인:  node \"" + path.join(ROOT, "ops.mjs") + "\" doctor");
