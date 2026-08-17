#!/usr/bin/env node
// 편집자가 방금 끝낸 영상을 찾는다.
//
//   node find-latest.mjs                 네 사람 중 최근에 손댄 것 전부
//   node find-latest.mjs 오주헌           그 사람 것만
//   node find-latest.mjs --days 3        최근 3일 (기본 2일)
//   node find-latest.mjs --json          기계가 읽을 형태로
//
// 왜 이렇게 찾나:
//   구글 드라이브에서 영상 파일을 통째로 find 하면 2분이 넘어 죽는다.
//   그래서 **주제 폴더의 mtime 으로 먼저 좁히고**, 그 안만 뒤진다. 0.2초면 끝난다.

import fs from "node:fs";
import path from "node:path";

const ROOT = "G:/내 드라이브/영상 편집";

// 폴더 이름이 점으로 시작한다. 일반 glob·ls 로는 안 보인다.
const PEOPLE = [
  { key: "김주성", dir: ".김주성 대표님", handle: "@kimjejo_pharma" },
  { key: "오주헌", dir: ".오주헌 약사님", handle: "@oyakstory" },
  { key: "전종열", dir: ".전종열 약사님", handle: null },
  { key: "제선영", dir: ".제선영 약사님", handle: "@jessi_yaksa" },
];
// 사람을 부르는 다른 이름들. "오약" 처럼 줄여 부르는 경우가 많다.
const ALIAS = {
  오주헌: ["오약", "oyakstory", "주헌"],
  제선영: ["제약", "jessi", "선영", "제선영약사"],
  김주성: ["김제조", "kimjejo", "주성", "대표님"],
  전종열: ["전약", "종열"],
};

const VIDEO = /\.(mp4|mov|m4v)$/i;
// 프리미어 자동저장·미리보기 폴더는 영상이 아니다. 들어가면 느려지기만 한다.
const SKIP_DIR = /^(Adobe Premiere Pro (Auto-Save|Audio Previews|Video Previews)|\.tmp|__MACOSX)$/i;

const arg = (name, def = null) => {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : def;
};
const DAYS = Number(arg("days", 2));
const AS_JSON = process.argv.includes("--json");
const SHOW_RAW = process.argv.includes("--raw");
const who = process.argv.slice(2).find((a) => !a.startsWith("--") && !/^\d+$/.test(a));

function matchPerson(q) {
  if (!q) return PEOPLE;
  const n = q.replace(/\s+/g, "").toLowerCase();
  const hit = PEOPLE.filter((p) => {
    if (p.key.toLowerCase().includes(n) || n.includes(p.key.toLowerCase())) return true;
    return (ALIAS[p.key] || []).some((a) => a.toLowerCase().includes(n) || n.includes(a.toLowerCase()));
  });
  return hit.length ? hit : PEOPLE;
}

// 폴더 안에서 영상을 찾는다. 편집자 하위폴더까지만 본다(더 깊이 갈 일이 없다).
function videosIn(dir, depth = 0, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth >= 2 || SKIP_DIR.test(e.name)) continue;
      videosIn(full, depth + 1, out);
    } else if (VIDEO.test(e.name)) {
      let st; try { st = fs.statSync(full); } catch { continue; }
      out.push({ file: full, name: e.name, mtime: st.mtimeMs, size: st.size, depth });
    }
  }
  return out;
}

// 편집 완성본과 카메라 원본을 가른다.
//   원본: 주제 폴더 바로 아래에 있는 큰 .mov (수백 MB). 캡션을 뽑을 대상이 아니다.
//   완성본: 편집자 폴더 안에 있거나, 작은 .mp4 로 내보낸 것.
// 제선영 약사님 폴더에 원본 .mov 가 수십 개라 이걸 안 가르면 전부 잡힌다.
function looksRaw(v) {
  const isMov = /\.mov$/i.test(v.name);
  const big = v.size > 60 * 1048576; // 60MB 넘는 mov 는 원본으로 본다
  return v.depth === 0 && isMov && big;
}

// 최종본 고르기: 편집자 폴더 > mp4 > 높은 차수(_수정2) > 최신
function pickFinal(list) {
  const usable = list.filter((v) => !looksRaw(v));
  const pool = usable.length ? usable : list;
  if (!pool.length) return null;
  const rev = (n) => {
    const m = n.match(/수정\s*(\d+)/);
    return m ? Number(m[1]) : 0;
  };
  const isMp4 = (n) => (/\.mp4$/i.test(n) ? 1 : 0);
  const best = [...pool].sort(
    (a, b) =>
      b.depth - a.depth ||
      isMp4(b.name) - isMp4(a.name) ||
      rev(b.name) - rev(a.name) ||
      b.mtime - a.mtime
  )[0];
  return { ...best, raw: usable.length === 0 };
}

const cutoff = Date.now() - DAYS * 864e5;
const results = [];

for (const p of matchPerson(who)) {
  const base = path.join(ROOT, p.dir);
  let topics;
  try { topics = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
  const recent = topics
    .filter((t) => t.isDirectory())
    .map((t) => {
      const full = path.join(base, t.name);
      let st; try { st = fs.statSync(full); } catch { return null; }
      return { topic: t.name, dir: full, mtime: st.mtimeMs };
    })
    .filter(Boolean)
    .filter((t) => t.mtime >= cutoff)
    .sort((a, b) => b.mtime - a.mtime);

  for (const t of recent) {
    const v = pickFinal(videosIn(t.dir));
    if (!v) continue;
    const folder = path.dirname(v.file);
    results.push({
      person: p.key,
      handle: p.handle,
      topic: t.topic,
      editor: folder === t.dir ? null : path.basename(folder),
      video: v.file,
      folder,
      mtime: new Date(v.mtime).toISOString(),
      size_mb: +(v.size / 1048576).toFixed(1),
      caption_exists: fs.existsSync(path.join(folder, "캡션.html")),
      raw: !!v.raw,
    });
  }
}

const shown = SHOW_RAW ? results : results.filter((r) => !r.raw);
shown.sort((a, b) => b.mtime.localeCompare(a.mtime));

if (AS_JSON) {
  console.log(JSON.stringify(shown, null, 2));
} else if (!shown.length) {
  console.log(`최근 ${DAYS}일 안에 편집 완성본이 없다.`);
  const raws = results.filter((r) => r.raw).length;
  if (raws) console.log(`원본 촬영분만 ${raws}개 있다. 보려면 --raw, 기간은 --days.`);
} else {
  const dropped = results.length - shown.length;
  console.log(
    `최근 ${DAYS}일 · 편집 완성본 ${shown.length}개` +
      (dropped ? ` (원본 촬영분 ${dropped}개는 뺐다 — 보려면 --raw)` : "") + "\n"
  );
  for (const r of shown) {
    console.log(`  ${r.person}${r.editor ? " / 편집자 " + r.editor : ""}`);
    console.log(`    ${r.topic}`);
    console.log(`    ${path.basename(r.video)}  ${r.size_mb}MB  ${r.mtime.slice(0, 16).replace("T", " ")}`);
    console.log(`    캡션 ${r.caption_exists ? "이미 있음" : "없음 ← 만들 것"}`);
    console.log(`    ${r.folder}`);
    console.log("");
  }
}
