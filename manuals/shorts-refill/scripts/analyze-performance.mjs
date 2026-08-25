#!/usr/bin/env node
// 재고와 큐 위생을 본다. 어느 영역이 비었고, 큐에 발행분이 남았는지.
//
//   node analyze-performance.mjs --stock-only        평소에는 이것만 쓴다
//   node analyze-performance.mjs <실측.tsv>          재생수를 참고로 같이 볼 때
//
// **무엇을 쓸지는 여기서 정하지 않는다.** 그건 `follow-strategy.mjs` 가 팔로우 기준으로 낸다.
// 재생수와 팔로우는 260825 실측에서 정반대로 나왔다. 재생수 절은 참고용이다.
//
// 인스타 계정 @haruyaksa 하나에 두 채널 영상이 다 올라간다. 그래서 아카이브도
// 양쪽을 다 읽는다. 유튜브 조회수와 인스타 재생수는 절대값 비교를 하지 않는다
// (재생수는 반복 재생을 센다). 순위만 쓴다.

import fs from "node:fs";
import path from "node:path";

const ROOT = "C:/dev/n8n-youtube-shorts-automation";
const CHANNELS = ["하루건강약사", "건강장수비결"];

// 게시 뒤 며칠은 계속 오른다. 이보다 어린 편은 "죽었다" 고 판정하지 않는다.
const SETTLE_DAYS = 4;

// 전략은 `follow-strategy.mjs` 가 팔로우 기준으로 낸다. 여기는 재고와 큐 위생을 본다.
// 재생수 TSV 를 넘기면 참고로 같이 보여 주지만, **판정을 재생수로 하지 마라.**
// 260825 에 두 축이 정반대로 나왔다. 안약 편은 재생수 2위, 팔로우 전환은 밑에서 3등이었다.
const STOCK_ONLY = process.argv.includes("--stock-only");
const tsvPath = STOCK_ONLY ? null : process.argv[2];
if (!tsvPath && !STOCK_ONLY) {
  console.error("실측 TSV 경로를 넘기거나 --stock-only 를 붙여라.");
  console.error("  node analyze-performance.mjs --stock-only");
  console.error("  node analyze-performance.mjs work/<taskId>/insta-plays.tsv");
  process.exit(1);
}

// ---------- 실측 읽기 ----------
const reels = !tsvPath ? [] : fs.readFileSync(tsvPath, "utf8").split(/\r?\n/)
  .map((line) => line.trim()).filter(Boolean)
  .filter((line) => !line.startsWith("#"))
  .map((line) => {
    const [date, plays, likes, code, ...rest] = line.split("\t");
    return { date, plays: Number(plays), likes: Number(likes), code, caption: rest.join(" ").trim() };
  })
  .filter((r) => Number.isFinite(r.plays));

if (!reels.length && !STOCK_ONLY) { console.error(`${tsvPath} 에 읽을 줄이 없다.`); process.exit(1); }

const today = reels.length
  ? reels.reduce((max, r) => (r.date > max ? r.date : max), reels[0].date)
  : new Date().toISOString().slice(0, 10);
const ageDays = (d) => Math.round((Date.parse(today) - Date.parse(d)) / 86400000);

// ---------- 아카이브 읽기 ----------
// 발행된 팩의 원문은 '<채널> 소재/사용완료' 에 남는다. 파일 모양이 두 가지다.
// 회로가 떨군 것은 {selected:{...}} 로 한 겹 싸여 있고, 손으로 넣은 것은 팩이 통째로 있다.
function readPack(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    const s = j.selected || j;
    const pack = s.final_pack || j.final_pack || {};
    const title = pack.hook_title || s.title || j.title;
    if (!title) return null;
    return {
      title,
      lane: s.lane || j.lane || "(없음)",
      pillar: pack.channel_content_pillar || "(없음)",
      topicKey: pack.topic_key || s.topic_key || j.topic_key || "",
      rows: (pack.rank_items || []).map((it) => it.card_name).filter(Boolean),
      subtitle: pack.subtitle || "",
    };
  } catch { return null; }
}

const published = [];
const stock = [];
const queued = [];
for (const ch of CHANNELS) {
  const usedDir = path.join(ROOT, `${ch} 소재`, "사용완료");
  if (fs.existsSync(usedDir)) {
    for (const f of fs.readdirSync(usedDir)) {
      if (!f.endsWith(".json")) continue;
      const p = readPack(path.join(usedDir, f));
      // 파일명 앞의 ISO 시각이 그 편을 실제로 쓴 시점이다.
      const stamp = (f.match(/^(\d{4}-\d{2}-\d{2})T/) || [])[1] || null;
      if (p) published.push({ ...p, channel: ch, date: stamp });
    }
  }
  // 재고는 `<채널> 소재` 폴더가 원장이다. 회로가 읽는 곳이 거기다.
  // research/queue 는 사본이라 여기서 세면 안 된다. 발행하고 안 지운 팩이 남아 있어서
  // 260825 실측에서 실제 15건이 26건으로 부풀었다.
  const stockDir = path.join(ROOT, `${ch} 소재`);
  if (fs.existsSync(stockDir)) {
    for (const f of fs.readdirSync(stockDir)) {
      if (!f.endsWith(".json")) continue;
      const p = readPack(path.join(stockDir, f));
      if (p) stock.push({ ...p, channel: ch });
    }
  }
  // 사본 쪽에 발행된 팩이 남아 있으면 npm test 의 두 검사가 상시 실패한다.
  const queueDir = path.join(ROOT, "research", "queue", ch);
  if (fs.existsSync(queueDir)) {
    for (const f of fs.readdirSync(queueDir)) {
      if (!f.endsWith(".json")) continue;
      const p = readPack(path.join(queueDir, f));
      if (p) queued.push({ ...p, channel: ch, file: f });
    }
  }
}
const stockUnique = [...new Map(stock.map((s) => [s.topicKey || s.title, s])).values()];
const publishedKeys = new Set(published.map((p) => p.topicKey || p.title).filter(Boolean));
const staleQueue = queued.filter((q) => publishedKeys.has(q.topicKey || q.title));

// ---------- 붙이기 ----------
// 캡션 첫 줄이 제목과 같을 거라 믿으면 안 된다. 인스타에 올릴 때 캡션을 다시 쓰기
// 때문이다. 실측 예: 발행 제목 `혈압약 드시면 꼭 피해야 하는 음식 4` → 캡션
// `혈압약 드실 때, 음식도 같이 살펴보셔야 해요`. 앞글자로 붙이면 이런 편이 통째로
// 빠져서 260825 첫 실행에서 58편 중 21편만 붙었다.
//
// 그래서 내용어 겹침으로 붙이고, 게시 날짜가 가까운 쪽을 우선한다.
const STOP = new Set(["그리고", "하지만", "때문", "이것", "그것", "해요", "돼요", "있어요", "없어요", "드세요", "보세요", "하세요", "가지"]);
function words(text) {
  return new Set(String(text || "")
    .replace(/[^가-힣0-9]/g, " ").split(/\s+/)
    .map((w) => w.replace(/(으로|에서|에게|부터|까지|보다|처럼|한테|이나|라도|마다|만큼|은|는|이|가|을|를|의|에|도|만|과|와|로|랑)$/, ""))
    .map((w) => w.replace(/(하지|하면|하고|해서|지면|으면|면서|아서|어서|니까|는데|지만|다면|려면|어요|아요|세요|예요|져요|워요|줘요|와요|나요)$/, ""))
    .filter((w) => w.length >= 2 && !STOP.has(w)));
}
function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

// 제목만 견주면 캡션이 제목을 안 쓰는 편을 놓친다. 부제와 행 이름까지 넣어 견준다.
for (const p of published) p.words = words([p.title, p.subtitle, ...p.rows].join(" "));

// 아카이브 파일명 앞의 ISO 시각이 발행 시점이다. 인스타에는 같은 날이나 다음 날 올라간다.
const MATCH_LIMIT = 0.34;   // verify-queued-topics-are-fresh.mjs 와 같은 기준
// 날짜는 가산점이 아니라 자르는 조건이다. 겹침만 보면 7월 릴스가 8월 팩에 붙는다
// (실측: `아침부터 기운이 잘 안 난다면` 이 53일 뒤 팩에 붙었다). 릴스는 유튜브보다
// 먼저 올라가지 않고, 밀려도 3주 안에는 올라간다.
const EARLIEST = -1;
const LATEST = 21;

for (const r of reels) {
  const cap = words(r.caption);
  let best = null;
  let bestScore = 0;
  for (const p of published) {
    if (!p.date) continue;
    const gap = (Date.parse(r.date) - Date.parse(p.date)) / 86400000;
    if (gap < EARLIEST || gap > LATEST) continue;
    const score = overlap(cap, p.words);
    if (score < MATCH_LIMIT) continue;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  r.pack = best;
  r.matchScore = bestScore;
}

const matched = reels.filter((r) => r.pack);
const settled = reels.filter((r) => ageDays(r.date) >= SETTLE_DAYS);
const sorted = [...settled].sort((a, b) => b.plays - a.plays);
const cut = (arr, frac) => arr[Math.max(0, Math.floor(arr.length * frac) - 1)]?.plays ?? 0;
const topLine = cut(sorted, 0.25);
const bottomLine = sorted[Math.max(0, Math.ceil(sorted.length * 0.75) - 1)]?.plays ?? 0;

const fmt = (n) => n.toLocaleString("ko-KR");
const row = (r) => `${String(fmt(r.plays)).padStart(9)}  ${r.date}(${String(ageDays(r.date)).padStart(2)}일)  ${r.pack ? r.pack.lane : "(레퍼런스/미상)"}\n            ${r.caption}`;

// 재생수 절은 TSV 를 넘겼을 때만 낸다. 판정용이 아니라 참고용이다.
if (!STOCK_ONLY) {
console.log(`# 인스타 @haruyaksa 실측 ${reels.length}편 (기준일 ${today})`);
console.log(`  아카이브에 붙은 것 ${matched.length}편, 안 붙은 것 ${reels.length - matched.length}편(레퍼런스 카드나 옛 편)`);
console.log(`  ${SETTLE_DAYS}일 미만이라 판정 보류 ${reels.length - settled.length}편`);
console.log(`  상위 25% 경계 ${fmt(topLine)}회 / 하위 25% 경계 ${fmt(bottomLine)}회\n`);

console.log(`## 이긴 것 (상위 25%)`);
for (const r of sorted.filter((r) => r.plays >= topLine)) console.log(row(r));

console.log(`\n## 죽은 것 (하위 25%, ${SETTLE_DAYS}일 이상 지난 것만)`);
for (const r of sorted.filter((r) => r.plays <= bottomLine)) console.log(row(r));

console.log(`\n## 아직 판정 못 하는 것 (${SETTLE_DAYS}일 미만)`);
for (const r of reels.filter((r) => ageDays(r.date) < SETTLE_DAYS).sort((a, b) => b.plays - a.plays)) console.log(row(r));
}

// ---------- 영역 쏠림 ----------
function tally(list, key) {
  const c = {};
  for (const x of list) c[x[key]] = (c[x[key]] || 0) + 1;
  return Object.entries(c).sort((a, b) => b[1] - a[1]);
}

// 최근 발행 영역은 아카이브 날짜로 센다. 릴스 실측이 없어도 나와야 하는 값이다.
const recent = [...published].filter((p) => p.date).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 12);
console.log(`\n## 최근 발행 12편의 영역 (여기 있는 영역은 이번 배치에서 피한다)`);
for (const [lane, n] of tally(recent, "lane")) console.log(`  ${String(n).padStart(2)}  ${lane}`);

if (staleQueue.length) {
  console.log(`
## 먼저 치울 것: research/queue 에 발행된 팩이 ${staleQueue.length}건 남아 있다`);
  console.log(`   두면 npm test 의 verify-stockpile-titles-unpublished 가 상시 실패한다. 지우고 시작한다.`);
  for (const q of staleQueue) console.log(`     , research/queue/${q.channel}/${q.file}  (${q.title})`);
}

console.log(`\n## 지금 재고의 영역 (${stockUnique.length}건)`);
for (const [lane, n] of tally(stockUnique, "lane")) console.log(`  ${String(n).padStart(2)}  ${lane}`);
for (const s of stockUnique) console.log(`      - [${s.channel}] ${s.title}`);

// 이긴 편이 어느 영역이었나. 소재를 새로 뽑을 때 여기서 고른다.
const winners = sorted.filter((r) => r.plays >= topLine && r.pack).map((r) => r.pack);
const losers = sorted.filter((r) => r.plays <= bottomLine && r.pack).map((r) => r.pack);
console.log(`\n## 영역별 성적 (이긴 편 / 죽은 편)`);
const lanes = new Set([...winners, ...losers, ...recent].map((p) => p.lane));
for (const lane of lanes) {
  const w = winners.filter((p) => p.lane === lane).length;
  const l = losers.filter((p) => p.lane === lane).length;
  console.log(`  ${String(w).padStart(2)}승 ${String(l).padStart(2)}패  ${lane}`);
}
