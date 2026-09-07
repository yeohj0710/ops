#!/usr/bin/env node
// n8n 회로가 실제로 쓰는 키로 KIE 잔액을 잰다.
//
//   node kie-balance.mjs
//
// 왜 이게 있나. kie.ai/billing 화면은 "지금 크롬에 로그인된 계정" 의 잔액이다.
// n8n 이 쓰는 키가 다른 계정이면 화면은 0 인데 회로는 멀쩡히 돈다.
// 260829 와 260830 두 번 연속 이걸로 P2 를 건너뛰었다. 화면 말고 이 명령으로 판정한다.
//
// 키는 화면에 찍지 않는다. n8n 자격증명에서 꺼내 호출에만 쓴다.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const OPS = "C:/dev/ops";
const MACHINE = JSON.parse(fs.readFileSync(path.join(OPS, "machine.json"), "utf8"));
const DEV = MACHINE.dev_root.replace(/\//g, path.sep);
const AUTOMATION = path.join(DEV, "n8n-youtube-shorts-automation");

// sqlite3 와 crypto-js 는 n8n 프로젝트 쪽 node_modules 에만 있다.
const req = createRequire(path.join(AUTOMATION, "package.json"));

const CONFIG = path.join(AUTOMATION, ".n8n", "config");
const DB = path.join(AUTOMATION, ".n8n", "database.sqlite");

// 회로 한 번이 쓰는 크레딧. kie.ai/logs 실측(260829, 260830).
const COST = { image: 6, bgm: 12 };
const PER_RUN = COST.image + COST.bgm;
const CHANNELS = 2;

const fail = (msg) => {
  console.log(`잔액 확인 실패: ${msg}`);
  console.log("화면으로 대신 판정하지 마라. kie.ai/billing 은 다른 계정일 수 있다.");
  process.exit(2);
};

if (!fs.existsSync(CONFIG)) fail(`n8n config 없음: ${CONFIG}`);
if (!fs.existsSync(DB)) fail(`n8n DB 없음: ${DB}`);

const encryptionKey = JSON.parse(fs.readFileSync(CONFIG, "utf8")).encryptionKey;
if (!encryptionKey) fail("config 에 encryptionKey 가 없다");

const sqlite3 = req("sqlite3");
const CryptoJS = req("crypto-js");

const rows = await new Promise((resolve, reject) => {
  const db = new sqlite3.Database(DB, sqlite3.OPEN_READONLY);
  db.all(
    "select id, name, type, data from credentials_entity where type = 'httpHeaderAuth'",
    [],
    (err, r) => (err ? reject(err) : resolve(r || [])),
  );
});

let auth = null;
for (const row of rows) {
  try {
    const j = JSON.parse(CryptoJS.AES.decrypt(row.data, encryptionKey).toString(CryptoJS.enc.Utf8));
    if (String(j.name).toLowerCase() === "authorization" && String(j.value || "").startsWith("Bearer ")) {
      auth = j.value;
      break;
    }
  } catch {
    // 다른 키로 암호화된 항목은 건너뛴다
  }
}
if (!auth) fail("httpHeaderAuth 자격증명에서 Authorization 헤더를 못 찾았다");

let data;
try {
  const res = await fetch("https://api.kie.ai/api/v1/chat/credit", {
    headers: { Authorization: auth },
    signal: AbortSignal.timeout(20000),
  });
  data = await res.json();
} catch (e) {
  fail(`API 호출 실패: ${e.message}`);
}

if (data?.code !== 200 || typeof data.data !== "number") {
  fail(`예상 못 한 응답: ${JSON.stringify(data).slice(0, 200)}`);
}

const credits = data.data;
const need = PER_RUN * CHANNELS;
const runsLeft = Math.floor(credits / PER_RUN);

console.log("KIE 잔액 (n8n 이 쓰는 키 기준)");
console.log(`  잔액        ${credits} 크레딧`);
console.log(`  회로 1회    ${PER_RUN} 크레딧 (이미지 ${COST.image} + BGM ${COST.bgm})`);
console.log(`  두 채널     ${need} 크레딧 → 남는 값 ${Math.round((credits - need) * 10) / 10}`);
console.log(`  남은 회차   ${runsLeft} 회 (한 채널 기준)`);
console.log("");
console.log(credits >= need ? "PASS — 두 채널 P2 실행 가능" : `BLOCK — ${need - credits} 크레딧 모자란다. 충전은 사람이 한다`);
process.exit(credits >= need ? 0 : 1);
