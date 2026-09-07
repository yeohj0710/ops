#!/usr/bin/env node

// 프리랜서 급여 알프레드 등록 - 완료 검사
//
// 막는 것은 넷이다.
//   1. 대상.json 이 없다. 명단을 안 만들고 끝낸 것이다
//   2. 대상.json 에 주민등록번호나 계좌번호가 들어 있다. 이 저장소는 공개다
//   3. 지급요청.md 가 없다. 대표가 송금할 수 없는 상태로 끝낸 것이다
//   4. 세전 합계와 세후 합계가 3.3% 관계가 아니다. 두 금액을 바꿔 넣은 것이다
//
// 쓰는 법
//   node manuals/freelancer-payroll/checks.mjs <진행 중인 task JSON 경로>
//   node manuals/freelancer-payroll/checks.mjs --self-test

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.OPS_ROOT || path.resolve(HERE, "..", "..");

// 주민등록번호 여섯자리-일곱자리. 하이픈이 없어도 잡는다.
const 주민 = /\b\d{6}\s*-?\s*[1-8]\d{6}\b/;
// 계좌번호로 보이는 것. 숫자와 하이픈만으로 열자리를 넘는 덩어리.
const 계좌 = /\b\d[\d-]{9,}\d\b/;

export function 개인정보가있나(text) {
  const s = String(text || "");
  if (주민.test(s)) return "주민등록번호";
  if (계좌.test(s)) return "계좌번호";
  return null;
}

// 세전에서 3.3% 를 떼면 세후다. 사람마다 원 단위로 끊으므로 인원수만큼 오차를 허용한다.
export function 세후가맞나(세전, 세후, 인원) {
  const 기대 = 세전 - Math.round(세전 * 0.033);
  return Math.abs(기대 - 세후) <= Math.max(1, Number(인원) || 1);
}

// 검사용 가짜 값이다. 통째로 적어 두면 커밋 검사가 진짜 주민등록번호로 보고 막는다.
// 실제 번호를 여기 붙여넣지 마라. 이 저장소는 공개다.
const 예시주민 = ["000101", "3000000"].join("-");
const 예시계좌 = ["352", "0000", "0000", "00"].join("-");

function selfTest() {
  assert.equal(개인정보가있나("박OO 50000원"), null);
  assert.equal(개인정보가있나(예시주민), "주민등록번호");
  assert.equal(개인정보가있나(예시주민.replace("-", "")), "주민등록번호");
  assert.equal(개인정보가있나(예시계좌), "계좌번호");
  assert.equal(세후가맞나(50000, 48350, 1), true);
  assert.equal(세후가맞나(490000, 473830, 6), true);
  assert.equal(세후가맞나(50000, 50000, 1), false);
  console.log("self-test 통과");
}

if (process.argv.includes("--self-test")) {
  selfTest();
  process.exit(0);
}

function readJSON(f) {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, ""));
  } catch {
    return null;
  }
}

const taskPath = process.argv[2] || process.env.OPS_TASK;
const task = taskPath ? readJSON(taskPath) : null;
const DIR = path.join(ROOT, "work", task?.id || "freelancer-payroll");

const 실패 = [];
const 알림 = [];

const 대상경로 = path.join(DIR, "대상.json");
const raw = fs.existsSync(대상경로) ? fs.readFileSync(대상경로, "utf8") : null;

if (!raw) {
  실패.push(`대상.json 이 없다. ${DIR} 에 이번 달 명단을 남기고 끝낸다`);
} else {
  const 샌것 = 개인정보가있나(raw);
  if (샌것) {
    실패.push(
      `대상.json 에 ${샌것} 가 들어 있다. 이 저장소는 공개다. ` +
        `그 값은 프로젝트 폴더에만 두고 대상.json 에서는 지운다`
    );
  }

  const 대상 = readJSON(대상경로);
  const 줄 = Array.isArray(대상) ? 대상 : (대상?.대상 ?? []);
  if (!줄.length) 실패.push("대상.json 에 사람이 하나도 없다. 정말 0명이면 보고에만 적고 이 파일을 지운다");

  const 세전 = 줄.reduce((a, r) => a + (Number(r.세전금액) || 0), 0);
  const 세후 = Number(대상?.세후합계) || 0;
  if (세전 && 세후 && !세후가맞나(세전, 세후, 줄.length)) {
    실패.push(
      `세전 ${세전.toLocaleString()}원과 세후 ${세후.toLocaleString()}원이 3.3% 관계가 아니다. ` +
        `두 금액을 바꿔 넣지 않았는지 본다`
    );
  }
  if (세전 && !세후) 알림.push("세후합계를 안 적었다. 지급요청문에 넣으려면 필요하다");

  const 뺀사람 = 줄.filter((r) => r.제외사유);
  if (뺀사람.length) 알림.push(`자료가 없어 뺀 사람 ${뺀사람.length}명. 보고에 옮겼는지 본다`);
}

if (!fs.existsSync(path.join(DIR, "지급요청.md"))) {
  실패.push(`지급요청.md 가 없다. 대표가 그대로 송금할 수 있는 초안까지 만들고 끝낸다`);
}

for (const a of 알림) console.log("  참고: " + a);
if (실패.length) {
  console.error("\n완료 검사 실패");
  for (const f of 실패) console.error("  - " + f);
  process.exit(1);
}
console.log("완료 검사 통과");
