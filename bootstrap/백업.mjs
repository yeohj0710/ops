#!/usr/bin/env node
// 이 컴퓨터의 에이전트 설정을 드라이브 '에이전트' 폴더로 거둔다.
// 방향: 컴 → 드라이브.  반대는 설치.mjs.
//
//   node 백업.mjs [--dev C:/dev] [--dry]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readManifest, findDevRoot, resolveTarget, copyTree, removeTree, arg, hasFlag } from "./lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const devRoot = findDevRoot(arg("dev"));
const dry = hasFlag("dry");
const manifest = readManifest(HERE);

console.log("거두는 곳: " + HERE);
console.log("프로젝트 폴더: " + devRoot);
if (dry) console.log("(--dry — 세기만 하고 쓰지 않는다)\n");
else console.log("");

let total = 0;
const rows = [];
for (const item of manifest.items) {
  const from = resolveTarget(item, devRoot);
  const to = path.join(HERE, item.store);
  if (!fs.existsSync(from)) {
    console.log(`  건너뜀  ${item.what} — 이 컴에 없다 (${from})`);
    rows.push({ ...item, n: 0, missing: true });
    continue;
  }
  let n = 0;
  if (dry) {
    n = fs.statSync(from).isFile() ? 1 : copyTree(from, path.join(HERE, ".__dry", item.store));
  } else {
    removeTree(to);
    n = copyTree(from, to);
  }
  total += n;
  rows.push({ ...item, n });
  console.log(`  ${String(n).padStart(4)}개  ${item.what}`);
}
if (dry) removeTree(path.join(HERE, ".__dry"));

// 사람이 열어보는 목록도 같이 남긴다.
if (!dry) {
  const md = [
    "# 드라이브에 담긴 것",
    "",
    "> `백업.mjs` 가 자동으로 쓴다. 손으로 고치지 마라.",
    "",
    "마지막 백업: " + new Date().toLocaleString("ko-KR"),
    "",
    "| 무엇 | 파일 수 | 새 컴에서 가는 자리 |",
    "| --- | --- | --- |",
    ...rows.map(
      (r) =>
        `| ${r.what} | ${r.missing ? "없음" : r.n} | \`${
          r.base === "dev" ? "<프로젝트폴더>" : "<사용자폴더>"
        }/${r.path}\` |`
    ),
    "",
    "## 일부러 뺀 것",
    "",
    ...Object.entries(manifest.제외).map(([k, v]) => `- **${k}** — ${v}`),
  ].join("\n");
  fs.writeFileSync(path.join(HERE, "목록.md"), md + "\n", "utf8");
}

console.log("");
console.log(dry ? `옮길 파일 ${total}개` : `옮긴 파일 ${total}개`);
console.log("자격증명(auth.json·.env·키)은 목록에 없어서 애초에 안 간다.");
