#!/usr/bin/env node
// 팔로우를 많이 데려온 편의 **카드 그림**을 받아 온다. 제목이 아니라 행을 보려는 것이다.
//
//   node collect-winning-cards.mjs               팔로우 상위 12편
//   node collect-winning-cards.mjs --top 20      개수를 바꾼다
//   node collect-winning-cards.mjs --worst       바닥 4편도 같이 받는다 (진 카드 대조용)
//   node collect-winning-cards.mjs --account xx  다른 계정 (기본 haruyaksa)
//
// 왜 필요한가. 260825 에 팩 22장을 쓰고 통째로 반려됐다. 대시보드는 조회수와 팔로우만 주고,
// 매뉴얼 공략점은 그 편이 왜 이겼는지를 **요약한 문장**으로만 준다("넓음, 얻음, 내 삶").
// 그래서 세 축을 다 만족하면서 행이 전부 뻔한 팩이 나왔다.
// 1위 집밥 편의 행은 케첩, 콜라, 사과즙, 들깨가루처럼 **뜻밖의 재료 이름**인데,
// 그 사실이 어디에도 안 적혀 있어서 알 수가 없었다.
//
// 이 계정 릴스는 정지 카드 한 장이라 **썸네일이 곧 카드 전체**다. 행이 다 읽힌다.
//
// 왜 인스타를 직접 안 여나. 인스타 화면에는 **편별 팔로우 수가 안 나온다.**
// 어느 카드가 이겼는지로 줄을 세우려면 대시보드의 지표와 붙여야 한다. 로그인도 필요 없다.
//
// 그림은 `references/이긴카드/` 에 떨어지고 git 에 안 올라간다(용량).
// 사람이 읽는 것은 `references/이긴카드.md` 이고, 그건 **에이전트가 그림을 보고 옮겨 적는다.**
// 이 스크립트는 무엇을 옮겨 적을지 목록만 정한다. 판단을 스크립트가 하고 모델이 안 한다.

import fs from "node:fs";
import path from "node:path";

const HERE = import.meta.dirname;
const REF = path.join(HERE, "..", "references");
const IMG = path.join(REF, "이긴카드");
const SITE = "https://reels-insight-lab.vercel.app";
const SOURCE = `${SITE}/data/dashboard.json`;

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const ACCOUNT = opt("account", "haruyaksa");
const TOP = Number(opt("top", 12));
const WANT_WORST = argv.includes("--worst");

const num = (v) => Number(String(v ?? "").replace(/[^0-9.]/g, "")) || 0;

// process.exit() 를 안 쓴다. fetch 가 물고 있는 소켓 때문에 윈도우에서 libuv assertion 이
// 같이 찍혀 진짜 오류처럼 보인다. exitCode 만 세우고 함수에서 빠져나간다.
async function run() {
  console.log(`자료 ${SOURCE}`);
  const res = await fetch(SOURCE);
  if (!res.ok) {
    console.error(`대시보드를 못 받았다: ${res.status}`);
    return 1;
  }
  const doc = await res.json();

  // ---------- 이 계정 편만 추리고 겹친 것을 합친다 ----------
  // 알려진 함정: 한 릴스가 릴스 인사이트와 게시물 인사이트로 **두 번** 잡힌다.
  // 팔로우가 큰 쪽을 남긴다. 작은 쪽은 화면을 덜 내린 컷이다.
  const byKey = new Map();
  for (const r of doc.records || []) {
    const handle = r.account_handle || r.instagram_account || "";
    if (handle !== ACCOUNT) continue;
    const title = r.instagram_reel_title || r.content_title_hint || "";
    const thumb = r.thumbnail_source || r.instagram_thumbnail_source || "";
    if (!title || !thumb) continue;
    const s = r.summary || {};
    const row = {
      title,
      thumb,
      shortcode: r.instagram_shortcode || "",
      url: r.instagram_reel_url || "",
      views: num(s.views),
      follows: num(s.follows),
      watch: num(s.average_watch_time?.value),
      date: r.instagram_post_date || "",
    };
    const key = row.shortcode || title;
    const old = byKey.get(key);
    if (!old || row.follows > old.follows) byKey.set(key, row);
  }

  const all = [...byKey.values()];
  if (!all.length) {
    console.error(`${ACCOUNT} 편을 못 찾았다. --account 를 확인해라.`);
    return 1;
  }
  all.sort((a, b) => b.follows - a.follows);

  const picked = all.slice(0, TOP).map((r, i) => ({ ...r, band: "이긴", rank: i + 1 }));
  if (WANT_WORST) {
    const worst = all.slice(-4).reverse().map((r, i) => ({ ...r, band: "진", rank: all.length - i }));
    picked.push(...worst);
  }

  // ---------- 그림을 받는다 ----------
  fs.mkdirSync(IMG, { recursive: true });
  let got = 0;
  let skipped = 0;
  const failed = [];

  for (const r of picked) {
    const ext = path.extname(r.thumb) || ".webp";
    r.file = String(r.rank).padStart(2, "0") + "-" + (r.shortcode || "no-code") + ext;
    const dest = path.join(IMG, r.file);
    if (fs.existsSync(dest)) {
      skipped += 1;
      continue;
    }
    try {
      const img = await fetch(SITE + r.thumb);
      if (!img.ok) throw new Error("HTTP " + img.status);
      fs.writeFileSync(dest, Buffer.from(await img.arrayBuffer()));
      got += 1;
    } catch (e) {
      // 하나 실패해도 멈추지 않는다. 끝에 모아서 알린다.
      failed.push(`${r.title} (${e.message})`);
    }
  }

  // ---------- 옮겨 적을 목록 ----------
  // 다음 단계가 이 파일만 보고 돈다. 모델이 무엇을 볼지 다시 정하지 않는다.
  const L = [];
  L.push("# 옮겨 적을 카드 목록");
  L.push("");
  L.push(`계정 ${ACCOUNT}, 편 ${all.length}, 받은 상위 ${TOP}${WANT_WORST ? " + 바닥 4" : ""}`);
  L.push("");
  L.push("**이 목록의 그림을 하나씩 열어 행을 `이긴카드.md` 에 옮겨 적는다.**");
  L.push("제목만 베끼지 마라. **행마다 무엇을 이름으로 댔는지**가 옮겨 적는 이유다.");
  L.push("");
  L.push("| 순위 | 팔로우 | 조회 | 시청 | 그림 | 제목 |");
  L.push("| --- | --- | --- | --- | --- | --- |");
  for (const r of picked) {
    L.push(
      `| ${r.band}${r.rank} | ${r.follows.toLocaleString("ko-KR")} | ${r.views.toLocaleString("ko-KR")} | ${r.watch}초 | \`이긴카드/${r.file}\` | ${r.title} |`,
    );
  }
  L.push("");
  L.push("원본 링크");
  L.push("");
  for (const r of picked) L.push(`- ${r.band}${r.rank} ${r.title}: ${r.url}`);
  L.push("");
  fs.writeFileSync(path.join(REF, "수집목록.md"), L.join("\n"), "utf8");

  // 기계가 읽는 사본도 같이 남긴다.
  fs.writeFileSync(
    path.join(REF, "수집목록.json"),
    JSON.stringify({ account: ACCOUNT, total: all.length, picked }, null, 2),
    "utf8",
  );

  console.log(`그림 ${got}장 새로 받음, ${skipped}장은 이미 있음`);
  if (failed.length) {
    console.log(`못 받은 것 ${failed.length}건`);
    for (const f of failed) console.log("  " + f);
  }
  console.log(`목록: ${path.join(REF, "수집목록.md")}`);
  console.log("");
  console.log("다음: 그림을 하나씩 열어 행을 references/이긴카드.md 에 옮겨 적어라.");
  return 0;
}

process.exitCode = await run();
