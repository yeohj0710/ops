#!/usr/bin/env node
// 팔로워 분할 반복주문 완료 검사. ops done 이 자동으로 돌린다.
//
// 묶음은 조회수 업무와 같은 폴더(<OPS>/work/snsview-drip/)에 쌓인다. 그중 kind 가 follower 인 것만 본다.
// 막는 것은 셋이다.
//   1. 팔로워 묶음이 하나도 없다 (start 를 안 돌렸다)
//   2. 태스크 입력에 묶음 id 가 있는데 그 묶음이 안 끝났다. 없으면 가장 최근 팔로워 묶음이 안 끝났다
//   3. 그 묶음에 시작 전 기록(profile-before.json)이 없다. 1279 상품은 A/S 를 물을 때 주문 전 팔로워 수를 요구한다
//
// 끝났다는 것은 state.json 의 done 이 true 이고 orders 수가 runs 와 같다는 뜻이다.
// 서버에서 팔로워가 다 들어왔는지는 여기서 안 본다(돈 안 드는 API 라도 네트워크를 탄다). status --api 로 본다.

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
      .filter((b) => b && b.kind === "follower")
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
  : [];

const 실패 = [];
if (!batches.length) 실패.push("팔로워 묶음이 하나도 없다. snsfollow-drip.mjs start 를 먼저 돌린다");

const target = wantId ? batches.find((b) => b.id === wantId) : batches.at(-1);
if (wantId && !target) 실패.push(`태스크가 가리키는 팔로워 묶음 ${wantId} 가 없다`);

if (target) {
  const pct = Math.round((target.orders.length / target.runs) * 100);
  if (target.done && target.orders.length >= target.runs) {
    console.log(`묶음 ${target.id} 완료. @${target.link} 에 ${target.orders.length}/${target.runs} 주문, ${target.orders.length * target.qty}명`);
  } else {
    실패.push(
      `묶음 ${target.id} 가 아직 ${target.orders.length}/${target.runs} (${pct}%) 다. ` +
        (target.paused ? `멈춘 이유: ${target.paused}. resume 으로 이어 간다` : target.stopped ? "stop 으로 멈췄다" : "끝날 때까지 기다렸다가 다시 done 을 친다")
    );
  }
  const before = readJSON(path.join(WORK, target.id, "profile-before.json"));
  if (!before) 실패.push(`묶음 ${target.id} 에 profile-before.json 이 없다. snsview-drip.mjs 로 바로 넣지 말고 snsfollow-drip.mjs start 로 넣는다`);
  else if (!before.ok) console.log(`참고: 시작 전 프로필을 못 읽었다 (${before.reason}). 서버 기록 start_count 로 대신한다 (status --api)`);
}

if (실패.length) {
  for (const f of 실패) console.error("실패: " + f);
  process.exit(1);
}
console.log("snsfollow-drip checks: ok");
