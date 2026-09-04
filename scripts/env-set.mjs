#!/usr/bin/env node
// 드라이브 자격증명 .env 에 키 하나를 넣는다. 값을 화면에 찍지 않는다.
//
//   node scripts/env-set.mjs SNSSUPPORTER_API_KEY --clipboard   클립보드에 복사해 둔 값을 넣는다
//   echo -n "값" | node scripts/env-set.mjs SNSSUPPORTER_API_KEY   표준입력 값을 넣는다
//   node scripts/env-set.mjs SNSSUPPORTER_API_KEY --check       있는지와 길이만 본다
//
// 왜 있나. 사이트가 보여주는 API 키를 에이전트가 화면에 옮겨 적으면 대화 기록에 키가 남는다.
// 사람이 키를 복사해 두고 이 명령을 치면 클립보드에서 파일로 바로 들어간다. 중간에 아무도 안 본다.
// 대상 파일은 <drive_root>/에이전트/자격증명/.env 다. machine.json 의 drive_root 를 따른다.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OPS = process.env.OPS_ROOT || path.resolve(HERE, "..");

const argv = process.argv.slice(2);
const NAME = argv.find((a) => !a.startsWith("--"));
const has = (f) => argv.includes("--" + f);

if (!NAME || !/^[A-Z][A-Z0-9_]*$/.test(NAME)) {
  console.error("키 이름이 필요하다. 대문자와 밑줄만. 예: node scripts/env-set.mjs SNSSUPPORTER_API_KEY --clipboard");
  process.exit(2);
}

function envPath() {
  const m = JSON.parse(fs.readFileSync(path.join(OPS, "machine.json"), "utf8"));
  if (!m.drive_root) throw new Error("machine.json 에 drive_root 가 없다. node setup.mjs --drive <경로> 를 먼저 돌린다");
  return path.join(m.drive_root.replace(/\//g, path.sep), "에이전트", "자격증명", ".env");
}

function readEnv(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

function currentValue(text) {
  const m = text.match(new RegExp("^" + NAME + "=(.*)$", "m"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
}

const file = envPath();

if (has("check")) {
  const v = currentValue(readEnv(file));
  console.log(v ? `${NAME} 있음 (${v.length}자)` : `${NAME} 없음`);
  console.log(file);
  process.exit(v ? 0 : 1);
}

let value = "";
if (has("clipboard")) {
  if (process.platform !== "win32") {
    console.error("--clipboard 는 Windows 에서만 된다. 다른 OS 는 표준입력으로 넣는다");
    process.exit(2);
  }
  value = execFileSync("powershell", ["-NoProfile", "-Command", "Get-Clipboard -Raw"], { encoding: "utf8" });
} else {
  value = fs.readFileSync(0, "utf8");
}
value = value.replace(/^﻿/, "").trim();

if (!value) {
  console.error("값이 비어 있다. 클립보드에 복사했는지, 표준입력으로 넘겼는지 본다");
  process.exit(2);
}
if (/\s/.test(value) || value.length > 200) {
  console.error(`값 모양이 이상하다 (${value.length}자, 공백 ${/\s/.test(value) ? "있음" : "없음"}). 키 하나만 복사했는지 본다`);
  process.exit(2);
}

let text = readEnv(file);
const line = `${NAME}=${value}`;
if (new RegExp("^" + NAME + "=", "m").test(text)) {
  text = text.replace(new RegExp("^" + NAME + "=.*$", "m"), line);
} else {
  if (text && !text.endsWith("\n")) text += "\n";
  text += line + "\n";
}
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, text, "utf8");
console.log(`${NAME} 저장 (${value.length}자)`);
console.log(file);
