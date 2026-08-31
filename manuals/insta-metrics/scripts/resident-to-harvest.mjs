#!/usr/bin/env node
/* harvest-resident.js 가 브라우저에서 뱉은 조각들을 harvest.json 모양으로 되돌린다.
 *
 *   node resident-to-harvest.mjs --handles <login-targets.json> \
 *     --dump <dump-0.json> --dump <dump-150.json> ... \
 *     --out <harvest-login.json>
 *
 * 왜 되돌려야 하나.
 * 브라우저가 돌려주는 행에는 계정 이름이 없다. 순번(`i`)만 있다.
 * 점이 든 핸들(wander.with.zoey)을 돌려주면 도구가 토큰으로 오인해 [BLOCKED] 로 지우기 때문이다.
 * 그래서 순번을 대상 목록에 맞춰 `u` 를 여기서 채운다.
 *
 * 나온 파일은 build-write-plan.mjs 에 그대로 넘긴다.
 * 로그아웃 런과 같이 넘기면(`--harvest a.json,b.json`) 뒤엣것이 앞을 덮는다.
 */

import fs from "node:fs";

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf("--" + n);
  return i > -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const flags = (n) =>
  argv.reduce((acc, v, i) => (v === "--" + n && argv[i + 1] ? [...acc, argv[i + 1]] : acc), []);

const handlesFile = flag("handles");
const dumps = flags("dump");
const out = flag("out");
if (!handlesFile || !dumps.length || !out) {
  console.error(
    "쓰는 법: node resident-to-harvest.mjs --handles <login-targets.json> --dump <조각.json> [--dump ...] --out <harvest-login.json>"
  );
  process.exit(2);
}

const hj = JSON.parse(fs.readFileSync(handlesFile, "utf8"));
const handles = (Array.isArray(hj) ? hj : hj.handles || []).map((h) =>
  String(h).trim().replace(/^@/, "")
);

const rows = [];
const seen = new Set();
for (const f of dumps) {
  const part = JSON.parse(fs.readFileSync(f, "utf8"));
  for (const r of Array.isArray(part) ? part : part.rows || []) {
    if (typeof r.i !== "number" || seen.has(r.i)) continue;
    const u = handles[r.i];
    if (!u) continue; // 순번이 목록 밖이면 버린다. 목록이 바뀐 것이다
    seen.add(r.i);
    rows.push({ ...r, u });
  }
}
rows.sort((a, b) => a.i - b.i);

const 상태 = {};
for (const r of rows) 상태[r.st || "?"] = (상태[r.st || "?"] || 0) + 1;

const state = {
  총: handles.length,
  받은행: rows.length,
  로그인런: true,
  halted: rows.some((r) => /^차단/.test(r.st || "")) ? "차단" : null,
  rows,
};
fs.writeFileSync(out, JSON.stringify(state, null, 1), "utf8");

console.log(
  JSON.stringify(
    {
      파일: out,
      대상: handles.length,
      받은행: rows.length,
      빠진행: handles.length - rows.length,
      상태: 상태,
      조회수있음: rows.filter((r) => typeof r.rm === "number").length,
      좋아요있음: rows.filter((r) => typeof r.lm === "number").length,
      연락처있음: rows.filter((r) => r.c && r.c.length).length,
      팔로워있음: rows.filter((r) => typeof r.f === "number").length,
    },
    null,
    1
  )
);
