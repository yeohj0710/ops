#!/usr/bin/env node
// 관제탑 사이트를 굽는다. 저장소를 읽어 정적 파일 하나로 만든다.
//   node site/build.mjs   →  site/dist/index.html
//
// 이 사이트가 답해야 하는 질문은 하나다. "이거 어떻게 시키지?"
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

    // 번호 목록. 항목 하나가 여러 줄이고 코드블록과 표가 섞이므로 조각으로 모은다.
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
          // 빈 줄에서 끊지 않는다. 코드블록이나 표 뒤에 빈 줄이 오고 다음 번호가 이어지는데,
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

    if (/^#{2,3}\s+/.test(L)) {
      out.push("<h4>" + inline(L.replace(/^#{2,3}\s+/, "")) + "</h4>");
      i++;
      continue;
    }
    if (L.trim() === "" || /^---+$/.test(L.trim())) {
      i++;
      continue;
    }

    // 목록 기호는 뒤에 공백이 와야 목록이다. 이걸 안 따지면 `**굵게**` 로 시작하는 문단을
    // 별표 목록으로 오해해서 어느 갈래에도 안 걸리고 통째로 사라진다.
    const notList = (s) => !/^\s*([-*]\s|\d+\.\s)/.test(s);
    const para = [];
    while (
      i < lines.length && lines[i].trim() && !/^[#>|]/.test(lines[i]) &&
      !isFence(lines[i]) && notList(lines[i])
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

      // 절차를 "## 절차" 로 안 적고 "## P1." 처럼 단계별 절로 나눈 매뉴얼이 있다(쇼츠).
      // 그럴 때는 개요 다음부터 산출물 앞까지를 통째로 절차로 본다. 안 그러면 카드가 텅 빈다.
      const steps = (() => {
        const s = section("절차");
        if (s) return s;
        const m = t.match(/\n(## P\d[\s\S]*?)(?=\n## 산출물|\n## 완료 검사|$)/);
        return m ? m[1].trim() : "";
      })();
      const stepCount =
        (section("절차").match(/^\d+\.\s/gm) || []).length || (steps.match(/^## P\d/gm) || []).length;

      return {
        id: d.name,
        title: (t.match(/^#\s+(.+)$/m) || [, d.name])[1].trim(),
        triggers: grab("부르는 말").split(",").map((s) => s.trim()).filter(Boolean),
        runner: grab("런너", "either"),
        surfaces: grab("제어층", "L1"),
        minutes: grab("한 번에 걸리는 시간"),
        what: plain(section("무엇을 만드는 업무인가").split("\n\n")[0] || ""),
        easy: section("쉬운 설명"),
        steps,
        outputs: section("산출물"),
        traps: section("알려진 함정"),
        noask: section("묻지 말고 이렇게 한다") || section("묻는 건 이것 하나뿐"),
        stepCount,
        trapCount: (section("알려진 함정").match(/^-\s/gm) || []).length,
        scripts,
      };
    })
    .filter(Boolean);
}

// 회사 로고, "W" 심볼. 원본은 드라이브의 로고 모음 SVG 인데 940KB 색프로파일이 박혀 있어
// 기하만 꺼내 site/logo.svg 로 들여놨다. fill 은 currentColor 라 쓰는 자리에서 색을 정한다.
// 브랜드 심볼색 #60A5FA, 워드마크 네이비 #004881.
const SKY = "#60A5FA";
const logoRaw = fs.readFileSync(path.join(ROOT, "site", "logo.svg"), "utf8").trim();
const logoInner = logoRaw.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
const logoBox = (logoRaw.match(/viewBox="([^"]+)"/) || [, "0 0 120.3888 90.541466"])[1];
const logoSvg = (cls) =>
  '<svg class="' + cls + '" viewBox="' + logoBox + '" aria-hidden="true">' + logoInner + "</svg>";
// 파비콘은 정사각이라야 한다. 가로가 긴 심볼(120.4 x 90.5)을 가운데로 넣는다.
// 탭에서 16px 로 줄어드니 여백은 최소만 준다. 심볼이 가로폭의 97% 를 차지한다.
const favicon =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1.9 -16.9 124.2 124.2">' +
      logoInner.replace('fill="currentColor"', 'fill="' + SKY + '"') +
      "</svg>"
  );

// 푸터 사업자 정보. wellnessbox.kr 의 lib/site-identity 와 같은 값이다.
const BIZ = [
  ["운영 사업자", "주식회사 웰니스박스"],
  ["대표자", "권혁찬"],
  ["사업자등록번호", "728-88-03267"],
  ["법인등록번호", "110111-0932570"],
  ["통신판매업신고", "제2025-서울동대문-1562호"],
  ["대표 전화", "02-6241-5530"],
  ["대표 이메일", "contact@wellnessbox.kr"],
  ["주소", "서울특별시 광진구 광나루로 520, 신용보증기금 4층 NEST AI LAB 402호"],
];

const M = manuals();
let commit = "";
try {
  commit = execFileSync("git", ["log", "-1", "--format=%cd", "--date=format:%Y-%m-%d %H:%M"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
} catch {}

const GRIP =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="6" cy="4" r="1.3"/><circle cx="10" cy="4" r="1.3"/>' +
  '<circle cx="6" cy="8" r="1.3"/><circle cx="10" cy="8" r="1.3"/>' +
  '<circle cx="6" cy="12" r="1.3"/><circle cx="10" cy="12" r="1.3"/></svg>';

const layer = (s) => (String(s).match(/L[1-4]/g) || ["L1"]).pop();
const LAYER_WHY = {
  L1: "명령어와 스크립트로 처리합니다. 화면을 쓰지 않아 빠릅니다",
  L2: "인앱 브라우저로 화면을 읽습니다",
  L3: "이미 로그인된 크롬을 씁니다",
  L4: "화면을 직접 제어합니다. 기계당 한 번에 하나만 돕니다",
};

// 목록은 접힌 줄 하나다. 눌러서 펼치고, 손잡이를 끌어 순서를 바꾸거나 보관함에 넣는다.
const cards = M.map((m) => {
  const runnerTip = m.runner.includes("codex")
    ? "길게 도는 작업이라 Codex 가 맡습니다"
    : "10분 안에 끝나는 작업이라 Claude 가 맡습니다";
  const lay = layer(m.surfaces);
  return [
    '<details class="card rev" id="' + m.id + '" data-id="' + m.id + '">',
    "<summary>",
    '<span class="grip" title="끌어서 순서를 바꾸거나 보관함에 넣습니다" aria-label="끌기 손잡이">' + GRIP + "</span>",
    '<span class="ttl">' + esc(m.title) + "</span>",
    '<span class="lay lay' + lay[1] + '" data-tip="' + esc(LAYER_WHY[lay]) + '">' + lay + "</span>",
    '<span class="caret"></span>',
    "</summary>",
    '<div class="body">',
    // 부르는 말을 여러 개 늘어놓으면 위 원리에 적어 둔 한 가지 형식과 어긋나 헷갈린다.
    // 카드에는 그 형식 그대로 만든 문장 하나만 둔다.
    (() => {
      const say = "G드라이브 에이전트 폴더 참고해서 " + m.title + " 업무 해줘";
      return '<div class="say"><button class="chip" data-copy="' + esc(say) + '">' + esc(say) + "</button></div>";
    })(),
    '<ul class="meta">',
    '<li data-tip="' + esc(runnerTip) + '">' + esc(m.runner) + " 가 맡습니다</li>",
    m.minutes ? '<li data-tip="한 번 돌릴 때 걸리는 시간입니다">' + esc(m.minutes) + "</li>" : "",
    m.stepCount ? '<li data-tip="매뉴얼에 적힌 단계 수입니다">' + m.stepCount + "단계</li>" : "",
    m.trapCount
      ? '<li data-tip="실제로 겪고 적어 둔 실패 사례입니다. 같은 실수를 반복하지 않습니다">겪어 본 함정 ' +
        m.trapCount + "가지</li>"
      : "",
    m.scripts.length ? '<li data-tip="' + esc(m.scripts.join(", ")) + '">전용 도구 ' + m.scripts.length + "개</li>" : "",
    '<li data-tip="' + esc(LAYER_WHY[lay]) + '">' + lay + " 까지 씁니다</li>",
    "</ul>",
    // 개요(`무엇을 만드는 업무인가`)는 에이전트가 읽는 문장이라 사람에게는 딱딱하다.
    // 쉬운 설명이 있으면 그걸 본문으로 쓰고, 없을 때만 개요를 보여준다.
    m.easy ? '<div class="easy">' + md(m.easy) + "</div>" : m.what ? '<p class="lead">' + esc(m.what) + "</p>" : "",
    '<details class="more"><summary>매뉴얼 전문 (에이전트가 읽는 절차서) <span class="caret"></span></summary><div class="detail">',
    m.steps ? '<h4 class="dh">절차</h4>' + md(m.steps) : "",
    m.outputs ? '<h4 class="dh">산출물</h4>' + md(m.outputs) : "",
    m.traps ? '<h4 class="dh">겪어 본 함정</h4>' + md(m.traps) : "",
    m.noask ? '<h4 class="dh">묻지 않고 진행하는 것</h4>' + md(m.noask) : "",
    '<p class="src"><a href="' + REPO + "/blob/main/manuals/" + m.id + '/MANUAL.md">매뉴얼 원문 보기</a></p>',
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
<title>웰니스박스 에이전트 기반 업무 자동화</title>
<meta name="description" content="반복하는 회사 일을 매뉴얼 한 장씩 적어 뒀습니다. 새 세션에 한 줄만 말하면 끝까지 합니다.">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<meta property="og:title" content="웰니스박스 에이전트 기반 업무 자동화">
<meta property="og:description" content="반복하는 회사 일을 매뉴얼 한 장씩 적어 뒀습니다.">
<link rel="icon" type="image/svg+xml" href="${favicon}">
<link rel="apple-touch-icon" href="${favicon}">
<script>document.documentElement.className='js'</script>
<style>
/* 색과 그라데이션은 wellnessbox.kr 에서 가져왔다. 하늘색 글로우 + 흰 바탕. */
:root{
  --card:#fff; --ink:#0f172a; --ink2:#475569; --dim:#94a3b8;
  --line:rgba(226,232,240,.9); --line2:#cbd5e1;
  --acc:#2563eb; --accBg:#eff6ff;
  --sky:${SKY};
  --warn:#b45309; --warnBg:#fffbeb;
  --ok:#047857; --okBg:#ecfdf5;
  --r:16px;
  --shadow:0 1px 2px rgba(15,23,42,.04), 0 14px 34px -24px rgba(15,23,42,.28);
  --shadow2:0 2px 6px rgba(15,23,42,.05), 0 22px 46px -26px rgba(15,23,42,.34);
  --page:radial-gradient(circle at 12% -2%, rgba(125,211,252,.30), transparent 34%),
         radial-gradient(circle at 90% 1%, rgba(191,219,254,.34), transparent 28%),
         linear-gradient(180deg,#f8fbff 0%,#fff 38%,#fff 100%);
  --ease:cubic-bezier(.16,1,.3,1);
}
@media (prefers-color-scheme:dark){
  :root{
    --card:#141922; --ink:#e8edf5; --ink2:#aab6c6; --dim:#748095;
    --line:rgba(255,255,255,.09); --line2:rgba(255,255,255,.16);
    --acc:#8ab4ff; --accBg:rgba(96,165,250,.13);
    --warn:#e0a077; --warnBg:rgba(224,160,119,.11);
    --ok:#5cc396; --okBg:rgba(92,195,150,.11);
    --shadow:0 1px 2px rgba(0,0,0,.34);
    --shadow2:0 2px 10px rgba(0,0,0,.45);
    --page:radial-gradient(circle at 12% -2%, rgba(56,189,248,.14), transparent 34%),
           radial-gradient(circle at 90% 1%, rgba(99,102,241,.12), transparent 28%),
           linear-gradient(180deg,#0c1017 0%,#0b0e14 40%,#0b0e14 100%);
  }
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;color:var(--ink);background:var(--page);background-attachment:fixed;
  font:16px/1.68 -apple-system,BlinkMacSystemFont,"Pretendard","Apple SD Gothic Neo","Malgun Gothic",Segoe UI,sans-serif;
  -webkit-font-smoothing:antialiased;word-break:keep-all}
.wrap{max-width:760px;margin:0 auto;padding:44px 20px 80px}
header.top{margin-bottom:26px}
.hmark{display:inline-block;color:var(--sky);margin:0 0 14px}
.hmark svg{width:38px;height:auto;display:block}
h1{margin:0 0 12px;font-size:clamp(28px,6.4vw,42px);font-weight:760;letter-spacing:-.035em;line-height:1.16}
.lede{margin:0;color:var(--ink2);font-size:16.5px;max-width:34em}
.lede strong{color:var(--ink);font-weight:650}

/* 원리. 이건 접지 않는다. 어떻게 돌아가는지 알아야 업무에 응용할 수 있다. */
.why{margin:20px 0 0;padding:20px 22px;border-radius:20px;position:relative;overflow:hidden;
  border:1px solid var(--line);background:var(--card);box-shadow:var(--shadow)}
.why::before{content:"";position:absolute;inset:0;pointer-events:none;
  background:radial-gradient(circle at 0% 0%, rgba(125,211,252,.22), transparent 46%)}
@media (prefers-color-scheme:dark){.why::before{background:radial-gradient(circle at 0% 0%, rgba(56,189,248,.13), transparent 46%)}}
.why ol{position:relative;margin:0;padding:0;list-style:none;counter-reset:w;
  display:flex;flex-direction:column;gap:12px}
.why li{counter-increment:w;display:grid;grid-template-columns:26px minmax(0,1fr);gap:12px;align-items:start;
  font-size:15.5px;color:var(--ink2);line-height:1.6}
.why li::before{content:counter(w);display:grid;place-items:center;width:26px;height:26px;border-radius:9px;
  background:var(--accBg);color:var(--acc);font-size:12.5px;font-weight:700;margin-top:1px}
.why b{color:var(--ink);font-weight:660}
.why .say2{display:inline-block;margin-top:7px;padding:8px 15px;border-radius:99px;font-weight:650;
  background:var(--accBg);color:var(--acc);font-size:14.5px;border:1px solid transparent;
  font-family:inherit;cursor:pointer;text-align:left;transition:background .13s,color .13s,border-color .13s}
.why .say2::before{content:"\\201C"}.why .say2::after{content:"\\201D"}
.why .say2:hover{border-color:var(--acc)}
.why .say2.copied{background:var(--okBg);color:var(--ok);border-color:transparent}
.helpbtn{position:relative;margin:16px 0 0;display:inline-flex;align-items:center;gap:8px;
  font:inherit;font-size:14.5px;font-weight:650;cursor:pointer;
  padding:10px 18px;border-radius:99px;border:1px solid var(--line2);background:var(--card);color:var(--ink);
  box-shadow:var(--shadow);transition:.18s var(--ease)}
.helpbtn:hover{transform:translateY(-1px);box-shadow:var(--shadow2);border-color:var(--acc);color:var(--acc)}
.helpbtn svg{width:16px;height:16px}
h2{font-size:12px;font-weight:700;letter-spacing:.13em;text-transform:uppercase;color:var(--dim);margin:34px 0 12px}
.cards{display:flex;flex-direction:column;gap:9px;min-height:12px}
/* overflow 를 숨기면 안 된다. 툴팁이 카드 밖으로 나가는데 거기서 잘린다.
   대신 summary 자체에 모서리를 줘서 hover 배경이 둥근 테두리를 안 넘게 한다. */
.card{position:relative;background:var(--card);border:1px solid var(--line);border-radius:var(--r);
  box-shadow:var(--shadow);transition:box-shadow .2s var(--ease),border-color .2s}
.card:hover{box-shadow:var(--shadow2);border-color:var(--line2);z-index:3}
.card>summary{display:flex;align-items:center;gap:10px;cursor:pointer;list-style:none;
  padding:15px 18px 15px 8px;font-size:18px;font-weight:680;letter-spacing:-.02em;line-height:1.35;
  border-radius:calc(var(--r) - 1px);transition:background .15s}
.card[open]>summary{border-radius:calc(var(--r) - 1px) calc(var(--r) - 1px) 0 0}
.card>summary::-webkit-details-marker{display:none}
.card>summary:hover{background:var(--accBg)}
.card>summary:hover .ttl{color:var(--acc)}
.card[open]{border-color:var(--line2)}
.card[open]>summary{border-bottom:1px solid var(--line)}
.card[open]>summary .caret{transform:rotate(180deg)}
.ttl{flex:1;min-width:0;transition:color .15s}
.card>summary .caret{color:var(--dim);flex:none}
.body{padding:20px}
/* 초점 테두리. 요소마다 실제 모양에 맞춰 준다. 한 규칙으로 몰면 네모가 어긋나 보인다. */
.card>summary:focus-visible,.boxhead:focus-visible{outline:2px solid var(--acc);outline-offset:-2px;border-radius:0}
.chip:focus-visible,.helpbtn:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
.hclose:focus-visible,.grip:focus-visible{outline:2px solid var(--acc);outline-offset:1px}
.more>summary:focus-visible,.hsec>summary:focus-visible{outline:2px solid var(--acc);outline-offset:3px;border-radius:6px}
a:focus-visible{outline:2px solid var(--acc);outline-offset:2px;border-radius:4px}

/* 끌어서 옮기기. 잡은 카드는 손끝을 따라다니고, 원래 자리에는 빈 자리가 남는다. */
.grip{flex:none;display:grid;place-items:center;width:30px;height:30px;border-radius:9px;
  color:var(--dim);cursor:grab;touch-action:none;transition:color .15s,background .15s}
.grip svg{width:16px;height:16px;fill:currentColor}
.grip:hover{color:var(--acc);background:rgba(37,99,235,.12)}
.card.dragging{position:fixed;z-index:60;margin:0;pointer-events:none;cursor:grabbing;
  border-color:var(--acc);box-shadow:0 18px 44px -14px rgba(15,23,42,.42);
  transform:rotate(-.6deg) scale(1.02);transition:none}
.card.dragging>summary{background:none}
.ghost{border:2px dashed var(--acc);border-radius:var(--r);background:var(--accBg);opacity:.7}
body.dnd{cursor:grabbing;user-select:none;-webkit-user-select:none}

/* 자주 안 쓰는 업무를 치워두는 곳. 끌어다 넣고, 끌어서 도로 꺼낸다. */
.boxwrap{margin-top:26px;border-top:1px solid var(--line);padding-top:18px}
.boxhead{display:flex;align-items:center;gap:10px;width:100%;font:inherit;background:none;border:0;
  cursor:pointer;padding:6px 2px;color:var(--ink2);text-align:left;transition:color .15s}
.boxhead:hover{color:var(--acc)}
.boxhead .bicon{flex:none;display:grid;place-items:center;width:28px;height:28px;border-radius:9px;
  background:rgba(148,163,184,.12);color:var(--dim)}
.boxhead .bicon svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.6}
.boxhead b{font-size:14px;font-weight:650;color:var(--ink)}
.boxhead .bsub{font-size:12.5px;color:var(--dim)}
.boxhead .caret{margin-left:auto;color:var(--dim)}
.boxwrap.on .boxhead .caret{transform:rotate(180deg)}
.boxwrap.on .boxhead .bicon{background:var(--accBg);color:var(--acc)}
.boxed{display:none;flex-direction:column;gap:9px;margin-top:12px;padding:10px;border-radius:var(--r);
  border:1.5px dashed var(--line2);background:rgba(148,163,184,.05)}
.boxwrap.on .boxed,body.dnd .boxed{display:flex}
.boxed:empty::after{content:"끌어다 놓으면 목록에서 치워집니다";display:block;text-align:center;
  padding:20px 8px;font-size:13px;color:var(--dim)}
.boxed .card{box-shadow:none;background:transparent;border-style:dashed}
.boxed .card>summary{font-size:16.5px;padding-top:12px;padding-bottom:12px}
.boxed .card:hover{background:var(--card);border-style:solid}
body.dnd .boxed{border-color:var(--acc);background:var(--accBg)}
.what{margin:0 0 18px;color:var(--ink2);font-size:15px}
.say{margin:0 0 16px}
.chips{display:flex;flex-wrap:wrap;gap:7px}
/* 따옴표는 ::before / ::after 로 붙인다. 그래서 여기에 data-tip 을 달면 안 된다.
   툴팁도 ::after 를 쓰기 때문에 hover 하는 순간 닫는 따옴표가 사라지고 폭이 줄어 글이 접힌다. */
.chip{font:inherit;font-size:14.5px;font-weight:600;cursor:pointer;background:var(--accBg);color:var(--acc);
  border:1px solid transparent;padding:6px 13px;border-radius:99px;
  transition:background .13s,color .13s,border-color .13s}
.chip::before{content:"\\201C"}
.chip::after{content:"\\201D"}
.chip:hover{border-color:var(--acc)}
.chip.copied{background:var(--okBg);color:var(--ok);border-color:transparent}
ul.meta{list-style:none;display:flex;flex-wrap:wrap;gap:6px 14px;margin:0;padding:0;font-size:13px;color:var(--dim)}
ul.meta li{cursor:help;border-bottom:1px dotted var(--line2);padding-bottom:1px}
.lay{font-size:11.5px;font-weight:700;padding:3px 8px;border-radius:6px;letter-spacing:.04em;cursor:help;flex:none}
.lay1{background:var(--okBg);color:var(--ok)}
.lay2{background:var(--accBg);color:var(--acc)}
.lay3{background:var(--warnBg);color:var(--warn)}
.lay4{background:var(--warnBg);color:var(--warn)}
/* 툴팁은 마우스가 있는 화면에서만 뜬다. 손가락에는 hover 가 없어서 뜰 일이 없고,
   좁은 폭에서 억지로 띄우면 화면 밖으로 나간다. */
[data-tip]{position:relative}
@media (hover:hover){
  [data-tip]:hover::after,[data-tip]:focus-visible::after{
    content:attr(data-tip);position:absolute;left:50%;bottom:calc(100% + 8px);transform:translateX(-50%);
    background:var(--ink);color:var(--bg);font-size:12.5px;font-weight:500;line-height:1.5;
    padding:7px 11px;border-radius:8px;white-space:normal;width:max-content;max-width:min(240px,58vw);
    z-index:40;pointer-events:none;box-shadow:0 6px 20px -8px rgba(0,0,0,.4);letter-spacing:0;text-transform:none}
  /* 오른쪽 끝에 붙은 배지는 가운데 정렬하면 화면 밖으로 나간다. 오른쪽 모서리에 맞춘다. */
  .lay[data-tip]:hover::after,.lay[data-tip]:focus-visible::after{left:auto;right:-6px;transform:none}
  /* 메타 줄은 왼쪽부터 차니 앞쪽은 왼쪽, 뒤쪽 둘은 오른쪽 모서리에 맞춘다. */
  ul.meta li:first-child[data-tip]:hover::after{left:0;transform:none}
  ul.meta li:nth-last-child(-n+2)[data-tip]:hover::after{left:auto;right:0;transform:none}
}
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
/* 사용법 모달. 안에서도 접었다 폈다 하는 트리라 처음엔 요약만 보인다. */
dialog.help{border:0;padding:0;max-width:640px;width:calc(100% - 32px);max-height:86vh;border-radius:22px;
  background:var(--card);color:var(--ink);box-shadow:0 40px 90px -30px rgba(15,23,42,.5);overflow:hidden}
dialog.help::backdrop{background:rgba(15,23,42,.42);backdrop-filter:blur(3px)}
dialog.help[open]{animation:pop .26s var(--ease)}
@keyframes pop{from{opacity:0;transform:translateY(14px) scale(.985)}to{opacity:1;transform:none}}
.hhead{position:sticky;top:0;z-index:2;display:flex;align-items:flex-start;gap:12px;padding:22px 22px 16px;
  border-bottom:1px solid var(--line);background:var(--card)}
.hhead h2{margin:0;font-size:19px;font-weight:700;letter-spacing:-.02em;text-transform:none;color:var(--ink);flex:1}
.hclose{flex:none;width:32px;height:32px;border-radius:10px;border:1px solid var(--line);background:none;
  color:var(--ink2);cursor:pointer;font:inherit;font-size:17px;line-height:1;display:grid;place-items:center;transition:.15s}
.hclose:hover{background:var(--accBg);color:var(--acc);border-color:var(--acc)}
.hbody{padding:20px 22px 26px;overflow-y:auto;max-height:calc(86vh - 74px);font-size:15px;color:var(--ink2)}
.hbody>p{margin:0 0 16px}
.hbody b{color:var(--ink);font-weight:650}
.lead{margin:0 0 18px;font-size:15.5px;color:var(--ink2)}
/* 쉬운 설명. 사람이 읽는 본문이라 카드 안에서 제일 크게 둔다. */
.easy{margin-top:18px;border-top:1px solid var(--line);padding-top:4px}
.easy p{margin:0 0 14px;font-size:15px;line-height:1.72;color:var(--ink2)}
.easy strong{color:var(--ink);font-weight:660}
.easy h4{font-size:12px;font-weight:700;letter-spacing:.1em;color:var(--dim);
  text-transform:none;margin:20px 0 9px}
.easy ol{margin:2px 0 18px;padding:0;list-style:none;counter-reset:e;
  display:flex;flex-direction:column;gap:12px}
.easy ol>li{counter-increment:e;display:grid;grid-template-columns:24px minmax(0,1fr);gap:11px;
  align-items:start;font-size:15px;line-height:1.7;color:var(--ink2)}
.easy ol>li::before{content:counter(e);display:grid;place-items:center;width:24px;height:24px;
  border-radius:8px;background:var(--accBg);color:var(--acc);font-size:12px;font-weight:700;margin-top:2px}
.easy ol>li>p{margin:0}
.easy ul{margin:0 0 14px;padding-left:19px;font-size:15px;color:var(--ink2)}
.easy li{margin-bottom:6px}
.easy code{font-size:13px}
.hsec{border-top:1px solid var(--line)}
.hsec>summary{display:flex;align-items:center;gap:8px;cursor:pointer;list-style:none;
  padding:14px 2px;font-size:15.5px;font-weight:660;color:var(--ink)}
.hsec>summary::-webkit-details-marker{display:none}
.hsec>summary:hover{color:var(--acc)}
.hsec>summary .caret{margin-left:auto;color:var(--dim)}
.hsec[open]>summary .caret{transform:rotate(180deg)}
.hsec .in{padding:0 2px 18px}
.hsec p{margin:0 0 11px;font-size:14.5px}
.hsec p:last-child{margin-bottom:0}
.hsec ul{margin:0 0 11px;padding-left:19px;font-size:14.5px}
.hsec li{margin-bottom:6px}
.chip.quote{display:block;width:100%;text-align:left;margin:0 0 12px;padding:13px 16px;border-radius:12px;font-size:15px}
.hsec td:first-child{white-space:nowrap;font-weight:700;color:var(--ink);font-size:12.5px}

/* 스크롤하며 하나씩 올라오게. 스크립트가 안 돌면 숨기지 않는다(.js 가 안 붙는다). */
.js .rev{opacity:0;transform:translateY(16px)}
.js .rev.in{opacity:1;transform:none;transition:opacity .55s var(--ease),transform .55s var(--ease)}
@media (prefers-reduced-motion:reduce){.js .rev{opacity:1;transform:none}}
/* 푸터는 wellnessbox.kr 과 같은 형태로 맞췄다. 밝기 모드와 무관하게 늘 짙은 남색이다. */
footer.site{margin-top:72px;position:relative;overflow:hidden;font-size:14px;color:#cbd5e1;
  border-top:1px solid rgba(30,41,59,.8);
  background:radial-gradient(circle at top left,rgba(56,189,248,.06),transparent 24%),
             linear-gradient(180deg,#101728 0%,#0b1220 100%)}
footer.site::before{content:"";position:absolute;left:0;right:0;top:0;height:1px;
  background:linear-gradient(90deg,transparent,rgba(125,211,252,.3),transparent)}
.fwrap{max-width:760px;margin:0 auto;padding:40px 20px 44px}
.ftop{display:grid;gap:32px;grid-template-columns:minmax(0,1fr) auto;align-items:start}
@media(max-width:560px){.ftop{grid-template-columns:1fr;gap:28px}}
.brand{display:inline-flex;align-items:center;gap:12px;text-decoration:none}
.mark{width:44px;height:44px;flex:none;border-radius:16px;display:grid;place-items:center;color:${SKY};
  background:rgba(255,255,255,.04);box-shadow:inset 0 0 0 1px rgba(255,255,255,.07)}
.mark svg{width:26px;height:auto;display:block}
.bname{font-size:16px;font-weight:600;color:#fff}
.flinks{display:flex;flex-wrap:wrap;gap:8px 20px;margin-top:20px}
.flinks a,.fcol a{color:#cbd5e1;text-decoration:none;transition:color .2s}
.flinks a:hover,.fcol a:hover,.brand:hover .bname{color:#fff}
/* 좁은 화면에서 날짜가 줄 가운데서 잘리지 않게 덩어리째 넘긴다. */
.copy{margin:24px 0 0;font-size:12px;color:#64748b;display:flex;flex-wrap:wrap;gap:2px 14px}
.copy>span{white-space:nowrap}
.fcol h3{margin:0;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.22em;color:#64748b}
.fcol ul{list-style:none;margin:12px 0 0;padding:0;display:flex;flex-direction:column;gap:10px}
.fcol a{display:inline-flex;align-items:center;gap:8px}
.dot{width:4px;height:4px;border-radius:50%;background:rgba(125,211,252,.55);flex:none}
.biz{margin-top:32px;border-top:1px solid rgba(255,255,255,.08);padding-top:24px}
.bizbox{border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.02);border-radius:22px;overflow:hidden}
.bizbox>summary{display:flex;align-items:center;justify-content:space-between;gap:12px;
  padding:16px 20px;cursor:pointer;list-style:none;font-size:16px;font-weight:600;color:#fff}
.bizbox>summary::-webkit-details-marker{display:none}
.pill{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-width:88px;
  border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.04);border-radius:99px;
  padding:6px 12px;font-size:14px;font-weight:500;color:#e2e8f0;transition:.3s}
.bizbox>summary:hover .pill{border-color:rgba(125,211,252,.3);background:rgba(125,211,252,.1);color:#fff}
.pill svg{width:15px;height:15px;transition:transform .3s}
.bizbox[open] .pill svg{transform:rotate(180deg)}
.bizgrid{margin:0;border-top:1px solid rgba(255,255,255,.08);padding:20px;
  display:grid;gap:16px 32px;grid-template-columns:repeat(2,minmax(0,1fr))}
@media(max-width:560px){.bizgrid{grid-template-columns:1fr}}
.bizgrid dt{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.18em;color:#64748b}
.bizgrid dd{margin:8px 0 0;font-size:14px;line-height:1.6;color:#e2e8f0}
.bizgrid .wide{grid-column:1/-1}
.toast{position:fixed;left:50%;bottom:26px;transform:translate(-50%,12px);z-index:120;
  display:flex;align-items:center;gap:9px;max-width:calc(100% - 32px);
  background:#0f172a;color:#f1f5f9;padding:12px 20px;border-radius:14px;
  font-size:14.5px;font-weight:600;line-height:1.4;
  box-shadow:0 18px 40px -16px rgba(15,23,42,.55);
  opacity:0;visibility:hidden;pointer-events:none;
  transition:opacity .18s var(--ease),transform .18s var(--ease),visibility .18s}
.toast.on{opacity:1;visibility:visible;transform:translate(-50%,0)}
.toast .tick{flex:none;display:grid;place-items:center;width:19px;height:19px;border-radius:50%;
  background:#34d399;color:#04231a;font-size:12px;font-weight:800}
.toast .tx{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style>
</head>
<body>
<div class="wrap">

<header class="top">
  <a class="hmark" href="https://wellnessbox.kr" aria-label="웰니스박스">${logoSvg("")}</a>
  <h1>웰니스박스<br>에이전트 기반 업무 자동화</h1>
  <p class="lede">반복하는 회사 일을 <strong>매뉴얼 한 장</strong>씩 적어 뒀습니다.</p>

  <div class="why rev">
    <ol>
      <li><span><b>매뉴얼을 구글 드라이브에 미리 깔아 뒀습니다.</b>
        절차, 회사 정보, 로그인 계정이 에이전트 폴더 하나에 들어 있습니다.</span></li>
      <li><span><b>Claude 나 Codex 새 세션에 한 줄만 말하면 끝까지 합니다.</b>
        <button class="chip say2" data-copy="G드라이브 에이전트 폴더 참고해서 ○○ 업무 해줘">G드라이브 에이전트 폴더 참고해서 ○○ 업무 해줘</button></span></li>
      <li><span><b>원리는 CUA, 컴퓨터를 직접 조작하는 것입니다.</b>
        명령어(L1)부터 컴퓨터 전체 제어(L4)까지 써서, 계정으로 하는 일도 사람 손을 안 거칩니다.</span></li>
      <li><span><b>쓸수록 매뉴얼이 두꺼워집니다.</b>
        업무를 하다 막혔다 뚫으면 그 대목을 매뉴얼에 적고 끝냅니다. 다음에는 같은 데서 안 헤맵니다.</span></li>
    </ol>
    <button class="helpbtn" id="helpopen" type="button">
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
        <circle cx="10" cy="10" r="7.4"/><path d="M8 7.7a2 2 0 1 1 2.6 1.9c-.5.2-.7.6-.7 1.1v.5"/><path d="M10 14.1h.01"/>
      </svg>사용법 자세히 보기</button>
  </div>
</header>

<section>
  <h2 class="rev">등록된 업무</h2>
  <div class="cards" id="list">
${cards || '<p class="what">아직 없습니다.</p>'}
  </div>

  <div class="boxwrap rev" id="boxwrap">
    <button class="boxhead" id="boxhead" type="button" aria-expanded="false">
      <span class="bicon"><svg viewBox="0 0 20 20" stroke-linecap="round" stroke-linejoin="round">
        <path d="M2.8 6.4h14.4v9.3a1.3 1.3 0 0 1-1.3 1.3H4.1a1.3 1.3 0 0 1-1.3-1.3z"/>
        <path d="M2.2 3.4h15.6v3H2.2z"/><path d="M8.2 9.9h3.6"/></svg></span>
      <span><b>치워둔 업무</b> <span class="bsub" id="boxn">비어 있음</span></span>
      <span class="caret"></span>
    </button>
    <div class="boxed" id="boxed"></div>
  </div>
</section>

</div>

<footer class="site">
  <div class="fwrap">
    <div class="ftop rev">
      <div>
        <a class="brand" href="https://wellnessbox.kr">
          <span class="mark">${logoSvg("")}</span>
          <span class="bname">웰니스박스</span>
        </a>
        <div class="flinks">
          <a href="https://wellnessbox.kr/about/terms">이용약관</a>
          <a href="https://wellnessbox.kr/about/privacy">개인정보처리방침</a>
          <a href="https://wellnessbox.kr/about/contact">문의하기</a>
        </div>
        <p class="copy"><span>© <span id="year">${new Date().getFullYear()}</span> 웰니스박스. All rights reserved.</span>${
          commit ? '<span class="upd">마지막 갱신 ' + esc(commit) + "</span>" : ""
        }</p>
      </div>

      <div class="fcol">
        <h3>Links</h3>
        <ul>
          <li><a href="https://wellnessbox.kr"><span class="dot"></span><span>웰니스박스</span></a></li>
          <li><a href="${REPO}"><span class="dot"></span><span>저장소</span></a></li>
        </ul>
      </div>
    </div>

    <section class="biz rev">
      <details class="bizbox">
        <summary>사업자 정보
          <span class="pill"><span class="pilltx">열기</span>
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7"
              stroke-linecap="round" stroke-linejoin="round"><path d="M5 7.5 10 12.5 15 7.5"/></svg>
          </span>
        </summary>
        <dl class="bizgrid">
${BIZ.map(
  ([k, v]) =>
    '          <div' + (v.length > 30 ? ' class="wide"' : "") + "><dt>" + esc(k) + "</dt><dd>" + esc(v) + "</dd></div>"
).join("\n")}
        </dl>
      </details>
    </section>
  </div>
</footer>

<dialog class="help" id="help">
  <div class="hhead">
    <h2>이 시스템 쓰는 법</h2>
    <button class="hclose" type="button" aria-label="닫기">&times;</button>
  </div>
  <div class="hbody">
    <p>반복하는 회사 일의 <b>절차서를 구글 드라이브에 미리 깔아 뒀습니다.</b>
    Claude 나 Codex 새 세션에 <b>"G드라이브 에이전트 폴더 보고 ○○ 해줘"</b> 라고 하면,
    그 폴더에서 해당 매뉴얼을 찾아 읽고 끝까지 처리합니다.
    화면을 직접 조작하기 때문에(CUA) 계정으로 하는 일까지 됩니다.</p>

    <details class="hsec" open>
      <summary>시키는 법 <span class="caret"></span></summary>
      <div class="in">
        <p>형식은 하나뿐입니다. <b>업무 이름</b>만 갈아 끼우면 됩니다.</p>
        <button class="chip quote" data-copy="G드라이브 에이전트 폴더 참고해서 ○○ 업무 해줘">G드라이브 에이전트 폴더 참고해서 ○○ 업무 해줘</button>
        <p>업무 카드를 펼치면 그 업무 이름을 넣어 만든 문장이 나옵니다.
        눌러서 복사한 뒤 Claude 나 Codex 새 세션에 그대로 붙여넣으면 됩니다.</p>
        <p>줄여서 "캡션 써줘" 처럼 말해도 알아듣습니다. 매뉴얼마다 줄임말을 적어 뒀습니다.
        다만 <b>처음 켠 컴퓨터에서는 위 형식을 그대로 쓰세요.</b> 그래야 에이전트가
        드라이브에서 매뉴얼을 먼저 찾습니다.</p>
      </div>
    </details>

    <details class="hsec">
      <summary>왜 배경 설명이 필요 없나 <span class="caret"></span></summary>
      <div class="in">
        <p>구글 드라이브 <b>내 드라이브 → 에이전트</b> 폴더 하나에 다 들어 있습니다.</p>
        <ul>
          <li><b>매뉴얼</b>: 업무마다 절차, 산출물, 앞서 겪은 함정, 물어보지 않고 진행할 것</li>
          <li><b>회사 정보</b>: 사업자 정보, 서류 위치, 노션, 코드 폴더와 배포 주소</li>
          <li><b>계정</b>: 로그인이 필요한 40여 개 서비스의 아이디와 비밀번호</li>
        </ul>
        <p>에이전트는 뿌리 파일 하나를 열고 표에서 갈래를 골라 들어갑니다.
        전부 읽지 않고 두세 번 만에 필요한 데에 닿습니다.</p>
      </div>
    </details>

    <details class="hsec">
      <summary>어디까지 직접 하나 (L1에서 L4까지) <span class="caret"></span></summary>
      <div class="in">
        <p>일마다 어디까지 만져야 하는지가 다릅니다. 매뉴얼에 그 층을 적어 두면 에이전트가 맞는 도구를 골라 씁니다.
        위층이 되면 위층으로 하고, 막히면 아래로 내려갑니다.</p>
        <div class="tw"><table><thead><tr><th>층</th><th>무엇으로</th><th>예</th></tr></thead><tbody>
          <tr><td>L1</td><td>명령어와 스크립트</td><td>파일 찾기, 영상 자르기, 데이터 만들기</td></tr>
          <tr><td>L2</td><td>인앱 브라우저</td><td>로그인 없이 열리는 웹 화면 읽기</td></tr>
          <tr><td>L3</td><td>이미 로그인된 크롬</td><td>인스타, 유튜브, 인포크처럼 계정이 있어야 하는 일</td></tr>
          <tr><td>L4</td><td>컴퓨터 전체 제어</td><td>브라우저 밖 프로그램. 카톡, 한글, 프리미어</td></tr>
        </tbody></table></div>
        <p>L3 과 L4 를 열어 뒀습니다. 그래서 유튜브에 올리고, 인스타에 게시하고,
        관리자 페이지를 고치고, 카톡을 읽는 것까지 <b>사람 손을 안 거치고 끝납니다.</b></p>
      </div>
    </details>

    <details class="hsec">
      <summary>Claude 와 Codex 를 나누는 기준 <span class="caret"></span></summary>
      <div class="in">
        <p><b>Claude</b> 는 10분 안에 끝나는 일을 맡습니다. 판단이 섞이거나 사람이 옆에서 보는 작업입니다.</p>
        <p><b>Codex</b> 는 길게 도는 일을 맡습니다. 수백 건 수집, 대량 분류, 며칠 도는 조사 루프입니다.</p>
        <p>업무 카드에 어느 쪽이 맡는지 적혀 있습니다. 굳이 지정하지 않아도 되고,
        둘이 같은 매뉴얼을 읽기 때문에 결과는 같습니다.</p>
      </div>
    </details>

    <details class="hsec">
      <summary>물어보지 않고 진행합니다 <span class="caret"></span></summary>
      <div class="in">
        <p>폰으로 시켜 놓고 자리를 비우는 경우가 많아, 중간에 묻지 않게 해 뒀습니다.
        값이 애매하면 정하고, 자료가 모자라면 있는 것으로 하고, 대상이 여럿이면 전부 합니다.
        정한 것과 모자랐던 것은 끝에 한 번 보고합니다.</p>
        <p>멈추고 여쭙는 건 넷뿐입니다.</p>
        <ul>
          <li>남에게 가는 메시지 (나와의 채팅은 그냥 보냅니다)</li>
          <li>시키지 않은 곳에 게시하기</li>
          <li><b>매뉴얼에 없는 지출</b></li>
          <li>되살릴 수 없는 삭제</li>
        </ul>
        <p><b>매뉴얼에 값이 적힌 지출은 업무를 시키신 것으로 승인된 것으로 봅니다.</b>
        "쇼츠 돌려줘" 안에 조회수 주문 200원이 들어 있으면 그것까지가 시키신 일입니다.
        금액과 수량, 대상을 화면에 숫자로 적고 그대로 진행합니다. 답을 기다리느라 멈추지 않습니다.</p>
        <p>다만 이 셋 중 하나라도 어긋나면 그때는 멈추고 여쭙습니다.
        금액이 매뉴얼에 적힌 것과 다를 때, 잔액이 모자라 충전이 필요할 때,
        대상이 이번 업무에서 만든 것이 아닐 때입니다.</p>
        <p><b>로그인 창이 떠도 멈추지 않습니다.</b> 이미 로그인된 크롬으로 열고,
        "구글로 로그인" 버튼을 누르고, 아이디 칸을 눌러 크롬에 저장된 계정을 고릅니다.
        비밀번호를 손으로 쳐 넣는 것만 하지 않습니다. 그 셋으로도 안 되는 서비스는
        한 번만 직접 로그인해 두시면 그 뒤로는 계속 됩니다.</p>
      </div>
    </details>

    <details class="hsec">
      <summary>업무 늘리기 <span class="caret"></span></summary>
      <div class="in">
        <p>새 일은 그냥 시켜 보면 됩니다. 끝나고 이렇게 말하면 이 목록에 카드가 하나 늘어납니다.</p>
        <button class="chip quote" data-copy="방금 한 거 업무로 등록해줘">방금 한 거 업무로 등록해줘</button>
        <p>하다가 막혔던 지점까지 매뉴얼에 적히기 때문에, 다음부터는 같은 데서 안 헤맵니다.
        새 컴퓨터에서 쓰려면 드라이브 에이전트 폴더의 <code>설치.mjs</code> 를 한 번 실행하면 됩니다.</p>
      </div>
    </details>

    <details class="hsec">
      <summary>이 목록 손보기 <span class="caret"></span></summary>
      <div class="in">
        <p>업무 이름을 누르면 그 업무 설명이 열립니다. 언제 쓰는지, 뭐라고 말하면 되는지,
        말하고 나면 무슨 일이 벌어지는지가 순서대로 적혀 있습니다.</p>
        <p>왼쪽 점 여섯 개짜리 손잡이를 <b>끌면 순서가 바뀝니다.</b> 손가락으로도 됩니다.</p>
        <p>자주 안 쓰는 업무는 아래 <b>치워둔 업무</b> 칸으로 끌어다 놓으면 목록에서 빠집니다.
        도로 쓰려면 거기서 위 목록으로 끌어 올리면 됩니다.</p>
        <p>바꾼 순서와 치워둔 목록은 이 브라우저에만 저장합니다. 다른 컴퓨터에는 따라가지 않습니다.</p>
      </div>
    </details>
  </div>
</dialog>

<div class="toast" id="toast"><span class="tick">&#10003;</span><span class="tx">복사했습니다</span></div>
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
  // 글자를 바꾸지 않는다. 바꾸면 칩 폭이 변해서 옆 글이 밀린다.
  b.classList.add('copied');
  var t = document.getElementById('toast');
  t.querySelector('.tx').textContent = '복사했습니다  ' + text;
  t.classList.add('on');
  clearTimeout(window.__toastT);
  window.__toastT = setTimeout(function () { t.classList.remove('on'); }, 1800);
  setTimeout(function () { b.classList.remove('copied'); }, 1200);
});

// 저작권 연도는 서울 기준으로 맞춘다. 굽는 시점 값이 박혀 있어도 열 때 다시 쓴다.
try {
  document.getElementById('year').textContent =
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric' }).format(new Date());
} catch (e) {}

var biz = document.querySelector('.bizbox');
if (biz) biz.addEventListener('toggle', function () {
  biz.querySelector('.pilltx').textContent = biz.open ? '접기' : '열기';
});

// ── 사용법 모달 ────────────────────────────────────────────────
document.addEventListener('click', function (e) {
  if (e.target.closest('#helpopen')) {
    var d = document.getElementById('help');
    if (!d.open) d.showModal();
    return;
  }
  if (e.target.closest('.hclose')) { e.target.closest('dialog').close(); return; }
  // 바깥(백드롭)을 누르면 닫는다. dialog 자체가 클릭 대상이면 바깥이다.
  if (e.target.tagName === 'DIALOG') e.target.close();
});

// ── 목록 손보기. 순서와 치워둔 것을 이 브라우저에 기억한다 ──────
var LIST = document.getElementById('list');
var BOX = document.getElementById('boxed');
var WRAP = document.getElementById('boxwrap');
var HEAD = document.getElementById('boxhead');
var KEY = 'wnbx.list.v1';

function count() {
  var n = BOX.children.length;
  document.getElementById('boxn').textContent = n ? n + '개' : '비어 있음';
}
function openBox(on) {
  WRAP.classList.toggle('on', on);
  HEAD.setAttribute('aria-expanded', on ? 'true' : 'false');
}
HEAD.addEventListener('click', function () { openBox(!WRAP.classList.contains('on')); });

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify({
      order: [].map.call(LIST.children, function (c) { return c.dataset.id; }),
      boxed: [].map.call(BOX.children, function (c) { return c.dataset.id; })
    }));
  } catch (e) {}
  count();
}
(function restore() {
  var s;
  try { s = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { s = {}; }
  var all = {};
  [].forEach.call(document.querySelectorAll('.card'), function (c) { all[c.dataset.id] = c; });
  (s.order || []).forEach(function (id) { if (all[id]) LIST.appendChild(all[id]); });
  (s.boxed || []).forEach(function (id) { if (all[id]) BOX.appendChild(all[id]); });
  if (BOX.children.length) openBox(true);
  count();
})();

// 끌어서 옮기기.
// 잡은 카드는 position:fixed 로 손끝을 따라다니고, 원래 자리에는 같은 높이의 빈 자리를 둔다.
// 그래야 무엇을 잡고 있는지 눈에 보인다. HTML5 드래그는 손가락에서 안 먹어 포인터 이벤트로 짰다.
var drag = null, suppress = false;

function place(x, y) {
  var el = document.elementFromPoint(x, y);
  if (!el) return;
  var over = el.closest('.card');
  if (over && over !== drag.card && over !== drag.ghost &&
      (over.parentElement === LIST || over.parentElement === BOX)) {
    var r = over.getBoundingClientRect();
    over.parentElement.insertBefore(drag.ghost, y > r.top + r.height / 2 ? over.nextSibling : over);
    return;
  }
  var zone = el.closest('#list, #boxed');
  if (zone && zone !== drag.ghost.parentElement) zone.appendChild(drag.ghost);
}

document.addEventListener('pointerdown', function (e) {
  var g = e.target.closest('.grip');
  if (!g || e.button) return;
  var card = g.closest('.card');
  var r = card.getBoundingClientRect();
  drag = { card: card, grip: g, moved: false, sx: e.clientX, sy: e.clientY,
           dx: e.clientX - r.left, dy: e.clientY - r.top, w: r.width, h: r.height };
  g.setPointerCapture(e.pointerId);
  e.preventDefault();
});

// 보관함이 화면 밖에 있으면 거기까지 끌고 갈 수가 없다. 위아래 끝에 닿으면 화면을 따라 굴린다.
var edgeTimer = null, edgeY = 0;
function edgeScroll() {
  var h = window.innerHeight, band = 110, v = 0;
  if (edgeY < band) v = -Math.ceil((band - edgeY) / 6);
  else if (edgeY > h - band) v = Math.ceil((edgeY - (h - band)) / 6);
  if (v) { window.scrollBy(0, v); if (drag) place(window.__dx, edgeY); }
  edgeTimer = drag ? requestAnimationFrame(edgeScroll) : null;
}

document.addEventListener('pointermove', function (e) {
  if (!drag) return;
  window.__dx = e.clientX; edgeY = e.clientY;
  if (!edgeTimer) edgeTimer = requestAnimationFrame(edgeScroll);
  if (!drag.moved) {
    if (Math.abs(e.clientY - drag.sy) < 5 && Math.abs(e.clientX - drag.sx) < 5) return;
    drag.moved = true;
    drag.card.open = false;             // 펼쳐진 채로 끌면 화면을 다 덮는다
    var rr = drag.card.getBoundingClientRect();
    drag.h = rr.height; drag.dy = Math.min(drag.dy, rr.height - 8);
    drag.ghost = document.createElement('div');
    drag.ghost.className = 'ghost';
    drag.ghost.style.height = drag.h + 'px';
    drag.card.parentElement.insertBefore(drag.ghost, drag.card);
    drag.card.style.width = drag.w + 'px';
    drag.card.style.height = drag.h + 'px';
    drag.card.classList.add('dragging');
    document.body.classList.add('dnd');
    openBox(true);                      // 치우는 칸이 열려 있어야 거기로 끌 수 있다
  }
  drag.card.style.left = (e.clientX - drag.dx) + 'px';
  drag.card.style.top = (e.clientY - drag.dy) + 'px';
  place(e.clientX, e.clientY);
});

function endDrag() {
  if (!drag) return;
  if (edgeTimer) { cancelAnimationFrame(edgeTimer); edgeTimer = null; }
  var moved = drag.moved;
  if (moved) {
    drag.ghost.parentElement.insertBefore(drag.card, drag.ghost);
    drag.ghost.remove();
    drag.card.classList.remove('dragging');
    drag.card.style.cssText = '';
    document.body.classList.remove('dnd');
    if (!BOX.children.length) openBox(false);
    save();
    suppress = true;
    setTimeout(function () { suppress = false; }, 0);
  }
  drag = null;
}
document.addEventListener('pointerup', endDrag);
document.addEventListener('pointercancel', endDrag);

// 손잡이를 그냥 눌렀거나, 끌고 난 직후의 클릭이 설명 모달을 열지 않게 한다.
document.addEventListener('click', function (e) {
  if (e.target.closest('.grip') || suppress) { e.preventDefault(); e.stopPropagation(); }
}, true);

// ── 스크롤하면 하나씩 올라오게 ─────────────────────────────────
var rev = document.querySelectorAll('.rev');
if (window.IntersectionObserver) {
  var io = new IntersectionObserver(function (rows) {
    rows.forEach(function (row) {
      if (!row.isIntersecting) return;
      row.target.classList.add('in');
      io.unobserve(row.target);
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: .06 });
  [].forEach.call(rev, function (el, i) {
    el.style.transitionDelay = Math.min(i, 6) * 55 + 'ms';
    io.observe(el);
  });
} else {
  [].forEach.call(rev, function (el) { el.classList.add('in'); });
}
</script>
</body>
</html>
`;

fs.mkdirSync(DIST, { recursive: true });
fs.writeFileSync(path.join(DIST, "index.html"), html, "utf8");
console.log(
  "구웠다: " + path.join(DIST, "index.html") + "  (" + (html.length / 1024).toFixed(0) + "KB, 업무 " + M.length + "개)"
);
