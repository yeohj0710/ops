#!/usr/bin/env node
// 인플루언서 시딩 영상 한 편에 넣을 조회수, 좋아요 주문을 새 기준(261001)으로 뽑는다. 기본은 계획만 적고 돈은 안 쓴다.
//
//   node seed-plan.mjs --link <주소> --median <평소 조회수 중앙값> --views <지금 조회수>
//                      --like-rate <평소 좋아요율, 0.012 꼴> --likes <지금 좋아요>     계획만
//   ... --go                                                                          snsview-drip.mjs start 로 실제 주문
//
// 왜 바꿨나 (261001). 260929~30 에 "채널 중앙값 × 2 + 1" 목표와 "지금 조회수 위에 중앙값만큼 더" 를 같이 써서
// 작은 계정 게시물이 평소의 6~13배까지 갔다(m_beauty_review, misadongdong, enna.diary, ginalintw).
// 좋아요는 모든 계정에 같은 비율(인스타 1.5%, 틱톡 3%)을 같은 크기로 같은 간격에 넣어 일정하게 보였다.
//
// 새 기준
//   조회수: 최종 조회수 = 평소 중앙값 × 배율. 배율은 저조 0.6~0.85(20%), 보통 1.15~1.45(40%), 잘 됨 1.45~1.8(28%), 조금 터짐 1.8~2.2(12%).
//           주문량 = 최종 조회수 − 지금 조회수. 2.2배 위로는 절대 안 간다
//   중앙값 근처 금지 (261007). 옛 배율(보통 0.95~1.3 이 52%)로 넣었더니 국내 판테놀 9명이 거의 다 평소의 1.0배 언저리에 붙었다.
//           자연히 평소만큼 나온 사람(주문 없음)까지 1.0배에 겹쳐 표가 중앙값과 똑같아 보였다. 그래서
//           1) 배율에서 0.85~1.15 를 뺐다. 2) 지금 이미 평소의 0.85배를 넘었으면 저조는 고르지 않고, 최종을 지금의 1.15배 이상으로 잡는다.
//           3) 비용 상한으로 잘린 최종이 0.85~1.15 에 떨어지면 0.7~0.85 로 낮추고, 그것도 지금보다 낮으면 안 넣는다
//   좋아요: 최종 좋아요 = 최종 조회수 × 그 계정 평소 좋아요율 × 0.75~1.25. 주문량 = 최종 좋아요 − 지금 좋아요.
//           좋아요를 숨긴 게시물(--likes-hidden)과 최소 수량이 안 되는 몫은 안 넣는다
//   크기와 간격: 상품 최소 단위로만 넣는다(조회수 100회, 인스타 좋아요 10개, 틱톡 좋아요 50개). 간격 ±50%.
//           전체 기간은 편마다 36~60시간에서 뽑는다(261007 사용자 지시 "최소 주문 단위로 넓게 텀을 둬서". 옛 기준은 수량 ±40%, 8~20시간)
//
// 옵션
//   --median N        그 채널 평소 조회수 중앙값 (대상, 고정 게시물 뺀 최근 12개. 틱톡은 최근 15개)
//   --views N         지금 조회수. 다른 쪽이 넣고 있는 주문이 있으면 그 남은 몫도 더해서 준다
//   --like-rate R     그 계정 최근 게시물의 (좋아요 ÷ 조회수) 중앙값. 0.012 처럼 소수로
//   --likes N         지금 좋아요
//   --likes-hidden    좋아요 수를 숨긴 게시물. 좋아요 주문을 안 넣는다
//   --no-likes        좋아요는 넣지 않는다
//   --no-views        조회수는 넣지 않는다 (이미 조회수 묶음이 도는 게시물에 좋아요만 맞출 때. --views 에 그 묶음이 끝난 뒤 조회수를 준다)
//   --max-won N       조회수 주문 비용 상한(원). 넘으면 N × 0.8~1.1 안에서 무작위로 잘라 최종 조회수를 낮춘다(261002).
//                     평소 중앙값이 큰 계정(10만 안팎)은 그대로 채우면 한 편에 ₩5,000~10,000 이 들어서 넣었다
//   --go              계획대로 실제 주문을 건다 (snsview-drip.mjs start --force)

import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRIP = path.join(HERE, "snsview-drip.mjs");
const argv = process.argv.slice(2);
const has = (k) => argv.includes(`--${k}`);
const flag = (k, d = null) => {
  const i = argv.indexOf(`--${k}`);
  return i > -1 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const fail = (m) => {
  console.error(m);
  process.exit(2);
};
const num = (n) => Math.round(n).toLocaleString("ko-KR");
const rnd = (lo, hi) => lo + Math.random() * (hi - lo);

const link = flag("link");
if (!link) fail("--link 에 게시물 주소를 준다");
const tiktok = /tiktok\.com/.test(link);
if (!tiktok && !/instagram\.com/.test(link)) fail("인스타 릴스나 틱톡 영상 주소만 받는다. 샤오홍슈, 스레드, 페이스북은 상품이 없다");
const median = Number(flag("median"));
const views = Number(flag("views"));
if (!(median > 0)) fail("--median 에 평소 조회수 중앙값을 준다");
if (!(views >= 0)) fail("--views 에 지금 조회수를 준다");
const noLikes = has("no-likes") || has("likes-hidden");
const likeRate = Number(flag("like-rate"));
const likes = Number(flag("likes", 0));
if (!noLikes && !(likeRate > 0 && likeRate < 1)) fail("--like-rate 에 그 계정 평소 좋아요율을 0.012 꼴로 준다. 숨긴 게시물이면 --likes-hidden");

// 상품: 인스타 조회수 813(100회 ₩10), 인스타 좋아요 258(외국인, 10개 ₩15), 틱톡 조회수 321(100회 ₩50), 틱톡 좋아요 322(50개 ₩150)
const SVC = tiktok
  ? { view: { id: 321, min: 100, max: 1000, won: 0.5 }, like: { id: 322, min: 50, max: 160, won: 3 } }
  : { view: { id: 813, min: 100, max: 5000, won: 0.1 }, like: { id: 258, min: 10, max: 300, won: 1.5 } };

// 0.85~1.15 는 비워 둔다. 중앙값에 붙으면 티가 난다(261007)
const TIERS = [
  { name: "저조", p: 0.2, lo: 0.6, hi: 0.85 },
  { name: "보통", p: 0.4, lo: 1.15, hi: 1.45 },
  { name: "잘 됨", p: 0.28, lo: 1.45, hi: 1.8 },
  { name: "조금 터짐", p: 0.12, lo: 1.8, hi: 2.2 },
];
const NEAR_LO = 0.85;
const NEAR_HI = 1.15;
const MAX_MULT = 2.2;
const maxWon = Number(flag("max-won", 0));
// 이미 평소 근처까지 자연히 온 게시물은 저조를 빼고 뽑는다. 안 그러면 "안 넣음" 으로 1.0배에 그대로 남는다
const already = views >= median * NEAR_LO;
const pool = already ? TIERS.slice(1) : TIERS;
let r = Math.random() * pool.reduce((a, t) => a + t.p, 0);
const tier = pool.find((t) => (r -= t.p) < 0) || pool[0];
const mult = Math.round(rnd(tier.lo, tier.hi) * 100) / 100;
let finalViews = Math.round(median * mult);
let bumpNote = "";
if (already && finalViews < views * NEAR_HI) {
  finalViews = Math.min(Math.round(views * rnd(NEAR_HI, 1.4)), Math.round(median * MAX_MULT));
  bumpNote = `         지금 이미 평소의 ${(views / median).toFixed(2)}배라 지금의 1.15~1.4배로 올림 → 최종 ${num(finalViews)} (평소의 ${(finalViews / median).toFixed(2)}배)`;
}
let capNote = "";
if (maxWon > 0 && (finalViews - views) * SVC.view.won > maxWon) {
  const capWon = Math.round(maxWon * rnd(0.8, 1.1));
  let capped = views + Math.round(capWon / SVC.view.won);
  capNote = `         비용 상한 ₩${num(capWon)} 으로 잘라 최종 ${num(capped)} (평소의 ${(capped / median).toFixed(2)}배)`;
  const ratio = capped / median;
  if (ratio > NEAR_LO && ratio < NEAR_HI) {
    capped = Math.round(median * rnd(0.7, NEAR_LO));
    capNote += `, 중앙값 근처라 ${num(capped)} (${(capped / median).toFixed(2)}배)로 낮춤`;
  }
  finalViews = capped;
}
const ratioNow = views / median;
const nearSkip = finalViews - views < SVC.view.min && ratioNow > NEAR_LO && ratioNow < NEAR_HI;
const spanSec = Math.round(rnd(36, 60) * 3600);

// 총량 total 을 주문 여러 번으로 나눈다. 수량 흔들기의 평균값으로 횟수를 잡아 총량이 위로 쏠리지 않게 한다
// 최소 단위로만 넣는다(261007). 횟수 = 총량 ÷ 최소 수량, 간격 = 전체 기간 ÷ 횟수
function split(total, svc) {
  const qty = svc.min;
  const runs = Math.max(1, Math.round(total / qty));
  return { qty, runs, vary: 0, avg: qty, every: Math.max(300, Math.round(spanSec / Math.max(1, runs - 1 || 1))) };
}

const out = [];
const orders = [];
const viewTotal = finalViews - views;
out.push(`대상     ${link}`);
out.push(`조회수   평소 중앙값 ${num(median)} × ${mult} (${tier.name}) = 최종 ${num(Math.round(median * mult))}, 지금 ${num(views)}`);
if (bumpNote) out.push(bumpNote);
if (capNote) out.push(capNote);
if (nearSkip) out.push(`         경고: 안 넣으면 평소의 ${ratioNow.toFixed(2)}배로 중앙값에 붙어 남는다. 비용 상한을 올려 다시 뽑는다`);
if (has("no-views")) {
  out.push("         조회수는 넣지 않는다 (--no-views). 좋아요는 지금 조회수 기준");
} else if (viewTotal < SVC.view.min) {
  out.push(`         이미 평소 수준이거나 모자란 몫이 ${num(Math.max(0, viewTotal))}회라 조회수는 안 넣는다`);
} else {
  const v = split(viewTotal, SVC.view);
  orders.push({ kind: "조회수", svc: SVC.view, ...v, total: viewTotal });
}
const endViews = has("no-views") ? views : Math.max(views, finalViews);
if (has("likes-hidden")) out.push("좋아요   숨긴 게시물이라 안 넣는다");
else if (has("no-likes")) out.push("좋아요   넣지 않는다 (--no-likes)");
else {
  const lm = Math.round(rnd(0.75, 1.25) * 100) / 100;
  const target = Math.round(endViews * likeRate * lm);
  const likeTotal = target - likes;
  out.push(`좋아요   최종 ${num(endViews)} × 평소 ${(likeRate * 100).toFixed(2)}% × ${lm} = ${num(target)}, 지금 ${num(likes)}`);
  if (likeTotal < SVC.like.min) out.push(`         모자란 몫 ${num(Math.max(0, likeTotal))}개가 최소 ${SVC.like.min}개 밑이라 안 넣는다`);
  else orders.push({ kind: "좋아요", svc: SVC.like, ...split(likeTotal, SVC.like), total: likeTotal });
}
let sum = 0;
for (const o of orders) {
  const cost = o.avg * o.runs * o.svc.won;
  sum += cost;
  out.push(
    `주문     ${o.kind} ${o.svc.id}: ${num(o.qty)}개 × ${o.runs}번 = ${num(o.avg * o.runs)}, ` +
      `${Math.round(o.every / 60)}분 간격 ±50%, 약 ₩${num(cost)} (건당 ₩${num(o.qty * o.svc.won)})`,
  );
}
if (!orders.length) out.push("주문     없음");
else out.push(`합계     약 ₩${num(sum)}, 기간 ${Math.round(spanSec / 3600)}시간 안팎`);
console.log(out.join("\n"));

if (has("go") && orders.length) {
  for (const o of orders) {
    const args = [DRIP, "start", "--force", "--link", link, "--service", String(o.svc.id), "--qty", String(o.qty), "--qty-vary", String(o.vary),
      "--runs", String(o.runs), "--every", `${o.every}s`, "--jitter", "0.5"];
    const res = spawnSync(process.execPath, args, { encoding: "utf8" });
    const lines = (res.stdout + res.stderr).trim().split("\n");
    console.log(`\n[${o.kind}] ` + lines.filter((l) => /^묶음 |첫 주문|걸렸다|모자란다/.test(l)).join("\n"));
  }
}
