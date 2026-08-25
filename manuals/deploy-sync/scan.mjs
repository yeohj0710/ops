#!/usr/bin/env node
// 배포 사이트 최신화 1단계. 무엇이 뒤처졌는지만 센다.
//
//   node scan.mjs             표를 찍고 work/deploy-sync/scan.json 을 쓴다
//   node scan.mjs --fast      Vercel 조회를 건너뛴다 (네트워크가 없을 때)
//   node scan.mjs --json      표 대신 JSON 만 찍는다
//
// 읽기만 한다. 배포하지 않고 파일도 고치지 않는다. 유료 호출이 없다.
// 한 프로젝트가 깨져도 그 줄만 "확인 실패" 로 두고 나머지를 계속 센다.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OPS = path.resolve(HERE, "..", "..");
const DEV = readDevRoot();
const REG = JSON.parse(strip(fs.readFileSync(path.join(HERE, "registry.json"), "utf8")));
const OUT_DIR = path.join(OPS, "work", "deploy-sync");

const FAST = process.argv.includes("--fast");
const JSON_ONLY = process.argv.includes("--json");

const 휴면일수 = REG.기준?.휴면일수 ?? 14;
const 노후일수 = REG.기준?.노후일수 ?? 30;
const 뒤처짐시간 = REG.기준?.배포뒤처짐시간 ?? 6;

function strip(s) {
  return s.replace(/^﻿/, "");
}

function readDevRoot() {
  try {
    const m = JSON.parse(strip(fs.readFileSync(path.join(OPS, "machine.json"), "utf8")));
    if (m.dev_root) return m.dev_root.replace(/\//g, path.sep);
  } catch {}
  return path.resolve(OPS, "..");
}

const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");

function sh(cmd, cwd, timeout = 120000) {
  const shell = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "/bin/sh";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", cmd + " 2>&1"] : ["-c", cmd + " 2>&1"];
  return execFileSync(shell, args, { cwd, encoding: "utf8", timeout }).replace(ANSI, "");
}

function git(args, cwd) {
  try {
    // stderr 를 버린다. upstream 이 없는 저장소가 섞여 있어 안 버리면 화면이 fatal 로 덮인다.
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 20000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

// 폴더 안에서 가장 최근에 손댄 파일 시각. 루프가 데이터를 채웠는지 보는 가장 싼 방법이다.
function newest(target, depth = 3) {
  let best = null;
  const walk = (p, lv) => {
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      return;
    }
    if (!st.isDirectory()) {
      if (!best || st.mtime > best) best = st.mtime;
      return;
    }
    if (lv < 0) return;
    let entries;
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git" || e.name === ".vercel") continue;
      walk(path.join(p, e.name), lv - 1);
    }
  };
  walk(target, depth);
  return best;
}

// "12s" "8m" "21h" "4d" 를 지금 기준 시각으로 되돌린다. Vercel 이 나이만 알려준다.
// 방금 올린 것은 초 단위로 나온다. s 를 빼먹으면 그것만 "모름" 이 된다.
function ageToDate(age) {
  const m = String(age).match(/^(\d+)(s|m|h|d|mo|y)$/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = { s: 1000, m: 60000, h: 3600000, d: 86400000, mo: 2592000000, y: 31536000000 }[m[2]];
  return new Date(Date.now() - n * unit);
}

function vercelProjects() {
  const rows = [];
  let next = null;
  for (let page = 0; page < 12; page++) {
    let out;
    try {
      out = sh("npx vercel project ls" + (next ? " --next " + next : ""), DEV);
    } catch (e) {
      return { rows, error: String(e.message || e).slice(0, 200) };
    }
    for (const line of out.split("\n")) {
      const m = line.match(/^\s{2}(\S+)\s+(https?:\S+)\s+(\S+)\s+(\S+)\s*$/);
      if (m && m[1] !== "Project") rows.push({ name: m[1], url: m[2], age: m[3], at: ageToDate(m[3]) });
    }
    const nm = out.match(/--next (\d+)/);
    if (!nm) break;
    next = nm[1];
  }
  return { rows, error: null };
}

const hours = (d) => (d ? (Date.now() - d.getTime()) / 3600000 : null);
const days = (d) => (d ? hours(d) / 24 : null);
const fmt = (d) =>
  d
    ? `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} ` +
      `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
    : "없음";

// ── 실측 ────────────────────────────────────────────────────────

const remote = FAST ? { rows: [], error: "--fast 로 건너뜀" } : vercelProjects();
const byName = new Map(remote.rows.map((r) => [r.name, r]));
const 자동제외 = new Set(REG.자동배포에서뺀다 ?? []);

// 지난번에 우리가 민 기록. 배포 스크립트가 "바뀐 게 없다" 며 건너뛰는 경우가 있어서
// Vercel 배포 시각만 보면 영원히 "배포 필요" 로 남는다. 우리가 민 뒤로 소스가
// 안 바뀌었으면 최신으로 본다.
const 민기록 = new Map();
try {
  const run = JSON.parse(fs.readFileSync(path.join(OUT_DIR, "run.json"), "utf8").replace(/^﻿/, ""));
  if (!run.dry_run) {
    for (const r of run.항목 ?? []) if (r.결과 === "성공") 민기록.set(r.프로젝트, new Date(run.끝));
  }
} catch {}

const projects = [];
for (const [name, spec] of Object.entries(REG.프로젝트)) {
  const row = {
    프로젝트: name,
    폴더: spec.폴더,
    url: spec.url,
    배포: spec.배포,
    공개: spec.공개,
    메모: spec.메모 || "",
    판정: "확인 실패",
    할일: [],
    경고: [],
  };
  try {
    const dir = path.join(DEV, spec.폴더.replace(/\//g, path.sep));
    row.경로 = dir;
    if (!fs.existsSync(dir)) {
      row.판정 = "폴더 없음";
      row.경고.push("등록된 폴더가 이 기계에 없다");
      projects.push(row);
      continue;
    }

    let dep = byName.get(name);
    // 프로젝트가 스스로 남긴 배포 자국이 있으면 그쪽이 정확하다.
    // Vercel 은 나이를 "4d" 처럼 뭉뚱그려 주는데, 자국은 초까지 적혀 있다.
    for (const mark of ["data/.last_deploy.json", "etc/codex-deploy-state/last_deploy.json"]) {
      const f = path.join(dir, mark.replace(/\//g, path.sep));
      if (!fs.existsSync(f)) continue;
      try {
        const j = JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, ""));
        const t = j.at ?? j.deployedAt ?? j.lastDeploy;
        if (t && !Number.isNaN(new Date(t).getTime())) {
          const 자국 = new Date(t);
          if (!dep?.at || 자국 > dep.at) {
            if (dep) dep.at = 자국;
            else byName.set(name, { name, url: spec.url, age: "자국", at: 자국 });
          }
          row.배포자국 = mark;
        }
      } catch {}
    }
    dep = byName.get(name);
    row.마지막배포 = dep?.at ? fmt(dep.at) : "모름";
    row.배포나이 = dep?.age ?? "모름";
    if (dep && dep.url !== spec.url && !spec.url.includes("wellnessbox.kr") && !spec.url.includes("wnbx")) {
      row.경고.push(`Vercel 이 말하는 주소가 다르다: ${dep.url}`);
    }

    const ledger = spec.데이터원장 ? path.join(dir, spec.데이터원장.replace(/\//g, path.sep)) : null;
    const dataAt = ledger && fs.existsSync(ledger) ? newest(ledger) : null;
    row.데이터갱신 = fmt(dataAt);

    const outDir = ["dist", "out", "build"].map((d) => path.join(dir, d)).find((d) => fs.existsSync(d));
    const buildAt = outDir ? newest(outDir) : null;
    row.빌드산출 = outDir ? path.basename(outDir) + " " + fmt(buildAt) : "없음";
    row.올릴것 = fmt([dataAt, buildAt].filter(Boolean).sort((a, b) => b - a)[0] ?? null);

    if (fs.existsSync(path.join(dir, ".git"))) {
      const 줄들 = (git(["status", "--porcelain"], dir) || "").split("\n").filter((l) => l.trim());
      row.미커밋 = 줄들.length;
      // 자료가 미커밋인 것과 소스가 미커밋인 것은 뜻이 다르다.
      // 자료는 루프가 계속 쌓으니 미커밋이 정상이다. 소스가 미커밋이면
      // 다른 세션이 고치는 중일 수 있고, 그대로 올리면 남의 미완성이 프로덕션에 뜬다.
      const 자료자리 = /^(data|state|work|logs?|etc|dist|out|build|public\/(data|frames|thumbs))\//;
      row.소스미커밋 = 줄들
        .map((l) => l.slice(3).replace(/^"|"$/g, "").split(" -> ").pop().replace(/\\/g, "/"))
        .filter((f) => f && !자료자리.test(f) && !f.startsWith("node_modules/"))
        .slice(0, 200);
      const last = git(["log", "-1", "--format=%ci"], dir);
      row.마지막커밋 = last ? fmt(new Date(last)) : "없음";
      row._커밋시각 = last ? new Date(last).toISOString() : null;
      const ahead = git(["rev-list", "--count", "@{u}..HEAD"], dir);
      row.안올린커밋 = ahead === null ? "원격 없음" : Number(ahead);
    } else {
      row.미커밋 = 0;
      row.소스미커밋 = [];
      row.마지막커밋 = "저장소 아님";
      row.안올린커밋 = "저장소 아님";
    }

    // ── 판정 ──
    const 최근활동 = [row._커밋시각 ? new Date(row._커밋시각) : null, dataAt, buildAt]
      .filter(Boolean)
      .sort((a, b) => b - a)[0] ?? null;
    const 조용한날 = days(최근활동);
    const 소스시각 = [dataAt, buildAt].filter(Boolean).sort((a, b) => b - a)[0] ?? null;
    // Vercel 은 배포 나이를 분 단위로만 알려준다. 몇 분 차이로 "뒤처졌다" 고 하면
    // 방금 스스로 올린 루프를 매번 다시 밀게 된다. 그래서 유예를 둔다.
    const 유예분 = spec.배포 === "loop" ? REG.기준?.루프유예분 ?? 90 : REG.기준?.유예분 ?? 15;
    const 민때 = 민기록.get(name) ?? null;
    const 올린때 = [dep?.at ?? null, 민때].filter(Boolean).sort((a, b) => b - a)[0] ?? null;
    if (민때 && (!dep?.at || 민때 > dep.at)) row.마지막배포 = fmt(민때) + " (밈)";
    const 소스가더새것 = 소스시각 && 올린때 ? 소스시각.getTime() - 올린때.getTime() > 유예분 * 60000 : false;
    // 루프가 스스로 올렸는지 볼 때도 우리가 민 것을 같이 센다. 안 그러면
    // "바뀐 게 없어 건너뛴다" 는 사이트가 영원히 멈춤으로 남는다.
    const 배포뒤 = 올린때 ? hours(올린때) : null;

    // 휴면이 먼저다. 두 주 넘게 아무도 안 건드린 사이트는 고장이 아니라 안 쓰는 것이다.
    // 거기서 "안 올린 변경이 있다" 를 보고 되살리면 빌드 시간만 먹는다.
    if (조용한날 !== null && 조용한날 > 휴면일수) {
      row.판정 = "휴면";
      row.할일 = [];
      if (소스가더새것) row.경고.push("올리지 않은 변경이 남아 있다. 되살릴지는 사람이 정한다");
    } else if (소스가더새것) {
      row.판정 = "배포 필요";
    } else if (spec.배포 === "loop" && 배포뒤 !== null && 배포뒤 > 뒤처짐시간) {
      row.판정 = "루프 멈춤 의심";
    } else if (dep) {
      row.판정 = "최신";
    } else {
      row.판정 = FAST ? "확인 안 함" : "Vercel 에 없음";
    }

    if (typeof row.안올린커밋 === "number" && row.안올린커밋 > 0) {
      row.경고.push(`push 안 한 커밋 ${row.안올린커밋}개` + (row.안올린커밋 > 500 ? " (한 번에 밀면 오래 걸린다. 사람이 정한다)" : ""));
    }
    if (row.미커밋 > 100) row.경고.push(`미커밋 ${row.미커밋}개`);

    // ── 할 일 ──
    // 소스가 미커밋이면 자동으로 올리지 않는다. 260825 에 이걸 안 보고 올렸다가
    // 다른 세션이 고치던 중간 상태가 프로덕션에 올라가 사이트가 404 로 죽었다.
    if ((row.판정 === "배포 필요" || row.판정 === "루프 멈춤 의심") && row.소스미커밋?.length) {
      row.판정 = "소스 미커밋";
      row.할일 = [];
      row.경고.push(
        `소스가 미커밋이다(${row.소스미커밋.length}개: ${row.소스미커밋.slice(0, 4).join(", ")}). ` +
          "다른 세션이 고치는 중일 수 있어 자동 배포에서 뺐다. 확인했으면 run.mjs --only 로 민다"
      );
    } else if (row.판정 === "배포 필요" || row.판정 === "루프 멈춤 의심") {
      if (spec.배포 === "github") {
        row.할일.push({ 종류: "push", 명령: "git push", cwd: dir });
      } else if (자동제외.has(name)) {
        row.판정 = "사람이 부를 때만";
        row.경고.push(REG.자동배포에서뺀이유?.[name] ?? "자동 배포에서 뺐다");
      } else {
        if (spec.동기화) row.할일.push({ 종류: "동기화", 명령: spec.동기화, cwd: dir });
        if (spec.빌드 && !String(spec.배포명령 || "").includes("run deploy"))
          row.할일.push({ 종류: "빌드", 명령: spec.빌드, cwd: dir });
        if (spec.배포명령) row.할일.push({ 종류: "배포", 명령: spec.배포명령, cwd: dir });
      }
    }
  } catch (e) {
    row.경고.push("확인 중 오류: " + String(e.message || e).slice(0, 120));
  }
  projects.push(row);
}

// 등록 안 된 것과 버려진 것
const 등록된폴더 = new Set(Object.values(REG.프로젝트).map((s) => s.폴더));
const 등록안됨 = [];
for (const root of ["", "etc"]) {
  const base = root ? path.join(DEV, root) : DEV;
  let entries = [];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {}
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const rel = root ? `${root}/${e.name}` : e.name;
    if (등록된폴더.has(rel)) continue;
    if (fs.existsSync(path.join(base, e.name, ".vercel", "project.json"))) 등록안됨.push(rel);
  }
}

const 등록된이름 = new Set(Object.keys(REG.프로젝트));
const 유휴 = remote.rows
  .filter((r) => !등록된이름.has(r.name))
  .filter((r) => {
    const d = days(r.at);
    return d !== null && d >= 노후일수;
  })
  .map((r) => ({ 프로젝트: r.name, url: r.url, 나이: r.age }));

const report = {
  찍은시각: new Date().toISOString(),
  dev_root: DEV,
  vercel: { 전체: remote.rows.length, 오류: remote.error },
  프로젝트: projects,
  등록안됨,
  유휴,
  요약: {},
};
for (const p of projects) report.요약[p.판정] = (report.요약[p.판정] ?? 0) + 1;
report.할일있는것 = projects.filter((p) => p.할일.length).map((p) => p.프로젝트);

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, "scan.json"), JSON.stringify(report, null, 2), "utf8");

if (JSON_ONLY) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

// ── 표 ──────────────────────────────────────────────────────────

const pad = (s, n) => {
  s = String(s ?? "");
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 0x1100 ? 2 : 1;
  return s + " ".repeat(Math.max(1, n - w));
};

console.log(`\n배포 사이트 최신화 점검  ${new Date().toLocaleString("ko-KR")}`);
console.log(`Vercel 프로젝트 ${remote.rows.length}개 중 등록된 것 ${projects.length}개` + (remote.error ? `  (조회 실패: ${remote.error})` : ""));
console.log("");
console.log(pad("프로젝트", 32) + pad("판정", 20) + pad("마지막 배포", 14) + pad("올릴 것", 14) + "할 일");
console.log("-".repeat(110));
for (const p of projects) {
  const 할일 = p.할일.length ? p.할일.map((t) => t.종류).join(" 다음 ") : "";
  console.log(pad(p.프로젝트, 32) + pad(p.판정, 20) + pad(p.마지막배포 ?? "", 14) + pad(p.올릴것 ?? "", 14) + 할일);
  for (const w of p.경고) console.log("  " + pad("", 30) + "! " + w);
}

console.log("\n요약");
for (const [k, v] of Object.entries(report.요약)) console.log(`  ${pad(k, 18)}${v}개`);

if (등록안됨.length) {
  console.log(`\n등록 안 된 폴더 ${등록안됨.length}개  (registry.json 에 넣을지 사람이 정한다)`);
  console.log("  " + 등록안됨.join(", "));
}
if (유휴.length) {
  console.log(`\n${노후일수}일 넘게 조용한 Vercel 프로젝트 ${유휴.length}개  (되살리지 않는다. 지울지는 사람이 정한다)`);
  console.log("  " + 유휴.slice(0, 12).map((v) => `${v.프로젝트}(${v.나이})`).join(", ") + (유휴.length > 12 ? ` 외 ${유휴.length - 12}개` : ""));
}

console.log(`\n적었다: ${path.join(OUT_DIR, "scan.json")}`);
console.log(report.할일있는것.length ? `다음: node "${path.join(HERE, "run.mjs")}"` : "다음: 밀 것이 없다. weight.mjs 로 넘어간다");
