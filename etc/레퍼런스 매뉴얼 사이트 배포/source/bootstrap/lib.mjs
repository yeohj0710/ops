// 백업.mjs 와 설치.mjs 가 같이 쓰는 것들.
// 드라이브 폴더에서 저장소 없이 단독으로 돌아야 하므로 의존성을 두지 않는다.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const HOME = os.homedir();

// 자격증명이 실수로 딸려 가는 걸 막는다. 이름만 봐도 걸러지는 것들.
const NEVER = [
  /(^|[\\/])auth\.json$/i,
  /(^|[\\/])\.env(\..*)?$/i,
  /(^|[\\/])credentials?\.json$/i,
  /(^|[\\/])(id_rsa|id_ed25519)$/i,
  /\.(pem|key|p12|pfx)$/i,
  /(^|[\\/])node_modules([\\/]|$)/,
  /(^|[\\/])\.git([\\/]|$)/,
];
export const blocked = (p) => NEVER.some((re) => re.test(p));

export function readManifest(dir) {
  const p = path.join(dir, "manifest.json");
  if (!fs.existsSync(p)) throw new Error("manifest.json 이 없다: " + p);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// 프로젝트 폴더를 찾는다. 없으면 만들 자리를 정해 준다.
export function findDevRoot(argDev) {
  if (argDev) return argDev.replace(/\\/g, "/");
  for (const c of ["C:/dev", path.join(HOME, "dev")]) {
    if (fs.existsSync(c)) return c.replace(/\\/g, "/");
  }
  return "C:/dev";
}

export function resolveTarget(item, devRoot) {
  const base = item.base === "dev" ? devRoot : HOME;
  return path.join(base, item.path);
}

// 폴더를 통째로 복사하되 금지 목록은 건너뛴다. 옮긴 파일 수를 센다.
export function copyTree(from, to) {
  let n = 0;
  if (!fs.existsSync(from)) return 0;
  const stat = fs.statSync(from);
  if (stat.isFile()) {
    if (blocked(from)) return 0;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    return 1;
  }
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name);
    if (blocked(src)) continue;
    n += copyTree(src, path.join(to, e.name));
  }
  return n;
}

// fs.rmSync({recursive:true}) 은 한글 경로에서 프로세스를 통째로 죽인다.
// stderr 도 안 남기고 exit 127 로 끝나며 폴더는 그대로 살아 있다.
// '내 드라이브', '에이전트' 가 경로에 있으니 여기서는 절대 쓰지 않는다.
export function removeTree(p) {
  if (!fs.existsSync(p)) return;
  let st;
  try {
    st = fs.lstatSync(p);
  } catch {
    return;
  }
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(p)) removeTree(path.join(p, e));
    try {
      fs.rmdirSync(p);
    } catch {}
  } else {
    try {
      fs.unlinkSync(p);
    } catch {}
  }
}

export function stamp() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, "0");
  return `${String(d.getFullYear()).slice(2)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(
    d.getHours()
  )}${p(d.getMinutes())}`;
}

export function arg(name, def = null) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : def;
}
export const hasFlag = (name) => process.argv.includes("--" + name);
