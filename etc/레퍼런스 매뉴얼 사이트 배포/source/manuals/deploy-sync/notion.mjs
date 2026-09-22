#!/usr/bin/env node
// 배포 사이트 최신화 4단계. 노션 "각종 프로젝트 배포 링크" 페이지 본문을 만든다.
//
//   node notion.mjs
//
// 노션에 직접 쓰지 않는다. work/deploy-sync/notion-new.md 를 만들어 놓을 뿐이다.
// 그 파일로 페이지 윗부분을 갈아끼우는 것은 노션을 만질 수 있는 런너가 한다.
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
    .replace(/\s*·\s*/g, ", ")
    .replace(/,\s*,/g, ",")
    .trim();
}

const KST = (d) => {
  const f = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const g = (t) => f.find((p) => p.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")} KST`;
};

// ── 원자료 ──────────────────────────────────────────────────────

const links = JSON.parse(fs.readFileSync(path.join(HUB, "links.json"), "utf8").replace(/^﻿/, ""));

let loops = [];
try {
  const { SHOW } = await import("file:///" + path.join(HUB, "loops.mjs").replace(/\\/g, "/"));
  const raw = execFileSync(process.execPath, [path.join(DEV, "loop-status.mjs"), "--json"], {
    encoding: "utf8",
    timeout: 300000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const j = JSON.parse(raw);
  loops = j.loops
    .filter((r) => SHOW[r.key])
    .map((r) => {
      const s = SHOW[r.key];
      let detail = "";
      try {
        detail = s.pick(r) || "";
      } catch {}
      return { title: 말로바꾼다(s.title), url: s.url, state: r.상태 ?? "알 수 없음", detail: 말로바꾼다(detail) };
    });
} catch (e) {
  console.warn("루프 상태를 못 읽었다:", String(e.message ?? e).slice(0, 160));
}

let scan = null;
try {
  scan = JSON.parse(fs.readFileSync(path.join(OUT_DIR, "scan.json"), "utf8").replace(/^﻿/, ""));
} catch {}

const 옛윗부분파일 = path.join(OUT_DIR, "notion-current-top.md");
const 옛윗부분 = fs.existsSync(옛윗부분파일) ? fs.readFileSync(옛윗부분파일, "utf8") : null;

// ── 본문 ────────────────────────────────────────────────────────

const L = [];
const 표 = (헤더, 줄들) => {
  L.push('<table fit-page-width="true" header-row="true">');
  L.push("<tr>");
  for (const h of 헤더) L.push(`<td>${h}</td>`);
  L.push("</tr>");
  for (const r of 줄들) {
    L.push("<tr>");
    for (const c of r) L.push(`<td>${c}</td>`);
    L.push("</tr>");
  }
  L.push("</table>");
};

L.push('<callout icon="🔗">');
L.push(`\t**공개 링크판 **[**yeohj.vercel.app**](https://yeohj.vercel.app)`);
L.push("\t배포 링크의 기준은 `C:\\dev\\dev-hub\\links.json` 입니다. 이 페이지는 그것을 옮겨 적고 지금 상태를 덧붙입니다.");
L.push(`\t최종 동기화: **${KST(new Date())}**`);
L.push("\t로그인 표시는 계정이 있어야 열린다는 뜻입니다. 비밀번호와 토큰, 대외비 자료는 적지 않습니다.");
L.push("</callout>");
L.push("<empty-block/>");

if (loops.length) {
  L.push("### **루프 현황**");
  표(
    ["루프", "상태", "현재 수치", "링크"],
    loops.map((l) => [l.title, l.state, l.detail || "확인 중", l.url ? `[열기](${l.url})` : "사이트 없음"])
  );
  L.push("<empty-block/>");
}

if (scan) {
  const 판정별 = scan.요약 ?? {};
  const 손볼것 = (scan.프로젝트 ?? []).filter((p) => p.판정 !== "최신" && p.판정 !== "휴면");
  L.push("### **사이트 점검**");
  L.push(
    // 노션은 제목 아래 들여쓴 줄의 탭을 지우고 저장한다. 여기서 탭을 넣으면
    // 다음번에 "찾을 것" 이 페이지와 안 맞아 바꾸기가 실패한다. 그래서 안 넣는다.
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
    L.push("손볼 것이 없습니다. 전부 최신입니다.");
  }
  if (scan.유휴?.length) {
    L.push(
      `쓰지 않는 Vercel 프로젝트가 ${scan.유휴.length}개 남아 있습니다. 되살리지 않고 그대로 둡니다. 지울지는 사람이 정합니다.`
    );
  }
  L.push("<empty-block/>");
}

for (const g of links.groups ?? []) {
  const 실을것 = (g.items ?? []).filter((i) => i.access !== "private");
  if (!실을것.length) continue;
  L.push(`### **${말로바꾼다(g.title)}**`);
  for (const i of 실을것) {
    const 뒤 = [];
    if (i.access === "internal") 뒤.push("로그인 필요");
    if (i.note) 뒤.push(말로바꾼다(i.note));
    const 꼬리 = 뒤.length ? ` (${뒤.join(", ")})` : "";
    L.push(`- ${i.icon ? i.icon + " " : ""}[**${말로바꾼다(i.name)}**](${i.url})${꼬리}`);
  }
}

const 제외 = (links.groups ?? []).flatMap((g) => (g.items ?? []).filter((i) => i.access === "private"));
if (제외.length) {
  L.push("### **공개 제외**");
  for (const i of 제외) L.push(`- **${말로바꾼다(i.name)}** (${말로바꾼다(i.note) || "대외비"})`);
}

L.push("<empty-block/>");

const body = L.join("\n") + "\n";
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, "notion-new.md"), body, "utf8");

console.log(`새 윗부분을 만들었다: ${path.join(OUT_DIR, "notion-new.md")}`);
console.log(`  루프 ${loops.length}줄, 링크 ${(links.groups ?? []).reduce((n, g) => n + (g.items?.length ?? 0), 0)}개`);

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
