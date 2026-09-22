#!/usr/bin/env node
// 이번 호출에서 인스타에 올릴 한 편을 정한다. P4 앞에 돌린다.
//
//   node pick-next-reel.mjs <인스타피드.json>
//
// 인스타피드.json 은 로그인된 탭에서 받아 저장한다 (L3).
//   const r = await fetch("/api/v1/feed/user/15272270790/?count=18",
//     { headers: { "x-ig-app-id": "936619743392459" } }).then(r => r.json());
//   r.items.map(i => ({ code: i.code, taken: i.taken_at, cap: (i.caption?.text || "").split("\n")[0] }))
//
// 왜 이게 있나. 예전 규칙은 "최신 미게시 후보 1편" 이었는데, 그대로 따르면 한 채널이 굶는다.
// 후보가 있는 채널은 P2 를 건너뛰고, 후보가 없는 채널만 새로 만들어서, 늘 방금 만든 쪽이
// 최신이 된다. 밀린 편은 영영 안 올라간다. 260830 에 실제로 그 굴레를 봤다.
//
// 그래서 규칙을 바꿨다. **가장 오래된 미게시 후보 1편**을 올린다.
// 두 채널이 하루 한 편씩 올리면 이 규칙만으로 채널이 저절로 번갈아 나간다.
// 시각이 같을 때만 직전 릴스와 다른 채널을 고른다.
//
// 후보는 **각 채널의 최신 유튜브 영상 한 편씩**뿐이다. 그보다 예전 영상은 후보가 아니다
// ("오래된 미업로드 영상을 거슬러 올라가지 마라" 를 이 규칙이 깨지 않게 하는 울타리다).

import fs from "node:fs";
import path from "node:path";

const OPS = "C:/dev/ops";
const MACHINE = JSON.parse(fs.readFileSync(path.join(OPS, "machine.json"), "utf8"));
const DEV = MACHINE.dev_root.replace(/\//g, path.sep);
const AUTOMATION = path.join(DEV, "n8n-youtube-shorts-automation");

const CHANNELS = [
  ["하루건강약사", "하루건강약사 소재"],
  ["건강장수비결", "건강장수비결 소재"],
];

const feedPath = process.argv[2];
if (!feedPath || !fs.existsSync(feedPath)) {
  console.log('사용법: node pick-next-reel.mjs "<인스타피드.json>"');
  console.log("피드는 로그인된 탭에서 받아 저장한다. 파일 머리말의 코드를 보라.");
  process.exit(2);
}

// 제목과 캡션 첫 줄을 견줄 때 공백과 문장부호 차이를 지운다.
const norm = (s) => String(s || "").replace(/\s+/g, "").replace(/[.,!?·・…]/g, "").trim();

const feed = JSON.parse(fs.readFileSync(feedPath, "utf8"));
const items = Array.isArray(feed) ? feed : feed.items || [];
const postedCaps = items.map((i) => norm(i.cap ?? i.caption));

const lastOf = (dir) => {
  const p = path.join(AUTOMATION, dir, "기록", "업로드기록.jsonl");
  if (!fs.existsSync(p)) return null;
  const lines = fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const j = JSON.parse(lines[i]);
      if (j.video_id) return j;
    } catch {
      // 깨진 줄은 건너뛴다
    }
  }
  return null;
};

// 피드에서 가장 최근 릴스가 어느 채널 것인지 (동률일 때 쓰는 보조 기준)
let lastPostedChannel = null;
outer: for (const it of items) {
  for (const [name, dir] of CHANNELS) {
    const p = path.join(AUTOMATION, dir, "기록", "업로드기록.jsonl");
    if (!fs.existsSync(p)) continue;
    const hit = fs
      .readFileSync(p, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .some((l) => {
        try {
          return norm(JSON.parse(l).title) === norm(it.cap ?? it.caption);
        } catch {
          return false;
        }
      });
    if (hit) {
      lastPostedChannel = name;
      break outer;
    }
  }
}

const rows = [];
for (const [name, dir] of CHANNELS) {
  const last = lastOf(dir);
  if (!last) {
    rows.push({ channel: name, state: "기록 없음" });
    continue;
  }
  const posted = postedCaps.includes(norm(last.title));
  rows.push({
    channel: name,
    title: last.title,
    videoId: last.video_id,
    url: last.url,
    uploadedAt: last.uploaded_at,
    posted,
    state: posted ? "게시됨" : "미게시",
  });
}

console.log("이번에 올릴 한 편 고르기 (규칙: 가장 오래된 미게시 후보)");
console.log("");
for (const r of rows) {
  if (!r.videoId) {
    console.log(`  ${r.channel.padEnd(8)} ${r.state}`);
    continue;
  }
  console.log(`  ${r.channel.padEnd(8)} ${r.state.padEnd(6)} ${r.uploadedAt}  ${r.videoId}  ${r.title}`);
}
console.log("");

const candidates = rows.filter((r) => r.videoId && !r.posted);
if (candidates.length === 0) {
  console.log("미게시 후보 없음 — 이번 호출에서는 인스타에 올리지 않는다.");
  console.log(JSON.stringify({ pick: null, reason: "no_candidate" }));
  process.exit(3);
}

candidates.sort((a, b) => {
  const t = new Date(a.uploadedAt) - new Date(b.uploadedAt);
  if (t !== 0) return t;
  // 시각이 같으면 직전 릴스와 다른 채널을 앞세운다
  if (lastPostedChannel) {
    if (a.channel !== lastPostedChannel && b.channel === lastPostedChannel) return -1;
    if (b.channel !== lastPostedChannel && a.channel === lastPostedChannel) return 1;
  }
  return 0;
});

const pick = candidates[0];
const why =
  candidates.length === 1
    ? "미게시 후보가 하나뿐이다"
    : `후보 ${candidates.length}편 중 유튜브 업로드가 가장 이르다`;

console.log(`고른 편: ${pick.channel} / ${pick.title}`);
console.log(`  영상ID  ${pick.videoId}`);
console.log(`  주소    ${pick.url}`);
console.log(`  이유    ${why}`);
if (lastPostedChannel) console.log(`  직전 릴스 채널  ${lastPostedChannel}`);
console.log("");
console.log("다음: node extract.mjs " + pick.videoId);
console.log("");
console.log(JSON.stringify({ pick, candidates: candidates.length, lastPostedChannel }));
