#!/usr/bin/env node
// 새 팩을 이긴 카드 옆에 세워 놓고 **팩마다 한 줄씩 답하게** 만든다.
//
//   node compare-with-winners.mjs --out <OPS>/work/<taskId>/견주기.md    빈 표를 만든다
//   node compare-with-winners.mjs --check <OPS>/work/<taskId>/견주기.md  다 채웠는지 본다
//
// 왜 필요한가. P2.5 로 카드를 읽게 해도 그건 글로 쓴 지시라, 대충 훑고 넘어가도
// 아무것도 실패하지 않는다. 260825 에 정확히 그렇게 됐다. 공략점 요약을 읽고
// "다 맞췄다" 고 판단했는데 행이 전부 뻔했고 22장이 통째로 반려됐다.
//
// 그래서 판정을 문장에서 **빈칸**으로 바꾼다. 팩마다 이 두 개를 적어야 한다.
//
//   뜻밖인 행   이 팩에서 시청자가 몰랐을 행 하나를 그대로 옮겨 적는다
//   견줄 카드   이긴 카드 몇 번 옆에 세웠는지
//
// **뜻밖인 행을 못 적으면 그 팩은 버린다.** 260825 의 두통 팩(물 마셔라, 어깨 풀어라,
// 눈 감아라, 끼니 챙겨라)은 네 줄 중 어느 것도 여기 적을 수 없었다. 그게 판정이다.
//
// 이 검사는 **적었는지만** 본다. 적은 것이 진짜 뜻밖인지는 사람이 통독해서 본다.
// 그래도 빈칸을 마주하면 대충 넘어가기가 훨씬 어려워진다.

import fs from "node:fs";
import path from "node:path";

const HERE = import.meta.dirname;
const REF = path.join(HERE, "..", "references");
const N8N = "C:/dev/n8n-youtube-shorts-automation";
const CHANNELS = ["하루건강약사", "건강장수비결"];

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};

const PLACEHOLDER = /^\s*(|-|—|\?+|없음|미정|TODO|todo|해당\s*없음)\s*$/;

function queuedPacks() {
  const out = [];
  for (const ch of CHANNELS) {
    const dir = path.join(N8N, "research", "queue", ch);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".json"))) {
      try {
        const doc = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        const p = doc.final_pack || doc;
        out.push({ ch, file: f, title: p.hook_title || doc.title, rows: p.rank_items || [] });
      } catch {}
    }
  }
  return out;
}

function winners() {
  const f = path.join(REF, "수집목록.json");
  if (!fs.existsSync(f)) return [];
  try {
    return (JSON.parse(fs.readFileSync(f, "utf8")).picked || []).filter((r) => r.band === "이긴");
  } catch {
    return [];
  }
}

// ---------- 빈 표를 만든다 ----------
function build(outPath) {
  const packs = queuedPacks();
  if (!packs.length) {
    console.error("큐에 팩이 없다. 팩을 먼저 넣고 돌려라.");
    return 1;
  }
  const win = winners();
  if (!win.length) {
    console.error("references/수집목록.json 이 없다. collect-winning-cards.mjs 를 먼저 돌려라.");
    return 1;
  }

  const L = [];
  L.push("# 이긴 카드와 견주기");
  L.push("");
  L.push("**팩마다 두 칸을 채운다. 뜻밖인 행을 못 적으면 그 팩을 버린다.**");
  L.push("적을 것이 없다는 뜻은 그 팩이 아무것도 안 알려준다는 뜻이다.");
  L.push("");
  L.push("옆에 세울 카드 (그림은 `references/이긴카드/`)");
  L.push("");
  for (const w of win.slice(0, 5)) {
    L.push(`- **이긴${w.rank}** 팔로우 ${w.follows.toLocaleString("ko-KR")}, \`${w.file}\` ${w.title}`);
  }
  L.push("");
  L.push("---");
  L.push("");
  L.push("| 팩 | 뜻밖인 행 (그대로 옮겨 적는다) | 견줄 카드 |");
  L.push("| --- | --- | --- |");
  for (const p of packs) L.push(`| ${p.ch} ${p.file} | | |`);
  L.push("");
  L.push("## 버린 팩과 이유");
  L.push("");
  L.push("(뜻밖인 행을 못 적어서 버린 팩을 여기 적는다. 없으면 `없음` 한 줄.)");
  L.push("");

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, L.join("\n"), "utf8");
  console.log(`빈 표를 썼다: ${outPath}`);
  console.log(`팩 ${packs.length}개. 카드 그림을 열어 놓고 두 칸을 채워라.`);
  console.log("다 채우면: node compare-with-winners.mjs --check <그 파일>");
  return 0;
}

// ---------- 다 채웠는지 본다 ----------
function check(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`${filePath} 가 없다. --out 으로 먼저 만들어라.`);
    return 1;
  }
  const text = fs.readFileSync(filePath, "utf8");
  const packs = queuedPacks();

  const filled = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 3) continue;
    if (/^-+$/.test(cells[0]) || cells[0] === "팩") continue;
    filled.set(cells[0], { surprise: cells[1], against: cells[2] });
  }

  const bad = [];
  for (const p of packs) {
    const key = `${p.ch} ${p.file}`;
    const row = filled.get(key);
    if (!row) {
      bad.push(`${key}: 표에 줄이 없다`);
      continue;
    }
    if (PLACEHOLDER.test(row.surprise)) bad.push(`${key}: 뜻밖인 행이 비어 있다`);
    else if (row.surprise.length < 10) bad.push(`${key}: 뜻밖인 행이 너무 짧다 ("${row.surprise}")`);
    if (PLACEHOLDER.test(row.against)) bad.push(`${key}: 견줄 카드가 비어 있다`);
  }

  console.log(`큐의 팩 ${packs.length}개, 표에 채워진 줄 ${filled.size}개`);
  if (bad.length) {
    console.log("");
    for (const b of bad) console.log("  막힘 " + b);
    console.log("");
    console.log("**뜻밖인 행을 못 적는 팩은 버려라.** 빈칸을 채우려고 아무 행이나 옮겨 적지 마라.");
    console.log("버렸으면 큐에서 파일을 빼고 이 검사를 다시 돌려라.");
    return 1;
  }
  console.log("팩마다 뜻밖인 행과 견줄 카드가 적혀 있다.");
  console.log("이 검사는 적었는지만 본다. 진짜 뜻밖인지는 사람이 통독해서 본다.");
  return 0;
}

const outPath = opt("out");
const checkPath = opt("check");
if (outPath) process.exitCode = build(path.resolve(outPath));
else if (checkPath) process.exitCode = check(path.resolve(checkPath));
else {
  console.log("쓰는 법:");
  console.log("  node compare-with-winners.mjs --out <OPS>/work/<taskId>/견주기.md");
  console.log("  node compare-with-winners.mjs --check <OPS>/work/<taskId>/견주기.md");
  process.exitCode = 1;
}
