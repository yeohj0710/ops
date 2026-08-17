#!/usr/bin/env node
// 관제탑 사이트를 굽는다. 저장소 내용을 그대로 읽어 정적 파일 하나로 만든다.
//   node site/build.mjs   →  site/dist/index.html

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "site", "dist");

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ls = (d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith(".json")) : []);
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

// ── 매뉴얼 ──
function manuals() {
  const dir = path.join(ROOT, "manuals");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
    .map((d) => {
      const file = path.join(dir, d.name, "MANUAL.md");
      if (!fs.existsSync(file)) return null;
      const t = fs.readFileSync(file, "utf8");
      const grab = (label, def = "") =>
        (t.match(new RegExp("^-\\s*\\*\\*" + label + "\\*\\*:\\s*(.+)$", "m")) || [, def])[1].trim();
      // 'm' 플래그를 주면 $ 가 매 줄 끝에서 맞아 게으른 수량자가 즉시 멈춘다.
      // 줄머리는 \n 으로 직접 잡고 플래그는 쓰지 않는다.
      const section = (name) => {
        const m = t.match(new RegExp("\\n## " + name + "\\s*\\n([\\s\\S]*?)(?=\\n## |$)"));
        return m ? m[1].trim() : "";
      };
      const plain = (s) =>
        s
          .replace(/\*\*(.+?)\*\*/g, "$1")
          .replace(/`(.+?)`/g, "$1")
          .replace(/\[(.+?)\]\(.+?\)/g, "$1")
          .trim();
      return {
        id: d.name,
        title: (t.match(/^#\s+(.+)$/m) || [, d.name])[1].trim(),
        trigger: grab("부르는 말"),
        runner: grab("런너", "either"),
        surfaces: grab("제어층", "L1"),
        minutes: grab("한 번에 걸리는 시간"),
        what: plain(section("무엇을 만드는 업무인가").split("\n")[0] || ""),
        steps: (section("절차").match(/^\d+\.\s/gm) || []).length,
        traps: (section("알려진 함정").match(/^-\s/gm) || []).length,
        asks: (section("사람에게 물어야 하는 지점").match(/^-\s/gm) || []).length,
        hasChecks: fs.existsSync(path.join(dir, d.name, "checks.mjs")),
      };
    })
    .filter(Boolean);
}

// ── 태스크 ──
function tasks() {
  const T = path.join(ROOT, "tasks");
  const queue = ls(path.join(T, "queue")).map((f) => readJson(path.join(T, "queue", f)));
  const doing = ls(path.join(T, "doing")).map((f) => readJson(path.join(T, "doing", f)));
  const doneDir = path.join(T, "done");
  const done = [];
  if (fs.existsSync(doneDir)) {
    for (const e of fs.readdirSync(doneDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      for (const f of ls(path.join(doneDir, e.name))) done.push(readJson(path.join(doneDir, e.name, f)));
    }
  }
  done.sort((a, b) => String(b.finished || "").localeCompare(String(a.finished || "")));
  return { queue, doing, done };
}

function lastCommit() {
  try {
    return execFileSync("git", ["log", "-1", "--format=%cd|%s", "--date=format:%Y-%m-%d %H:%M"], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
}

const M = manuals();
const T = tasks();
const [commitDate, commitMsg] = (lastCommit() || "|").split("|");
const now = new Date().toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" });
const REPO = "https://github.com/yeohj0710/ops";

const layerBadge = (s) => {
  const top = (String(s).match(/L[1-4]/g) || ["L1"]).pop();
  return `<span class="lay lay${top[1]}">${top}</span>`;
};

const manualRows = M.length
  ? M.map(
      (m) => `<article class="card">
  <div class="chead">
    <h3>${esc(m.title)}</h3>
    ${layerBadge(m.surfaces)}
  </div>
  ${m.what ? `<p class="what">${esc(m.what)}</p>` : ""}
  ${
    m.trigger
      ? `<p class="say">${m.trigger
          .split(",")
          .map((w) => `<span>${esc(w.trim())}</span>`)
          .join("")}</p>`
      : ""
  }
  <p class="meta">
    <span>${esc(m.runner)}</span>
    ${m.minutes ? `<span>${esc(m.minutes)}</span>` : ""}
    ${m.steps ? `<span>절차 ${m.steps}단계</span>` : ""}
    ${m.traps ? `<span>함정 ${m.traps}개</span>` : ""}
    ${m.asks ? `<span>확인 지점 ${m.asks}개</span>` : ""}
    ${m.hasChecks ? `<span>자동 검사</span>` : ""}
    <a href="${REPO}/blob/main/manuals/${m.id}/MANUAL.md">매뉴얼 보기 →</a>
  </p>
</article>`
    ).join("\n")
  : `<p class="empty">아직 등록된 업무가 없다. 세션에 "○○ 업무로 등록해줘" 라고 하면 여기 올라온다.</p>`;

const taskList = (arr, kind) =>
  arr.length
    ? `<ul class="tasks">${arr
        .slice(0, 12)
        .map(
          (t) =>
            `<li><span class="dot ${kind}"></span><b>${esc(t.title)}</b><span class="tid">${esc(
              t.manual
            )}</span>${
              t.lease ? `<span class="tid">${esc(t.lease.runner)}@${esc(t.lease.machine)}</span>` : ""
            }</li>`
        )
        .join("")}</ul>`
    : `<p class="empty">없음</p>`;

const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>업무 관제탑 — 매뉴얼로 굴리는 회사 업무</title>
<meta name="description" content="업무 하나를 매뉴얼 한 폴더로 적어두면 Claude와 Codex가 같은 큐에서 뽑아 돕니다.">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<meta property="og:title" content="업무 관제탑">
<meta property="og:description" content="업무 하나를 매뉴얼 한 폴더로. Claude와 Codex가 같은 큐에서 일합니다.">
<meta property="og:type" content="website">
<style>
:root{
  --bg:#f7f7f5; --panel:#fff; --ink:#16181a; --ink2:#464b52; --dim:#767c85;
  --line:#e4e5e2; --line2:#d2d4d0;
  --acc:#1f5fbf; --accSoft:#e7eefb;
  --live:#12744c; --liveSoft:#e0f0e8;
  --idle:#8a6a10; --idleSoft:#f8f0dc;
  --stop:#a9382c; --stopSoft:#fae9e6;
  --shadow:0 1px 2px rgba(22,24,26,.05);
  --r:11px;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#101113; --panel:#181a1d; --ink:#e9eaec; --ink2:#b9bec6; --dim:#868d97;
    --line:#26282c; --line2:#373a40;
    --acc:#7ba5f0; --accSoft:#182338;
    --live:#54c091; --liveSoft:#122a20;
    --idle:#d7a852; --idleSoft:#2a2213;
    --stop:#e78377; --stopSoft:#2d1a17;
    --shadow:none;
  }
}
*{box-sizing:border-box}
body{
  margin:0;background:var(--bg);color:var(--ink);
  font:16px/1.6 -apple-system,BlinkMacSystemFont,"Pretendard","Apple SD Gothic Neo","Malgun Gothic",Segoe UI,sans-serif;
  -webkit-font-smoothing:antialiased;
}
.wrap{max-width:720px;margin:0 auto;padding:52px 18px 72px;display:flex;flex-direction:column;gap:38px}
header{display:flex;flex-direction:column;gap:9px}
h1{margin:0;font-size:clamp(24px,5vw,30px);font-weight:700;letter-spacing:-.025em}
.lede{margin:0;color:var(--ink2);font-size:15px;max-width:54ch}
.stamp{font-size:12.5px;color:var(--dim);font-variant-numeric:tabular-nums}
h2{font-size:11.5px;font-weight:680;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);margin:0 0 12px}

.say{margin:0 0 9px;display:flex;flex-wrap:wrap;gap:6px}
.say span{
  font-size:13px;background:var(--accSoft);color:var(--acc);
  padding:3px 9px;border-radius:99px;font-weight:600;
}
.say span::before{content:"“"}
.say span::after{content:"”"}

.cards{display:flex;flex-direction:column;gap:11px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:15px 17px;box-shadow:var(--shadow)}
.chead{display:flex;align-items:center;gap:10px;margin-bottom:7px}
.card h3{margin:0;font-size:16.5px;font-weight:670;letter-spacing:-.015em;flex:1}
.what{margin:0 0 10px;color:var(--ink2);font-size:14.5px}
.meta{margin:0;display:flex;flex-wrap:wrap;gap:5px 12px;font-size:12.5px;color:var(--dim)}
.meta a{color:var(--acc);text-decoration:none;font-weight:600}
.meta a:hover{text-decoration:underline}

.lay{font-size:11px;font-weight:700;padding:2px 7px;border-radius:5px;letter-spacing:.03em}
.lay1{background:var(--liveSoft);color:var(--live)}
.lay2{background:var(--accSoft);color:var(--acc)}
.lay3{background:var(--idleSoft);color:var(--idle)}
.lay4{background:var(--stopSoft);color:var(--stop)}

.board{display:grid;grid-template-columns:repeat(3,1fr);gap:11px}
@media(max-width:620px){.board{grid-template-columns:1fr}}
.col{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:13px 15px;box-shadow:var(--shadow)}
.col h3{margin:0 0 9px;font-size:12px;font-weight:680;letter-spacing:.1em;text-transform:uppercase;color:var(--dim)}
.col .n{font-size:22px;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.tasks{list-style:none;margin:9px 0 0;padding:0;display:flex;flex-direction:column;gap:7px}
.tasks li{font-size:13.5px;display:flex;flex-wrap:wrap;align-items:center;gap:6px;line-height:1.45}
.tasks b{font-weight:600}
.dot{width:7px;height:7px;border-radius:99px;flex:none}
.dot.queue{background:var(--dim)}
.dot.doing{background:var(--live)}
.dot.done{background:var(--line2)}
.tid{font-size:11.5px;color:var(--dim)}
.empty{margin:9px 0 0;font-size:13.5px;color:var(--dim)}

.how{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:16px 18px;box-shadow:var(--shadow)}
.how p{margin:0 0 11px;font-size:14.5px;color:var(--ink2)}
.how p:last-child{margin-bottom:0}
.how b{color:var(--ink)}
code{
  font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:1px 6px;
}
pre{margin:0 0 11px;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:11px 13px;overflow-x:auto}
pre code{background:none;border:none;padding:0}

footer{border-top:1px solid var(--line);padding-top:16px;font-size:13px;color:var(--dim);display:flex;flex-direction:column;gap:5px}
footer a{color:var(--acc);text-decoration:none}
footer a:hover{text-decoration:underline}
</style>
</head>
<body>
<div class="wrap">

<header>
  <h1>업무 관제탑</h1>
  <p class="lede">업무 하나를 매뉴얼 한 폴더로 적어두면, 새 세션에 한 문장만 말해도 Claude 와 Codex 가 그대로 처리합니다.</p>
  <p class="stamp">${esc(now)} 기준 · 업무 ${M.length}개</p>
</header>

<section>
  <h2>등록된 업무</h2>
  <div class="cards">
${manualRows}
  </div>
</section>

<section>
  <h2>일감</h2>
  <div class="board">
    <div class="col"><h3>대기</h3><div class="n">${T.queue.length}</div>${taskList(T.queue, "queue")}</div>
    <div class="col"><h3>진행</h3><div class="n">${T.doing.length}</div>${taskList(T.doing, "doing")}</div>
    <div class="col"><h3>완료</h3><div class="n">${T.done.length}</div>${taskList(T.done, "done")}</div>
  </div>
</section>

<section>
  <h2>쓰는 법</h2>
  <div class="how">
    <p><b>업무 시키기</b> — 위 카드의 따옴표 안 말을 세션에 그대로 합니다.</p>
    <p><b>새 업무 등록</b> — “○○ 업무로 등록해줘”, “방금 한 거 등록해줘”. 절차를 채워 올리면 이 목록에 뜹니다.</p>
    <p><b>새 컴퓨터</b> — 구글 드라이브 <code>에이전트</code> 폴더의 <code>설치.mjs</code> 를 한 번 실행하면 지침·스킬·저장소가 전부 깔립니다.</p>
    <pre><code>git clone ${REPO}.git C:/dev/ops
node C:/dev/ops/setup.mjs</code></pre>
    <p>제어 수단은 위에서부터 씁니다 — <b>L1</b> 명령어·API, <b>L2</b> 인앱 브라우저, <b>L3</b> 로그인된 크롬, <b>L4</b> 화면 제어. 화면을 쓰는 일감은 기계당 하나씩만 나갑니다.</p>
  </div>
</section>

<footer>
  <div><a href="${REPO}">github.com/yeohj0710/ops</a> · 공개 저장소</div>
  ${commitDate ? `<div>마지막 커밋 ${esc(commitDate)} — ${esc(commitMsg)}</div>` : ""}
</footer>

</div>
</body>
</html>
`;

fs.mkdirSync(DIST, { recursive: true });
fs.writeFileSync(path.join(DIST, "index.html"), html, "utf8");
console.log(`구웠다: ${path.join(DIST, "index.html")}  (업무 ${M.length}개 · 일감 ${T.queue.length}/${T.doing.length}/${T.done.length})`);
