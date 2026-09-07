#!/usr/bin/env node
// 조회수 분할 반복주문 완료 검사. ops done 이 자동으로 돌린다.
//
// 막는 것은 셋뿐이다.
//   1. 묶음이 하나도 없다 (start 를 안 돌렸다)
//   2. 태스크 입력에 묶음 id 가 있는데 그 묶음이 안 끝났다
//   3. 묶음 id 가 없으면 가장 최근 묶음이 안 끝났다
//
// 끝났다는 것은 state.json 의 done 이 true 이고 orders 수가 runs 와 같다는 뜻이다.
// 돌고 있는 중이면 진행률을 찍고 실패로 낸다. 완료는 사람이 기다렸다가 다시 done 을 친다.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OPS = process.env.OPS_ROOT ?? path.resolve(HERE, "..", "..");
const WORK = path.join(OPS, "work", "snsview-drip");

const readJSON = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, ""));
  } catch {
    return null;
  }
};

const taskFile = process.argv[2] || process.env.OPS_TASK;
const task = taskFile ? readJSON(taskFile) : null;
const wantId = task?.input?.batchId || task?.input?.batch || null;

const batches = fs.existsSync(WORK)
  ? fs
      .readdirSync(WORK)
      .map((d) => readJSON(path.join(WORK, d, "state.json")))
      .filter(Boolean)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
  : [];

const 실패 = [];
if (!batches.length) 실패.push("묶음이 하나도 없다. snsview-drip.mjs start 를 먼저 돌린다");

const target = wantId ? batches.find((b) => b.id === wantId) : batches.at(-1);
if (wantId && !target) 실패.push(`태스크가 가리키는 묶음 ${wantId} 가 없다`);

if (target) {
  const pct = Math.round((target.orders.length / target.runs) * 100);
  if (target.done && target.orders.length >= target.runs) {
    console.log(`묶음 ${target.id} 완료. ${target.orders.length}/${target.runs} 주문, ${target.orders.length * target.qty}회`);
  } else {
    실패.push(
      `묶음 ${target.id} 가 아직 ${target.orders.length}/${target.runs} (${pct}%) 다. ` +
        (target.paused ? `멈춘 이유: ${target.paused}. resume 으로 이어 간다` : target.stopped ? "stop 으로 멈췄다" : "끝날 때까지 기다렸다가 다시 done 을 친다")
    );
  }
}

if (실패.length) {
  for (const f of 실패) console.error("실패: " + f);
  process.exit(1);
}
console.log("snsview-drip checks: ok");
