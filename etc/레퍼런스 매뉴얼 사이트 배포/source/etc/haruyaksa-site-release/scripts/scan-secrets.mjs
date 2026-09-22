#!/usr/bin/env node
// 커밋 전 검사. 남의 개인정보와 살아있는 자격증명만 막는다.
// 회사 내부 자료, 단가, 기획은 통과시킨다. 이 저장소는 공개다.
//
// 사람이 확인하고 통과시키려면:  OPS_SCAN_OK=1 git commit ...

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.OPS_SCAN_OK === "1") {
  console.log("검사 건너뜀 (OPS_SCAN_OK=1)");
  process.exit(0);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const RULES = [
  { name: "API 키와 토큰", re: /\b(sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|ya29\.[A-Za-z0-9_-]{20,})\b/ },
  { name: "개인 키 파일", re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: "주민등록번호", re: /\b\d{6}[-\s]?[1-4]\d{6}\b/ },
  { name: "휴대폰 번호", re: /\b01[016789][-\s]?\d{3,4}[-\s]?\d{4}\b/ },
  { name: "계좌번호로 보이는 것", re: /(계좌|입금|송금|account)\D{0,12}\b\d{2,6}-\d{2,6}-\d{2,8}\b/i },
  { name: "카드번호", re: /\b(?:\d{4}[-\s]){3}\d{4}\b/ },
  { name: "비밀번호를 값으로 적음", re: /(비밀번호|비번|암호|password|passwd|pwd)\s*[:=]\s*["']?[^\s"'<>]{6,}/i },
];

const FILENAME_RULES = [
  { name: "신분증이나 통장 사본으로 보이는 파일", re: /(신분증|주민등록증|운전면허|여권|통장사본|사업자등록증)/ },
  { name: "환경변수 파일", re: /(^|\/)\.env(\.|$)/ },
];

const SKIP_SELF = /scripts[\\/]scan-secrets\.mjs$/;

function staged() {
  const out = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACM"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

const hits = [];
for (const rel of staged()) {
  if (SKIP_SELF.test(rel)) continue;

  for (const r of FILENAME_RULES) {
    if (r.re.test(rel)) hits.push({ file: rel, line: 0, rule: r.name, text: rel });
  }

  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue;
  const stat = fs.statSync(abs);
  if (stat.size > 2_000_000) continue;

  let text;
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch {
    continue;
  }
  if (text.includes(String.fromCharCode(0))) continue; // 이진 파일

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const r of RULES) {
      if (r.re.test(lines[i])) {
        hits.push({ file: rel, line: i + 1, rule: r.name, text: lines[i].trim().slice(0, 120) });
      }
    }
  }
}

if (!hits.length) process.exit(0);

console.error("\n커밋을 막았다. 공개 저장소에 올라가면 안 되는 값이 보인다.\n");
for (const h of hits) {
  console.error(`  ${h.rule}`);
  console.error(`    ${h.file}${h.line ? ":" + h.line : ""}`);
  console.error(`    ${h.text}`);
  console.error("");
}
console.error("고치는 법");
console.error("  1. 그 값을 지우고 비공개 저장소나 환경변수로 옮긴다");
console.error("  2. 검사가 틀렸으면(예시 번호, 남의 것이 아닌 값) 아래로 통과시킨다");
console.error("       OPS_SCAN_OK=1 git commit ...");
console.error("");
process.exit(1);
