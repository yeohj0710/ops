#!/usr/bin/env node
// 배포 사이트 최신화 완료 검사. ops done 이 자동으로 돌린다.
//
// 막는 것은 넷뿐이다.
//   1. scan 을 안 돌렸다
//   2. scan 이 오래됐다 (여섯 시간 넘음)
//   3. 밀어야 할 것이 남아 있는데 run 을 안 돌렸다
//   4. run 에서 실패한 것이 있는데 그대로 뒀다
//
// 휴면과 "사람이 부를 때만" 은 막지 않는다. 그건 안 하는 게 맞는 것들이다.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OPS = process.env.OPS_ROOT ?? path.resolve(HERE, "..", "..");
const DIR = path.join(OPS, "work", "deploy-sync");

const 실패 = [];
const 알림 = [];

function readJSON(f) {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, ""));
  } catch {
    return null;
  }
}

const scan = readJSON(path.join(DIR, "scan.json"));
if (!scan) {
  실패.push(`scan.json 이 없다. node "${path.join(HERE, "scan.mjs")}" 를 먼저 돌린다`);
} else {
  const 시간 = (Date.now() - new Date(scan.찍은시각).getTime()) / 3600000;
  if (시간 > 6) 실패.push(`scan.json 이 ${시간.toFixed(1)}시간 전 것이다. 다시 세고 나서 끝낸다`);

  const 남은것 = (scan.프로젝트 ?? []).filter((p) => p.할일?.length).map((p) => p.프로젝트);
  const run = readJSON(path.join(DIR, "run.json"));
  if (남은것.length) {
    if (!run) {
      실패.push(`밀 것이 ${남은것.length}개 남았는데 run 을 안 돌렸다: ${남은것.join(", ")}`);
    } else if (run.dry_run) {
      실패.push("run 을 dry-run 으로만 돌렸다. --dry-run 없이 다시 돌린다");
    } else {
      const 민것 = new Set((run.항목 ?? []).map((r) => r.프로젝트));
      const 빠진것 = 남은것.filter((n) => !민것.has(n));
      if (빠진것.length) 실패.push(`run 이 건드리지 않은 것이 있다: ${빠진것.join(", ")}`);
    }
  }
  if (run?.항목?.some((r) => r.결과 === "실패")) {
    const f = run.항목.filter((r) => r.결과 === "실패").map((r) => `${r.프로젝트}(${r.실패단계})`);
    실패.push(`배포에 실패한 것이 있다: ${f.join(", ")}. 고치고 다시 밀거나, 왜 못 미는지 보고에 적고 이 파일을 지운다`);
  }

  const 휴면 = (scan.프로젝트 ?? []).filter((p) => p.판정 === "휴면").length;
  if (휴면) 알림.push(`휴면 ${휴면}개는 건드리지 않았다. 맞는 처리다`);
  if (scan.유휴?.length) 알림.push(`쓰지 않는 Vercel 프로젝트 ${scan.유휴.length}개는 그대로 뒀다`);
}

const weight = readJSON(path.join(DIR, "weight.json"));
if (!weight) 알림.push("weight 를 안 돌렸다. 사용량 점검 없이 끝내도 되지만, 돌리면 무거운 자리가 나온다");
else if (weight.발견?.length) 알림.push(`사용량 점검에서 ${weight.발견.length}건 나왔다. 보고에 옮겼는지 본다`);

if (!fs.existsSync(path.join(DIR, "notion-new.md"))) 알림.push("노션 본문을 안 만들었다. 노션을 못 만지는 런너면 그냥 둔다");

for (const a of 알림) console.log("  참고: " + a);
if (실패.length) {
  console.error("\n완료 검사 실패");
  for (const f of 실패) console.error("  - " + f);
  process.exit(1);
}
console.log("완료 검사 통과");
