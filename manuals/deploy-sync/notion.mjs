#!/usr/bin/env node
// 배포 사이트 최신화 4단계. 노션 "각종 프로젝트 배포 링크" 페이지 본문을 만든다.
//
//   node notion.mjs
//
// 노션에 직접 쓰지 않는다. work/deploy-sync/notion-new.md 를 만들어 놓을 뿐이다.
// 그 파일로 페이지 윗부분을 갈아끼우는 것은 노션을 만질 수 있는 런너가 한다.
//
// 본문 원본은 여기가 아니라 <DEV>/dev-hub/notion.mjs 다
//   링크 목록, 설명, 배포 나이, 루프 현황은 전부 그쪽이 links.json 하나에서 찍는다.
//   여기서 같은 것을 다시 찍으면 두 벌이 되고, 한쪽만 고친 날 페이지가 망가진다.
//   260912 에 실제로 그랬다. 여기서 찍은 본문은 휴면 링크 21개가 (undefined) 로 나왔고
//   설명도 전부 빠져 있었다. 그대로 넣었으면 페이지가 통째로 퇴화했다.
//   그래서 이 스크립트는 dev-hub 본문을 받아 "사이트 점검" 한 덩어리만 끼워 넣는다.
//
// 이 스크립트가 만드는 것은 "사이트 점검" 절뿐이다
//   scan.json 의 판정을 사람 말로 옮긴다. dev-hub 는 이 절을 만들지 않는다.
//
// 페이지를 통째로 덮어쓰지 않는다
//   아래쪽 "진행 상황 브리핑" 은 사람과 다른 업무가 쌓아 온 기록이다.
//   통째로 덮어쓰면 옮겨 적다 한 글자만 틀려도 그 기록이 조용히 바뀐다.
//   그래서 윗부분만 갈아끼운다. 찾을 문장이 안 맞으면 노션이 오류를 내고 아무것도 안 바뀐다.
//   조용히 망가지는 것보다 시끄럽게 실패하는 쪽이 낫다.
//
// 먼저 있어야 하는 것
//   work/deploy-sync/notion-current-top.md   지금 페이지에서 브리핑 위까지만 받아 둔 것
//   work/deploy-sync/scan.json               scan.mjs 가 만든 것
//
// 바꾸는 법: update_content 한 번.
//   old_str = notion-current-top.md 내용 그대로
//   new_str = notion-new.md 내용 그대로

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OPS = path.resolve(HERE, "..", "..");
const OUT_DIR = path.join(OPS, "work", "deploy-sync");
const DEV = readDevRoot();
const HUB = path.join(DEV, "dev-hub");

function readDevRoot() {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(OPS, "machine.json"), "utf8").replace(/^﻿/, ""));
    if (m.dev_root) return m.dev_root.replace(/\//g, path.sep);
  } catch {}
  return path.resolve(OPS, "..");
}

// 줄표와 가운뎃점을 쓰지 않는다. 원자료에 섞여 들어와도 여기서 걸러 낸다.
function 말로바꾼다(s) {
  return String(s ?? "")
    .replace(/\s+[—–]\s+/g, ", ")
    .replace(/[—–]/g, ", ")
    .replace(/\s*·\s*/g, ", ");
}

const KST = (d) => {
  const p = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
  return p.replace(" ", " ") + " KST";
};

fs.mkdirSync(OUT_DIR, { recursive: true });

let scan = null;
try {
  scan = JSON.parse(fs.readFileSync(path.join(OUT_DIR, "scan.json"), "utf8").replace(/^﻿/, ""));
} catch {}

const 옛윗부분파일 = path.join(OUT_DIR, "notion-current-top.md");
const 옛윗부분 = fs.existsSync(옛윗부분파일) ? fs.readFileSync(옛윗부분파일, "utf8") : null;

// ── dev-hub 가 찍은 본문을 받는다 ────────────────────────────────

const 허브생성기 = path.join(HUB, "notion.mjs");
if (!fs.existsSync(허브생성기)) {
  console.error(`멈춘다. 본문 생성기가 없다: ${허브생성기}`);
  console.error("  링크 목록은 dev-hub 가 원장이다. 저장소를 먼저 받아 온다.");
  process.exit(1);
}

let 허브본문;
try {
  허브본문 = execFileSync(process.execPath, [허브생성기], {
    cwd: HUB,
    encoding: "utf8",
    timeout: 300000,
    maxBuffer: 32 * 1024 * 1024,
  });
} catch (e) {
  console.error(`멈춘다. dev-hub/notion.mjs 가 실패했다: ${e.message}`);
  process.exit(1);
}

const 줄 = 허브본문.replace(/\r\n/g, "\n").split("\n");
if (!줄.some((l) => l.startsWith("### **"))) {
  console.error("멈춘다. dev-hub 본문에 절 제목이 하나도 없다. 빈손으로 나온 것이다.");
  process.exit(1);
}

// ── 사이트 점검 절만 여기서 만든다 ──────────────────────────────

const 점검 = [];
if (scan) {
  const 표 = (헤더, 줄들) => {
    점검.push('<table fit-page-width="true" header-row="true">');
    점검.push("<tr>");
    for (const h of 헤더) 점검.push(`<td>${h}</td>`);
    점검.push("</tr>");
    for (const r of 줄들) {
      점검.push("<tr>");
      for (const c of r) 점검.push(`<td>${c}</td>`);
      점검.push("</tr>");
    }
    점검.push("</table>");
  };

  const 판정별 = scan.요약 ?? {};
  const 손볼것 = (scan.프로젝트 ?? []).filter((p) => p.판정 !== "최신" && p.판정 !== "휴면");

  점검.push("### **사이트 점검**");
  // 노션은 제목 아래 들여쓴 줄의 탭을 지우고 저장한다. 여기서 탭을 넣으면
  // 다음번에 "찾을 것" 이 페이지와 안 맞아 바꾸기가 실패한다. 그래서 안 넣는다.
  점검.push(
    `${KST(new Date(scan.찍은시각))} 기준. 등록된 사이트 ${scan.프로젝트?.length ?? 0}개를 셌습니다. ` +
      Object.entries(판정별)
        .map(([k, v]) => `${k} ${v}개`)
        .join(", ") +
      "."
  );
  if (손볼것.length) {
    표(
      ["사이트", "판정", "마지막 배포", "메모"],
      손볼것.map((p) => [p.프로젝트, p.판정, p.마지막배포 ?? "모름", 말로바꾼다(p.경고?.[0] ?? p.메모 ?? "")])
    );
  } else {
    점검.push("손볼 것이 없습니다. 전부 최신입니다.");
  }
  if (scan.유휴?.length) {
    점검.push(
      `쓰지 않는 Vercel 프로젝트가 ${scan.유휴.length}개 남아 있습니다. 되살리지 않고 그대로 둡니다. 지울지는 사람이 정합니다.`
    );
  }
  점검.push("<empty-block/>");
}

// ── 루프 현황 다음, 첫 링크 묶음 앞에 끼운다 ────────────────────

let 자리 = 줄.findIndex((l) => l.startsWith("### **"));
const 루프 = 줄.findIndex((l) => l.startsWith("### **루프 현황"));
if (루프 >= 0) {
  const 다음 = 줄.findIndex((l, i) => i > 루프 && l.startsWith("### **"));
  자리 = 다음 >= 0 ? 다음 : 줄.length;
}
if (자리 < 0) 자리 = 줄.length;

const 본문 = [...줄.slice(0, 자리), ...점검, ...줄.slice(자리)].join("\n").replace(/\n+$/, "\n");
fs.writeFileSync(path.join(OUT_DIR, "notion-new.md"), 본문, "utf8");

const 링크수 = 줄.filter((l) => /^- /.test(l)).length;
console.log(`새 윗부분을 만들었다: ${path.join(OUT_DIR, "notion-new.md")}`);
console.log(`  dev-hub 본문 ${줄.length}줄, 링크 줄 ${링크수}개, 사이트 점검 ${점검.length ? "넣음" : "못 넣음(scan.json 없음)"}`);

if (!점검.length) {
  console.log("  scan.json 이 없어 사이트 점검 절이 빠졌다. scan.mjs 를 먼저 돌린다.");
}

if (!옛윗부분) {
  console.log(`\n아직 못 바꾼다. ${path.basename(옛윗부분파일)} 가 없다.`);
  console.log("  노션 페이지를 열어 맨 위 callout 부터 '진행 상황 브리핑' 바로 앞까지를");
  console.log(`  그대로 ${옛윗부분파일} 에 저장하고 이 스크립트를 다시 돌린다.`);
} else if (옛윗부분.includes("진행 상황 브리핑")) {
  console.log("\n멈춘다. 받아 둔 윗부분에 '진행 상황 브리핑' 이 들어 있다.");
  console.log("  너무 많이 떠 왔다. 브리핑 바로 앞까지만 남기고 다시 돌린다.");
  console.log("  이대로 바꾸면 그 아래 기록이 통째로 날아간다.");
  process.exit(1);
} else {
  console.log("\n이제 노션에서 한 번 바꾸면 된다. update_content 한 번이다.");
  console.log(`  old_str = ${옛윗부분파일} 내용 그대로`);
  console.log(`  new_str = ${path.join(OUT_DIR, "notion-new.md")} 내용 그대로`);
  console.log("  문장이 안 맞으면 노션이 오류를 낸다. 그때는 페이지를 다시 받아 old 를 새로 뜬다.");
}
