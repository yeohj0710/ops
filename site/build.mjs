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

const M = manuals();
let commit = "";
try {
  commit = execFileSync("git", ["log", "-1", "--format=%cd", "--date=format:%Y-%m-%d %H:%M"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
} catch {}

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
  // 접힌 상태에서는 제목만 보인다. 펼치면 개요, 한 번 더 펼치면 매뉴얼 본문.
  return [
    '<details class="card" id="' + m.id + '">',
    "<summary>",
    '<span class="ttl">' + esc(m.title) + "</span>",
    '<span class="lay lay' + lay[1] + '" data-tip="' + esc(LAYER_WHY[lay]) + '">' + lay + "</span>",
    '<span class="caret"></span>',
    "</summary>",
    '<div class="body">',
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
    '<details class="more"><summary>매뉴얼 전문 <span class="caret"></span></summary><div class="detail">',
    m.steps ? '<h4 class="dh">어떻게 하나</h4>' + md(m.steps) : "",
    m.outputs ? '<h4 class="dh">무엇이 남나</h4>' + md(m.outputs) : "",
    m.traps ? '<h4 class="dh">겪어 본 함정</h4>' + md(m.traps) : "",
    m.noask ? '<h4 class="dh">이럴 땐 묻지 않고 진행합니다</h4>' + md(m.noask) : "",
    '<p class="src"><a href="' + REPO + "/blob/main/manuals/" + m.id + '/MANUAL.md">매뉴얼 원문 보기 →</a></p>',
    "</div></details>",
    "</div></details>",
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
header.top{margin-bottom:26px}
h1{margin:0 0 14px;font-size:clamp(28px,6vw,38px);font-weight:750;letter-spacing:-.03em;line-height:1.2}
.lede{margin:0;color:var(--ink2);font-size:17px;max-width:34em}
.lede strong{color:var(--ink);font-weight:650}
h2{font-size:12px;font-weight:700;letter-spacing:.13em;text-transform:uppercase;color:var(--dim);margin:52px 0 16px}
.cards{display:flex;flex-direction:column;gap:10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--shadow);overflow:hidden}
.card>summary{display:flex;align-items:center;gap:10px;cursor:pointer;list-style:none;
  padding:17px 20px;font-size:18px;font-weight:680;letter-spacing:-.02em;line-height:1.35;transition:background .13s}
.card>summary::-webkit-details-marker{display:none}
.card>summary:hover{background:var(--accBg)}
.card[open]>summary{border-bottom:1px solid var(--line)}
.ttl{flex:1}
.card>summary .caret{color:var(--dim);flex:none}
.card[open]>summary .caret{transform:rotate(180deg)}
.body{padding:20px}
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
.more{margin-top:16px;border-top:1px solid var(--line);padding-top:12px}
.more>summary{cursor:pointer;font-size:14px;font-weight:600;color:var(--acc);list-style:none;display:inline-flex;align-items:center;gap:5px}
.more>summary::-webkit-details-marker{display:none}
.caret{display:inline-block;width:0;height:0;border:4px solid transparent;border-top-color:currentColor;margin-top:3px;transition:.15s}
.more[open]>summary .caret{transform:rotate(180deg);margin-top:-3px}
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
.doc{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:24px;box-shadow:var(--shadow)}
.doc h3{font-size:15.5px;font-weight:700;color:var(--ink);letter-spacing:-.015em;margin:30px 0 9px}
.doc h3:first-child{margin-top:0}
.doc p{margin:0 0 12px;font-size:15px;color:var(--ink2)}
.doc p:last-child{margin-bottom:0}
.doc b{color:var(--ink);font-weight:650}
.chip.quote{display:block;width:100%;text-align:left;margin:0 0 12px;padding:13px 16px;border-radius:10px;font-size:15.5px}
.doc td:first-child{white-space:nowrap;font-weight:700;color:var(--ink);font-size:12.5px}
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
  <p class="lede">반복하는 회사 일을 <strong>매뉴얼 한 장</strong>씩 적어 뒀습니다.
  눌러서 펼치면 뭐라고 말하면 되는지 나옵니다.</p>
</header>

<section>
  <div class="cards">
${cards || '<p class="what">아직 없습니다.</p>'}
  </div>
</section>

<section>
  <h2>돌아가는 방식</h2>
  <div class="doc">

    <h3>세팅은 구글 드라이브 한 곳에 있다</h3>
    <p>구글 드라이브 <b>내 드라이브 → 에이전트</b> 폴더에 매뉴얼·회사 정보·로그인 계정을 다 넣어 뒀습니다.
    그래서 아무것도 안 깔린 새 컴퓨터에서도, Claude 나 Codex 새 세션에 이 한 줄이면 됩니다.</p>
    <button class="chip quote" data-copy="G드라이브 에이전트 폴더 보고 카톡 봐줘" data-tip="누르면 복사됩니다">G드라이브 에이전트 폴더 보고 카톡 봐줘</button>
    <p>에이전트가 그 폴더에서 매뉴얼을 찾아 읽고, 필요한 회사 정보와 계정도 거기서 꺼내 씁니다.
    배경을 매번 설명해 줄 필요가 없습니다. 시킬 때마다 <b>한 문장이면 끝납니다.</b></p>

    <h3>화면까지 직접 만진다 — L1에서 L4까지</h3>
    <p>일마다 어디까지 만져야 하는지가 다릅니다. 매뉴얼에 그 층을 적어 두면 에이전트가 맞는 도구를 골라 씁니다.</p>
    <div class="tw"><table><thead><tr><th>층</th><th>무엇으로</th><th>예</th></tr></thead><tbody>
      <tr><td>L1</td><td>명령어와 스크립트</td><td>파일 찾기, 영상 자르기, 데이터 만들기</td></tr>
      <tr><td>L2</td><td>인앱 브라우저</td><td>로그인 없이 열리는 웹 화면 읽기</td></tr>
      <tr><td>L3</td><td>이미 로그인된 크롬</td><td>인스타·유튜브·인포크처럼 계정이 있어야 하는 일</td></tr>
      <tr><td>L4</td><td>컴퓨터 전체 제어</td><td>브라우저 밖 프로그램. 카톡, 한글, 프리미어</td></tr>
    </tbody></table></div>
    <p>L3·L4 까지 열어 뒀습니다. 그래서 <b>계정으로 하는 일은 대부분 사람 손을 안 거치고 끝납니다</b> —
    유튜브에 올리고, 인스타에 게시하고, 관리자 페이지를 고치고, 카톡을 읽는 것까지.
    보내기·게시·결제·삭제처럼 되돌릴 수 없는 것만 한 번 물어봅니다.</p>

    <h3>업무 늘리기</h3>
    <p>새 일은 그냥 시켜 보면 됩니다. 끝나고 <b>"방금 한 거 업무로 등록해줘"</b> 라고 하면
    이 목록에 카드가 하나 늘어납니다. 하다가 막혔던 지점까지 매뉴얼에 적혀서 다음부터는 같은 데서 안 헤맵니다.</p>

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
