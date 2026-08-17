#!/usr/bin/env node
// 유튜브 쇼츠를 인스타 업로드용 폴더 규격으로 뽑는다.
//
//   node extract.mjs --list                    아직 안 뽑은 최근 영상을 보여준다
//   node extract.mjs <영상ID> [<영상ID> ...]    그 영상들을 뽑는다
//
// 추출기 exe(`YouTube·Instagram 미디어 추출기`)와 같은 로직이다. yt-dlp 를 직접 쓴다.
// 폴더 하나에 mp4 · metadata.json · caption.txt · 캡션.html · 업로드 준비.json 다섯 개를 만든다.
// 캡션 내용은 사람이나 에이전트가 채운다 (P5). 이 스크립트는 틀과 영상만 만든다.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const DEST = "G:/내 드라이브/영상 편집/AI 크리에이터/인스타그램 업로드용";
const CHANNELS = {
  "UCxiJMEG0LQZPKZB1LhwaGNg": "하루건강약사",
  "UCz3jUUxisXo0OE-9Km_gJbQ": "건강장수비결",
};
const ALLOWED = Object.keys(CHANNELS);

const sh = (args, opts = {}) =>
  execFileSync("yt-dlp", args, { encoding: "utf8", maxBuffer: 1 << 26, ...opts });

// 파일 이름에 못 쓰는 글자를 뺀다. 폴더 이름 규칙은 `YYMMDDHHMMSS 제목`.
const safe = (s) => s.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim();

function stampNow() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return (
    String(d.getFullYear()).slice(2) + p(d.getMonth() + 1) + p(d.getDate()) +
    p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
  );
}

// 이미 뽑아 둔 영상 ID 를 모은다. 폴더 이름이 아니라 metadata 를 본다.
function prepared() {
  const ids = new Set();
  for (const d of fs.readdirSync(DEST)) {
    const dir = path.join(DEST, d);
    let st;
    try { st = fs.statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    const mf = fs.readdirSync(dir).find((f) => f.endsWith("metadata.json"));
    if (!mf) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, mf), "utf8"));
      if (j.youtube_video_id) ids.add(j.youtube_video_id);
    } catch {}
  }
  return ids;
}

function recent(limit = 10) {
  const rows = [];
  for (const ch of ALLOWED) {
    const out = sh([
      "--flat-playlist", "--playlist-end", String(limit),
      "--print", "%(id)s\t%(title)s",
      `https://www.youtube.com/channel/${ch}/shorts`,
    ]);
    out.trim().split("\n").filter(Boolean).forEach((l, i) => {
      const [id, ...t] = l.split("\t");
      rows.push({ ch, channel: CHANNELS[ch], id, title: t.join("\t"), rank: i });
    });
  }
  return rows;
}

// 아직 안 뽑은 것 중 **최근 것만** 고른다.
// 오래전에 안 뽑은 건 인스타에 안 맞아서 일부러 건너뛴 것이라 거슬러 올라가지 않는다.
// 채널별로 '가장 최근에 뽑은 영상' 보다 위에 있는 것까지만 본다.
function backlog() {
  const done = prepared();
  const rows = recent();
  const result = [];
  for (const ch of ALLOWED) {
    const list = rows.filter((r) => r.ch === ch).sort((a, b) => a.rank - b.rank);
    const cut = list.findIndex((r) => done.has(r.id));
    const fresh = (cut === -1 ? list.slice(0, 1) : list.slice(0, cut)).filter((r) => !done.has(r.id));
    result.push(...fresh);
  }
  return result;
}

function grab(id) {
  const meta = JSON.parse(sh(["-J", "--no-warnings", `https://www.youtube.com/watch?v=${id}`]));
  if (!ALLOWED.includes(meta.channel_id)) {
    throw new Error(`남의 채널 영상이다: ${meta.uploader} (${meta.channel_id})`);
  }
  const title = safe(meta.title);
  const name = `${stampNow()} ${title}`;
  const dir = path.join(DEST, name);
  fs.mkdirSync(dir, { recursive: true });

  const mp4 = path.join(dir, `${name}.mp4`);
  sh(["-f", "bv*+ba/b", "--merge-output-format", "mp4", "-o", mp4,
      `https://www.youtube.com/watch?v=${id}`], { stdio: "inherit" });
  if (!fs.existsSync(mp4)) throw new Error("영상이 안 만들어졌다");

  const now = new Date().toISOString();
  const write = (f, o) => fs.writeFileSync(path.join(dir, f), JSON.stringify(o, null, 2) + "\n", "utf8");

  write(`${name} metadata.json`, {
    title: meta.title,
    uploader: meta.uploader,
    channel_id: meta.channel_id,
    ownership_status: "confirmed",
    publication_date: meta.upload_date
      ? `${meta.upload_date.slice(0,4)}-${meta.upload_date.slice(4,6)}-${meta.upload_date.slice(6,8)}T00:00:00+09:00`
      : null,
    source_url: `https://www.youtube.com/shorts/${id}`,
    youtube_video_id: id,
    media_file: `${name}.mp4`,
    prepared_at: now,
    preparation_source: "ops shorts-pipeline extract.mjs",
  });

  write("업로드 준비.json", {
    version: 1,
    status: "ready_for_manual_upload",
    upload_mode: "manual",
    source_url: `https://www.youtube.com/shorts/${id}`,
    video_path: `${name}.mp4`,
    caption_html: "캡션.html",
    metadata_path: `${name} metadata.json`,
    target_account: "@haruyaksa",
    target_aspect_ratio: "original",
    source_ownership: {
      status: "confirmed",
      uploader: meta.uploader,
      channel_id: meta.channel_id,
      allowed_channel_ids: ALLOWED,
    },
    prepared_at: now,
  });

  // 캡션은 P5 에서 채운다. 유튜브 설명이 있으면 씨앗으로 남긴다.
  fs.writeFileSync(path.join(dir, `${name} caption.txt`), (meta.description || "").trim() + "\n", "utf8");

  const tmpl = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>${title} 캡션</title>
<style>body{font:15px/1.7 -apple-system,"Malgun Gothic",sans-serif;margin:0;padding:24px;background:#f7f7f5}
h1{font-size:17px;margin:0 0 14px}textarea{width:100%;min-height:70vh;padding:14px;border:1px solid #ddd;border-radius:8px;font:inherit;white-space:pre-wrap}</style>
</head><body>
<h1>${title} — 인스타 캡션</h1>
<textarea id="caption" spellcheck="false"></textarea>
</body></html>
`;
  fs.writeFileSync(path.join(dir, "캡션.html"), tmpl, "utf8");
  return { name, dir, uploader: meta.uploader, title: meta.title };
}

const args = process.argv.slice(2);
if (args.includes("--list") || !args.length) {
  const b = backlog();
  if (!b.length) {
    console.log("밀린 것이 없다.");
  } else {
    console.log(`아직 안 뽑은 최근 영상 ${b.length}개\n`);
    for (const r of b) console.log(`  ${r.channel}  ${r.id}  ${r.title}`);
    console.log(`\n뽑으려면:  node extract.mjs ${b.map((r) => r.id).join(" ")}`);
  }
} else {
  for (const id of args) {
    try {
      const r = grab(id);
      console.log(`OK  ${r.uploader} · ${r.title}`);
      console.log(`    ${r.dir}`);
    } catch (e) {
      console.error(`실패 ${id}: ${e.message}`);
    }
  }
  console.log("\n캡션은 아직 비어 있다. P5 로 채운다.");
}
