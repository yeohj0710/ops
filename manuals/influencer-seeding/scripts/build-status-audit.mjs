#!/usr/bin/env node
/* 「인플루언서」 탭의 진행 상태가 협상 메모·진행 증거와 맞는지 점검한다.
 *
 *   node build-status-audit.mjs --out <작업폴더>/status-audit.json
 *   node build-status-audit.mjs --self-test
 *
 * 값을 쓰지 않는다. 명시적인 근거만 자동 변경 후보로 만들고, 수락·취소처럼
 * 원문이나 확정 체크를 다시 봐야 하는 것은 검토 목록으로 분리한다.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { readRows } from "./build-sort-plan.mjs";

const SHEET_ID = "1heUo8C09kEHMQo7qOTYC5bMOCSMTHCvb-m7O3tm2BOE";
const TAB = "인플루언서";

const txt = (value) => String(value ?? "").trim();
const isTrue = (value) => value === true || value === 1 || txt(value).toUpperCase() === "TRUE";
const has = (text, patterns) => patterns.some((pattern) => pattern.test(text));

const CANCELLATION = [
  /(?:이번\s*캠페인|배정|협업|진행).{0,20}(?:취소|철회|빠짐|불참)/i,
  /\b(?:cancel(?:led)?|withdraw(?:n)?)\b/i,
];
const REJECTION = [
  /(?:명시적\s*)?거절/i,
  /(?:광고|협업|캠페인|참여|진행).{0,20}(?:안\s*함|안\s*받|않겠|하지\s*않|불가)/i,
  /(?:관심|의향).{0,10}(?:없음|없다)/i,
  /협상\s*불가/i,
  /조건.{0,15}(?:맞지\s*않|안\s*맞)/i,
  /\bnot\s+interested\b/i,
  /\bdeclin(?:e|ed)\b/i,
  /(?:拒绝|不参加|不合作)/,
];
const REJECT_FIT = [
  /(?:콘텐츠|언어권|캠페인|약국\s*이미지|타깃).{0,20}(?:부적합|맞지\s*않|안\s*맞)/i,
  /(?:이미지|콘텐츠).{0,30}약국.{0,20}(?:맞지\s*않|안\s*맞)/i,
  /(?:부적합|내부\s*제외)/i,
];
const SCHEDULE_HOLD = [
  /(?:\d{1,2}\s*월|다음\s*달|귀국\s*후|입국\s*후).{0,25}(?:부터\s*)?(?:가능|희망)/i,
  /(?:현재|지금).{0,15}(?:방문|촬영)\s*일정.{0,10}없.{0,40}(?:향후|나중).{0,20}(?:협력|협업)\s*희망/i,
  /(?:일정|스케줄|방문|촬영).{0,20}(?:미룸|미뤄|연기|보류)/i,
  /일정.{0,15}(?:차\s*있|가득)/i,
  /(?:현재|지금|그때).{0,10}한국에.{0,12}(?:없|계시지\s*않)/i,
];
const NEGOTIATION = [
  /(?:가격|비용|금액|단가|예산|페이팔|fee|budget).{0,25}(?:요구|희망|제시|문의|얼마|협의|협상|조율)/i,
  /(?:요구|희망|제시|문의|얼마|협의|협상|조율).{0,25}(?:가격|비용|금액|단가|예산|원|fee|budget)/i,
  /(?:₩|￦|\bKRW\b|\d[\d,.]*\s*원).{0,15}(?:요구|희망|제시|문의|협의|협상|조율)/i,
  /(?:세금계산서|지급일|payment).{0,20}(?:질문|문의|협의|조율)/i,
  /조건.{0,20}(?:협의\s*중|조율\s*중|문의)/i,
];
const HOLD = [
  /DM\s*불가/i,
  /(?:연락\s*(?:수단|방법)|컨택).{0,12}(?:없|불가)/i,
  /(?:방문\s*(?:계획|일정)).{0,12}(?:없|미정)/i,
];
const ACCEPTANCE = [
  /(?:수락|동의)/i,
  /(?:협업|캠페인|참여|진행).{0,20}(?:하겠|가능|확정)/i,
  /합의.{0,10}(?:완료|확정)/i,
  /\b(?:accept(?:ed)?|agreed)\b/i,
  /(?:同意合作|接受合作|参加できます)/,
];
const NO_REPLY = [/(?:답장|회신|응답).{0,10}(?:없|대기)/i];
const NO_PROOF = [
  /(?:합의|수락).{0,20}(?:원문.{0,10}없|확인되지\s*않|확인\s*안\s*됨)/i,
  /(?:원문|증거).{0,15}(?:없|미확인)/i,
];

function candidate(row, recommendedStatus, reason, evidenceColumn = "③협상 관련 메모", mode = "auto") {
  const currentStatus = txt(row["진행 상태"]);
  if (currentStatus === recommendedStatus && mode === "auto") return null;
  return {
    mode,
    row: row.row,
    key: row.key,
    currentStatus,
    recommendedStatus,
    reason,
    evidenceColumn,
    evidence: txt(row[evidenceColumn]),
  };
}

export function classifyRow(row) {
  const currentStatus = txt(row["진행 상태"]);
  const memo = txt(row["③협상 관련 메모"]);
  const confirmed = isTrue(row["⑤확정"]);

  if (confirmed) {
    if (has(memo, CANCELLATION)) {
      return candidate(row, "확인 필요", "확정 체크와 취소·철회 메모가 충돌함", "③협상 관련 메모", "review");
    }
    return candidate(row, "확정", "⑤확정이 TRUE", "⑤확정");
  }

  if (!memo) {
    if (currentStatus === "확정") {
      return candidate(row, "확인 필요", "확정 상태인데 ⑤확정과 협상 메모 근거가 없음", "진행 상태", "review");
    }
    return null;
  }

  if (currentStatus === "확정" && has(memo, CANCELLATION)) {
    return candidate(row, "확인 필요", "확정 상태와 취소·철회 메모가 충돌함", "③협상 관련 메모", "review");
  }
  if (has(memo, SCHEDULE_HOLD)) return candidate(row, "일정 보류", "참여 의사는 있으나 일정이 미뤄진 메모");
  if (has(memo, REJECTION)) return candidate(row, "거절", "명시적 거절 또는 참여 불가 메모");
  if (has(memo, REJECT_FIT)) return candidate(row, "반려", "콘텐츠·언어권·캠페인 적합도 부족 메모");
  if (has(memo, NO_REPLY) || has(memo, NO_PROOF)) return null;
  if (has(memo, NEGOTIATION)) return candidate(row, "협상중", "금액·조건 협상 메모");
  if (has(memo, HOLD)) return candidate(row, "보류", "연락 통로나 방문 계획이 없는 메모");
  if (has(memo, ACCEPTANCE)) {
    return candidate(row, "확정", "수락으로 보이는 메모는 원문과 ⑤확정을 확인해야 함", "③협상 관련 메모", "review");
  }
  return null;
}

export async function buildStatusAudit(opts = {}) {
  const sheet = await readRows({ sheetId: opts.sheetId ?? SHEET_ID, tab: opts.tab ?? TAB, gid: opts.gid });
  const candidates = sheet.rows.map(classifyRow).filter(Boolean);
  const auto = candidates.filter((item) => item.mode === "auto");
  const review = candidates.filter((item) => item.mode === "review");
  return {
    시트: opts.sheetId ?? SHEET_ID,
    탭: opts.tab ?? TAB,
    gid: sheet.gid,
    행: sheet.rows.length,
    자동변경후보: auto,
    검토후보: review,
    요약: {
      자동변경: auto.length,
      검토필요: review.length,
      상태별: Object.fromEntries([...new Set(auto.map((item) => item.recommendedStatus))].map((status) => [status, auto.filter((item) => item.recommendedStatus === status).length])),
    },
  };
}

function selfTest() {
  const row = (status, memo, extra = {}) => ({ row: 3, key: "@test", "진행 상태": status, "③협상 관련 메모": memo, "⑤확정": "FALSE", ...extra });
  assert.equal(classifyRow(row("협상중", "", { "⑤확정": "TRUE" })).recommendedStatus, "확정");
  assert.equal(classifyRow(row("협상중", "11월부터 촬영 가능하다고 하심")).recommendedStatus, "일정 보류");
  assert.equal(classifyRow(row("1차 발송", "이번 캠페인은 진행하지 않겠습니다")).recommendedStatus, "거절");
  assert.equal(classifyRow(row("미접촉", "콘텐츠가 캠페인에 맞지 않음")).recommendedStatus, "반려");
  assert.equal(classifyRow(row("미접촉", "DM불가")).recommendedStatus, "보류");
  assert.equal(classifyRow(row("1차 발송", "150,000원 희망")).recommendedStatus, "협상중");
  assert.equal(classifyRow(row("협상중", "협업 진행하겠습니다")).mode, "review");
  assert.equal(classifyRow(row("확정", "11월부터 촬영 가능", { "⑤확정": "TRUE" })), null);
  assert.equal(classifyRow(row("확정", "이번 배정 취소", { "⑤확정": "TRUE" })).mode, "review");
  console.log("build-status-audit self-test: ok");
}

if (process.argv[1] && process.argv[1].replaceAll("\\", "/").endsWith("build-status-audit.mjs")) {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) selfTest();
  else {
    const flag = (name, fallback = null) => {
      const index = argv.indexOf(`--${name}`);
      return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[index + 1] : fallback;
    };
    const result = await buildStatusAudit({
      sheetId: flag("sheet-id", SHEET_ID),
      tab: flag("tab", TAB),
      gid: flag("gid"),
    });
    const out = flag("out");
    if (out) fs.writeFileSync(out, JSON.stringify(result, null, 1), "utf8");
    console.log(JSON.stringify({ 탭: result.탭, 행: result.행, ...result.요약 }, null, 1));
  }
}
