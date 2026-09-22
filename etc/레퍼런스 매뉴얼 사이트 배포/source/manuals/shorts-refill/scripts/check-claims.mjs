#!/usr/bin/env node
// 팩의 행 가운데 **틀리면 사람이 다치는 주장**을 골라내, 근거를 적었는지 본다.
//
//   node check-claims.mjs                 대기 중인 팩 전부
//   node check-claims.mjs <파일...>       고른 팩만
//
// 왜 필요한가. 지금 있는 검사는 **모양만** 본다.
//   verify-queued-packs-pass-gate   자수, 문장꼴, 명사화
//   verify-queued-topics-are-fresh  이미 낸 것과 겹치는지
// 둘 다 "이 숫자가 맞나" 는 안 본다. AI 리뷰어가 보긴 하지만 모순 문구를 통과시킨 전례가 있다.
//
// 그래서 결정적으로 막는다. 위험 표지가 붙은 행은 팩의 `notes` 에 근거를 적어야 통과한다.
// 근거는 출처 링크가 아니라 **무엇에 기대어 썼는지 한 마디**다.
// 예: "개봉 후 기한은 약국 표준 안내", "뇌졸중 신호는 교과서 표준", "보온 12시간은 밥솥 설명서".
//
// 등급은 셋이다.
//   A 생활 관찰  틀려도 해가 없다. 검사 안 한다
//   B 표준 안내  제품 설명서나 규정에 있는 수치. 근거 한 마디를 적는다
//   C 몸에 영향  증상, 약, 용량, 응급. 근거를 적고 **교과서 표준만 쓴다**
//
// 통과했다고 사실이라는 뜻이 아니다. **근거 없이 숫자를 지어내는 것**을 막을 뿐이다.

import fs from "node:fs";
import path from "node:path";

const N8N = "C:/dev/n8n-youtube-shorts-automation";
const CHANNELS = ["하루건강약사", "건강장수비결"];

// C 등급. 몸에 직접 영향을 주는 말이다.
const BODY = [
  { re: /(뇌졸중|심근경색|암|중독|실명|마비|골절|쇼크|경련|사망|돌연사)/, why: "중대한 병 이름" },
  { re: /(119|응급실|구급차)/, why: "응급 안내" },
  { re: /(끊으|중단|줄이세요|늘리세요)\s*(세요|시면|면)?/, why: "약을 끊거나 양을 바꾸라는 말" },
  { re: /\d+\s*(mg|밀리그램|g\b|정|알|캡슐|포)/, why: "용량 숫자" },
  { re: /(항생제|혈압약|당뇨약|와파린|아스피린|스테로이드|수면제|진통제)/, why: "약 이름" },
];

// B 등급. 틀리면 손해를 보지만 다치지는 않는 수치다.
const STANDARD = [
  { re: /\d+\s*(시간|분|일|주|달|개월|년)/, why: "기간 숫자" },
  { re: /\d+\s*(도|℃)/, why: "온도 숫자" },
  { re: /\d+\s*(배|퍼센트|%)/, why: "비율 숫자" },
  { re: /\d{2,4}-\d{3,4}-\d{4}/, why: "전화번호" },
  { re: /(공단|보건소|식약처|질병관리청|보험공단|소비자원)/, why: "기관 이름" },
];

// notes 에 이런 말이 있으면 "무엇에 기대어 썼는지" 를 적은 것으로 본다.
const BASIS = /(표준|설명서|교과서|규정|제도|고시|급여기준|안내|지침|매뉴얼|라벨|허가사항|복약지도|약국|제조사|공식|확인함|확인했다|근거)/;

function loadPacks(files) {
  if (files.length) return files.map((f) => ({ file: f, json: JSON.parse(fs.readFileSync(f, "utf8")) }));
  const out = [];
  for (const ch of CHANNELS) {
    const dir = path.join(N8N, `${ch} 소재`);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const p = path.join(dir, f);
      try {
        out.push({ file: p, json: JSON.parse(fs.readFileSync(p, "utf8")) });
      } catch {}
    }
  }
  return out;
}

const packs = loadPacks(process.argv.slice(2));
if (!packs.length) {
  console.log("검사할 팩이 없다.");
  process.exit(0);
}

let flagged = 0;
let blocked = 0;
const report = [];

for (const { file, json } of packs) {
  const pack = json.final_pack || json;
  const notes = String(json.notes || pack.notes || "");
  const hasBasis = BASIS.test(notes);
  const rows = pack.rank_items || [];
  const hits = [];

  for (const item of rows) {
    const text = [item.card_name, item.card_reason, item.name, item.reason].filter(Boolean).join(" ");
    const body = BODY.filter((m) => m.re.test(text)).map((m) => m.why);
    const std = STANDARD.filter((m) => m.re.test(text)).map((m) => m.why);
    if (!body.length && !std.length) continue;
    hits.push({ rank: item.rank, grade: body.length ? "C" : "B", why: [...body, ...std], name: item.card_name });
  }

  if (!hits.length) continue;
  flagged += 1;
  const worst = hits.some((h) => h.grade === "C") ? "C" : "B";
  const ok = hasBasis;
  if (!ok) blocked += 1;

  report.push({ file: path.basename(file), worst, ok, hits, notes: notes.slice(0, 120) });
}

console.log(`팩 ${packs.length}개 가운데 근거가 필요한 것 ${flagged}개, 근거가 없는 것 ${blocked}개\n`);

for (const r of report) {
  console.log(`${r.ok ? "OK  " : "막힘"} [${r.worst}] ${r.file}`);
  for (const h of r.hits) console.log(`       ${h.rank}행 ${h.grade}, ${h.why.join(", ")}, ${h.name}`);
  if (!r.ok) console.log(`       notes 에 무엇에 기대어 썼는지 한 마디를 적어라. 지금: "${r.notes || "(비어 있다)"}"`);
  console.log("");
}

if (blocked) {
  console.log("근거를 적거나, 그 행을 뺀 다음 다시 돌려라.");
  console.log("**확인이 안 되면 숫자를 지어내지 말고 그 행을 버린다.** 항목이 모자라면 주제를 바꾼다.");
  process.exit(1);
}
console.log("근거가 필요한 행에 전부 근거가 적혀 있다.");
console.log("이 검사는 근거를 적었는지만 본다. 내용이 맞는지는 사람이 통독해서 본다.");
