#!/usr/bin/env node
/* 지표 열(숫자 열)에 글자가 들어 있는 칸을 찾는다.
 *
 *   node scan-junk.mjs --out <작업폴더>/junk.json
 *
 * 왜 이게 있나.
 * 260831 런이 여기서 섰다. 완료 검사는 "지표 열에 비공개 문자열 0건"을 요구하는데
 * 계획을 만드는 쪽은 그 칸을 아예 못 봤다. 그래서 계획에 못 들어갔고, 계획에 없으니
 * 건드릴 수도 없었다. 런너가 세 번 재검증하고 사람을 불렀다. 끝날 수 없는 조건이었다.
 *
 * 왜 못 봤나. **gviz 는 숫자 열에 든 문자열을 빈칸으로 돌려준다.**
 * `tqx=out:csv` 도 `out:json` 도 똑같이 null 이다. CSV 대조로는 영영 안 잡힌다.
 * 반면 `export?format=csv` 는 서식 그대로라 글자가 그대로 나온다.
 * **두 눈이 어긋나는 칸이 곧 그 문자열이다.** 자격증명 없이 이걸로 찾는다.
 *
 * 대신 export 는 숫자에도 콤마를 붙여 주니(17000 → "17,000") export 만 보고
 * "콤마가 있으니 문자열" 이라고 읽으면 안 된다. 반드시 둘을 대조한다.
 */

import fs from "node:fs";
import { decodeJsStringContent } from "../../../lib/js-string.mjs";

const SHEET_ID = "1heUo8C09kEHMQo7qOTYC5bMOCSMTHCvb-m7O3tm2BOE";

/* 이 업무가 숫자만 있어야 한다고 보는 열
 *
 * **플랫폼으로 거르지 않는다.** 숫자 열에 글자가 든 것은 인스타든 샤오홍슈든 똑같이 고장이다.
 * gviz 가 그 칸을 빈칸으로 돌려주니 수식도 죽고 계획에도 안 잡힌다.
 * 플랫폼 거르기는 "빈칸을 몇 개 채워야 하나" 를 셀 때(build-targets)만 하는 일이다. */
export const TABS = [
  { tab: "인플루언서", columns: ["릴스 중앙 조회수", "팔로워", "노트 중앙 좋아요"], platform: null },
  { tab: "유입", columns: ["릴스 중앙 조회수", "좋아요 중앙값", "팔로워"], platform: null },
];

export function parseCsv(t) {
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

const bl = (v) => !String(v ?? "").trim();
const txt = (v) => String(v ?? "").trim();

async function get(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`못 받았다: HTTP ${r.status} ${url}`);
  return r.text();
}

/* 탭 이름 → gid. htmlview 안에 이름과 gid 가 나란히 들어 있다.
 * gid 를 매뉴얼에 적어 두면 다른 세션이 탭을 만들거나 지운 날 조용히 엉뚱한 탭을 읽는다. */
export async function resolveGids(sheetId = SHEET_ID) {
  const html = await get(`https://docs.google.com/spreadsheets/d/${sheetId}/htmlview`);
  const map = new Map();
  for (const m of html.matchAll(/name:\s*"((?:[^"\\]|\\.)*)"[\s\S]{0,400}?gid:\s*"(\d+)"/g)) {
    const name = decodeJsStringContent(m[1]);
    if (!map.has(name)) map.set(name, m[2]);
  }
  if (!map.size) throw new Error("htmlview 에서 탭 gid 를 못 읽었다. 시트 공유 설정을 본다");
  return map;
}

/* 줄여 쓴 표기의 배수. 인스타는 K M, 샤오홍슈는 만 w 万 을 쓴다 */
const UNITS = { k: 1e3, m: 1e6, b: 1e9, w: 1e4, 천: 1e3, 만: 1e4, 억: 1e8, 万: 1e4, 亿: 1e8 };

/* 숫자로 읽히는 글자면 그 숫자를 준다.
 *
 *   "14,000" → 14000    "783.2K" → 783200    "9.9만" → 99000
 *   "1.2M"   → 1200000  "1.2w"   → 12000     "3천"   → 3000
 *
 * **줄여 쓴 표기를 그대로 두면 안 된다.** 숫자 열에 든 글자라 gviz 가 빈칸으로 돌려주고,
 * 그러면 `예상 조회수` 같은 수식이 죽고 계획에도 안 잡혀서 영영 안 고쳐지는 칸이 된다.
 * 화면에는 값이 보이는데 어느 도구도 못 읽는 상태라 사람 눈에만 멀쩡해 보인다.
 *
 * **편 값은 근사값이다.** `783.2K` 의 원래 값은 783,163 일 수도 있다.
 * 그래서 `근사` 를 같이 돌려준다. 나중에 그 계정을 실측하면 이 칸은 덮어써도 되는 칸이다. */
export function asNumber(s) {
  const t = txt(s).replace(/[,\s₩¥￦]/g, "");
  if (!t) return null;
  const m = t.match(/^(-?\d+(?:\.\d+)?)\s*([a-zA-Z천만억万亿]?)$/);
  if (!m) return null;
  const unit = m[2] ? UNITS[m[2].toLowerCase()] ?? UNITS[m[2]] : 1;
  if (!unit) return null;
  const n = Number(m[1]) * unit;
  return Number.isFinite(n) ? Math.round(n) : null;
}

/* 줄여 쓴 표기였는가. 편 값이 근사값이라는 표시다 */
export function isAbbrev(s) {
  return /[a-zA-Z천만억万亿]/.test(txt(s).replace(/[,\s₩¥￦]/g, ""));
}

export async function scanTab({ sheetId = SHEET_ID, tab, gid, columns, platform = null, keyColumn = "계정" }) {
  const typed = parseCsv(
    await get(`https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&headers=2&sheet=${encodeURIComponent(tab)}`),
  );
  const shown = parseCsv(
    await get(`https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`),
  );

  const H = typed[0].map(txt);
  let tb = typed.slice(1);
  const eH = shown[1] ? shown[1].map(txt) : [];
  let eb = shown.slice(2);
  while (eb.length && eb[eb.length - 1].every(bl)) eb.pop();
  while (tb.length && tb[tb.length - 1].every(bl)) tb.pop();

  const iKey = H.indexOf(keyColumn), jKey = eH.indexOf(keyColumn);
  if (iKey < 0 || jKey < 0) throw new Error(`${tab}: "${keyColumn}" 열이 없다`);

  // 두 눈이 같은 줄을 보고 있는지부터 확인한다. 어긋나면 gid 가 틀린 것이니 멈춘다
  if (tb.length !== eb.length) {
    throw new Error(`${tab}: 줄 수가 다르다 (gviz ${tb.length}, export ${eb.length}). gid ${gid} 를 다시 본다`);
  }
  const mismatch = tb.reduce((n, r, i) => n + (txt(r[iKey]) === txt(eb[i][jKey]) ? 0 : 1), 0);
  if (mismatch) throw new Error(`${tab}: 계정 열이 ${mismatch}줄 어긋난다. gid ${gid} 가 이 탭이 맞는지 본다`);

  const iPlat = eH.indexOf("플랫폼");
  const junk = [];
  const skippedByPlatform = [];
  for (const col of columns) {
    const i = H.indexOf(col), j = eH.indexOf(col);
    if (i < 0 || j < 0) continue;
    for (let r = 0; r < tb.length; r++) {
      if (!bl(tb[r][i]) || bl(eb[r][j])) continue; // 자료형 뷰에 값이 있으면 숫자다. 서식 뷰가 비었으면 진짜 빈칸이다
      const item = {
        tab,
        key: txt(eb[r][jKey]),
        column: col,
        value: txt(eb[r][j]),
        플랫폼: iPlat >= 0 ? txt(eb[r][iPlat]) : "",
        시트행: r + 3, // 1행 제목, 2행 머리글
      };
      const n = asNumber(item.value);
      item.제안 = n === null ? "clear" : "set";
      if (n !== null) {
        item.숫자 = n;
        if (isAbbrev(item.value)) item.근사 = true; // 줄여 쓴 표기를 편 값. 실측이 나오면 덮어쓴다
      }
      if (platform && item.플랫폼 && item.플랫폼 !== platform) { skippedByPlatform.push(item); continue; }
      junk.push(item);
    }
  }
  return { tab, gid, 행: tb.length, 검사한열: columns.filter((c) => H.includes(c)), junk, 다른플랫폼: skippedByPlatform };
}

export async function scanAll({ sheetId = SHEET_ID, tabs = TABS, allPlatforms = false } = {}) {
  const gids = await resolveGids(sheetId);
  const out = { 시트: sheetId, 탭: {}, junk: [], 다른플랫폼: [] };
  for (const t of tabs) {
    const gid = gids.get(t.tab);
    if (!gid) throw new Error(`시트에 "${t.tab}" 탭이 없다. 탭 이름이 바뀌었는지 본다`);
    const r = await scanTab({ sheetId, gid, ...t, platform: allPlatforms ? null : t.platform });
    out.탭[t.tab] = { gid, 행: r.행, 검사한열: r.검사한열, 건수: r.junk.length, 다른플랫폼: r.다른플랫폼.length };
    out.junk.push(...r.junk);
    out.다른플랫폼.push(...r.다른플랫폼);
  }
  out.요약 = out.junk.length
    ? out.junk.map((x) => `${x.tab}/${x.key}/${x.column}=${x.value}`).join(", ")
    : "지표 열에 글자 0건";
  return out;
}

// ── CLI ───────────────────────────────────────────────────────────────────────────
const invokedPath = process.argv[1]?.replace(/\\/g, "/");
if (invokedPath && (import.meta.url === `file://${invokedPath}` || invokedPath.endsWith("scan-junk.mjs"))) {
  const argv = process.argv.slice(2);
  const flag = (n, d = null) => {
    const i = argv.indexOf("--" + n);
    return i > -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
  };
  const res = await scanAll({ sheetId: flag("sheet-id", SHEET_ID), allPlatforms: argv.includes("--all-platforms") });
  const out = flag("out");
  if (out) fs.writeFileSync(out, JSON.stringify(res, null, 1), "utf8");
  console.log(JSON.stringify(res, null, 1));
}
