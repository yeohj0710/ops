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
//   status                         큐·진행·완료 현황
//   doctor                         이 기계 설정 점검

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

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
        hidden: id.startsWith("_"),
      };
    })
    .filter(Boolean);
}

function cmdManuals(argv) {
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
    console.log(`    런너 ${m.runner} · 제어층 ${m.surfaces}`);
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

function skillDescription() {
  const list = manualList().filter((m) => !m.hidden);
  const MAX = 12;
  const shown = list.slice(0, MAX).map((m) => {
    const words = m.trigger
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 3)
      .join("·");
    return words ? `${m.title}(${words})` : m.title;
  });
  const more = list.length > MAX ? ` 외 ${list.length - MAX}개` : "";
  const registered = shown.length ? `지금 등록된 업무 — ${shown.join(", ")}${more}.` : "아직 등록된 업무가 없다.";

  return (
    "회사 반복 업무를 매뉴얼대로 실행하거나 새 업무를 매뉴얼로 등록한다. " +
    registered +
    " 이 중 하나를 시키거나, " +
    '"업무로 등록해줘"·"매뉴얼로 만들어"·"시스템에 반영해"·"방금 한 거 등록해"·' +
    '"일감 뽑아서 해줘" 라고 하면 쓴다. 회사 업무처럼 들리는데 매뉴얼이 있는지 모를 때도 먼저 확인용으로 쓴다.'
  ).replace(/\s+/g, " ");
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
  console.log("");
  console.log("상시 컨텍스트에 남는 건 이 설명 한 줄뿐이다 (" + desc.length + "자):");
  console.log("  " + desc);
}

function cmdNew(argv) {
  const id = argv._[0];
  if (!id)
    die('매뉴얼 id 가 필요하다. 영문 소문자·하이픈. 예: node ops.mjs new proposal-deck --title "제안서 제작"');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) die("id 는 영문 소문자·숫자·하이픈만 쓴다. 예: proposal-deck");
  const dest = path.join(DIR.manuals, id);
  if (fs.existsSync(dest)) die(`manuals/${id} 가 이미 있다. 새로 만들지 말고 그걸 고쳐라.`);

  // 비슷한 매뉴얼이 이미 있으면 알려준다 — 매뉴얼이 둘로 갈라지는 게 제일 나쁘다.
  if (argv.title) {
    const needle = String(argv.title).toLowerCase();
    const near = manualList().filter(
      (m) => !m.hidden && [m.id, m.title, m.trigger].join(" ").toLowerCase().includes(needle)
    );
    for (const m of near) console.log(`주의: 비슷한 매뉴얼이 있다 — ${m.id} (${m.title})`);
  }

  fs.cpSync(path.join(DIR.manuals, "_template"), dest, { recursive: true });
  if (argv.title) {
    const f = path.join(dest, "MANUAL.md");
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/^# .*$/m, "# " + argv.title), "utf8");
  }
  console.log("만들었다: " + path.join(dest, "MANUAL.md"));
  console.log("");
  console.log("이제 할 일:");
  console.log("  1. 머리말 네 줄(부르는 말·런너·제어층·시간)을 채운다");
  console.log("  2. 절차·알려진 함정·완료 검사를 채운다 — 방금 한 일이 있으면 그대로 옮긴다");
  console.log("  3. node ops.mjs sync — 스킬 설명줄에 이 업무를 올린다 (부르는 말을 채운 뒤에 돌려라)");
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
  if (!s.pushed && hasRemote()) console.log("주의: 올리지 못했다 — " + s.reason);
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
  console.log(`대기 ${q} · 진행 ${d.length}`);
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
      "ops — 회사 업무 관제탑",
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
