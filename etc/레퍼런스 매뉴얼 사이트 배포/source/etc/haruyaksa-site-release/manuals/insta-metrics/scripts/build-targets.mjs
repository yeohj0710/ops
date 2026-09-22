#!/usr/bin/env node
/* 시트에서 아직 빈 지표 칸을 훑어 이번 런의 대상 목록을 만든다.
 *
 *   node build-targets.mjs --outdir <작업폴더>
 *
 * 왜 이게 있나.
 * 매뉴얼 1번(채울 대상을 뽑는다)이 글로만 있었다. 사람이 CSV 를 열어 빈칸을 세고
 * targets.json 을 손으로 적는 자리였다. 그 자리가 런마다 다르게 세어졌고,
 * 샤오홍슈 행까지 세어 "빈칸 192개" 같은 숫자가 나와서 다 못 채운 런처럼 보였다.
 * 실제로 이 업무가 채울 인스타 행의 빈칸은 그때 11개였다.
 *
 * 계정이 있으면 사유와 관계없이 숫자 지표 빈칸을 모두 대상으로 삼는다.
 * 삭제·비공개·릴스 없음도 추정값을 넣어야 하므로 예외로 건너뛰지 않는다.
 */

import fs from "node:fs";
import path from "node:path";
import { parseCsv, resolveGids } from "./scan-junk.mjs";

const SHEET_ID = "1heUo8C09kEHMQo7qOTYC5bMOCSMTHCvb-m7O3tm2BOE";

const TABS = [
  { tab: "인플루언서", metrics: ["릴스 중앙 조회수", "팔로워", "공개 연락처"], reasonColumn: "조회수 근거", platform: "인스타그램" },
  { tab: "유입", metrics: ["릴스 중앙 조회수", "좋아요 중앙값", "팔로워"], reasonColumn: null, platform: "인스타그램" },
];

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf("--" + n);
  return i > -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const OPT = {
  outdir: flag("outdir"),
  sheetId: flag("sheet-id", SHEET_ID),
  allBlanks: argv.includes("--all-blanks"),
};
if (!OPT.outdir) {
  console.error("쓰는 법: node build-targets.mjs --outdir <작업폴더> [--all-blanks]");
  process.exit(2);
}

const txt = (v) => String(v ?? "").trim();
const bl = (v) => !txt(v);
const handleOf = (v) => txt(v).replace(/^@/, "").toLowerCase();

async function get(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`못 받았다: HTTP ${r.status} ${url}`);
  return r.text();
}

const gids = await resolveGids(OPT.sheetId);
// sheet-diff 는 before/ 안의 *.csv 를 전부 탭 이름으로 읽는다.
// 여기에 파일을 더 떨구면 없는 탭을 찾다가 diff 가 실패한다. 그래서 폴더를 나눈다
fs.mkdirSync(path.join(OPT.outdir, "export"), { recursive: true });

const handles = [];
const seenHandle = new Set();
const targets = {};
const report = { 시트: OPT.sheetId, 기준: "빈칸 전부", 탭: {} };

for (const { tab, metrics, reasonColumn, platform } of TABS) {
  // 서식 뷰로 받는다. gviz 는 숫자 열에 든 글자를 빈칸으로 줘서 "빈칸" 판정이 어긋난다
  const gid = gids.get(tab);
  if (!gid) throw new Error(`시트에 "${tab}" 탭이 없다`);
  const csv = await get(`https://docs.google.com/spreadsheets/d/${OPT.sheetId}/export?format=csv&gid=${gid}`);
  fs.writeFileSync(path.join(OPT.outdir, "export", `${tab}.csv`), csv, "utf8");

  const rows = parseCsv(csv);
  const H = rows[1].map(txt);
  const body = rows.slice(2).filter((r) => r.some((v) => txt(v)));
  const iAcc = H.indexOf("계정"), iPlat = H.indexOf("플랫폼");
  const iReason = reasonColumn ? H.indexOf(reasonColumn) : -1;
  if (iAcc < 0) throw new Error(`${tab} 탭에 "계정" 열이 없다`);

  const cols = metrics.filter((c) => H.includes(c));
  const stat = { 행: body.length, 대상플랫폼: 0, 뽑은행: 0, 해명된빈칸: 0, 열별: {}, 없는열: metrics.filter((c) => !H.includes(c)) };
  for (const c of cols) stat.열별[c] = 0;
  const list = [];

  body.forEach((row, i) => {
    const raw = txt(row[iAcc]);
    const key = handleOf(raw);
    if (!key) return;
    if (platform && iPlat >= 0 && txt(row[iPlat]) !== platform) return;
    stat.대상플랫폼++;

    const 사유 = iReason >= 0 ? txt(row[iReason]) : "";
    const missing = [];
    for (const c of cols) {
      if (!bl(row[H.indexOf(c)])) continue;
      missing.push(c);
      stat.열별[c]++;
    }
    if (!missing.length) return;

    stat.뽑은행++;
    if (!seenHandle.has(key)) { seenHandle.add(key); handles.push(key); }
    list.push({ i: handles.indexOf(key), row: i + 3, handle: key, 계정: raw, missing, 사유: 사유 || undefined });
  });

  targets[tab] = list;
  report.탭[tab] = { gid, ...stat };
}

const out = { handles, targets };
fs.writeFileSync(path.join(OPT.outdir, "targets.json"), JSON.stringify(out, null, 1), "utf8");
report.계정 = handles.length;
report.요약 = Object.entries(report.탭).map(([t, s]) => `${t} ${s.뽑은행}행`).join(", ") + ` / 계정 ${handles.length}개`;
report.파일 = path.join(OPT.outdir, "targets.json");
fs.writeFileSync(path.join(OPT.outdir, "targets-report.json"), JSON.stringify(report, null, 1), "utf8");
console.log(JSON.stringify(report, null, 1));
