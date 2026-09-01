#!/usr/bin/env node
/* 「인플루언서」 탭을 읽어 정렬 계획을 만든다.
 *
 *   node build-sort-plan.mjs --out <작업폴더>/sort-plan.json
 *
 * 왜 이게 있나.
 * 정렬 규칙은 influencer-seeding 매뉴얼에 있고 순위 계산은 progress-rank.mjs 가 한다.
 * 그런데 시트를 만지는 업무가 둘이다. 시딩 진행 갱신과 지표 보충이다.
 * 지표 보충 쪽에는 "같은 순서로 정렬한다" 는 글만 있어서 실제로는 정렬을 못 했다.
 * **두 업무가 같은 명령 한 줄을 부르게 하려고 이걸 뺐다.** 규칙이 갈라지지 않는다.
 *
 * 값을 쓰지 않는다. 계획만 만든다. 시트에 옮기는 것은 사람이 승인한 L3 단계에서 한다.
 */

import fs from "node:fs";
import { buildPlan } from "./progress-rank.mjs";

const SHEET_ID = "1heUo8C09kEHMQo7qOTYC5bMOCSMTHCvb-m7O3tm2BOE";
const TAB = "인플루언서";
const HEADER_ROWS = 2; // 1행 제목, 2행 머리글

function parseCsv(t) {
  const rows = [];
  let f = "", row = [], q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; }
    else if (c !== "\r") f += c;
  }
  if (f.length || row.length) { row.push(f); rows.push(row); }
  return rows;
}

const txt = (v) => String(v ?? "").trim();
const blank = (v) => !txt(v);

/* 값이 없는 행인가.
 *
 * **체크박스는 비어 있어도 FALSE 로 나온다.** 260901 에 877~885 행이 그랬다.
 * 사람 눈에는 빈 줄인데 CSV 로는 FALSE 가 아홉 칸 들어 있어서 "빈 행 0개" 로 세어졌다.
 * 값이 아니라 서식이 남은 것이다. FALSE 만 남은 행은 빈 행으로 본다. */
const meaningless = (v) => blank(v) || txt(v).toUpperCase() === "FALSE";
const isEmptyRow = (cells) => cells.every(meaningless);

async function get(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`못 받았다: HTTP ${r.status} ${url}`);
  return r.text();
}

/* 탭 이름 → gid. gid 를 박아 두면 탭이 바뀐 날 엉뚱한 탭을 읽는다 */
async function resolveGid(sheetId, tab) {
  const html = await get(`https://docs.google.com/spreadsheets/d/${sheetId}/htmlview`);
  for (const m of html.matchAll(/name:\s*"((?:[^"\\]|\\.)*)"[\s\S]{0,400}?gid:\s*"(\d+)"/g)) {
    if (JSON.parse(`"${m[1]}"`) === tab) return m[2];
  }
  throw new Error(`시트에 "${tab}" 탭이 없다. 탭 이름이 바뀌었는지 본다`);
}

/* 서식 그대로 받는다. gviz 는 숫자 열에 든 "9.9만" 을 빈칸으로 주기 때문에
 * 그걸로 정렬하면 그 행들이 팔로워 0 으로 읽혀 통째로 뒤로 밀린다.
 * progress-rank 의 numberValue 가 K M 만 천 억 w 를 펴서 읽는다. */
export async function readRows({ sheetId = SHEET_ID, tab = TAB, gid } = {}) {
  const g = gid ?? (await resolveGid(sheetId, tab));
  const csv = parseCsv(await get(`https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${g}`));
  const header = (csv[HEADER_ROWS - 1] || []).map(txt);
  if (!header.includes("계정")) throw new Error(`${tab}: ${HEADER_ROWS}행에서 "계정" 머리글을 못 찾았다`);

  const body = csv.slice(HEADER_ROWS);
  while (body.length && isEmptyRow(body[body.length - 1])) body.pop();

  const rows = [];
  const blankRows = [];
  body.forEach((cells, i) => {
    const sheetRow = i + HEADER_ROWS + 1;
    if (isEmptyRow(cells)) { blankRows.push(sheetRow); return; } // 가운데 뚫린 빈 행
    const row = { row: sheetRow, key: txt(cells[header.indexOf("계정")]) };
    header.forEach((name, c) => { if (name) row[name] = txt(cells[c]); });
    rows.push(row);
  });
  return { gid: g, header, rows, blankRows };
}

export async function buildSortPlan(opts = {}) {
  const { gid, rows, blankRows } = await readRows(opts);
  const plan = buildPlan({ sheets: [{ title: opts.tab ?? TAB, rows }] });
  const sheet = plan.sheets[0];
  return {
    시트: opts.sheetId ?? SHEET_ID,
    탭: opts.tab ?? TAB,
    gid,
    행: sheet.rowCount,
    // 가운데 뚫린 빈 행. 정렬 전에 행째로 지워야 자리가 메워진다
    빈행: blankRows,
    // 지금 몇 쌍이 순서를 어기고 있나. 0 이면 이미 정렬돼 있으니 아무것도 하지 마라
    역전: sheet.inversionsBefore,
    정렬후행순서: sheet.sortedRowOrder,
    rows: sheet.rows,
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────────────
if (process.argv[1] && process.argv[1].replaceAll("\\", "/").endsWith("build-sort-plan.mjs")) {
  const argv = process.argv.slice(2);
  const flag = (n, d = null) => {
    const i = argv.indexOf("--" + n);
    return i > -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
  };
  const res = await buildSortPlan({
    sheetId: flag("sheet-id", SHEET_ID),
    tab: flag("tab", TAB),
    gid: flag("gid"),
  });
  const out = flag("out");
  if (out) fs.writeFileSync(out, JSON.stringify(res, null, 1), "utf8");
  console.log(JSON.stringify({ 탭: res.탭, gid: res.gid, 행: res.행, 빈행: res.빈행, 역전: res.역전 }, null, 1));
  if (res.빈행.length) console.log(`\n빈 행 ${res.빈행.length}개를 먼저 지워라: ${res.빈행.join(", ")}`);
  if (!res.역전) console.log("\n역전 0. 이미 정렬돼 있다. 정렬을 걸지 마라.");
}
