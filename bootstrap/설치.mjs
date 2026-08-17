#!/usr/bin/env node
// 새 컴퓨터에 에이전트 설정을 전부 깐다. 드라이브 폴더에서 그대로 실행한다.
// 방향: 드라이브 → 컴.  반대는 백업.mjs.
//
//   node 설치.mjs [--dev C:/dev] [--dry]
//
// 이미 있는 파일은 지우지 않고 백업_<날짜>/ 로 옮겨둔 뒤 덮는다.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { readManifest, findDevRoot, resolveTarget, copyTree, removeTree, stamp, arg, hasFlag } from "./lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const devRoot = findDevRoot(arg("dev"));
const dry = hasFlag("dry");
const manifest = readManifest(HERE);
const OPS = path.join(devRoot, "ops").replace(/\\/g, "/");

console.log("가져오는 곳: " + HERE);
console.log("프로젝트 폴더: " + devRoot);
if (dry) console.log("(--dry — 무엇이 바뀔지만 보여주고 쓰지 않는다)");
console.log("");

// 0. git · node 확인
function has(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const gitOK = has("git", ["--version"]);
console.log((gitOK ? "OK  " : "빠짐") + " git" + (gitOK ? "" : " — 설치해야 저장소를 받는다"));
console.log("OK   node " + process.version);
console.log("");

// 1. 설정 파일 제자리에 놓기
const backupDir = path.join(devRoot, "_에이전트설정백업_" + stamp());
let moved = 0;
let copied = 0;

console.log("[1/3] 설정 파일");
for (const item of manifest.items) {
  const from = path.join(HERE, item.store);
  const to = resolveTarget(item, devRoot);
  if (!fs.existsSync(from)) {
    console.log(`  건너뜀  ${item.what} — 드라이브에 없다`);
    continue;
  }
  const exists = fs.existsSync(to);
  if (dry) {
    console.log(`  ${exists ? "덮음(기존은 백업)" : "새로 놓음"}  ${item.what} → ${to}`);
    continue;
  }
  if (exists) {
    // 기존 것을 지우지 않는다. 통째로 옮겨두고 덮는다.
    const keep = path.join(backupDir, item.store);
    fs.mkdirSync(path.dirname(keep), { recursive: true });
    copyTree(to, keep);
    removeTree(to);
    moved++;
  }
  const n = copyTree(from, to);
  copied += n;
  console.log(`  ${String(n).padStart(4)}개  ${item.what} → ${to}`);
}
if (!dry && moved) console.log("  기존 설정 " + moved + "건은 " + backupDir + " 에 옮겨뒀다");

// 1-b. 자격증명 (.env) — manifest 에 없다. 드라이브에만 있고 저장소로는 안 간다.
const envFrom = path.join(HERE, "자격증명", ".env");
const envTo = path.join(devRoot, "ops", ".env");
if (fs.existsSync(envFrom)) {
  if (dry) {
    console.log(`  놓을 예정  자격증명 .env → ${envTo}`);
  } else {
    fs.mkdirSync(path.dirname(envTo), { recursive: true });
    fs.copyFileSync(envFrom, envTo);
    console.log(`     1개  자격증명 .env → ${envTo}`);
  }
} else {
  console.log("  건너뜀  자격증명 .env — 드라이브에 없다 (있으면 자동으로 놓는다)");
}

// 2. 관제탑 저장소
console.log("");
console.log("[2/3] 관제탑 저장소");
if (fs.existsSync(path.join(OPS, "ops.mjs"))) {
  console.log("  이미 있다: " + OPS);
  if (!dry && gitOK) {
    try {
      execFileSync("git", ["-C", OPS, "pull", "--rebase"], { stdio: "ignore" });
      console.log("  최신으로 당겼다");
    } catch {
      console.log("  당기지 못했다 — 나중에 git -C " + OPS + " pull");
    }
  }
} else if (!gitOK) {
  console.log("  git 이 없어 건너뛴다. git 을 깔고 다시 실행해라");
} else if (dry) {
  console.log("  clone 할 예정: " + OPS);
} else {
  fs.mkdirSync(devRoot, { recursive: true });
  try {
    execFileSync("git", ["clone", "https://github.com/yeohj0710/ops.git", OPS], { stdio: "inherit" });
    console.log("  받았다: " + OPS);
  } catch {
    console.log("  clone 실패 — 인터넷과 git 을 확인해라");
  }
}

// 3. 관제탑 세팅 (기계 등록·검사 훅·스킬 설치)
console.log("");
console.log("[3/3] 관제탑 세팅");
if (dry) {
  console.log("  node " + OPS + "/setup.mjs 를 돌릴 예정");
} else if (fs.existsSync(path.join(OPS, "setup.mjs"))) {
  try {
    execFileSync(process.execPath, [path.join(OPS, "setup.mjs"), "--dev", devRoot], {
      cwd: OPS,
      stdio: "inherit",
    });
  } catch {
    console.log("  실패 — node " + OPS + "/setup.mjs 를 직접 돌려라");
  }
} else {
  console.log("  저장소가 없어 건너뛴다");
}

console.log("");
console.log(dry ? "여기까지가 --dry 결과다. 진짜로 하려면 --dry 를 빼라." : "끝났다.");
if (!dry) {
  console.log("");
  console.log("확인:  node \"" + OPS + "/ops.mjs\" doctor");
  console.log("이제 세션에 \"카톡 봐줘\" 처럼 짧게 시키면 된다.");
  console.log("");
  console.log("사람이 직접 해야 하는 것 — Claude·Codex 로그인, 그리고 Codex 설정(config.toml).");
  console.log("그 둘은 기계마다 값이 달라 드라이브에 담지 않았다.");
}
