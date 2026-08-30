#!/usr/bin/env node
// 인스타 업로더에 mp4 를 넘길 로컬 서버를 띄운다. P6 에서 쓴다.
//
//   node insta-file-server.mjs "<준비 폴더 또는 mp4 경로>"
//   node insta-file-server.mjs "<...>" --port 8791
//
// 왜 이게 있나. 크롬 익스텐션의 file_upload 는 드라이브 경로도 스크래치패드도 거부한다.
// 되는 길은 하나뿐이다. 로컬 서버에서 페이지로 File 을 postMessage 로 넘긴다.
// 매 세션 이 서버를 손으로 짓느라 시간을 썼다. 여기 박아 둔다.
//
// 서버가 뜨면 인스타 탭에서 이렇게 이어 간다.
//
//   1) 인스타 탭에 message 리스너를 먼저 심는다
//   2) 임시 <a> 를 만들어 sender.html 을 연다. target="_blank" 에 rel="opener" 를 같이 준다
//      (rel 을 빼면 크롬이 noopener 를 걸어 window.opener 가 null 이 되고 File 이 못 건너온다)
//   3) 받은 File 을 DataTransfer 에 담아 input[type=file].files 에 넣고 change 를 쏜다
//   4) 끝나면 sender 탭을 닫고 Ctrl+C 로 이 서버를 내린다
//
// 팝업에서 게시하는 경우에는 sender 가 팝업의 opener 를 봐야 하므로
// 팝업 안에서 위 2번을 한다. 자세한 건 MANUAL.md 의 P6.

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
  console.log('사용법: node insta-file-server.mjs "<준비 폴더 또는 mp4 경로>" [--port 8791]');
  process.exit(2);
}

let mp4 = target;
if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
  const found = fs.readdirSync(target).filter((f) => f.toLowerCase().endsWith(".mp4"));
  if (found.length !== 1) {
    console.log(`폴더에 mp4 가 ${found.length} 개다. 파일을 직접 지정해라.`);
    found.forEach((f) => console.log(`  ${path.join(target, f)}`));
    process.exit(2);
  }
  mp4 = path.join(target, found[0]);
}
if (!fs.existsSync(mp4)) {
  console.log(`파일이 없다: ${mp4}`);
  process.exit(2);
}

const bytes = fs.statSync(mp4).size;
const NAME = "reel.mp4";
const ORIGIN = "https://www.instagram.com";

// sender 는 제 출처에서 mp4 를 받아 File 을 만들고 opener 로 넘긴다.
// 인스타 페이지가 직접 127.0.0.1 을 fetch 하는 길은 CSP 로 막혀 있어서 이 우회가 필요하다.
const SENDER = `<!doctype html><meta charset="utf-8"><title>sender</title>
<body style="font:16px system-ui;padding:24px">
<p id="s">파일을 읽는 중...</p>
<script>
const say = (t) => { document.getElementById('s').textContent = t; };
(async () => {
  try {
    const buf = await (await fetch('/${NAME}')).arrayBuffer();
    const file = new File([buf], ${JSON.stringify(path.basename(mp4))}, { type: 'video/mp4' });
    if (!window.opener) { say('opener 가 없다. 링크에 rel="opener" 를 줬는지 봐라.'); return; }
    window.opener.postMessage({ __reel: true, file }, ${JSON.stringify(ORIGIN)});
    say('보냈다 (' + buf.byteLength + ' bytes). 이 탭은 닫아도 된다.');
  } catch (e) { say('실패: ' + e.message); }
})();
</script>`;

const server = http.createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];
  if (url === `/${NAME}`) {
    res.writeHead(200, {
      "content-type": "video/mp4",
      "content-length": String(bytes),
      "access-control-allow-origin": "*",
    });
    fs.createReadStream(mp4).pipe(res);
    return;
  }
  if (url === "/sender.html" || url === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(SENDER);
    return;
  }
  res.writeHead(404).end("no");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("인스타 업로드용 로컬 서버가 떴다.");
  console.log(`  영상      ${mp4}`);
  console.log(`  크기      ${bytes.toLocaleString()} bytes`);
  console.log(`  sender    http://127.0.0.1:${PORT}/sender.html`);
  console.log(`  mp4       http://127.0.0.1:${PORT}/${NAME}`);
  console.log("");
  console.log("인스타 탭(또는 팝업)에 먼저 리스너를 심는다.");
  console.log("  window.__got = null;");
  console.log(`  addEventListener('message', e => { if (e.data && e.data.__reel) window.__got = e.data.file; });`);
  console.log("");
  console.log("그 다음 rel=\"opener\" 를 준 임시 <a> 를 만들어 진짜로 클릭한다.");
  console.log("끝나면 Ctrl+C 로 이 서버를 내린다.");
});
