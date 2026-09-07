#!/usr/bin/env node

// 통합 원장과 구_국내/구_일본 보관본을 대조한다.
// 단순히 "메인에 같은 핸들이 없음"을 미이관으로 세지 않는다.
// 현재 핸들의 병합 기록, 승인된 팔로워 범위 제외 규칙, 게시물 없는 계정을 따로 분류한다.

import assert from "node:assert/strict";
import fs from "node:fs";
import { parseCsv } from "./sheet-diff.mjs";

const SHEET_ID = "1heUo8C09kEHMQo7qOTYC5bMOCSMTHCvb-m7O3tm2BOE";
const OLD_TABS = ["구_국내 진행표", "구_일본 진행표"];
const txt = v => String(v ?? "").trim();
const norm = v => txt(v).normalize("NFKC").toLowerCase().replace(/[\s\u200b-\u200d\ufeff]/g, "");

export function normAccount(v) {
  let s = norm(v);
  const match = s.match(/(?:instagram\.com|instagr\.am)\/([^/?#]+)/i);
  if (match) s = match[1];
  return s.replace(/^@+/, "").replace(/[/?#].*$/, "");
}

export function headerIndex(header, name) {
  const target = norm(name);
  return header.findIndex(value => {
    const current = norm(value);
    return current === target || current.endsWith(target);
  });
}

function get(row, header, name) {
  const index = headerIndex(header, name);
  return index < 0 ? "" : txt(row[index]);
}

const isTrue = v => txt(v).toUpperCase() === "TRUE" || v === true || v === 1;
const number = v => {
  const n = Number(txt(v).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
};

export function isRangeExcluded(row, header) {
  const followers = number(get(row, header, "팔로워"));
  if (followers === null || (followers >= 5000 && followers <= 80000)) return false;
  const status = get(row, header, "진행 상태");
  const neverContacted = status === "미접촉" && !isTrue(get(row, header, "①DM 발송")) && !isTrue(get(row, header, "②응답"));
  return neverContacted || ["보류", "반려", "거절"].includes(status);
}

export function isNoPosts(row, header) {
  return number(get(row, header, "팔로워")) === null && /게시물\s*없음/.test(get(row, header, "품질·운영 메모"));
}

async function download(tab, sheetId = SHEET_ID) {
  const url = new URL(`https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq`);
  url.searchParams.set("tqx", "out:csv");
  url.searchParams.set("headers", "2");
  url.searchParams.set("sheet", tab);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${tab}: HTTP ${response.status}`);
  return response.text();
}

function table(csv) {
  const rows = parseCsv(csv);
  return { header: rows[0] ?? [], rows: rows.slice(1) };
}

export function audit(mainCsv, oldCsvByTab) {
  const main = table(mainCsv);
  const mainAccount = headerIndex(main.header, "계정");
  const mainMerge = headerIndex(main.header, "병합 기록");
  assert.ok(mainAccount >= 0 && mainMerge >= 0, "메인 계정/병합 기록 머리글을 못 찾았다");

  const mainByAccount = new Map();
  const mergeRows = [];
  main.rows.forEach((row, index) => {
    const key = normAccount(row[mainAccount]);
    if (key) {
      if (!mainByAccount.has(key)) mainByAccount.set(key, []);
      mainByAccount.get(key).push(index + 3);
    }
    const merge = txt(row[mainMerge]);
    if (merge) mergeRows.push({ row: index + 3, account: txt(row[mainAccount]), text: merge, norm: norm(merge) });
  });

  const tabs = [];
  for (const tab of OLD_TABS) {
    const old = table(oldCsvByTab[tab]);
    const accountIndex = headerIndex(old.header, "계정");
    assert.ok(accountIndex >= 0, `${tab}: 계정 머리글을 못 찾았다`);
    const result = { tab, total: 0, direct: 0, renamed: [], rangeExcluded: [], noPosts: [], unresolved: [] };
    old.rows.forEach((row, index) => {
      const account = txt(row[accountIndex]);
      const key = normAccount(account);
      if (!key) return;
      result.total++;
      if (mainByAccount.has(key)) { result.direct++; return; }
      const aliases = mergeRows.filter(x => x.norm.includes(`@${key}`) || x.norm.includes(`구핸들${key}`));
      if (aliases.length) {
        result.renamed.push({ oldRow: index + 3, oldAccount: account, mainRows: aliases.map(x => x.row), mainAccounts: aliases.map(x => x.account) });
      } else if (isRangeExcluded(row, old.header)) {
        result.rangeExcluded.push({ oldRow: index + 3, account, followers: get(row, old.header, "팔로워"), status: get(row, old.header, "진행 상태") });
      } else if (isNoPosts(row, old.header)) {
        result.noPosts.push({ oldRow: index + 3, account, reason: "게시물 없음" });
      } else {
        result.unresolved.push({ oldRow: index + 3, account, name: get(row, old.header, "이름"), followers: get(row, old.header, "팔로워"), status: get(row, old.header, "진행 상태") });
      }
    });
    tabs.push(result);
  }

  const duplicateMainAccounts = [...mainByAccount.entries()].filter(([, rows]) => rows.length > 1).map(([account, rows]) => ({ account, rows }));
  return {
    generatedAt: new Date().toISOString(),
    tabs,
    duplicateMainAccounts,
    summary: Object.fromEntries(tabs.map(x => [x.tab, {
      total: x.total,
      direct: x.direct,
      renamed: x.renamed.length,
      rangeExcluded: x.rangeExcluded.length,
      noPosts: x.noPosts.length,
      unresolved: x.unresolved.length
    }]))
  };
}

function selfTest() {
  const header = ["팔로워", "진행 상태", "①DM 발송", "②응답", "품질·운영 메모"];
  assert.equal(isRangeExcluded(["4,999", "미접촉", "FALSE", "FALSE", ""], header), true);
  assert.equal(isRangeExcluded(["80,001", "미접촉", "FALSE", "FALSE", ""], header), true);
  assert.equal(isRangeExcluded(["5,000", "미접촉", "FALSE", "FALSE", ""], header), false);
  assert.equal(isRangeExcluded(["80,000", "미접촉", "FALSE", "FALSE", ""], header), false);
  assert.equal(isRangeExcluded(["4,000", "1차 발송", "TRUE", "FALSE", ""], header), false);
  assert.equal(isNoPosts(["", "미접촉", "FALSE", "FALSE", "게시물 없음"], header), true);
  console.log("audit-legacy-tabs self-test: 6/6 passed");
}

if (process.argv.includes("--self-test")) selfTest();
else {
  const outAt = process.argv.indexOf("--out");
  const out = outAt >= 0 ? process.argv[outAt + 1] : null;
  const [mainCsv, ...oldCsvs] = await Promise.all(["인플루언서", ...OLD_TABS].map(tab => download(tab)));
  const result = audit(mainCsv, Object.fromEntries(OLD_TABS.map((tab, i) => [tab, oldCsvs[i]])));
  if (out) fs.writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ summary: result.summary, duplicateMainAccounts: result.duplicateMainAccounts }, null, 2));
  if (result.tabs.some(x => x.unresolved.length)) process.exitCode = 2;
}
