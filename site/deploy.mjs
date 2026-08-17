#!/usr/bin/env node
// 사이트를 굽고 올린 뒤 hjo.vercel.app 을 그 배포로 돌린다.
//   node site/deploy.mjs
//
// 별칭을 매번 다시 거는 이유: vercel 이 배포마다 새 주소를 주고,
// 프로젝트 자동 별칭(ops-ten-bice)은 이름을 바꾸기 전에 붙어서 그대로 남았다.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "hjo.vercel.app";

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", ...opts });

// Windows 에서 npx 는 .cmd 라 shell 없이는 못 부른다.
const npx = (args, opts = {}) =>
  execFileSync("npx " + args.join(" "), { cwd: ROOT, encoding: "utf8", shell: true, ...opts });

run(process.execPath, [path.join(ROOT, "site", "build.mjs")], { stdio: "inherit" });

const out = npx(["vercel", "deploy", "site/dist", "--prod", "--yes"], {
  stdio: ["ignore", "pipe", "pipe"],
});
const url = (out.match(/https:\/\/hjo-[a-z0-9]+-[a-z0-9-]+\.vercel\.app/) || [])[0];
if (!url) {
  console.error("배포 주소를 못 찾았다. 출력을 확인해라:\n" + out.slice(-800));
  process.exit(1);
}
console.log("올렸다: " + url);

npx(["vercel", "alias", "set", url, SITE], { stdio: "inherit" });
console.log("\nhttps://" + SITE);
