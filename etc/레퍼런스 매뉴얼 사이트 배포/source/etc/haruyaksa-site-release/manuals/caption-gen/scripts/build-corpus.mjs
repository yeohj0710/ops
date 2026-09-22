#!/usr/bin/env node
// 인스타에서 긁어온 캡션을 학습용 데이터로 쌓는다.
//
//   node build-corpus.mjs <내려받은 ig-captions.json>
//
// 긁는 방법은 MANUAL.md "레퍼런스 늘리기" 를 봐라.
// yt-dlp 로는 인스타를 못 읽어서, 로그인된 크롬에서 인스타 내부 API 를 부른다.
//
// 만드는 것
//   학습용 데이터/<사람> (@핸들)/
//     프로필.html                     계정 소개와 톤 (없을 때만 만든다)
//     _경향.md                        실측 통계. 길이, 이모지, 구분선, 훅, 해시태그
//     <조회수> <제목 앞부분>/캡션.html   캡션 원문. 조회수 높은 순
//
// 사람이 손으로 넣은 예시는 건드리지 않는다. 이름이 겹치면 건너뛴다.

import fs from "node:fs";
import path from "node:path";

const LEARN =
  "G:/내 드라이브/영상 편집/[공통] 유용한 소스/캡션 자동 생성/학습용 데이터";

// 핸들 → 학습용 데이터 폴더 이름
const FOLDER = {
  kimjejo_pharma: "김주성 대표님 (@kimjejo_pharma)",
  oyakstory: "오주헌 약사님 (@oyakstory)",
  jessi_yaksa: "제선영 약사님 (@jessi_yaksa)",
  haruyaksa: "하루건강약사 (@haruyaksa)",
  mijoo_lab: "김미주님 (@mijoo_lab)",
  "0.a_log": "박영아님 (@0.a_log)",
  _hyeoooo: "최형지님 (@_hyeoooo)",
};

const src = process.argv[2] || "C:/Users/hjyeo/Downloads/ig-captions.json";
if (!fs.existsSync(src)) {
  console.error("파일이 없다: " + src);
  process.exit(1);
}
const data = JSON.parse(fs.readFileSync(src, "utf8"));

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// Windows 폴더 이름 규칙: 금지문자 없음, 끝에 점이나 공백 금지.
// 이모지도 뺀다. 탐색기에서 깨져 보이고 경로를 다루기 번거롭다.
const safe = (s) =>
  s
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{20E3}\u{200D}]/gu, "")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 55)
    .replace(/[.\s]+$/, "")
    .trim() || "무제";

// 캡션에서 경향을 실측한다. 사람마다 형식이 정말 다르다.
function analyze(items) {
  const n = items.length;
  if (!n) return null;
  const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{20E3}]/gu;
  const numEmoji = /[1-9]\u{FE0F}?\u{20E3}/gu;
  const stat = (f) => items.map(f);
  const avg = (a) => Math.round(a.reduce((x, y) => x + y, 0) / a.length);
  const pct = (a) => Math.round((a.filter(Boolean).length / n) * 100);

  const tags = {};
  for (const it of items)
    for (const t of it.cap.match(/#[^\s#]+/g) || []) tags[t] = (tags[t] || 0) + 1;

  return {
    편수: n,
    평균길이: avg(stat((i) => i.cap.length)),
    평균줄수: avg(stat((i) => i.cap.split("\n").filter((l) => l.trim()).length)),
    이모지평균: avg(stat((i) => (i.cap.match(emoji) || []).length)),
    숫자이모지사용: pct(stat((i) => numEmoji.test(i.cap))),
    구분선사용: pct(stat((i) => /━{3,}|─{3,}|-{5,}/.test(i.cap))),
    첫줄평균: avg(stat((i) => i.cap.split("\n")[0].length)),
    해시태그평균: avg(stat((i) => (i.cap.match(/#[^\s#]+/g) || []).length)),
    팔로우유도: pct(stat((i) => /팔로우|팔로워|구독/.test(i.cap))),
    저장유도: pct(stat((i) => /저장|🔖/.test(i.cap))),
    자주쓰는해시태그: Object.entries(tags).sort((a, b) => b[1] - a[1]).slice(0, 10),
    조회수중앙값: (() => {
      const v = items.map((i) => i.play).filter((x) => x != null).sort((a, b) => a - b);
      return v.length ? v[Math.floor(v.length / 2)] : null;
    })(),
  };
}

function captionHtml(title, body, meta) {
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font:15px/1.75 -apple-system,"Malgun Gothic",sans-serif;margin:0;padding:24px;background:#f7f7f5;color:#16181a}
h1{font-size:16px;margin:0 0 6px}
.meta{font-size:12.5px;color:#767c85;margin:0 0 14px}
textarea{width:100%;min-height:60vh;padding:14px;border:1px solid #ddd;border-radius:8px;font:inherit;white-space:pre-wrap;background:#fff}</style>
</head><body>
<h1>${esc(title)}</h1>
<p class="meta">${esc(meta)}</p>
<textarea id="caption" spellcheck="false">${esc(body)}</textarea>
</body></html>
`;
}

let made = 0, skipped = 0;
const report = [];

for (const [handle, v] of Object.entries(data)) {
  if (v.error || !v.items?.length) continue;
  const folder = FOLDER[handle] || `${v.full || handle} (@${handle})`;
  const base = path.join(LEARN, folder);
  fs.mkdirSync(base, { recursive: true });

  // 조회수 높은 순으로 쌓는다. 잘 된 캡션이 앞에 오면 참고하기 쉽다.
  const sorted = [...v.items].sort((a, b) => (b.play || 0) - (a.play || 0));

  for (const it of sorted) {
    const first = it.cap.split("\n")[0];
    const views = it.play ? String(it.play).padStart(7, "0") : "0000000";
    const dir = path.join(base, `${views} ${safe(first)}`);
    if (fs.existsSync(dir)) { skipped++; continue; }
    fs.mkdirSync(dir, { recursive: true });
    const date = it.ts ? new Date(it.ts * 1000).toISOString().slice(0, 10) : "";
    fs.writeFileSync(
      path.join(dir, "캡션.html"),
      captionHtml(
        first.slice(0, 70),
        it.cap,
        `@${handle} / ${date} / 조회 ${it.play ?? "?"} / 좋아요 ${it.like ?? "?"} / https://instagram.com/p/${it.code}`
      ),
      "utf8"
    );
    made++;
  }

  // 프로필은 사람이 만든 게 있으면 손대지 않는다.
  const prof = path.join(base, "프로필.html");
  if (!fs.existsSync(prof)) {
    fs.writeFileSync(
      prof,
      captionHtml(
        `${v.full || handle} (@${handle})`,
        `표시 이름: ${v.full || ""}\n계정: @${handle}\n팔로워: ${v.followers ?? "?"}\n게시물: ${v.posts ?? "?"}\n\n소개글\n${v.bio || ""}`,
        "인스타 계정 소개에서 자동으로 만들었다. 사람이 다듬어도 된다."
      ),
      "utf8"
    );
  }

  // 경향은 매번 다시 쓴다. 캡션이 늘면 숫자도 달라져야 한다.
  const a = analyze(v.items);
  const lines = [
    `# @${handle} 캡션 경향 (실측)`,
    "",
    "> `build-corpus.mjs` 가 다시 쓴다. 손으로 고치지 마라.",
    `> 인스타 최근 ${a.편수}편을 실제로 세서 만들었다.`,
    "",
    `- 캡션 길이 평균 **${a.평균길이}자**, 줄 수 평균 **${a.평균줄수}줄**, 첫 줄 **${a.첫줄평균}자**`,
    `- 이모지 평균 **${a.이모지평균}개**`,
    `- 숫자 이모지(1️⃣2️⃣) 쓰는 편 **${a.숫자이모지사용}%**`,
    `- 구분선(━━━) 쓰는 편 **${a.구분선사용}%**`,
    `- 해시태그 평균 **${a.해시태그평균}개**`,
    `- 팔로우나 구독 유도 **${a.팔로우유도}%**, 저장 유도 **${a.저장유도}%**`,
    `- 조회수 중앙값 **${a.조회수중앙값 ?? "?"}**`,
    "",
    "## 자주 쓰는 해시태그",
    "",
    ...(a.자주쓰는해시태그.length
      ? a.자주쓰는해시태그.map(([t, c]) => `- ${t} (${c}편)`)
      : ["- (없음)"]),
    "",
    "## 캡션 쓸 때",
    "",
    "이 숫자에 맞춰라. 길이가 두 배로 길거나 이모지가 없으면 그 사람 글이 아니다.",
    "예시는 조회수 높은 순으로 폴더 이름에 붙어 있다. **앞쪽 것을 더 강하게 따른다.**",
  ];
  fs.writeFileSync(path.join(base, "_경향.md"), lines.join("\n") + "\n", "utf8");
  report.push({ handle, folder, 새로쌓음: sorted.length, ...a });
}

console.log(`캡션 ${made}개 새로 쌓음, ${skipped}개 이미 있어서 건너뜀\n`);
for (const r of report) {
  console.log(`${r.handle}  (${r.편수}편)`);
  console.log(`   길이 ${r.평균길이}자, ${r.평균줄수}줄, 이모지 ${r.이모지평균}개, 해시태그 ${r.해시태그평균}개`);
  console.log(`   숫자이모지 ${r.숫자이모지사용}%, 구분선 ${r.구분선사용}%, 팔로우유도 ${r.팔로우유도}%, 조회수중앙값 ${r.조회수중앙값}`);
  console.log("");
}
