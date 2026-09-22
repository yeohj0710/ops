#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseCsv } from "./sheet-diff.mjs";

const txt = (v) => String(v ?? "").trim();
const normAccount = (v) => txt(v).toLowerCase().replace(/^@/, "").replace(/[\s\u200b-\u200d\ufeff]/g, "").replace(/\/$/, "");
const platform = (v) => txt(v).includes("샤오") ? "샤오홍슈" : "인스타그램";
const keyOf = (p, a) => `${platform(p)}|${normAccount(a)}`;

export function estimatedViews(followers) {
  const n = Number(followers);
  if (!Number.isFinite(n) || n <= 0) return null;
  const factor = n < 3000 ? 1.4 : n < 5000 ? 1.2 : n < 10000 ? 0.76 : n < 30000 ? 0.69 : n < 50000 ? 0.60 : 0.55;
  return Math.round(n * factor);
}

export function offer(viewCount, wonPerView, floor, ceiling = 300000) {
  if (!Number.isFinite(viewCount) || viewCount <= 0) return null;
  return Math.min(ceiling, Math.max(floor, Math.round((viewCount * wonPerView) / 10000) * 10000));
}

const followerBand = (n) => n < 3000 ? "3천 미만" : n < 5000 ? "3천~5천" : n < 10000 ? "5천~1만" : n < 30000 ? "1만~3만" : n < 50000 ? "3만~5만" : "5만 이상";

function indexCsv(file, keyColumn = "계정", platformColumn = "플랫폼") {
  const csv = parseCsv(fs.readFileSync(file, "utf8"));
  const header = csv[0] || [];
  const ki = header.indexOf(keyColumn);
  const pi = header.indexOf(platformColumn);
  if (ki < 0 || pi < 0) throw new Error(`${file}: ${keyColumn}/${platformColumn} 머리글을 못 찾았다`);
  const keys = new Set();
  const accounts = new Set();
  for (const row of csv.slice(1)) {
    if (!txt(row[ki])) continue;
    keys.add(keyOf(row[pi], row[ki]));
    accounts.add(normAccount(row[ki]));
  }
  return { header, rows: csv.slice(1), keys, accounts };
}

function sourceUrl(item, sources) {
  return item.language === "일본어권" ? sources.japan : item.language === "국내" ? sources.domestic : sources.china;
}

function intakeFields(x) {
  const views = estimatedViews(x.followers);
  return {
    "수집일": x.collectionDate,
    "언어권": x.language,
    "플랫폼": x.platform,
    "계정": x.platform === "인스타그램" ? `@${normAccount(x.account)}` : normAccount(x.account),
    "이름": x.name,
    "팔로워": Number(x.followers),
    "릴스 중앙 조회수": views,
    "한국 거주": x.residence,
    "거주 근거": x.evidence,
    "발견 경로": x.discovery,
    ...(x.profileUrl ? { "프로필 URL": x.profileUrl } : {}),
    "처리": x.processing,
    "메모": `${x.note} · 중앙 조회수=${views}회 팔로워 구간 추정`,
  };
}

function influencerFields(x, sources) {
  const views = estimatedViews(x.followers);
  const firstOffer = offer(views, 5, 30000);
  const needsHighOfferReview = firstOffer >= 200000;
  const account = x.platform === "인스타그램" ? `@${normAccount(x.account)}` : normAccount(x.account);
  const source = sourceUrl(x, sources);
  const common = {
    "언어권": x.language,
    "플랫폼": x.platform,
    "진행 상태": needsHighOfferReview ? "확인 필요" : "미접촉",
    "계정": account,
    "출처": "직접 조사",
    "연락 수단": x.platform === "샤오홍슈" ? "없음" : "DM",
    ...(x.platform === "인스타그램" ? { "공개 연락처": "Instagram DM" } : {}),
    "이름": x.name,
    "팔로워": Number(x.followers),
    "릴스 중앙 조회수": views,
    "한국 접점": x.residence === "확실" ? "한국 상주 확인" : "한국 접점·체류 불명",
    "①DM 발송": false,
    "②응답": false,
    "⑤확정": false,
    "배정 건": "미배정",
    "⑦가이드 전달": false,
    "⑧촬영": false,
    "⑨초안 검수": false,
    "⑩업로드": false,
    "⑪정산자료": false,
    "⑫지급": false,
    "품질·운영 메모": `노션 직접 선별 목록 동기화 · ${views}회 팔로워 구간 추정 · 실측 전환 필요`,
    ...(x.profileUrl ? { "프로필 링크": x.profileUrl } : {}),
    "팔로워 구간": followerBand(Number(x.followers)),
    "한국 접점 근거": x.evidence,
    "근거 URL": source,
    "추천 액션": needsHighOfferReview
      ? (x.platform === "샤오홍슈"
        ? "20만원 이상 후보 · 앱에서 팔로워·노트 중앙 좋아요 재확인 전 발송 금지"
        : "20만원 이상 후보 · 릴스 9개(핀 제외) 재확인 전 발송 금지")
      : (x.platform === "샤오홍슈" ? "앱에서 팔로워·노트 중앙 좋아요 재확인" : "릴스 9개(핀 제외) 재확인 후 실측 전환"),
    "원본": "Notion 직접 선별 목록",
    "원본 증거 ID": source,
    "조회수 근거": "팔로워 구간 추정",
    "출처 상세": "Notion 선별 · 직접 조사",
  };
  if (x.platform === "샤오홍슈") {
    common["샤오홍슈 ID"] = normAccount(x.account);
    common["닉네임"] = x.name;
  }
  return common;
}

function operations(items, mapper) {
  return items.flatMap((item) => Object.entries(mapper(item)).filter(([, value]) => value !== "" && value !== null && value !== undefined).map(([column, value]) => ({ type: "set", key: item.platform === "인스타그램" ? `@${normAccount(item.account)}` : normAccount(item.account), column, value })));
}

export function build({ payload, beforeIntake, beforeInfluencer }) {
  const intake = indexCsv(beforeIntake);
  const influencers = indexCsv(beforeInfluencer);
  const seen = new Set();
  const errors = [];
  const intakeNew = [];
  const influencerNew = [];

  for (const item of payload.items || []) {
    const k = keyOf(item.platform, item.account);
    if (!normAccount(item.account) || !txt(item.name) || !Number.isFinite(Number(item.followers)) || Number(item.followers) <= 0) errors.push(`${k}: 계정·이름·팔로워 필수`);
    if (seen.has(k)) errors.push(`${k}: 노션 후보 중복`);
    seen.add(k);
    if (item.promotion && influencers.accounts.has(normAccount(item.account)) && !influencers.keys.has(k)) {
      errors.push(`${k}: 다른 플랫폼에 같은 계정이 있다. 처리=중복·promotion=false로 통합 판정하라`);
    }
    if (!intake.keys.has(k)) intakeNew.push(item);
    if (item.promotion && !influencers.keys.has(k)) influencerNew.push(item);
  }
  if (errors.length) throw new Error(errors.join("\n"));

  const intakeAllowed = [...new Set(intakeNew.flatMap((x) => Object.keys(intakeFields(x))))];
  const infAllowed = [...new Set(influencerNew.flatMap((x) => Object.keys(influencerFields(x, payload.sources))))];
  const intakeKeys = intakeNew.map((x) => x.platform === "인스타그램" ? `@${normAccount(x.account)}` : normAccount(x.account));
  const infKeys = influencerNew.map((x) => x.platform === "인스타그램" ? `@${normAccount(x.account)}` : normAccount(x.account));
  const formulaColumns = ["1차 제안", "2차 상향", "3차 상향(상한)", "단가 산정 근거", "예상 조회수", "조회당 단가", "계정 정규화(비교용)"];

  return {
    summary: {
      notionCandidates: payload.items.length,
      intakeNew: intakeNew.length,
      influencerNew: influencerNew.length,
      rejected: payload.items.filter((x) => x.processing === "반려").length,
      pending: payload.items.filter((x) => x.processing === "신규").length,
      highOfferReview: influencerNew.filter((x) => offer(estimatedViews(x.followers), 5, 30000) >= 200000).map((x) => ({ account: x.account, estimatedViews: estimatedViews(x.followers), firstOffer: offer(estimatedViews(x.followers), 5, 30000) })),
    },
    intakeNew,
    influencerNew,
    intakePlan: { sheet: "유입", keyColumn: "계정", beforeSnapshot: beforeIntake, allowedColumns: intakeAllowed, protectedColumns: [], allowedClears: [], operations: operations(intakeNew, intakeFields) },
    influencerPlan: { sheet: "인플루언서", keyColumn: "계정", beforeSnapshot: beforeInfluencer, allowedColumns: infAllowed, protectedColumns: formulaColumns, allowedClears: [], operations: operations(influencerNew, (x) => influencerFields(x, payload.sources)) },
    diffAllow: {
      "유입": { keyColumn: "계정", columns: intakeAllowed, keys: [], newKeys: intakeKeys, deletedKeys: [], emptyCells: [], protectedColumns: [], externalColumns: [] },
      "인플루언서": { keyColumn: "계정", columns: infAllowed, keys: [], newKeys: infKeys, deletedKeys: [], emptyCells: [], protectedColumns: ["④합의 단가"], externalColumns: formulaColumns },
    },
  };
}

function selfTest() {
  assert.equal(estimatedViews(2999), 4199);
  assert.equal(estimatedViews(3000), 3600);
  assert.equal(estimatedViews(5000), 3800);
  assert.equal(estimatedViews(10000), 6900);
  assert.equal(estimatedViews(30000), 18000);
  assert.equal(estimatedViews(50000), 27500);
  assert.equal(offer(3600, 5, 30000), 30000);
  assert.equal(offer(69000, 5, 30000), 300000);
  const high = influencerFields({
    language: "국내", platform: "인스타그램", account: "high", name: "고가",
    followers: 100000, residence: "확실", evidence: "테스트", profileUrl: "",
  }, { china: "c", japan: "j", domestic: "d" });
  assert.equal(high["진행 상태"], "확인 필요");
  assert.match(high["추천 액션"], /핀 제외.*발송 금지/);
  console.log("build-notion-direct-sync-plan self-test: 10/10 passed");
}

function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--self-test")) selfTest();
  else {
    const input = arg("--input"), beforeDir = arg("--before"), outDir = arg("--out");
    if (!input || !beforeDir || !outDir) throw new Error("쓰는 법: --input <notion-candidates.json> --before <before 폴더> --out <결과 폴더>");
    fs.mkdirSync(outDir, { recursive: true });
    const result = build({ payload: JSON.parse(fs.readFileSync(input, "utf8")), beforeIntake: path.join(beforeDir, "유입.csv"), beforeInfluencer: path.join(beforeDir, "인플루언서.csv") });
    fs.writeFileSync(path.join(outDir, "유입-write-plan.json"), JSON.stringify(result.intakePlan, null, 2) + "\n");
    fs.writeFileSync(path.join(outDir, "인플루언서-write-plan.json"), JSON.stringify(result.influencerPlan, null, 2) + "\n");
    fs.writeFileSync(path.join(outDir, "diff-allow.json"), JSON.stringify(result.diffAllow, null, 2) + "\n");
    fs.writeFileSync(path.join(outDir, "sync-data.json"), JSON.stringify({ intakeNew: result.intakeNew, influencerNew: result.influencerNew }, null, 2) + "\n");
    fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(result.summary, null, 2) + "\n");
    console.log(JSON.stringify(result.summary, null, 2));
  }
}
