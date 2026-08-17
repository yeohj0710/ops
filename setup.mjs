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
const OPS = ROOT.replace(/\\/g, "/");
const CLI = path.join(ROOT, "ops.mjs").replace(/\\/g, "/");
const block = [
  BEGIN,
  "",
  "# 회사 업무 관제탑 (ops)",
  "",
  "회사 업무는 `" + OPS + "` 에서 굴린다. 사람은 배경 설명 없이 한 문장만 말한다.",
  "아래 두 트리거를 알아듣는 것이 이 블록의 전부다.",
  "",
  "**트리거 1 — \"○○ 해줘\" (업무 실행).** 반복 업무로 들리면 먼저 조용히 매뉴얼을 찾는다.",
  "",
  "```bash",
  "node \"" + CLI + "\" manuals \"○○\"",
  "```",
  "",
  "- 나오면: 그 `MANUAL.md` 를 **끝까지** 읽고 그대로 한다. 배경을 되묻지 마라 — 매뉴얼이 배경이다.",
  "  시작 전에 `" + OPS + "/AGENTS.md` (상시 지침)와 `runners/` 의 자기 파일(도구 대응표)도 읽는다.",
  "- 없으면: `manuals/_new-manual/MANUAL.md` 를 펴고 **기록 모드**로 해낸 뒤 매뉴얼로 승격한다.",
  "",
  "**트리거 2 — \"○○ 업무로 등록해줘\" (매뉴얼 등록).**",
  "비슷한 말: \"매뉴얼로 만들어\", \"시스템에 반영해\", \"다음에도 이렇게 해줘\", \"방금 한 거 등록해\".",
  "",
  "```bash",
  "node \"" + CLI + "\" new <영문-id> --title \"○○\"",
  "```",
  "",
  "뼈대가 생기면 방금 한 일(또는 사람이 불러주는 절차)을 템플릿 칸에 채운다.",
  "규칙 세 개: 도구 이름 대신 제어층(L1~L4)으로 적기, 절대경로 대신 `<OPS>` `<DEV>` 로 적기,",
  "막혔다 뚫은 것은 전부 \"알려진 함정\"에 옮기기. 다 채우면 커밋하고 push 한다 — 그래야 다른 컴에도 퍼진다.",
  "",
  "이 저장소는 공개다(github.com/yeohj0710/ops). 커밋 전 검사가 남의 개인정보·자격증명을 막는다.",
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
