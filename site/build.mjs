#!/usr/bin/env node
// 관제탑 사이트를 굽는다. 저장소를 읽어 정적 파일 하나로 만든다.
//   node site/build.mjs   →  site/dist/index.html
//
// 이 사이트가 답해야 하는 질문은 하나다 — "이거 어떻게 시키지?"
// 그래서 부르는 말을 제일 크게 두고, 눌러서 복사되게 했다(폰에서 쓴다).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "site", "dist");
const REPO = "https://github.com/yeohj0710/ops";
const FENCE = "```";

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ls = (d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith(".json")) : []);

const inline = (t) =>
  esc(t)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

const isFence = (s) => s.trim().startsWith(FENCE);
const isTableSep = (s) => /^\s*\|[\s:|-]+\|\s*$/.test(s || "");
const cells = (s) => s.trim().split("|").slice(1, -1).map((c) => c.trim());

const tableHtml = (head, rows) =>
  '<div class="tw"><table><thead><tr>' +
  head.map((h) => "<th>" + inline(h) + "</th>").join("") +
  "</tr></thead><tbody>" +
  rows.map((r) => "<tr>" + r.map((c) => "<td>" + inline(c) + "</td>").join("") + "</tr>").join("") +
  "</tbody></table></div>";

// 매뉴얼에 실제로 쓰는 것만 다루는 작은 렌더러.
function md(src) {
  const lines = src.split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const L = lines[i];

    if (isFence(L)) {
      const body = [];
      i++;
      while (i < lines.length && !isFence(lines[i])) body.push(lines[i++]);
      i++;
      out.push("<pre><code>" + esc(body.join("\n")) + "</code></pre>");
      continue;
    }

    if (/^\s*\|/.test(L) && isTableSep(lines[i + 1])) {
      const head = cells(L);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(tableHtml(head, rows));
      continue;
    }

    if (/^\s*[-*]\s+/.test(L)) {
      const items = [];
      while (i < lines.length && (/^\s*[-*]\s+/.test(lines[i]) || /^\s{2,}\S/.test(lines[i]))) {
        if (/^\s*[-*]\s+/.test(lines[i])) items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        else if (items.length) items[items.length - 1] += " " + lines[i].trim();
        i++;
      }
      out.push("<ul>" + items.map((t) => "<li>" + inline(t) + "</li>").join("") + "</ul>");
      continue;
    }

    // 번호 목록. 항목 하나가 여러 줄이고 코드블록·표가 섞이므로 조각으로 모은다.
    if (/^\s*\d+\.\s+/.test(L)) {
      const items = [];
      const add = (part) => {
        if (items.length) items[items.length - 1].push(part);
      };
      while (i < lines.length) {
        const cur = lines[i];
        if (/^\s*\d+\.\s+/.test(cur)) {
          items.push([{ t: "p", v: cur.replace(/^\s*\d+\.\s+/, "") }]);
          i++;
        } else if (isFence(cur)) {
          const body = [];
          i++;
          while (i < lines.length && !isFence(lines[i])) body.push(lines[i++].replace(/^ {3}/, ""));
          i++;
          add({ t: "code", v: body.join("\n") });
        } else if (/^\s*\|/.test(cur) && isTableSep(lines[i + 1])) {
          const head = cells(cur);
          i += 2;
          const rows = [];
          while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
          add({ t: "table", head, rows });
        } else if (/^\s{2,}\S/.test(cur)) {
          const last = items[items.length - 1];
          const tail = last && last[last.length - 1];
          if (tail && tail.t === "p") tail.v += " " + cur.trim();
          else add({ t: "p", v: cur.trim() });
          i++;
        } else if (cur.trim() === "") {
          // 빈 줄에서 끊지 않는다. 코드블록·표 뒤에 빈 줄이 오고 다음 번호가 이어지는데,
          // 여기서 break 하면 항목마다 <ol> 이 새로 생겨 번호가 전부 1 이 된다.
          let j = i + 1;
          while (j < lines.length && lines[j].trim() === "") j++;
          const nxt = lines[j] || "";
          if (/^\s*\d+\.\s+/.test(nxt) || /^\s{2,}\S/.test(nxt) || isFence(nxt) || /^\s*\|/.test(nxt)) {
            i = j;
          } else break;
        } else break;
      }
      const render = (p) =>
        p.t === "code"
          ? "<pre><code>" + esc(p.v) + "</code></pre>"
          : p.t === "table"
          ? tableHtml(p.head, p.rows)
          : "<p>" + inline(p.v) + "</p>";
      out.push("<ol>" + items.map((it) => "<li>" + it.map(render).join("") + "</li>").join("") + "</ol>");
      continue;
    }

    if (/^>\s?/.test(L)) {
      const q = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ""));
      out.push("<blockquote>" + inline(q.join(" ")) + "</blockquote>");
      continue;
    }

    if (/^###\s+/.test(L)) {
      out.push("<h4>" + inline(L.replace(/^###\s+/, "")) + "</h4>");
      i++;
      continue;
    }
    if (L.trim() === "" || /^---+$/.test(L.trim())) {
      i++;
      continue;
    }

    const para = [];
    while (
      i < lines.length && lines[i].trim() && !/^[#>|]/.test(lines[i]) &&
      !isFence(lines[i]) && !/^\s*[-*\d]/.test(lines[i])
    )
      para.push(lines[i++]);
    if (para.length) out.push("<p>" + inline(para.join(" ")) + "</p>");
    else i++;
  }
  return out.join("\n");
}

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
      const section = (name) => {
        const m = t.match(new RegExp("\\n## " + name + "\\s*\\n([\\s\\S]*?)(?=\\n## |$)"));
        return m ? m[1].trim() : "";
      };
      const plain = (s) =>
        s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/`(.+?)`/g, "$1").replace(/\[(.+?)\]\(.+?\)/g, "$1").trim();
      const scriptDir = path.join(dir, d.name, "scripts");
      const scripts = fs.existsSync(scriptDir) ? fs.readdirSync(scriptDir) : [];

      return {
        id: d.name,
        title: (t.match(/^#\s+(.+)$/m) || [, d.name])[1].trim(),
        triggers: grab("부르는 말").split(",").map((s) => s.trim()).filter(Boolean),
        runner: grab("런너", "either"),
        surfaces: grab("제어층", "L1"),
        minutes: grab("한 번에 걸리는 시간"),
        what: plain(section("무엇을 만드는 업무인가").split("\n\n")[0] || ""),
        steps: section("절차"),
        outputs: section("산출물"),
        traps: section("알려진 함정"),
        noask: section("묻지 말고 이렇게 한다") || section("묻는 건 이것 하나뿐"),
        stepCount: (section("절차").match(/^\d+\.\s/gm) || []).length,
        trapCount: (section("알려진 함정").match(/^-\s/gm) || []).length,
        scripts,
      };
    })
    .filter(Boolean);
}

function tasks() {
  const T = path.join(ROOT, "tasks");
  const doneDir = path.join(T, "done");
  let done = 0;
  if (fs.existsSync(doneDir))
    for (const e of fs.readdirSync(doneDir, { withFileTypes: true }))
      if (e.isDirectory()) done += ls(path.join(doneDir, e.name)).length;
  return { queue: ls(path.join(T, "queue")).length, doing: ls(path.join(T, "doing")).length, done };
}

const M = manuals();
const T = tasks();
let commit = "";
try {
  commit = execFileSync("git", ["log", "-1", "--format=%cd", "--date=format:%Y-%m-%d %H:%M"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
} catch {}
const now = new Date().toLocaleString("ko-KR", { dateStyle: "long", timeStyle: "short" });

const layer = (s) => (String(s).match(/L[1-4]/g) || ["L1"]).pop();
const LAYER_WHY = {
  L1: "명령어와 스크립트로 처리합니다. 화면을 쓰지 않아 빠릅니다",
  L2: "인앱 브라우저로 화면을 읽습니다",
  L3: "이미 로그인된 크롬을 씁니다",
  L4: "화면을 직접 제어합니다. 기계당 한 번에 하나만 돕니다",
};

const cards = M.map((m) => {
  const runnerTip = m.runner.includes("codex")
    ? "길게 도는 작업이라 Codex 가 맡습니다"
    : "10분 안에 끝나는 작업이라 Claude 가 맡습니다";
  const lay = layer(m.surfaces);
  return [
    '<article class="card" id="' + m.id + '">',
    '<header class="chead"><h3>' + esc(m.title) + "</h3>",
    '<span class="lay lay' + lay[1] + '" data-tip="' + esc(LAYER_WHY[lay]) + '">' + lay + "</span></header>",
    m.what ? '<p class="what">' + esc(m.what) + "</p>" : "",
    '<div class="say"><span class="saylabel">이렇게 말하면 됩니다</span><div class="chips">' +
      m.triggers
        .map((w) => '<button class="chip" data-copy="' + esc(w) + '" data-tip="누르면 복사됩니다">' + esc(w) + "</button>")
        .join("") +
      "</div></div>",
    '<ul class="meta">',
    '<li data-tip="' + esc(runnerTip) + '">' + esc(m.runner) + "</li>",
    m.minutes ? '<li data-tip="한 번 돌릴 때 걸리는 시간입니다">' + esc(m.minutes) + "</li>" : "",
    m.stepCount ? '<li data-tip="매뉴얼에 적힌 단계 수입니다">' + m.stepCount + "단계</li>" : "",
    m.trapCount
      ? '<li data-tip="실제로 겪고 적어 둔 실패 사례입니다. 같은 실수를 반복하지 않습니다">함정 ' + m.trapCount + "</li>"
      : "",
    m.scripts.length ? '<li data-tip="' + esc(m.scripts.join(", ")) + '">전용 도구 ' + m.scripts.length + "</li>" : "",
    "</ul>",
    '<details><summary>자세히 <span class="caret"></span></summary><div class="detail">',
    m.steps ? '<h4 class="dh">어떻게 하나</h4>' + md(m.steps) : "",
    m.outputs ? '<h4 class="dh">무엇이 남나</h4>' + md(m.outputs) : "",
    m.traps ? '<h4 class="dh">겪어 본 함정</h4>' + md(m.traps) : "",
    m.noask ? '<h4 class="dh">이럴 땐 묻지 않고 진행합니다</h4>' + md(m.noask) : "",
    '<p class="src"><a href="' + REPO + "/blob/main/manuals/" + m.id + '/MANUAL.md">매뉴얼 원문 보기 →</a></p>',
    "</div></details></article>",
  ]
    .filter(Boolean)
    .join("\n");
}).join("\n");

const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>업무 관제탑</title>
<meta name="description" content="한 문장만 말하면 됩니다. 등록된 업무와 부르는 말을 모아 둔 곳.">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<meta property="og:title" content="업무 관제탑">
<meta property="og:description" content="한 문장만 말하면 됩니다.">
<style>
:root{
  --bg:#faf9f7; --card:#fff; --ink:#14161a; --ink2:#4a4f57; --dim:#868c95;
  --line:#e9e7e2; --line2:#d8d5ce;
  --acc:#2f5fd0; --accBg:#eef2fd;
  --warn:#a2542a; --warnBg:#fbf0e7;
  --ok:#1c6b4a; --okBg:#e6f2ec;
  --r:14px;
  --shadow:0 1px 2px rgba(20,22,26,.04), 0 8px 24px -16px rgba(20,22,26,.18);
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#0e1013; --card:#171a1f; --ink:#eceef1; --ink2:#b4bac2; --dim:#7e858f;
    --line:#242830; --line2:#343a44;
    --acc:#89aef5; --accBg:#18223a;
    --warn:#e0a077; --warnBg:#2c211a;
    --ok:#5cc396; --okBg:#12291f;
    --shadow:0 1px 2px rgba(0,0,0,.3);
  }
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);
  font:16px/1.68 -apple-system,BlinkMacSystemFont,"Pretendard","Apple SD Gothic Neo","Malgun Gothic",Segoe UI,sans-serif;
  -webkit-font-smoothing:antialiased;word-break:keep-all}
.wrap{max-width:760px;margin:0 auto;padding:64px 20px 88px}
header.top{margin-bottom:44px}
h1{margin:0 0 14px;font-size:clamp(28px,6vw,38px);font-weight:750;letter-spacing:-.03em;line-height:1.2}
.lede{margin:0;color:var(--ink2);font-size:17px;max-width:34em}
.lede strong{color:var(--ink);font-weight:650}
.stamp{margin:18px 0 0;font-size:13px;color:var(--dim);font-variant-numeric:tabular-nums}
.how{margin:28px 0 0;padding:18px 20px;background:var(--accBg);border-radius:var(--r);font-size:15px;color:var(--ink2);line-height:1.7}
.how b{color:var(--ink)}
.how .ex{display:inline-block;margin-top:10px;padding:7px 14px;background:var(--card);border:1px solid var(--line2);border-radius:99px;font-size:15px;color:var(--ink);font-weight:600}
h2{font-size:12px;font-weight:700;letter-spacing:.13em;text-transform:uppercase;color:var(--dim);margin:52px 0 16px}
.cards{display:flex;flex-direction:column;gap:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:22px 22px 18px;box-shadow:var(--shadow)}
.chead{display:flex;align-items:baseline;gap:10px;margin-bottom:8px}
.card h3{margin:0;font-size:19px;font-weight:680;letter-spacing:-.02em;flex:1;line-height:1.35}
.what{margin:0 0 18px;color:var(--ink2);font-size:15px}
.say{margin:0 0 16px}
.saylabel{display:block;font-size:12px;color:var(--dim);margin-bottom:8px;font-weight:600}
.chips{display:flex;flex-wrap:wrap;gap:7px}
.chip{font:inherit;font-size:14.5px;font-weight:600;cursor:pointer;background:var(--accBg);color:var(--acc);border:1px solid transparent;padding:6px 13px;border-radius:99px;transition:.13s}
.chip::before{content:"\\201C"}
.chip::after{content:"\\201D"}
.chip:hover{border-color:var(--acc)}
.chip.copied{background:var(--okBg);color:var(--ok)}
.chip.copied::before,.chip.copied::after{content:""}
ul.meta{list-style:none;display:flex;flex-wrap:wrap;gap:6px 14px;margin:0;padding:0;font-size:13px;color:var(--dim)}
ul.meta li{cursor:help;border-bottom:1px dotted var(--line2);padding-bottom:1px}
.lay{font-size:11.5px;font-weight:700;padding:3px 8px;border-radius:6px;letter-spacing:.04em;cursor:help;flex:none}
.lay1{background:var(--okBg);color:var(--ok)}
.lay2{background:var(--accBg);color:var(--acc)}
.lay3{background:var(--warnBg);color:var(--warn)}
.lay4{background:var(--warnBg);color:var(--warn)}
[data-tip]{position:relative}
[data-tip]:hover::after,[data-tip]:focus-visible::after{
  content:attr(data-tip);position:absolute;left:50%;bottom:calc(100% + 8px);transform:translateX(-50%);
  background:var(--ink);color:var(--bg);font-size:12.5px;font-weight:500;line-height:1.5;
  padding:7px 11px;border-radius:8px;white-space:normal;width:max-content;max-width:240px;
  z-index:20;pointer-events:none;box-shadow:0 6px 20px -8px rgba(0,0,0,.4);letter-spacing:0;text-transform:none}
details{margin-top:16px;border-top:1px solid var(--line);padding-top:12px}
summary{cursor:pointer;font-size:14px;font-weight:600;color:var(--acc);list-style:none;display:inline-flex;align-items:center;gap:5px}
summary::-webkit-details-marker{display:none}
.caret{display:inline-block;width:0;height:0;border:4px solid transparent;border-top-color:currentColor;margin-top:3px;transition:.15s}
details[open] .caret{transform:rotate(180deg);margin-top:-3px}
.detail{padding-top:6px;font-size:14.5px;color:var(--ink2)}
.dh{font-size:13px;font-weight:700;color:var(--ink);margin:22px 0 8px}
.dh:first-child{margin-top:14px}
.detail p{margin:0 0 10px}
.detail ul,.detail ol{margin:0 0 12px;padding-left:20px}
.detail li{margin-bottom:7px}
.detail strong{color:var(--ink);font-weight:650}
.detail blockquote{margin:0 0 12px;padding:10px 14px;background:var(--warnBg);border-radius:9px;color:var(--ink);font-size:14px}
.detail h4{font-size:14px;margin:16px 0 7px;color:var(--ink)}
code{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--bg);border:1px solid var(--line);border-radius:5px;padding:1px 5px;word-break:break-all}
pre{margin:8px 0 12px;background:var(--bg);border:1px solid var(--line);border-radius:9px;padding:12px 14px;overflow-x:auto}
pre code{background:none;border:none;padding:0;word-break:normal}
.tw{overflow-x:auto;margin:0 0 12px}
table{border-collapse:collapse;font-size:13.5px;width:100%}
th,td{text-align:left;padding:7px 12px 7px 0;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--dim);font-weight:600;font-size:12.5px;white-space:nowrap}
.src{margin:18px 0 0;font-size:13px}
.src a{color:var(--acc);text-decoration:none;font-weight:600}
.board{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
@media(max-width:560px){.board{grid-template-columns:1fr}}
.col{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:16px 18px;box-shadow:var(--shadow)}
.col h3{margin:0 0 4px;font-size:12px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--dim)}
.col .n{font-size:26px;font-weight:700;letter-spacing:-.03em;font-variant-numeric:tabular-nums;line-height:1.2}
.col p{margin:4px 0 0;font-size:13px;color:var(--dim)}
.setup{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:22px;box-shadow:var(--shadow)}
.setup p{margin:0 0 12px;font-size:15px;color:var(--ink2)}
.setup p:last-child{margin-bottom:0}
.setup b{color:var(--ink)}
footer{margin-top:60px;padding-top:20px;border-top:1px solid var(--line);font-size:13px;color:var(--dim);display:flex;flex-wrap:wrap;gap:6px 16px}
footer a{color:var(--acc);text-decoration:none}
.toast{position:fixed;left:50%;bottom:28px;transform:translate(-50%,14px);background:var(--ink);color:var(--bg);padding:11px 20px;border-radius:99px;font-size:14px;font-weight:600;opacity:0;transition:.2s;pointer-events:none;z-index:50}
.toast.on{opacity:1;transform:translate(-50%,0)}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style>
</head>
<body>
<div class="wrap">

<header class="top">
  <h1>업무 관제탑</h1>
  <p class="lede">회사에서 반복하는 일을 <strong>매뉴얼 한 장</strong>으로 적어 뒀습니다.
  Claude 나 Codex 새 세션에 <strong>한 문장</strong>만 말하면 그대로 처리합니다.</p>

  <div class="how">
    <b>쓰는 법</b> — 아래 업무 카드에서 따옴표 안의 말을 그대로 하면 됩니다. 눌러서 복사할 수 있습니다.
    <br><span class="ex">카톡 봐줘</span>
  </div>

  <p class="stamp">${esc(now)} 기준 · 등록된 업무 ${M.length}개</p>
</header>

<section>
  <h2>등록된 업무</h2>
  <div class="cards">
${cards || '<p class="what">아직 없습니다.</p>'}
  </div>
</section>

<section>
  <h2>일감</h2>
  <div class="board">
    <div class="col"><h3>대기</h3><div class="n">${T.queue}</div><p>줄 서 있는 일</p></div>
    <div class="col"><h3>진행</h3><div class="n">${T.doing}</div><p>지금 돌아가는 일</p></div>
    <div class="col"><h3>완료</h3><div class="n">${T.done}</div><p>끝낸 일 누적</p></div>
  </div>
</section>

<section>
  <h2>새 컴퓨터에서 쓰려면</h2>
  <div class="setup">
    <p>구글 드라이브 <b>내 드라이브 → 에이전트</b> 폴더의 <code>설치.mjs</code> 를 한 번 실행하면 끝납니다.
    지침·스킬·기억·매뉴얼이 전부 제자리에 깔립니다.</p>
    <pre><code>node "&lt;드라이브&gt;/내 드라이브/에이전트/설치.mjs"</code></pre>
    <p>설치가 안 된 컴퓨터에서도 <b>"G드라이브 에이전트 폴더 보고 ○○ 해줘"</b> 라고 하면 바로 됩니다.
    그 폴더 하나에 매뉴얼·회사 정보·계정이 다 들어 있습니다.</p>
    <p><b>새 업무를 늘리려면</b> 그냥 시켜 보고 <b>"방금 한 거 업무로 등록해줘"</b> 라고 하면 됩니다.
    하면서 겪은 함정까지 매뉴얼에 적혀서 다음부터는 헤매지 않습니다.</p>
  </div>
</section>

<footer>
  <span><a href="${REPO}">github.com/yeohj0710/ops</a></span>
  ${commit ? "<span>마지막 갱신 " + esc(commit) + "</span>" : ""}
</footer>

</div>
<div class="toast" id="toast">복사했습니다</div>
<script>
document.addEventListener('click', async function (e) {
  var b = e.target.closest('.chip');
  if (!b) return;
  var text = b.dataset.copy;
  try { await navigator.clipboard.writeText(text); }
  catch (err) {
    var ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  }
  var old = b.textContent;
  b.classList.add('copied'); b.textContent = '복사됨';
  var t = document.getElementById('toast');
  t.classList.add('on'); setTimeout(function () { t.classList.remove('on'); }, 1400);
  setTimeout(function () { b.classList.remove('copied'); b.textContent = old; }, 1400);
});
</script>
</body>
</html>
`;

fs.mkdirSync(DIST, { recursive: true });
fs.writeFileSync(path.join(DIST, "index.html"), html, "utf8");
console.log(
  "구웠다: " + path.join(DIST, "index.html") + "  (" + (html.length / 1024).toFixed(0) + "KB · 업무 " + M.length + "개)"
);
