#!/usr/bin/env node
// 배포 사이트 최신화 3단계. Vercel 사용량을 먹는 자리를 찾는다.
//
//   node weight.mjs            등록된 사이트를 훑어 무거운 자리를 찾는다
//   node weight.mjs --deploys  최근 배포 횟수까지 센다 (프로젝트마다 조회가 한 번씩 더 든다)
//
// 읽기만 한다. 아무것도 고치지 않는다. 고치는 것은 shrink.mjs 와 사람이 한다.
//
// 무엇을 보나
//   용량   올리는 payload 가 얼마나 큰가. 전송량이 여기서 나온다
//   이미지 300KB 넘는 그림. 대개 여기가 제일 크고 제일 쉽게 준다
//   캐시   파일 이름에 해시가 없는데 stale-while-revalidate 를 걸어 뒀는가
//   크론   가만히 둬도 도는 것이 있는가. 함수 실행시간을 계속 먹는다
//   배포   하루에 몇 번이나 올리는가. 빌드 시간이 여기서 나간다

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OPS = path.resolve(HERE, "..", "..");
const OUT_DIR = path.join(OPS, "work", "deploy-sync");
const REG = JSON.parse(fs.readFileSync(path.join(HERE, "registry.json"), "utf8").replace(/^﻿/, ""));
const DEV = readDevRoot();

const DEPLOYS = process.argv.includes("--deploys");
const 이미지한계 = 300 * 1024;
const payload한계 = 40 * 1024 * 1024;

function readDevRoot() {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(OPS, "machine.json"), "utf8").replace(/^﻿/, ""));
    if (m.dev_root) return m.dev_root.replace(/\//g, path.sep);
  } catch {}
  return path.resolve(OPS, "..");
}

const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");
const shell = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "/bin/sh";
const wrap = (cmd) => (process.platform === "win32" ? ["/d", "/s", "/c", cmd + " 2>&1"] : ["-c", cmd + " 2>&1"]);
const MB = (n) => (n / 1024 / 1024).toFixed(1) + "MB";
const KB = (n) => Math.round(n / 1024) + "KB";

const 이미지확장자 = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".tiff"]);
const 미디어확장자 = new Set([".mp4", ".mov", ".webm", ".mp3", ".wav", ".m4a"]);

function walk(dir, depth = 8) {
  const files = [];
  const go = (p, lv) => {
    let entries;
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git" || e.name === ".next" || e.name === ".vercel") continue;
      const full = path.join(p, e.name);
      if (e.isDirectory()) {
        if (lv > 0) go(full, lv - 1);
      } else {
        try {
          files.push({ path: full, size: fs.statSync(full).size });
        } catch {}
      }
    }
  };
  go(dir, depth);
  return files;
}

function readJSON(f) {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, ""));
  } catch {
    return null;
  }
}

function 배포횟수(name) {
  try {
    const out = execFileSync(shell, wrap(`npx vercel ls ${name}`), { cwd: DEV, encoding: "utf8", timeout: 120000 }).replace(ANSI, "");
    const ages = [...out.matchAll(/^\s{2}(\d+)(m|h|d)\s/gm)].map((m) => ({ n: Number(m[1]), u: m[2] }));
    const 하루안 = ages.filter((a) => a.u === "m" || (a.u === "h" && a.n <= 24)).length;
    return { 최근20건중하루안: 하루안, 본것: ages.length };
  } catch {
    return null;
  }
}

const 발견 = [];
const 사이트 = [];
const 심각도순 = { 높음: 0, 보통: 1, 낮음: 2 };
const 적는다 = (심각도, 프로젝트, 무엇, 왜, 어떻게) => 발견.push({ 심각도, 프로젝트, 무엇, 왜, 어떻게 });

const scan = fs.existsSync(path.join(OUT_DIR, "scan.json")) ? readJSON(path.join(OUT_DIR, "scan.json")) : null;
const 휴면 = new Set((scan?.프로젝트 ?? []).filter((p) => p.판정 === "휴면").map((p) => p.프로젝트));

for (const [name, spec] of Object.entries(REG.프로젝트)) {
  const dir = path.join(DEV, spec.폴더.replace(/\//g, path.sep));
  if (!fs.existsSync(dir)) continue;
  if (휴면.has(name)) continue;

  const row = { 프로젝트: name, 폴더: spec.폴더 };

  // 1. 올리는 payload
  const outDir = ["dist", "out", "build"].map((d) => path.join(dir, d)).find((d) => fs.existsSync(d));
  const publicDir = path.join(dir, "public");
  const 대상 = outDir ?? (fs.existsSync(publicDir) ? publicDir : null);
  if (대상) {
    // .vercelignore 에 적힌 것은 올라가지 않는다. 그것까지 세면 없는 문제를 만든다.
    const ig = path.join(dir, ".vercelignore");
    const 무시 = fs.existsSync(ig)
      ? fs
          .readFileSync(ig, "utf8")
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith("#"))
          .map((l) => l.replace(/^\/+|\/+$/g, "").replace(/\//g, path.sep))
      : [];
    const files = walk(대상).filter((f) => {
      const rel = path.relative(대상, f.path);
      return !무시.some((g) => rel === g || rel.startsWith(g + path.sep));
    });
    const total = files.reduce((s, f) => s + f.size, 0);
    row.payload = total;
    row.파일수 = files.length;
    row.기준폴더 = path.relative(dir, 대상);
    if (total > payload한계) {
      const 큰것 = files.sort((a, b) => b.size - a.size).slice(0, 3).map((f) => `${path.relative(대상, f.path)} ${MB(f.size)}`);
      적는다("높음", name, `올리는 것이 ${MB(total)}`, "전송량과 배포 시간이 여기서 나온다", `제일 큰 것부터 본다: ${큰것.join(", ")}`);
    }

    // 2. 이미지
    const 이미지 = files.filter((f) => 이미지확장자.has(path.extname(f.path).toLowerCase()));
    const 큰이미지 = 이미지.filter((f) => f.size > 이미지한계).sort((a, b) => b.size - a.size);
    row.이미지수 = 이미지.length;
    row.이미지용량 = 이미지.reduce((s, f) => s + f.size, 0);
    row.큰이미지 = 큰이미지.slice(0, 10).map((f) => ({ 파일: path.relative(dir, f.path), 크기: f.size }));
    if (큰이미지.length) {
      const 합 = 큰이미지.reduce((s, f) => s + f.size, 0);
      적는다(
        합 > 10 * 1024 * 1024 ? "높음" : "보통",
        name,
        `${이미지한계 / 1024}KB 넘는 그림 ${큰이미지.length}장, 합쳐서 ${MB(합)}`,
        "그림이 payload 의 대부분이면 전송량이 그만큼 나간다",
        `shrink.mjs --only ${name} 로 줄인다. 폭 1920 로 맞추고 다시 굽는다`
      );
    }

    const 미디어 = files.filter((f) => 미디어확장자.has(path.extname(f.path).toLowerCase()));
    const 큰미디어 = 미디어.filter((f) => f.size > 5 * 1024 * 1024);
    if (큰미디어.length) {
      적는다("보통", name, `5MB 넘는 영상과 소리 ${큰미디어.length}개`, "Vercel 에 올리면 전송량을 크게 먹는다", "영상은 유튜브나 외부 저장소에 두고 링크만 건다");
    }
  }

  // 3. 캐시 설정
  const vjson = readJSON(path.join(dir, "vercel.json"));
  if (vjson) {
    const headers = JSON.stringify(vjson.headers ?? []);
    row.swr = headers.includes("stale-while-revalidate");
    if (row.swr && 대상) {
      const 해시없는자산 = walk(대상, 3).filter(
        (f) => /\.(css|js)$/i.test(f.path) && !/[.-][0-9a-f]{6,}\.(css|js)$/i.test(f.path)
      );
      if (해시없는자산.length) {
        적는다(
          "높음",
          name,
          `파일 이름에 해시가 없는데 stale-while-revalidate 를 걸어 뒀다 (${해시없는자산.length}개)`,
          "다시 배포해도 브라우저가 최대 하루 동안 옛 파일을 쓴다. 화면이 깨진 채로 남는다",
          "주소에 내용 해시를 붙이거나 max-age=0, must-revalidate 로 바꾼다"
        );
      }
    }
    if (vjson.crons?.length) {
      row.크론 = vjson.crons.map((c) => `${c.path} ${c.schedule}`);
      적는다("보통", name, `크론 ${vjson.crons.length}개`, "아무도 안 봐도 함수가 계속 돈다", `쓰는지 확인한다: ${row.크론.join(", ")}`);
    }
  }

  // 4. Next 설정
  const nextCfg = ["next.config.js", "next.config.mjs", "next.config.ts"].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
  if (nextCfg) {
    const t = fs.readFileSync(nextCfg, "utf8");
    if (/unoptimized\s*:\s*true/.test(t)) {
      적는다("보통", name, "next/image 최적화를 꺼 뒀다", "원본 그림이 그대로 나가서 전송량이 는다", "unoptimized 를 빼거나, 그림을 미리 줄여서 넣는다");
    }
    const rev = [...t.matchAll(/revalidate\s*[:=]\s*(\d+)/g)].map((m) => Number(m[1])).filter((n) => n > 0 && n < 60);
    if (rev.length) {
      적는다("보통", name, `revalidate 가 ${Math.min(...rev)}초로 짧다`, "그만큼 자주 다시 굽는다. 함수 실행시간을 먹는다", "몇 분 단위로 늘려도 되는지 본다");
    }
  }

  // 5. 배포 횟수
  if (DEPLOYS) {
    const d = 배포횟수(name);
    if (d) {
      row.배포 = d;
      if (d.최근20건중하루안 >= 12) {
        적는다("보통", name, `하루에 ${d.최근20건중하루안}번 넘게 올린다`, "배포마다 빌드 시간이 깎인다", "바뀐 게 없으면 건너뛰게 한다. deploy-if-changed 방식을 쓴다");
      }
    }
  }

  사이트.push(row);
}

// 6. 계정 전체
if (scan?.유휴?.length) {
  적는다(
    "보통",
    "(계정 전체)",
    `${REG.기준?.노후일수 ?? 30}일 넘게 조용한 프로젝트 ${scan.유휴.length}개`,
    "쓰지 않는 프로젝트가 목록을 덮어 무엇이 살아 있는지 안 보인다",
    "지울지는 사람이 정한다. 지운다면 vercel remove <이름> --yes 로 하나씩"
  );
}
const 실험잔재 = (scan?.유휴 ?? []).filter((v) => /(probe|test|-071[46]|-clean|scraper-test)/i.test(v.프로젝트));
if (실험잔재.length >= 10) {
  적는다(
    "보통",
    "(계정 전체)",
    `한 번 쓰고 버린 실험 프로젝트가 ${실험잔재.length}개 남아 있다`,
    "이름에 probe, test, 날짜가 붙어 있고 전부 같은 시기에 만들어졌다",
    "묶어서 지우면 목록이 한 화면에 들어온다. 지우는 것은 사람이 정한다"
  );
}

발견.sort((a, b) => 심각도순[a.심각도] - 심각도순[b.심각도]);

const report = { 찍은시각: new Date().toISOString(), 사이트, 발견 };
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, "weight.json"), JSON.stringify(report, null, 2), "utf8");

const pad = (s, n) => {
  s = String(s ?? "");
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 0x1100 ? 2 : 1;
  return s + " ".repeat(Math.max(1, n - w));
};

console.log(`\n사용량 점검  ${new Date().toLocaleString("ko-KR")}`);
console.log(pad("프로젝트", 32) + pad("올리는 것", 12) + pad("파일", 8) + pad("그림", 8) + "그림 용량");
console.log("-".repeat(80));
for (const s of 사이트.sort((a, b) => (b.payload ?? 0) - (a.payload ?? 0))) {
  console.log(
    pad(s.프로젝트, 32) +
      pad(s.payload ? MB(s.payload) : "없음", 12) +
      pad(s.파일수 ?? "", 8) +
      pad(s.이미지수 ?? "", 8) +
      (s.이미지용량 ? MB(s.이미지용량) : "")
  );
}

console.log(`\n찾은 것 ${발견.length}건`);
for (const f of 발견) {
  console.log(`\n  [${f.심각도}] ${f.프로젝트}  ${f.무엇}`);
  console.log(`    왜: ${f.왜}`);
  console.log(`    어떻게: ${f.어떻게}`);
}
if (!발견.length) console.log("  무거운 자리가 없다. 이미 정리돼 있다.");

console.log(`\n적었다: ${path.join(OUT_DIR, "weight.json")}`);
