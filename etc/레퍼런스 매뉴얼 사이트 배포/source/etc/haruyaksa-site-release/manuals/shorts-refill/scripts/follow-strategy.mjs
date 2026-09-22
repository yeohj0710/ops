#!/usr/bin/env node
// 팔로우 유입 기준으로 "무엇을 써야 하나" 를 뽑는다.
//
//   node follow-strategy.mjs [--account haruyaksa] [--json <내려받은 파일>] [--out 전략.md]
//
// **목표는 팔로우 전환율이 아니라 팔로우 수다.** 전환율이 낮아도 조회수가 크면 그만이다.
//
//   팔로우 수 = 조회수 × 전환율
//
// 누적 관측값은 게시 후 경과 시간이 다르다. 상관과 중앙값 비교를 인과나 손실로 해석하지 않는다.
// 0명도 포함하며, 같은 릴스는 최신 관측 한 건만 남긴다.
//
// 자료는 릴스 인사이트 랩이 화면 녹화를 OCR 로 데이터화해 둔 것이다.
// 로그인이 필요 없어서 L1 으로 그냥 받는다. 화면을 긁을 일이 없다.
//
// **다른 계정과 견주지 마라.** 같은 자료에 제이약사, 제씨약사, 김제조, 오약이 같이 들어 있지만
// 그 넷은 얼굴과 자격이 있는 실제 약사고 하루건강약사는 AI 크리에이터다.
// 그쪽 상위 편은 "이 약사가 실제로 쓰는 약", "내돈내산" 처럼 **사람이 있어야 성립하는 것**이다.
// 옮겨 오면 못 지킬 약속을 하게 된다. 전략은 이 계정 안에서만 세운다.
// 계정 표가 필요하면 `--compare-accounts` 를 붙인다. 기본은 안 나온다.
//
// 이 스크립트는 **짧은 한 장**을 쓴다. 세션이 1.5MB JSON 을 읽게 하지 않는다.

import fs from "node:fs";
import path from "node:path";
import { collapse } from "./follow-metrics.mjs";

const SOURCE = "https://reels-insight-lab.vercel.app/data/dashboard.json";
const N8N = "C:/dev/n8n-youtube-shorts-automation";
const CHANNELS = ["하루건강약사", "건강장수비결"];

const argv = process.argv.slice(2);
const arg = (name, def = null) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const ACCOUNT = arg("account", "haruyaksa");
const OUT = arg("out");

// ---------- 자료 ----------
const localJson = arg("json");
const raw = localJson
  ? JSON.parse(fs.readFileSync(localJson, "utf8"))
  : await (await fetch(SOURCE)).json();

const all = collapse(raw.records || []);
const mine = all.filter((r) => r.account === ACCOUNT);
if (!mine.length) {
  console.error(`${ACCOUNT} 자료가 없다. 계정 이름을 확인해라.`);
  process.exit(1);
}

const rate = (r) => (r.follows / r.views) * 100;
const sum = (v, k) => v.reduce((s, r) => s + (r[k] || 0), 0);
const pooled = (v) => (sum(v, "follows") / sum(v, "views")) * 100;
const median = (v) => {
  const s = v.map(rate).sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
};

// ---------- 본편인지 가르기 ----------
// 본편 회로가 쓴 팩은 `<채널> 소재/사용완료` 에 원문이 남는다. 제목이 조금 바뀌어 올라가므로
// 두 글자 조각 겹침으로 견준다. 레퍼런스 카드와 옛 편은 여기 없다.
const published = [];
for (const ch of CHANNELS) {
  const dir = path.join(N8N, `${ch} 소재`, "사용완료");
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const o = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      const s = o.selected || o;
      const t = (s.final_pack || o.final_pack || {}).hook_title || s.title;
      if (t) published.push(t);
    } catch {}
  }
}
const bigrams = (s) => new Set(String(s || "").replace(/[^가-힣0-9]/g, "").match(/[가-힣]{2}/g) || []);
const overlap = (a, b) => {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let c = 0;
  for (const x of A) if (B.has(x)) c += 1;
  return c / Math.min(A.size, B.size);
};
const isMainline = (r) => published.some((t) => overlap(r.title, t) >= 0.5);

// ---------- 리포트 ----------
const L = [];
const say = (s = "") => L.push(s);
const pct = (n) => n.toFixed(3) + "%";
const kn = (n) => n.toLocaleString("ko-KR");

const stamp = new Date().toISOString().slice(0, 10);
say(`# 팔로우 유입 분석 (${ACCOUNT})`);
say("");
say(`자료: [릴스 인사이트 랩 데이터](${SOURCE})`);
say(`뽑은 날 ${stamp}, 편 수 ${mine.length}, 총 조회 ${kn(sum(mine, "views"))}, 총 팔로우 ${kn(sum(mine, "follows"))}`);
say("");
say("목표는 릴스별 팔로우 유입 수다. 조회수와 전환율은 결과를 설명하는 보조 지표로 본다.");
say(`팔로우 0명 ${mine.filter(r => r.follows === 0).length}편을 포함했다. 같은 릴스는 최신 관측을 사용하며 합산하지 않았다.`);
say("누적 수치의 관측일과 게시 후 경과 시간이 다르다. 릴스 귀속 팔로우 합계는 현재 팔로워 수나 순증가가 아니다.");
say("");

// 계정 비교는 기본으로 안 낸다. 아래 이유를 보라.
if (argv.includes("--compare-accounts")) {
  say("## 계정끼리 견주기 (참고만)");
  say("");
  say("**이 표로 전략을 세우지 마라.** 다른 계정은 얼굴과 자격이 있는 실제 약사고");
  say("이 계정은 AI 크리에이터다. 그쪽 상위 편은 사람이 있어야 성립하는 소재라 옮길 수 없다.");
  say("");
  say("| 계정 | 편 | 총 조회 | 총 팔로우 | 전환 |");
  say("| --- | --- | --- | --- | --- |");
  const accounts = [...new Set(all.map((r) => r.account))]
    .map((a) => ({ a, v: all.filter((r) => r.account === a) }))
    .sort((x, y) => pooled(y.v) - pooled(x.v));
  for (const { a, v } of accounts) {
    const mark = a === ACCOUNT ? " **(이 계정)**" : "";
    say(`| ${a}${mark} | ${v.length} | ${kn(sum(v, "views"))} | ${kn(sum(v, "follows"))} | ${pct(pooled(v))} |`);
  }
  say("");
} else {
  say("다른 계정과 견주지 않는다. 그쪽은 실제 약사고 이 계정은 AI 크리에이터라 소재가 옮겨지지 않는다.");
  say("전환율 절대값도 계정 성격에 따라 달라지므로, **이 계정 안에서의 순위만** 쓴다.");
  say("");
}

// 목표는 팔로우 수다. 그래서 줄 세우기도 수로 한다.
const byFollows = [...mine].sort((a, b) => b.follows - a.follows);
const rates = mine.map(rate).sort((a, b) => a - b);
const midRate = rates[Math.floor(rates.length / 2)];

// 조회수와 전환율 가운데 무엇이 팔로우 수를 흔들었는지. 로그로 봐야 배수가 보인다.
const ln = Math.log;
const sd = (arr) => {
  const mu = arr.reduce((s, x) => s + x, 0) / arr.length;
  return Math.sqrt(arr.reduce((s, x) => s + (x - mu) ** 2, 0) / arr.length);
};
const corr = (a, b) => {
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let sa = 0, sb = 0, sab = 0;
  for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; sa += da * da; sb += db * db; sab += da * db; }
  return sab / Math.sqrt(sa * sb);
};
const positive = mine.filter(r => r.follows > 0);
const lf = positive.map((r) => ln(r.follows));
const lv = positive.map((r) => ln(r.views));
const lr = positive.map((r) => ln(r.follows / r.views));
const totalF = sum(mine, "follows");
const top10F = byFollows.slice(0, 10).reduce((s, r) => s + r.follows, 0);

say("## 조회수·전환율과 팔로우 수의 상관");
say("");
say("큰 수치의 영향을 줄이려고 조회수와 전환율을 로그로 바꿔 비교했다. 표준편차는 수치의 흩어진 정도, 상관은 함께 늘고 줄어드는 정도다.");
say("");
say("| 견줄 것 | 로그 표준편차 | 팔로우 수와 상관 |");
say("| --- | --- | --- |");
say(`| 조회수 | ${sd(lv).toFixed(2)} | ${corr(lf, lv).toFixed(2)} |`);
say(`| 전환율 | ${sd(lr).toFixed(2)} | ${corr(lf, lr).toFixed(2)} |`);
say("");
say(`로그 통계는 팔로우가 양수인 ${positive.length}편만 계산했다. 전체 순위와 합계에는 0명도 포함했다.`);
say(`조회수와 전환율의 로그 상관은 ${corr(lv, lr).toFixed(2)}이다. 이 값만으로 제목이나 소재의 효과를 확정할 수 없다.`);
say(`상위 10편이 전체 팔로우의 ${Math.round((top10F / totalF) * 100)}%를 만들었다(${kn(top10F)}/${kn(totalF)}). 상위 소수 영상에 유입이 집중됐다.`);
say("");

say("## 팔로우를 많이 데려온 편");
say("");
say("| 팔로우 | 조회 | 전환 | 시청 | 회로 | 제목 |");
say("| --- | --- | --- | --- | --- | --- |");
for (const r of byFollows.slice(0, 15)) {
  say(`| ${kn(r.follows)} | ${kn(r.views)} | ${pct(rate(r))} | ${r.watch || "?"}초 | ${isMainline(r) ? "본편" : "그 외"} | ${r.title.slice(0, 36)} |`);
}
say("");

// 조회수는 벌어 놓고 전환에서 흘린 편. 중앙 전환율만 됐어도 몇 명 더 벌었는지로 센다.
const spilled = mine
  .map((r) => ({ ...r, lost: Math.round(r.views * midRate / 100) - r.follows }))
  .filter((r) => r.lost > 15)
  .sort((a, b) => b.lost - a.lost);
say("## 중앙 전환율을 적용한 참고 비교");
say("");
say(`각 조회수에 중앙 전환율(${pct(midRate)})을 곱한 단순 비교다. 실제 놓친 팔로우나 달성 가능한 예측치가 아니다.`);
say("");
say("| 단순 차이 | 실제 팔로우 | 조회 | 전환 | 제목 |");
say("| --- | --- | --- | --- | --- |");
for (const r of spilled.slice(0, 10)) {
  say(`| ${kn(r.lost)} | ${kn(r.follows)} | ${kn(r.views)} | ${pct(rate(r))} | ${r.title.slice(0, 36)} |`);
}
say("");

say("## 관측된 팔로우 유입 하위 편");
say("");
say("| 팔로우 | 조회 | 전환 | 시청 | 제목 |");
say("| --- | --- | --- | --- | --- |");
for (const r of byFollows.slice(-10)) {
  say(`| ${kn(r.follows)} | ${kn(r.views)} | ${pct(rate(r))} | ${r.watch || "?"}초 | ${r.title.slice(0, 36)} |`);
}
say("");

// 회로별
const bon = mine.filter(isMainline);
const etc = mine.filter((r) => !isMainline(r));
say("## 회로별 참고 비교");
say("제목 유사도로 추정한 구분이라 오분류할 수 있다. 실제 제작 로그를 대신하지 않는다.");
say("");
say("| 회로 | 편 | 합산 전환 | 중앙 전환 |");
say("| --- | --- | --- | --- |");
if (bon.length) say(`| 본편 제목 추정 | ${bon.length} | ${pct(pooled(bon))} | ${pct(median(bon))} |`);
if (etc.length) say(`| 레퍼런스와 옛 편 | ${etc.length} | ${pct(pooled(etc))} | ${pct(median(etc))} |`);
say("");

// 항목 수. 제목 끝 숫자로 센다.
const bucket = (r) => {
  const m = r.title.match(/(\d+)\s*(가지)?\s*$/);
  if (!m) return "숫자 없음";
  const n = Number(m[1]);
  return n <= 4 ? "4개 이하" : n === 5 ? "5개" : "6개 이상";
};
const groups = {};
for (const r of mine) (groups[bucket(r)] = groups[bucket(r)] || []).push(r);
say("## 항목 수별");
say("");
say("| 항목 수 | 편 | 합산 전환 | 중앙 전환 |");
say("| --- | --- | --- | --- |");
for (const k of ["4개 이하", "5개", "6개 이상", "숫자 없음"]) {
  const v = groups[k];
  if (v?.length) say(`| ${k} | ${v.length} | ${pct(pooled(v))} | ${pct(median(v))} |`);
}
say("");
say("항목 수와 회로는 서로 얽혀 있다. 6개 이상은 대부분 레퍼런스 카드다.");
say("**항목을 늘리면 오른다고 단정하지 마라.** 본편 카드는 세로 공간 때문에 4개로 정한 것이고,");
say("늘리려면 레이아웃을 먼저 고쳐야 한다. 그건 사람이 정할 일이다.");
say("");

say("---");
say("");
say("이 파일은 `follow-strategy.mjs` 가 다시 쓴다. 손으로 고치면 다음 실행에 지워진다.");
say("읽고 나서 정한 것은 `MANUAL.md` 의 `공략점` 절에 적는다.");

const text = L.join("\n") + "\n";
if (OUT) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, text, "utf8");
  console.log(`썼다: ${OUT} (${mine.length}편)`);
} else {
  process.stdout.write(text);
}
