#!/usr/bin/env node
// 인스타 업로더에 파일을 넘길 로컬 서버를 띄운다. 릴스 한 편도, 카드뉴스 여러 장도 같은 길이다.
//
//   node insta-file-server.mjs "<폴더 또는 파일 경로>"
//   node insta-file-server.mjs "<...>" --port 8791
//
// 왜 이게 있나. 크롬 익스텐션의 file_upload 는 드라이브 경로도 스크래치패드도 거부한다.
// 되는 길은 하나뿐이다. 로컬 서버에서 페이지로 File 을 postMessage 로 넘긴다.
// 매 세션 이 서버를 손으로 짓느라 시간을 썼다. 여기 박아 둔다.
//
// 폴더를 주면 이렇게 고른다.
//   mp4 가 있으면 mp4 만 (릴스)
//   없으면 png 와 jpg 를 이름순으로 전부 (카드뉴스 캐러셀)
// 카드뉴스 폴더는 `01 ...png` 처럼 앞에 번호가 붙어 있어 이름순이 곧 장 순서다.
//
// 서버가 뜨면 인스타 탭에서 이렇게 이어 간다.
//
//   1) 인스타 탭에 message 리스너를 먼저 심는다
//      addEventListener('message', e => { if (e.data && e.data.__reel) window.__got = e.data.files; });
//   2) 임시 <a> 를 만들어 sender.html 을 연다. target="_blank" 에 rel="opener" 를 같이 준다
//      (rel 을 빼면 크롬이 noopener 를 걸어 window.opener 가 null 이 되고 File 이 못 건너온다)
//   3) 받은 File 들을 DataTransfer 에 담아 input[type=file].files 에 넣고 change 를 쏜다
//   4) 끝나면 sender 탭을 닫고 Ctrl+C 로 이 서버를 내린다
//
// 팝업에서 게시할 때는 팝업 컨텍스트의 생성자로 File 을 다시 만들어야 업로더가 받는다.
//   p.__files = arr.map(f => new p.File([bytes], f.name, {type: f.type}))
// 자세한 건 MANUAL.md 의 P6 과 cardnews-post 매뉴얼.

import fs from "node:fs";
import path from "node:path";
import http from "node:http";

const args = process.argv.slice(2);
const portIndex = args.indexOf("--port");
const PORT = portIndex >= 0 ? Number(args[portIndex + 1]) : 8791;
// portIndex 가 -1 일 때 portIndex + 1 은 0 이라, 그냥 빼면 첫 인자가 사라진다.
const portValueIndex = portIndex >= 0 ? portIndex + 1 : -1;
const target = args.filter((a, i) => !a.startsWith("--") && i !== portValueIndex)[0];

if (!target) {
  console.log('사용법: node insta-file-server.mjs "<폴더 또는 파일 경로>" [--port 8791]');
  process.exit(2);
}
if (!fs.existsSync(target)) {
  console.log(`경로가 없다: ${target}`);
  process.exit(2);
}

const MIME = { ".mp4": "video/mp4", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

let files = [];
if (fs.statSync(target).isDirectory()) {
  const all = fs.readdirSync(target).filter((f) => MIME[path.extname(f).toLowerCase()]);
  const mp4 = all.filter((f) => f.toLowerCase().endsWith(".mp4")).sort();
  const imgs = all.filter((f) => !f.toLowerCase().endsWith(".mp4")).sort();
  const chosen = mp4.length ? mp4 : imgs;
  if (!chosen.length) {
    console.log(`폴더에 올릴 파일이 없다: ${target}`);
    process.exit(2);
  }
  files = chosen.map((f) => path.join(target, f));
} else {
  files = [target];
}

if (files.length > 10) {
  console.log(`인스타 캐러셀은 10장이 상한인데 ${files.length}장이다. 폴더를 정리해라.`);
  process.exit(2);
}

const entries = files.map((p, i) => ({
  i,
  path: p,
  name: path.basename(p),
  type: MIME[path.extname(p).toLowerCase()],
  size: fs.statSync(p).size,
}));

const ORIGIN = "https://www.instagram.com";
const MANIFEST = entries.map((e) => ({ i: e.i, name: e.name, type: e.type, size: e.size }));

// sender 는 제 출처에서 파일을 받아 File 을 만들고 opener 로 넘긴다.
// 인스타 페이지가 직접 127.0.0.1 을 fetch 하는 길은 CSP 로 막혀 있어서 이 우회가 필요하다.
const SENDER = `<!doctype html><meta charset="utf-8"><title>sender</title>
<body style="font:16px system-ui;padding:24px">
<p id="s">파일을 읽는 중...</p>
<script>
const M = ${JSON.stringify(MANIFEST)};
const say = (t) => { document.getElementById('s').textContent = t; };
(async () => {
  try {
    const files = [];
    for (const m of M) {
      const buf = await (await fetch('/f/' + m.i)).arrayBuffer();
      files.push(new File([buf], m.name, { type: m.type }));
      say('읽는 중 ' + files.length + '/' + M.length);
    }
    if (!window.opener) { say('opener 가 없다. 링크에 rel="opener" 를 줬는지 봐라.'); return; }
    window.opener.postMessage({ __reel: true, files, file: files[0] }, ${JSON.stringify(ORIGIN)});
    say('보냈다 (' + files.length + '개). 이 탭은 닫아도 된다.');
  } catch (e) { say('실패: ' + e.message); }
})();
</script>`;

const server = http.createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];
  const m = url.match(/^\/f\/(\d+)$/);
  if (m) {
    const e = entries[Number(m[1])];
    if (!e) return void res.writeHead(404).end("no");
    res.writeHead(200, {
      "content-type": e.type,
      "content-length": String(e.size),
      "access-control-allow-origin": "*",
    });
    fs.createReadStream(e.path).pipe(res);
    return;
  }
  if (url === "/sender.html" || url === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(SENDER);
    return;
  }
  // 예전 릴스 절차가 부르던 주소를 그대로 살려 둔다
  if (url === "/reel.mp4" && entries[0]) {
    res.writeHead(200, { "content-type": entries[0].type, "content-length": String(entries[0].size) });
    fs.createReadStream(entries[0].path).pipe(res);
    return;
  }
  res.writeHead(404).end("no");
});

server.listen(PORT, "127.0.0.1", () => {
  const total = entries.reduce((a, e) => a + e.size, 0);
  console.log(`인스타 업로드용 로컬 서버가 떴다. ${entries.length}개`);
  entries.forEach((e) => console.log(`  [${e.i}] ${e.name}  ${e.size.toLocaleString()} bytes`));
  console.log(`  합계     ${total.toLocaleString()} bytes`);
  console.log(`  sender   http://127.0.0.1:${PORT}/sender.html`);
  console.log("");
  console.log("인스타 탭(또는 팝업)에 먼저 리스너를 심는다.");
  console.log("  window.__got = null;");
  console.log("  addEventListener('message', e => { if (e.data && e.data.__reel) window.__got = e.data.files; });");
  console.log("");
  console.log('그 다음 rel="opener" 를 준 임시 <a> 를 만들어 진짜로 클릭한다.');
  console.log("끝나면 Ctrl+C 로 이 서버를 내린다.");
});
