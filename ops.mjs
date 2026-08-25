#!/usr/bin/env node
// ops - 회사 업무 관제탑 CLI
// 의존성 없음. node ops.mjs <명령>
//
// 명령
//   next [--runner claude|codex]   다음 태스크를 뽑아 점유한다
//   add --manual <id> --title "…"  태스크를 큐에 넣는다
//   done <taskId> [--note "…"]     완료 검사를 돌리고 끝낸다
//   block <taskId> --note "…"      막혔다고 적고 큐로 돌려보낸다
//   new <id> --title "…"           새 매뉴얼 뼈대를 만든다
//   sync                           매뉴얼 목록으로 ops 스킬 설명줄을 다시 쓰고 양쪽 도구에 설치
//   manuals [검색어]               매뉴얼 목록
//   status                         큐, 진행, 완료 현황
//   doctor                         이 기계 설정 점검

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { callPhrase, readPreauth } from "./lib/call-phrase.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIR = {
  manuals: path.join(ROOT, "manuals"),
  queue: path.join(ROOT, "tasks", "queue"),
  doing: path.join(ROOT, "tasks", "doing"),
  done: path.join(ROOT, "tasks", "done"),
};

// ---------- 유틸 ----------

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const writeJson = (p, o) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(o, null, 2) + "\n", "utf8");
};
const ls = (d) =>
  fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith(".json")) : [];

// 로컬 시각 ISO (KST 등 기계 시간대 그대로)
function stamp(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const s = off >= 0 ? "+" : "-";
  const p = (n) => String(Math.abs(n)).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${s}${p(Math.trunc(off / 60))}:${p(off % 60)}`
  );
}
const yyyymm = (iso) => iso.slice(0, 7);

function machine() {
  const p = path.join(ROOT, "machine.json");
  if (!fs.existsSync(p)) {
    return { name: os.hostname().toLowerCase(), dev_root: "C:/dev", setup: false };
  }
  return { setup: true, ...readJson(p) };
}

function git(args, opts = {}) {
  try {
    return {
      ok: true,
      out: execFileSync("git", args, {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        ...opts,
      }).trim(),
    };
  } catch (e) {
    return { ok: false, out: ((e.stdout || "") + (e.stderr || "")).trim() };
  }
}

// fs.rmSync({recursive:true}) 은 한글 경로에서 stderr 없이 프로세스를 죽인다(exit 127).
// 드라이브 경로에 '내 드라이브', '에이전트' 가 들어가므로 절대 쓰지 않는다.
function removeTreeSafe(p) {
  if (!fs.existsSync(p)) return;
  let st;
  try {
    st = fs.lstatSync(p);
  } catch {
    return;
  }
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(p)) removeTreeSafe(path.join(p, e));
    try {
      fs.rmdirSync(p);
    } catch {}
  } else {
    try {
      fs.unlinkSync(p);
    } catch {}
  }
}

const isRepo = () => git(["rev-parse", "--git-dir"]).ok;
const hasRemote = () => isRepo() && git(["remote"]).out.length > 0;

// 커밋하고 올린다. 올리기 실패는 치명이 아니다(원격이 없거나 경쟁에서 밀린 경우).
function sync(message) {
  if (!isRepo()) return { pushed: false, reason: "저장소 아님" };
  git(["add", "-A"]);
  const staged = git(["diff", "--cached", "--quiet"]);
  if (staged.ok) return { pushed: false, reason: "바뀐 것 없음" };
  const c = git(["commit", "-m", message]);
  if (!c.ok) return { pushed: false, reason: "커밋 실패: " + c.out };
  if (!hasRemote()) return { pushed: false, reason: "원격 없음" };
  let p = git(["push"]);
  if (!p.ok) {
    const r = git(["pull", "--rebase"]);
    if (!r.ok) return { pushed: false, reason: "리베이스 충돌: " + r.out };
    p = git(["push"]);
  }
  return { pushed: p.ok, reason: p.ok ? "" : p.out };
}

function pullFirst() {
  if (!hasRemote()) return;
  git(["pull", "--rebase"]);
}

// 다른 컴에서 등록한 업무를 놓치지 않게 가끔 당겨온다.
// 매번 당기면 오프라인일 때 느려지므로 시간으로 끊는다.
function pullIfStale(hours = 6) {
  if (!hasRemote()) return;
  const mark = path.join(ROOT, ".git", "ops-last-pull");
  try {
    if (fs.existsSync(mark) && Date.now() - fs.statSync(mark).mtimeMs < hours * 3600e3) return;
  } catch {}
  git(["pull", "--rebase"]);
  try {
    fs.writeFileSync(mark, "");
  } catch {}
}

// ---------- 매뉴얼 ----------

function manualList() {
  if (!fs.existsSync(DIR.manuals)) return [];
  return fs
    .readdirSync(DIR.manuals, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const id = d.name;
      const file = path.join(DIR.manuals, id, "MANUAL.md");
      if (!fs.existsSync(file)) return null;
      const text = fs.readFileSync(file, "utf8");
      return {
        id,
        file,
        title: (text.match(/^#\s+(.+)$/m) || [, id])[1].trim(),
        trigger: (text.match(/^-\s*\*\*부르는 말\*\*:\s*(.+)$/m) || [, ""])[1].trim(),
        runner: (text.match(/^-\s*\*\*런너\*\*:\s*(.+)$/m) || [, "either"])[1].trim(),
        surfaces: (text.match(/^-\s*\*\*제어층\*\*:\s*(.+)$/m) || [, "L1"])[1].trim(),
        preauth: readPreauth(text),
        hidden: id.startsWith("_"),
      };
    })
    .filter(Boolean);
}

function cmdManuals(argv) {
  pullIfStale();
  const q = argv._[0];
  let list = manualList();
  if (q) {
    const needle = q.toLowerCase();
    list = list.filter((m) =>
      [m.id, m.title, m.trigger].join(" ").toLowerCase().includes(needle)
    );
  }
  const shown = list.filter((m) => !m.hidden || q);
  if (!shown.length) return console.log("맞는 매뉴얼이 없다. `node ops.mjs manuals` 로 전체를 본다.");
  console.log("매뉴얼 " + shown.length + "개\n");
  for (const m of shown) {
    console.log(`  ${m.id}`);
    console.log(`    ${m.title}`);
    if (m.trigger) console.log(`    부르는 말: ${m.trigger}`);
    // 짧은 호출만 주면 Codex 가 승인 게이트를 한 번 더 건다. lib/call-phrase.mjs 를 보라.
    if (!m.hidden) console.log(`    붙여넣을 말: ${callPhrase(m.title, m.preauth)}`);
    console.log(`    런너 ${m.runner}, 제어층 ${m.surfaces}`);
    console.log(`    ${m.file}`);
    console.log("");
  }
}

// ---------- 스킬 ----------
// 상시 컨텍스트에 남는 건 아래에서 만드는 설명 한 줄뿐이다. 본문은 스킬이 불릴 때만 로드된다.
// 그래서 등록된 업무가 늘어도 세션 비용은 한 줄씩만 는다.

const SKILL_TARGETS = [
  { tool: "claude", dir: path.join(os.homedir(), ".claude", "skills", "ops") },
  { tool: "codex", dir: path.join(os.homedir(), ".codex", "skills", "ops") },
];

// 능력 파일 목록. 파일 이름이 곧 능력 이름이다 (읽어라.md 는 색인이라 뺀다).
function abilityList() {
  const dir = path.join(ROOT, "abilities");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "읽어라.md")
    .map((f) => f.replace(/\.md$/, ""))
    .sort();
}

function skillDescription() {
  const list = manualList().filter((m) => !m.hidden);
  const MAX = 12;
  const shown = list.slice(0, MAX).map((m) => {
    const words = m.trigger
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 3)
      .join(", ");
    return words ? `${m.title}(${words})` : m.title;
  });
  const more = list.length > MAX ? ` 외 ${list.length - MAX}개` : "";
  const registered = shown.length ? `지금 등록된 업무는 이렇다. ${shown.join(" / ")}${more}.` : "아직 등록된 업무가 없다.";

  const abil = abilityList();
  const abilities = abil.length
    ? " 업무 이름이 없어도 쓰는 능력이 따로 있다. " +
      abil.join(", ") +
      '. "에이전트 폴더 참고해서 ○○ 해줘" 처럼 업무 이름 없이 시키거나, ' +
      "카톡 대화를 찾아보거나 노션, 드라이브, 시트, 메일, 인스타, 피그마를 만져야 하면 이 스킬로 능력 목록을 편다."
    : "";

  return (
    "회사 반복 업무를 매뉴얼대로 실행하거나 새 업무를 매뉴얼로 등록한다. " +
    registered +
    " 이 중 하나를 시키거나, " +
    '"업무로 등록해줘", "매뉴얼로 만들어", "시스템에 반영해", "방금 한 거 등록해", ' +
    '"일감 뽑아서 해줘" 라고 하면 쓴다. 회사 업무처럼 들리는데 매뉴얼이 있는지 모를 때도 먼저 확인용으로 쓴다.' +
    abilities
  ).replace(/\s+/g, " ");
}

// 구글 드라이브에 두는 안내문. 새 컴에서 이 시스템을 발견하는 유일한 통로다.
// 운영은 git 저장소가 한다. 드라이브에는 저장소를 두지 않는다(Drive 가 .git 을 건드려 깨뜨린다).
function writeDriveGuide() {
  const me = machine();
  if (!me.drive_root || !fs.existsSync(me.drive_root)) {
    console.log("구글 드라이브를 못 찾아 안내문은 건너뛴다 (node setup.mjs --drive <경로>)");
    return;
  }
  const dir = path.join(me.drive_root, "에이전트");
  const list = manualList().filter((m) => !m.hidden);
  // 표에 짧은 부르는 말만 두면 Codex 가 승인 게이트에서 멈춘다(260825 실측).
  // 폰에서 그대로 복사해 붙일 문장을 싣는다. lib/call-phrase.mjs 에 이유를 적어 뒀다.
  const rows = list.length
    ? list.map((m) => `| ${m.title} | ${callPhrase(m.title, m.preauth)} |`).join("\n")
    : "| (아직 없다) | |";

  const text = `# 에이전트 업무 시스템

> 이 파일은 \`node ops.mjs sync\` 가 다시 쓴다. 손으로 고치지 마라.

**여기가 뿌리다.** 필요한 걸 아래 표에서 고르고 그 파일 하나만 연다.
전부 읽지 마라. 한 번에 한 갈래씩 내려가면 두세 번에 닿는다.

세팅이 안 된 컴에서도 이 폴더만 보고 바로 일할 수 있다.
등록된 업무와 일감 현황은 **https://wnbx.vercel.app**

---

## 무엇을 찾나 → 어디로

| 찾는 것 | 열 파일 |
| --- | --- |
| **무엇을 할 수 있나** (카톡, 노션, 시트, 피그마, 결제 등) | \`능력/읽어라.md\` |
| **정해진 업무를 절차대로** | \`매뉴얼/읽어라.md\` → 그 업무의 \`.md\` |
| 사업자번호, 법인번호, 주소, 전화, 매출 | \`정보/회사.md\` |
| 사업자등록증, 인감, 도장, 로고, 명함, 사업계획서 파일 | \`정보/핵심자료.md\` |
| 회의록, 기획, 진행 상황, 제품별 논의 | \`정보/노션.md\` |
| 코드 폴더, 배포 주소, 카톡 대화 읽는 법 | \`정보/프로젝트.md\` |
| 로그인 ID, 비밀번호 | \`자격증명/계정.md\` |
| API 키 | \`자격증명/.env\` |
| 이 컴에 설치하기 | 아래 "한 줄 설치" |

## "에이전트 폴더 참고해서 ○○ 해줘" 라고만 하면

**업무 이름을 대지 않아도 이 폴더의 능력은 그냥 쓴다.**
카톡 읽기, 노션, 드라이브, 시트, 메일, 인스타, 피그마, 문서 만들기가 전부 여기 있다.

1. \`능력/읽어라.md\` 를 연다. 표에서 지금 필요한 것 하나를 고른다
2. 그 파일만 읽고 그대로 쓴다. 능력마다 어떻게 하는지, 무엇을 하면 안 되는지가 적혀 있다
3. 목록에 없는 일이면 \`능력/화면과로그인.md\` 의 사다리(L1에서 L4)로 길이 있는지 보고 **일단 해본다**

**"매뉴얼이 없어서 못 합니다" 는 답이 아니다.** 능력이 있으면 하고, 하고 나서 적어두면 된다.

## 사람이 "○○ 업무 해줘" 라고 하면 (등록된 업무)

1. \`매뉴얼/읽어라.md\` 에서 그 업무를 찾는다. 있으면 그 파일을 **끝까지** 읽고 그대로 한다
2. 하다가 모르는 게 나오면 위 표에서 해당 갈래 하나만 연다
3. 매뉴얼에 없는 업무면 \`매뉴얼/_new-manual.md\` 를 보고 **기록 모드**로 하고 매뉴얼로 남긴다

매뉴얼은 "이 순서로 해라" 이고 능력은 "이건 할 수 있다" 다. 둘은 겹치지 않는다.
매뉴얼을 하다가 도구 쓰는 법이 막히면 능력 쪽을 편다.

## 매뉴얼 업무 완주 원칙

업무를 한 문장으로 호출하면 매뉴얼의 절차·후속 작업·완료 검사를 한 번에 실행한다.
중간 산출물만 남기고 멈추거나, 게시·전송·주문 버튼을 사람에게 넘기지 않는다.
한 단계가 막혀도 독립적으로 할 수 있는 나머지 단계는 계속하고, 의존 단계만 정확한 사유를
남긴다. 매뉴얼 밖의 대상, 비밀번호·CAPTCHA, 매뉴얼 밖 결제, 되살릴 수 없는 삭제만 사람을 부른다.

## 멈추고 사람을 부르는 곳

- **매뉴얼 밖의 결제.** 매뉴얼에 금액과 대상이 적힌 주문은 금액·대상을 보고하고 그대로 실행한다.
  등록된 결제수단이 없거나 충전·구독 변경이 필요한 경우에만 멈춘다. 카드번호를 손으로 치지 않는다
- **주민등록번호와 공동인증서(NPKI)**: 열지도 옮기지도 않는다
- **도장 찍는 자리**, 인감증명서와 통장사본을 바깥으로 보내기
- 매뉴얼 밖의 메시지, 메일, DM 보내기
- 매뉴얼 밖의 공개 게시·삭제

## 그 컴을 계속 쓸 거면 (한 줄 설치)

**이 파일 옆에 있는 \`설치.mjs\` 를 실행한다.** 드라이브 문자는 컴마다 다르니 경로는 실제 위치에 맞춘다.

\`\`\`bash
node "<이 폴더>/설치.mjs"
\`\`\`

**node 와 git 만 깔려 있으면 나머지는 알아서 한다.** 먼저 무엇이 바뀌는지 보고 싶으면 \`--dry\` 를 붙인다.
프로젝트 폴더를 \`C:/dev\` 말고 다른 데 두려면 \`--dev D:/work\` 처럼 알려준다.

설치.mjs 가 하는 일.

1. \`설정/\` 에 담긴 것을 제자리에 놓는다. Claude 전역 지침, 권한 설정, 스킬, 기억,
   Codex 전역 지침, 스킬, 규칙, 프로젝트 작업 지도. **기존 파일은 지우지 않고 백업해두고 덮는다.**
2. 관제탑 저장소를 받는다 (https://github.com/yeohj0710/ops)
3. 이 기계를 등록하고 ops 스킬을 Claude 와 Codex 양쪽에 설치한다

무엇이 어디로 가는지는 \`목록.md\` 에 있다.

**사람이 직접 해야 하는 것은 두 가지뿐이다.** Claude 와 Codex 로그인, 그리고 Codex 설정(\`config.toml\`).
그 둘은 기계마다 값이 달라서 담지 않았다.

## 회사 정보를 채워두면 에이전트가 안 묻는다

\`정보/회사.md\` 에 사업자번호, 법인번호, 주소, 전화, 매출이 들어 있다.
\`정보/핵심자료.md\` 는 사업자등록증, 인감증명서, 도장, 로고, 명함, 사업계획서가 **어느 파일인지** 알려준다
(원본은 \`내 드라이브/여형준님/00 핵심 자료/\`. 사본을 만들지 마라).

로그인 정보는 \`자격증명/계정.md\`, API 키는 \`자격증명/.env\` 에 있고
\`설치.mjs\` 가 \`.env\` 를 새 컴의 \`<프로젝트폴더>/ops/.env\` 로도 놓는다.

**주민등록번호와 공동인증서는 열지 않는다. 결제 정보는 입력창에 넣지 않는다.**
도장을 찍는 자리는 사람이 정한다. 자세한 건 \`자격증명/읽어라.md\`.

## 설정을 고친 뒤에는

이 컴에서 지침이나 스킬을 고쳤으면 드라이브로 거둬야 다른 컴이 받는다.
이 폴더의 \`백업.mjs\` 를 실행하면 된다. \`node ops.mjs sync\` 를 돌려도 같이 거둔다.

## 세팅한 뒤에는

| 하고 싶은 것 | 세션에 하는 말 |
| --- | --- |
| 등록된 업무 시키기 | 아래 표의 "붙여넣을 말" 을 **통째로** |
| 새 업무 등록하기 | "○○ 업무로 등록해줘", "방금 한 거 등록해줘" |
| 큐에서 뽑아 돌리기 | "일감 뽑아서 해줘" |

## 지금 등록된 업무 ${list.length}개

문장이 긴 이유가 있다. 업로드나 게시가 들어 있는 업무는 **그것까지 미리 허가한다는 말**이 뒤에 붙어 있다.
그 말을 빼면 Codex 가 절차를 다 읽고도 마지막에 "실행해도 될까요" 하고 멈춰 선다.
폰으로 시켜 놓고 자리를 비우면 거기서 일이 끝난다. **뒤를 자르지 말고 통째로 붙여넣어라.**

| 업무 | 붙여넣을 말 |
| --- | --- |
${rows}

## 왜 드라이브가 아니라 git 인가

- 매뉴얼과 일감은 **저장소**에 있다. 드라이브에는 이 안내문만 둔다.
- 두 에이전트가 동시에 일할 때 겹침을 \`git push\` 경쟁으로 판정한다. 드라이브에는 그 심판이 없어서
  같은 파일을 만지면 "충돌 사본" 이 생긴다.
- 드라이브 폴더 안에 git 저장소를 두면 동기화가 \`.git\` 을 건드려 깨진다.

## 컴 사이 동기화

\`ops.mjs\` 가 일감을 뽑거나 현황을 볼 때 6시간 간격으로 알아서 \`git pull\` 한다.
직접 맞추고 싶으면 관제탑 폴더에서 \`git pull\`, 또는 이 폴더의 \`설치.mjs\` 를 다시 실행한다.

## 이 폴더 구성

| | |
| --- | --- |
| \`시작.md\` | 지금 읽는 것 |
| \`설치.mjs\` | 새 컴에 전부 깐다 (드라이브 → 컴) |
| \`백업.mjs\` | 이 컴 설정을 거둔다 (컴 → 드라이브) |
| \`능력/\` | 업무 이름 없이도 쓰는 것들 (카톡, 노션, 드라이브, 시트, 메일, 인스타, 피그마, 문서, 화면, 돈) |
| \`매뉴얼/\` | 업무 절차서 사본 (읽기용). 설치 없이도 여기만 보면 일할 수 있다 |
| \`정보/\` | \`회사.md\`(사업자번호, 주소, 매출), \`핵심자료.md\`(서류, 도장, 로고 어디 있나) |
| \`자격증명/\` | \`계정.md\`(로그인 정보), \`.env\`(API 키) |
| \`설정/\` | 지침, 스킬, 기억. 설치기가 제자리에 놓는다 |
| \`목록.md\` | 무엇이 어디로 가는지 표 |
| \`manifest.json\` | 두 스크립트가 보는 목록 원본 |
`;

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "시작.md"), text, "utf8");

  // 부트스트랩 묶음을 드라이브에 깐다. 저장소 없이 단독으로 돌아야 한다.
  const bs = path.join(ROOT, "bootstrap");
  for (const f of ["설치.mjs", "백업.mjs", "lib.mjs", "manifest.json"]) {
    const src = path.join(bs, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, f));
  }

  // 능력 사본. 업무 이름을 대지 않아도 쓰는 것들이다.
  // 매뉴얼과 마찬가지로 읽기용이고, 고치는 건 저장소에서 한다.
  const asrc = path.join(ROOT, "abilities");
  if (fs.existsSync(asrc)) {
    const adir = path.join(dir, "능력");
    removeTreeSafe(adir);
    fs.mkdirSync(adir, { recursive: true });
    for (const f of fs.readdirSync(asrc)) {
      if (f === "desktop.ini") continue;
      fs.copyFileSync(path.join(asrc, f), path.join(adir, f));
    }
  }

  // 매뉴얼 사본. 저장소가 없는 컴에서도 드라이브만 보고 일할 수 있어야 한다.
  // 읽기용이다. 고치는 건 저장소에서 한다(겹침 판정을 git 이 해야 하므로).
  const mdir = path.join(dir, "매뉴얼");
  removeTreeSafe(mdir);
  // 폴더를 통째로 옮긴다. 매뉴얼이 딸린 스크립트를 부르는데 저장소 없는 컴에는 그게 없다.
  for (const m of manualList()) {
    const from = path.dirname(m.file);
    const to = path.join(mdir, m.id);
    fs.mkdirSync(to, { recursive: true });
    const copyDir = (a, b) => {
      for (const e of fs.readdirSync(a, { withFileTypes: true })) {
        if (e.name === "desktop.ini" || e.name === "node_modules") continue;
        const src = path.join(a, e.name);
        const dst = path.join(b, e.name);
        if (e.isDirectory()) {
          fs.mkdirSync(dst, { recursive: true });
          copyDir(src, dst);
        } else fs.copyFileSync(src, dst);
      }
    };
    copyDir(from, to);
  }
  fs.writeFileSync(
    path.join(mdir, "읽어라.md"),
    [
      "# 매뉴얼 사본 (읽기용)",
      "",
      "> `node ops.mjs sync` 가 저장소에서 복사한다. 여기서 고치면 다음 sync 에 지워진다.",
      "> 고칠 일이 있으면 저장소에서 고친다. https://github.com/yeohj0710/ops",
      "",
      "저장소가 없는 컴에서도 이 폴더만 보고 업무를 할 수 있게 두었다.",
      "일감 큐를 쓰려면 저장소가 있어야 한다(겹침을 git push 경쟁으로 판정한다).",
      "",
      "붙여넣을 말은 뒤를 자르지 말고 통째로 쓴다. 미리 허가가 빠지면 세션이 게시 직전에 멈춰 선다.",
      "",
      "| 업무 | 붙여넣을 말 |",
      "| --- | --- |",
      ...list.map((m) => `| [${m.title}](${m.id}/MANUAL.md) | ${callPhrase(m.title, m.preauth)} |`),
    ].join("\n") + "\n",
    "utf8"
  );

  // 정보와 자격증명 자리. 이미 사람이 채운 파일은 절대 덮지 않는다.
  const tmpl = path.join(bs, "정보-틀");
  if (fs.existsSync(tmpl)) {
    fs.mkdirSync(path.join(dir, "정보"), { recursive: true });
    fs.mkdirSync(path.join(dir, "자격증명"), { recursive: true });
    for (const f of fs.readdirSync(tmpl)) {
      const to =
        f === "자격증명-읽어라.md"
          ? path.join(dir, "자격증명", "읽어라.md")
          : path.join(dir, "정보", f);
      if (!fs.existsSync(to)) fs.copyFileSync(path.join(tmpl, f), to);
    }
  }
  console.log("드라이브 안내문과 설치기: " + dir);

  // 이 컴 설정을 거둔다.
  try {
    execFileSync(process.execPath, [path.join(dir, "백업.mjs"), "--dev", me.dev_root || "C:/dev"], {
      cwd: dir,
      stdio: "inherit",
    });
  } catch {
    console.log("설정 백업 실패. node \"" + path.join(dir, "백업.mjs") + "\" 를 직접 돌려라");
  }
}

function cmdSync() {
  const src = path.join(ROOT, "skill", "SKILL.md");
  if (!fs.existsSync(src)) die("skill/SKILL.md 가 없다.");

  let body = fs.readFileSync(src, "utf8");
  const desc = skillDescription();
  // 저장소 원본의 설명줄도 최신으로 유지한다.
  body = body.replace(/^description:.*$/m, "description: " + desc);
  // 매뉴얼 경로는 기계마다 다를 수 있으니 설치할 때 이 기계 값으로 굳힌다.
  const installed = body.replace(/C:\/dev\/ops/g, ROOT.replace(/\\/g, "/"));
  fs.writeFileSync(src, body, "utf8");

  for (const t of SKILL_TARGETS) {
    const parent = path.dirname(t.dir);
    if (!fs.existsSync(parent)) {
      console.log(`건너뜀 (${t.tool} 스킬 폴더 없음): ${parent}`);
      continue;
    }
    fs.mkdirSync(t.dir, { recursive: true });
    fs.writeFileSync(path.join(t.dir, "SKILL.md"), installed, "utf8");
    console.log(`${t.tool} 스킬 설치: ${path.join(t.dir, "SKILL.md")}`);
  }
  writeDriveGuide();
  console.log("");
  console.log("상시 컨텍스트에 남는 건 이 설명 한 줄뿐이다 (" + desc.length + "자):");
  console.log("  " + desc);
}

function cmdNew(argv) {
  const id = argv._[0];
  if (!id)
    die('매뉴얼 id 가 필요하다. 영문 소문자와 하이픈만 쓴다. 예: node ops.mjs new proposal-deck --title "제안서 제작"');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) die("id 는 영문 소문자, 숫자, 하이픈만 쓴다. 예: proposal-deck");
  const dest = path.join(DIR.manuals, id);
  if (fs.existsSync(dest)) die(`manuals/${id} 가 이미 있다. 새로 만들지 말고 그걸 고쳐라.`);

  // 비슷한 매뉴얼이 이미 있으면 알려준다. 매뉴얼이 둘로 갈라지는 게 제일 나쁘다.
  if (argv.title) {
    const needle = String(argv.title).toLowerCase();
    const near = manualList().filter(
      (m) => !m.hidden && [m.id, m.title, m.trigger].join(" ").toLowerCase().includes(needle)
    );
    for (const m of near) console.log(`주의: 비슷한 매뉴얼이 있다. ${m.id} (${m.title})`);
  }

  fs.cpSync(path.join(DIR.manuals, "_template"), dest, { recursive: true });
  if (argv.title) {
    const f = path.join(dest, "MANUAL.md");
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/^# .*$/m, "# " + argv.title), "utf8");
  }
  console.log("만들었다: " + path.join(dest, "MANUAL.md"));
  console.log("");
  console.log("이제 할 일:");
  console.log("  1. 머리말 다섯 줄(부르는 말, 미리 허가, 런너, 제어층, 시간)을 채운다");
  console.log("     미리 허가에 업로드, 게시, 주문 같은 밖으로 나가는 행동을 적어야 호출문이 완성된다");
  console.log("  2. 절차, 알려진 함정, 완료 검사를 채운다. 방금 한 일이 있으면 그대로 옮긴다");
  console.log("  3. node ops.mjs sync 로 스킬 설명줄에 이 업무를 올린다 (부르는 말을 채운 뒤에 돌려라)");
  console.log("  4. 커밋하고 push 한다 (git add -A && git commit && git push)");
}

// ---------- 태스크 ----------

function newId(manual) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const base = `${String(d.getFullYear()).slice(2)}${p(d.getMonth() + 1)}${p(
    d.getDate()
  )}-${p(d.getHours())}${p(d.getMinutes())}-${manual}`;
  let id = base;
  let n = 2;
  const taken = (x) =>
    fs.existsSync(path.join(DIR.queue, x + ".json")) ||
    fs.existsSync(path.join(DIR.doing, x + ".json"));
  while (taken(id)) id = `${base}-${n++}`;
  return id;
}

function cmdAdd(argv) {
  const manual = argv.manual;
  if (!manual) die("--manual <매뉴얼id> 가 필요하다. 목록은 `node ops.mjs manuals`.");
  const m = manualList().find((x) => x.id === manual);
  if (!m) die(`매뉴얼 '${manual}' 이 없다. 목록은 \`node ops.mjs manuals\`.`);

  const id = newId(manual);
  const task = {
    id,
    manual,
    title: argv.title || m.title,
    runner: argv.runner || m.runner || "either",
    est_minutes: Number(argv.est || 30),
    needs_screen: argv["needs-screen"] === true || /L3|L4/.test(m.surfaces),
    resource: argv.resource || null,
    priority: Number(argv.priority || 5),
    input: argv.input ? JSON.parse(argv.input) : {},
    created: stamp(),
    lease: null,
    log: [],
  };
  writeJson(path.join(DIR.queue, id + ".json"), task);
  sync(`task: 큐에 ${id}`);
  console.log(`큐에 넣었다: ${id}`);
  console.log(path.join(DIR.queue, id + ".json"));
}

function doingNow() {
  return ls(DIR.doing).map((f) => readJson(path.join(DIR.doing, f)));
}

function cmdNext(argv) {
  pullFirst();
  const me = machine();
  const runner = argv.runner || process.env.OPS_RUNNER || "either";

  const busy = doingNow();
  const heldResources = new Set(busy.map((t) => t.resource).filter(Boolean));
  const screenBusyHere = busy.some(
    (t) => t.needs_screen && t.lease && t.lease.machine === me.name
  );

  const candidates = ls(DIR.queue)
    .map((f) => readJson(path.join(DIR.queue, f)))
    .filter((t) => t.runner === "either" || runner === "either" || t.runner === runner)
    .filter((t) => !(t.resource && heldResources.has(t.resource)))
    .filter((t) => !(t.needs_screen && screenBusyHere))
    .sort(
      (a, b) => a.priority - b.priority || String(a.created).localeCompare(String(b.created))
    );

  if (!candidates.length) {
    const why = [];
    if (screenBusyHere) why.push("이 기계가 이미 화면 제어 태스크를 잡고 있다");
    if (heldResources.size) why.push(`점유 중인 대상: ${[...heldResources].join(", ")}`);
    console.log("EMPTY 큐에 지금 집을 수 있는 태스크가 없다.");
    if (why.length) console.log("이유: " + why.join(" / "));
    console.log("새 일감은 `node ops.mjs add --manual <id> --title \"…\"` 로 넣는다.");
    return;
  }

  for (const task of candidates) {
    const from = path.join(DIR.queue, task.id + ".json");
    const to = path.join(DIR.doing, task.id + ".json");
    task.lease = {
      machine: me.name,
      runner,
      at: stamp(),
    };
    task.log.push({ at: stamp(), what: "claim", by: `${runner}@${me.name}` });
    writeJson(to, task);
    fs.rmSync(from, { force: true });
    const s = sync(`claim: ${task.id} (${runner}@${me.name})`);

    // 원격이 있으면 경쟁에서 이겼는지 확인한다.
    if (hasRemote() && !s.pushed) {
      pullFirst();
      if (!fs.existsSync(to)) continue; // 남이 먼저 집었다. 다음 후보로.
      const now = readJson(to);
      if (!now.lease || now.lease.machine !== me.name) continue;
    }
    return printTask(task, me);
  }
  console.log("EMPTY 후보를 전부 남에게 뺏겼다. 잠시 뒤 다시 부른다.");
}

function printTask(task, me) {
  const m = manualList().find((x) => x.id === task.manual);
  const out = [];
  out.push("TASK " + task.id);
  out.push("제목: " + task.title);
  out.push("매뉴얼: " + (m ? m.file : "(없음) " + task.manual));
  out.push("런너 규칙: " + path.join(ROOT, "runners", (task.lease.runner === "codex" ? "codex" : "claude") + ".md"));
  out.push("상시 지침: " + path.join(ROOT, "AGENTS.md"));
  out.push("");
  out.push("입력값: " + JSON.stringify(task.input));
  out.push("예상 시간: " + task.est_minutes + "분");
  out.push("화면 제어: " + (task.needs_screen ? "쓴다 (이 기계에서 다른 화면 태스크 금지)" : "안 쓴다"));
  if (task.resource) out.push("점유 대상: " + task.resource);
  out.push("작업 폴더: " + path.join(ROOT, "work", task.id));
  out.push("");
  out.push("끝나면:");
  out.push(`  node "${path.join(ROOT, "ops.mjs")}" done ${task.id} --note "무엇을 했는지 한 줄"`);
  out.push("막히면:");
  out.push(`  node "${path.join(ROOT, "ops.mjs")}" block ${task.id} --note "무엇에 막혔는지"`);
  console.log(out.join("\n"));
  fs.mkdirSync(path.join(ROOT, "work", task.id), { recursive: true });
}

function findDoing(id) {
  const p = path.join(DIR.doing, id + ".json");
  if (!fs.existsSync(p)) die(`진행 중인 태스크 '${id}' 가 없다.`);
  return { p, task: readJson(p) };
}

function cmdDone(argv) {
  const id = argv._[0];
  if (!id) die("태스크 id 가 필요하다.");
  const { p, task } = findDoing(id);

  const checks = path.join(DIR.manuals, task.manual, "checks.mjs");
  if (fs.existsSync(checks)) {
    try {
      execFileSync(process.execPath, [checks, p], {
        cwd: ROOT,
        stdio: "inherit",
        env: { ...process.env, OPS_ROOT: ROOT, OPS_TASK: p },
      });
    } catch {
      console.error("\n완료 검사에서 막혔다. 고치고 같은 명령을 다시 실행해라.");
      console.error("검사 파일: " + checks);
      process.exit(1);
    }
  }

  task.log.push({ at: stamp(), what: "done", note: argv.note || "" });
  task.finished = stamp();
  task.status = "done";
  const dest = path.join(DIR.done, yyyymm(task.finished), id + ".json");
  writeJson(dest, task);
  fs.rmSync(p, { force: true });
  const s = sync(`done: ${id}`);
  console.log("끝냈다: " + id);
  console.log(dest);
  if (!s.pushed && hasRemote()) console.log("주의: 올리지 못했다. " + s.reason);
}

function cmdBlock(argv) {
  const id = argv._[0];
  if (!id) die("태스크 id 가 필요하다.");
  const { p, task } = findDoing(id);
  task.log.push({ at: stamp(), what: "block", note: argv.note || "" });
  task.lease = null;
  task.blocked_count = (task.blocked_count || 0) + 1;
  writeJson(path.join(DIR.queue, id + ".json"), task);
  fs.rmSync(p, { force: true });
  sync(`block: ${id}`);
  console.log("큐로 돌려보냈다: " + id + " (막힘 " + task.blocked_count + "회)");
  console.log("붙잡지 말고 바로 다음 태스크를 뽑아라.");
}

function cmdStatus() {
  pullFirst();
  const q = ls(DIR.queue).length;
  const d = doingNow();
  console.log(`대기 ${q}, 진행 ${d.length}`);
  for (const t of d) {
    console.log(
      `  ${t.id}  ${t.title}  ← ${t.lease?.runner}@${t.lease?.machine} (${t.lease?.at})`
    );
  }
  const months = fs.existsSync(DIR.done)
    ? fs.readdirSync(DIR.done, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    : [];
  let doneCount = 0;
  for (const m of months) doneCount += ls(path.join(DIR.done, m)).length;
  console.log(`완료 누적 ${doneCount}`);
}

function cmdDoctor() {
  const me = machine();
  const ok = (b) => (b ? "OK  " : "빠짐");
  console.log("저장소: " + ROOT);
  console.log(ok(me.setup) + " machine.json  " + (me.setup ? me.name : "→ node setup.mjs 를 한 번 돌려라"));
  console.log(ok(isRepo()) + " git 저장소");
  console.log(ok(hasRemote()) + " 원격 " + (hasRemote() ? git(["remote", "get-url", "origin"]).out : "→ 없으면 이 기계에서만 돈다"));
  console.log(ok(fs.existsSync(path.join(ROOT, ".git", "hooks", "pre-commit"))) + " 커밋 전 검사 훅");
  console.log("매뉴얼 " + manualList().filter((m) => !m.hidden).length + "개");
  if (me.setup && me.dev_root)
    console.log(ok(fs.existsSync(me.dev_root)) + " 프로젝트 폴더 " + me.dev_root);
}

// ---------- 진입 ----------

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function parse(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) out[k] = true;
      else (out[k] = v), i++;
    } else out._.push(a);
  }
  return out;
}

const [, , cmd, ...rest] = process.argv;
const argv = parse(rest);
const table = {
  next: cmdNext,
  add: cmdAdd,
  new: cmdNew,
  sync: cmdSync,
  done: cmdDone,
  block: cmdBlock,
  manuals: cmdManuals,
  status: cmdStatus,
  doctor: cmdDoctor,
};
if (!cmd || !table[cmd]) {
  console.log(
    [
      "ops, 회사 업무 관제탑",
      "",
      "  node ops.mjs next [--runner claude|codex]",
      "  node ops.mjs new <매뉴얼id> --title \"…\"",
      "  node ops.mjs add --manual <id> --title \"…\" [--runner] [--est 30] [--resource x] [--priority 5]",
      "  node ops.mjs done <taskId> --note \"…\"",
      "  node ops.mjs block <taskId> --note \"…\"",
      "  node ops.mjs manuals [검색어]",
      "  node ops.mjs sync",
      "  node ops.mjs status",
      "  node ops.mjs doctor",
    ].join("\n")
  );
  process.exit(cmd ? 1 : 0);
}
table[cmd](argv);
