#!/usr/bin/env node
// n8n 웹 로그인이 풀렸을 때 본편 회로를 명령줄로 돌린다 (L1, 260923).
//
//   node n8n-cli-execute.mjs <워크플로우ID>          예: mxrYb3maJS31gEYC (하루건강약사 본편)
//
// 왜 이게 있나. localhost:5678 이 로그인 화면으로 떨어졌고 크롬 어느 프로필에도 저장된 n8n 계정이 없었다.
// 비밀번호를 쳐 넣을 수는 없으니 서버는 그대로 두고, 같은 DB 를 쓰는 CLI 로 한 번 실행한다.
//
// 알아둘 것
// - start-n8n.ps1 과 같은 환경변수를 그대로 쓴다(파일 접근 허용 목록, ffmpeg, 렌더 폴더). 그래서 그 파일을 읽어
//   마지막 `n8n start` 줄만 `n8n execute --id=<ID>` 로 바꾼 임시 ps1 을 만든다.
// - 서버가 떠 있으면 태스크 브로커 포트 5679 가 겹친다. N8N_RUNNERS_BROKER_PORT 를 5691 로 돌린다.
// - 회로에 90초 대기(Wait BGM Retry 90s)가 있다. 65초 넘는 대기에 들어가면 CLI 는 "Execution was successful" 을
//   찍고 끝나지만 실제로는 DB 에 status=waiting 으로 저장된 것이다. 떠 있는 서버가 waitTill 에 이어서 돌린다.
//   끝났는지는 반드시 execution_entity 의 status 가 success/error 로 바뀐 것으로 본다. CLI 종료를 믿지 마라.
// - 서버가 안 떠 있으면 waiting 을 이어 줄 주체가 없다. 먼저 start-n8n.ps1 로 서버를 띄운다.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const id = process.argv[2];
if (!/^[A-Za-z0-9]+$/.test(id || "")) {
  console.error("사용법: node n8n-cli-execute.mjs <워크플로우ID>");
  process.exit(2);
}
const ROOT = "C:\\dev\\n8n-youtube-shorts-automation";
let s = fs.readFileSync(path.join(ROOT, "scripts", "start-n8n.ps1"), "utf8");
s = s.replace("$Root = Split-Path -Parent $PSScriptRoot", `$Root = "${ROOT}"`);
const start = '& "$Root\\node_modules\\.bin\\n8n.cmd" start';
if (!s.includes(start)) throw new Error("start-n8n.ps1 의 마지막 줄 모양이 바뀌었다. 이 스크립트를 고쳐라");
s = s.replace(start, `$env:N8N_RUNNERS_BROKER_PORT = "5691"\n& "$Root\\node_modules\\.bin\\n8n.cmd" execute --id=${id}`);
const tmp = path.join(os.tmpdir(), `n8n-exec-${id}.ps1`);
fs.writeFileSync(tmp, "\ufeff" + s, "utf8");
const log = path.join(os.tmpdir(), `n8n-exec-${id}.log`);
console.log(`실행: ${id}  로그: ${log}`);
const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", tmp], { encoding: "utf8", maxBuffer: 1 << 30 });
fs.writeFileSync(log, (r.stdout || "") + (r.stderr || ""), "utf8");
fs.unlinkSync(tmp);
const out = r.stdout || "";
const last = (out.match(/"lastNodeExecuted":\s*"([^"]+)"/g) || []).pop();
const waiting = /"status":\s*"waiting"/.test(out);
console.log(`CLI 종료 코드 ${r.status}. 마지막 노드 ${last || "?"}. ${waiting ? "DB 에 waiting 으로 남았다. 서버가 이어서 돌린다" : ""}`);
console.log("확정은 DB 로: select id,status,waitTill from execution_entity order by id desc limit 2");
