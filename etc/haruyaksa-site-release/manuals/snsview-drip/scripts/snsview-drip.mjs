#!/usr/bin/env node
// 릴스 조회수를 잘게 나눠 일정 간격으로 반복 주문한다. SNS서포터 표준 API 로 셸에서 끝까지 돈다.
// 브라우저도, 에이전트도 붙어 있을 필요가 없다. start 가 배경 프로세스를 띄우고 그 프로세스가 혼자 돈다.
//
//   node snsview-drip.mjs check                                    키, 잔액, 상품 단가와 최소 수량을 본다
//   node snsview-drip.mjs plan  --link <URL> --qty 100 --runs 100 --every 5m    비용과 소요 시간만 계산한다
//   node snsview-drip.mjs start --link <URL> --qty 100 --runs 100 --every 5m    묶음을 만들고 배경에서 돌린다
//   node snsview-drip.mjs status [묶음id]                           진행 상황. 묶음id 없으면 최근 것
//   node snsview-drip.mjs stop <묶음id>                              다음 회차부터 멈춘다
//   node snsview-drip.mjs resume <묶음id>                            멈춘 묶음을 이어서 돌린다
//   node snsview-drip.mjs list                                       묶음 전체
//   node snsview-drip.mjs guard [status|install|remove]              끊겨도 되살리는 예약 작업
//   node snsview-drip.mjs watch                                      끊긴 묶음을 되살린다. 예약 작업이 5분마다 부른다
//   node snsview-drip.mjs run <묶음id>                               루프 본체. start 와 resume 이 배경으로 띄운다
//
// 옵션
//   --link     주문할 게시물 주소. 릴스면 https://www.instagram.com/reel/<코드>/ 꼴
//   --qty      한 번에 주문할 조회수. 기본 100. 상품 최소 수량(50) 밑으로는 못 넣는다
//   --runs     총 주문 횟수. 기본 100
//   --every    간격. 5m, 300s, 1h, 숫자만 쓰면 분. 기본 5m. 60초 밑으로는 못 내린다
//   --service  상품 번호. 기본 813 ([동영상] 한국인 조회수, 1,000회에 100원)
//   --jitter   간격 흔들기 비율. 0.1 이면 간격의 ±10% 안에서 매번 조금씩 다르게. 기본 0
//   --allow-short  잔액이 총액보다 적어도 시작한다. 잔액이 떨어지면 거기서 멈춰 기다린다
//   --foreground   start 에서 배경으로 띄우지 않고 이 창에서 돈다
//   --root <경로>  ops 저장소 위치. 예약 작업과 시험용. 안 주면 이 스크립트 위치에서 찾는다
//
// 키는 <drive_root>/에이전트/자격증명/.env 의 SNSSUPPORTER_API_KEY 다. 환경변수로 줘도 된다.
// 키를 넣는 법: 사이트 내 정보 > 환경 탭 > 새로고침 으로 발급 > 복사 > node scripts/env-set.mjs SNSSUPPORTER_API_KEY --clipboard
//
// 상태는 <OPS>/work/snsview-drip/<묶음id>/state.json 에 있다. 프로세스가 죽어도 여기서 이어 간다.
// 이미 들어간 주문은 orders 배열에 주문번호와 함께 남는다. 같은 회차를 두 번 넣지 않는다.

import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const rootFlag = (() => {
  const i = process.argv.indexOf("--root");
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
})();
const NATURAL_OPS = path.resolve(HERE, "..", "..", "..");
const OPS = path.resolve(rootFlag || process.env.OPS_ROOT || NATURAL_OPS);
const WORK = path.join(OPS, "work", "snsview-drip");
// 심장박동이 이만큼 낡으면 그 프로세스는 죽은 것으로 본다. 회차 대기 중 15초마다 찍는다
const HEARTBEAT_STALE_MS = 150000;
// 되살리기 예약 작업 이름. 컴퓨터마다 하나면 된다
const TASK_NAME = "ops-snsview-drip-watch";
const WATCH_EVERY_MIN = 5;
// 아래 두 환경변수는 자체 시험용이다. 실제 주문에서는 건드리지 않는다
const API = process.env.SNSSUPPORTER_API_URL || "https://snssupporter.com/api/v2";
const DEFAULT_SERVICE = 813;
const MIN_EVERY_SEC = Number(process.env.SNSVIEW_DRIP_MIN_EVERY || 60);

// ── 인자 ────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const cmd = argv[0] || "help";
// 이름 없는 인자는 명령 바로 뒤에만 온다. 첫 `--` 에서 끊는다.
// 그냥 걸러내면 `--root <경로>` 의 경로가 묶음 id 자리에 들어간다 (260905 실측)
const positional = (() => {
  const out = [];
  for (const a of argv.slice(1)) {
    if (a.startsWith("--")) break;
    out.push(a);
  }
  return out;
})();
const flag = (name, dflt = null) => {
  const i = argv.indexOf("--" + name);
  return i > -1 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const has = (name) => argv.includes("--" + name);

// ── 공용 ────────────────────────────────────────────────────────────────────────
const p2 = (n) => String(n).padStart(2, "0");
function stamp(d = new Date()) {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}
const won = (n) => "₩" + Math.round(n).toLocaleString("ko-KR");
const num = (n) => Number(n).toLocaleString("ko-KR");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// process.exit() 를 fetch 직후에 부르면 Windows 에서 libuv 단언(UV_HANDLE_CLOSING)으로 죽으며 127 을 낸다.
// 그래서 종료 코드만 정하고 던져서 맨 아래 catch 가 조용히 끝내게 한다
class ExitError extends Error {
  constructor(code, msg = "") {
    // 메시지를 비워 두면 배경 루프의 기록에 "잔액 조회 실패: " 처럼 사유 없는 줄이 남는다 (260905 실측)
    super(msg);
    this.code = code;
    this.printed = true;
  }
}
function fail(msg, code = 2) {
  console.error(msg);
  throw new ExitError(code, String(msg).split("\n")[0]);
}

function readJson(f, dflt = null) {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, ""));
  } catch {
    return dflt;
  }
}
function writeJson(f, o) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(o, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, f);
}

function parseEvery(s) {
  if (s === null || s === undefined) return null;
  const t = String(s).trim().toLowerCase();
  const m = t.match(/^(\d+(?:\.\d+)?)\s*(s|sec|m|min|h|hr)?$/);
  if (!m) return NaN;
  const v = Number(m[1]);
  const unit = m[2] || "m";
  if (unit.startsWith("s")) return v;
  if (unit.startsWith("h")) return v * 3600;
  return v * 60;
}
function fmtDur(sec) {
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const parts = [];
  if (h) parts.push(h + "시간");
  if (m) parts.push(m + "분");
  if (s && !h) parts.push(s + "초");
  return parts.join(" ") || "0초";
}

// ── 키 ─────────────────────────────────────────────────────────────────────────
function envFile() {
  const m = readJson(path.join(OPS, "machine.json"), {});
  if (!m.drive_root) return null;
  return path.join(m.drive_root.replace(/\//g, path.sep), "에이전트", "자격증명", ".env");
}
function apiKey() {
  if (process.env.SNSSUPPORTER_API_KEY) return process.env.SNSSUPPORTER_API_KEY.trim();
  const f = envFile();
  if (f && fs.existsSync(f)) {
    const m = fs.readFileSync(f, "utf8").match(/^SNSSUPPORTER_API_KEY=(.*)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  return "";
}
function requireKey() {
  const k = apiKey();
  if (!k) {
    fail(
      [
        "SNSSUPPORTER_API_KEY 가 없다. 한 번만 넣어 두면 그 뒤로는 계속 된다.",
        "  1. https://snssupporter.com/account 에서 환경 탭 > 새로고침 을 눌러 API 키를 발급받는다",
        "  2. 그 키를 복사한다",
        `  3. node "${path.join(OPS, "scripts", "env-set.mjs")}" SNSSUPPORTER_API_KEY --clipboard`,
        "키는 " + (envFile() || "(machine.json 에 drive_root 없음)") + " 에 들어간다. 값은 화면에 찍지 않는다.",
      ].join("\n")
    );
  }
  return k;
}

// ── API ─────────────────────────────────────────────────────────────────────────
// 예약 작업이 되살린 프로세스는 이 창의 환경변수를 물려받지 않는다.
// 그래서 되살리기를 시험할 때 쓰라고 묶음 상태에 주소를 적어 둘 수 있게 했다.
// 진짜 주문이 시험 서버로 새지 않게, 그리고 시험이 진짜 돈을 쓰지 않게 **로컬 주소만** 받는다
function apiUrlFor(id) {
  const u = id ? readJson(statePath(id))?.apiUrl : null;
  if (u && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u)) return u;
  return API;
}

async function api(params, { timeoutMs = 30000, batchId = null } = {}) {
  const url = apiUrlFor(batchId);
  const key = requireKey();
  const body = new URLSearchParams({ key, ...params });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let r;
    try {
      r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: ctrl.signal,
      });
    } catch (e) {
      const why = e.name === "AbortError" ? `${timeoutMs / 1000}초 안에 응답이 없다` : e.cause?.code || e.message;
      throw new Error(`API 연결 실패 (${why}). 주소 ${url}, 인터넷과 사이트 상태를 본다`);
    }
    const text = await r.text();
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      throw new Error(`응답이 JSON 이 아니다 (HTTP ${r.status}): ${text.slice(0, 200).replace(/\s+/g, " ")}`);
    }
    if (j && typeof j === "object" && !Array.isArray(j) && j.error) throw new Error("API 오류: " + j.error);
    return j;
  } finally {
    clearTimeout(t);
  }
}

async function getBalance(batchId = null) {
  const j = await api({ action: "balance" }, { batchId });
  return { balance: Number(j.balance), currency: j.currency || "KRW" };
}

async function getService(id) {
  const list = await api({ action: "services" });
  if (!Array.isArray(list)) throw new Error("services 응답이 배열이 아니다");
  const s = list.find((x) => String(x.service) === String(id));
  if (!s) {
    const views = list.filter((x) => /조회수|view/i.test(x.name || "")).slice(0, 10);
    throw new Error(
      `상품 ${id} 가 목록에 없다. 조회수 상품 후보: ` +
        views.map((x) => `${x.service} ${x.name} (${x.rate}/1000, 최소 ${x.min})`).join(" / ")
    );
  }
  return {
    id: Number(s.service),
    name: s.name,
    category: s.category,
    rate: Number(s.rate), // 1,000개당 원
    min: Number(s.min),
    max: Number(s.max),
    dripfeed: !!s.dripfeed,
    raw: s,
  };
}

async function addOrder(service, link, quantity, batchId = null) {
  const j = await api({ action: "add", service: String(service), link, quantity: String(quantity) }, { timeoutMs: 45000, batchId });
  if (!j || j.order === undefined) throw new Error("주문 응답에 order 가 없다: " + JSON.stringify(j).slice(0, 200));
  return String(j.order);
}

async function getStatuses(ids, batchId = null) {
  if (!ids.length) return {};
  const out = {};
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const j = await api({ action: "status", orders: chunk.join(",") }, { batchId });
    if (chunk.length === 1 && j && j.status !== undefined && !j[chunk[0]]) out[chunk[0]] = j;
    else Object.assign(out, j);
  }
  return out;
}

// ── 묶음 상태 ────────────────────────────────────────────────────────────────────
function batchDir(id) {
  return path.join(WORK, id);
}
function statePath(id) {
  return path.join(batchDir(id), "state.json");
}
function loadState(id) {
  const s = readJson(statePath(id));
  if (!s) fail(`묶음 ${id} 가 없다. 목록은 node snsview-drip.mjs list`);
  return s;
}
function saveState(s) {
  writeJson(statePath(s.id), s);
}
function log(id, line) {
  const f = path.join(batchDir(id), "log.txt");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, `[${stamp()}] ${line}\n`, "utf8");
  console.log(`[${stamp()}] ${line}`);
}
function listBatches() {
  if (!fs.existsSync(WORK)) return [];
  return fs
    .readdirSync(WORK)
    .filter((d) => fs.existsSync(statePath(d)))
    .map((d) => readJson(statePath(d)))
    .filter(Boolean)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}
function linkCode(link) {
  const m = link.match(/\/(?:reel|reels|p|tv|shorts|video)\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  return link.replace(/^https?:\/\//, "").replace(/[^A-Za-z0-9]+/g, "-").slice(-24) || "link";
}
function newBatchId(link) {
  const d = new Date();
  const base = `${String(d.getFullYear()).slice(2)}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}-${linkCode(link)}`;
  let id = base;
  let n = 2;
  while (fs.existsSync(batchDir(id))) id = `${base}-${n++}`;
  return id;
}
function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// 그 묶음을 실제로 돌리고 있는 프로세스가 살아 있나.
// pid 만 보면 안 된다. 윈도우가 죽은 pid 를 다른 프로그램에 다시 내주면 산 것처럼 보인다.
// 그래서 심장박동을 같이 본다. 심장박동이 없는 옛 상태 파일은 pid 만으로 판정한다(겹쳐 돌리지 않으려고).
function ownerAlive(s) {
  if (!s || !s.pid || !pidAlive(s.pid)) return false;
  if (s.heartbeatAt) return Date.now() - s.heartbeatAt < HEARTBEAT_STALE_MS;
  // 심장박동을 안 찍던 옛 프로세스는 다음 회차 시각으로 가늠한다.
  // 살아 있으면 그 시각은 늘 앞날이다. 한참 지났는데 그대로면 pid 를 남이 물려받은 것이다
  const due = s.nextAt ? new Date(String(s.nextAt).replace(" ", "T")).getTime() : NaN;
  if (Number.isFinite(due)) return Date.now() < due + HEARTBEAT_STALE_MS;
  return true;
}

// 손볼 것이 남은 묶음. stop 으로 세운 것과 이미 끝난 것은 빼고, 너무 오래 묵은 것도 뺀다
function pendingBatches() {
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  return listBatches().filter((b) => {
    if (b.done || b.stopped) return false;
    const touched = new Date(String(b.lastOrderAt || b.createdAt).replace(" ", "T")).getTime();
    return !Number.isFinite(touched) || touched > weekAgo;
  });
}

// ── 입력 검증과 계획 ─────────────────────────────────────────────────────────────
function readPlanArgs(existing = null) {
  let link = flag("link", existing?.link);
  // 인스타 주소는 /reel/<코드>/ 꼴로 맞춘다. 계정명이 낀 주소도 같은 게시물이다
  const ig = link && link.match(/^https?:\/\/(?:www\.)?instagram\.com\/(?:[A-Za-z0-9_.]+\/)?(reel|reels|p|tv)\/([A-Za-z0-9_-]+)/);
  if (ig) link = `https://www.instagram.com/${ig[1] === "reels" ? "reel" : ig[1]}/${ig[2]}/`;
  const qty = Number(flag("qty", existing?.qty ?? 100));
  const runs = Number(flag("runs", existing?.runs ?? 100));
  const everySec = existing?.everySec ?? parseEvery(flag("every", "5m"));
  const service = Number(flag("service", existing?.service ?? DEFAULT_SERVICE));
  const jitter = Number(flag("jitter", existing?.jitter ?? 0));

  if (!link || !/^https?:\/\/\S+$/.test(link)) fail("--link 에 게시물 주소를 넣는다. 예: --link https://www.instagram.com/reel/XXXX/");
  if (!Number.isInteger(qty) || qty <= 0) fail("--qty 는 양의 정수다. 예: --qty 100");
  if (!Number.isInteger(runs) || runs <= 0) fail("--runs 는 양의 정수다. 예: --runs 100");
  if (!Number.isFinite(everySec) || everySec < MIN_EVERY_SEC)
    fail(`--every 는 ${MIN_EVERY_SEC}초 이상이어야 한다. 예: --every 5m (5m, 300s, 1h, 숫자만 쓰면 분)`);
  if (!Number.isFinite(jitter) || jitter < 0 || jitter > 0.5) fail("--jitter 는 0 에서 0.5 사이다. 예: --jitter 0.1");
  return { link, qty, runs, everySec, service, jitter };
}

async function makePlan(a) {
  const [svc, bal] = await Promise.all([getService(a.service), getBalance()]);
  if (a.qty < svc.min) fail(`상품 최소 수량이 ${num(svc.min)} 이다. --qty ${a.qty} 로는 못 넣는다`);
  if (a.qty > svc.max) fail(`상품 최대 수량이 ${num(svc.max)} 이다. --qty ${a.qty} 는 너무 크다`);
  const unitCost = (a.qty * svc.rate) / 1000;
  const total = unitCost * a.runs;
  const duration = (a.runs - 1) * a.everySec;
  return { svc, bal, unitCost, total, duration };
}

function planLines(a, p) {
  const end = new Date(Date.now() + p.duration * 1000);
  return [
    `대상   ${a.link}`,
    `상품   ${p.svc.id} ${p.svc.name} (1,000회 ${won(p.svc.rate)}, 최소 ${num(p.svc.min)})`,
    `주문   ${num(a.qty)}회 × ${num(a.runs)}번 = 총 ${num(a.qty * a.runs)}회, ${fmtDur(a.everySec)} 간격` +
      (a.jitter ? ` (±${Math.round(a.jitter * 100)}% 흔들림)` : ""),
    `비용   회당 ${won(p.unitCost)}, 총 ${won(p.total)}. 잔액 ${won(p.bal.balance)} → ${won(p.bal.balance - p.total)}`,
    `시간   첫 주문은 바로, 마지막 주문은 ${fmtDur(p.duration)} 뒤 (${stamp(end)} 무렵)`,
  ];
}

// ── 명령 ────────────────────────────────────────────────────────────────────────
async function cmdCheck() {
  const k = apiKey();
  console.log("키     " + (k ? `있음 (${k.length}자)` : "없음") + "  " + (process.env.SNSSUPPORTER_API_KEY ? "(환경변수)" : envFile() || ""));
  if (!k) requireKey();
  const bal = await getBalance();
  console.log(`잔액   ${won(bal.balance)}`);
  const svc = await getService(Number(flag("service", DEFAULT_SERVICE)));
  console.log(`상품   ${svc.id} ${svc.name} [${svc.category}]`);
  console.log(`단가   1,000회 ${won(svc.rate)} (1회 ${svc.rate / 1000}원), 최소 ${num(svc.min)}, 최대 ${num(svc.max)}, 사이트 예약주문 ${svc.dripfeed ? "됨" : "안 됨"}`);
  const running = listBatches().filter((b) => !b.done && pidAlive(b.pid));
  console.log(`돌고 있는 묶음 ${running.length}개` + (running.length ? ": " + running.map((b) => b.id).join(", ") : ""));
}

async function cmdPlan() {
  const a = readPlanArgs();
  const p = await makePlan(a);
  console.log(planLines(a, p).join("\n"));
  if (p.total > p.bal.balance) console.log(`\n잔액이 ${won(p.total - p.bal.balance)} 모자란다. 충전하거나 --runs 를 줄이거나, --allow-short 로 잔액이 되는 데까지만 돌린다.`);
}

function spawnRun(id) {
  const dir = batchDir(id);
  const out = fs.openSync(path.join(dir, "run.out.txt"), "a");
  const err = fs.openSync(path.join(dir, "run.err.txt"), "a");
  const child = spawn(process.execPath, [SELF, "run", id, "--root", OPS], {
    detached: true,
    stdio: ["ignore", out, err],
    windowsHide: true,
    cwd: dir,
    env: { ...process.env, OPS_ROOT: OPS },
  });
  child.unref();
  return child.pid;
}

// ── 되살리기 (윈도우 예약 작업) ───────────────────────────────────────────────────
// 왜 있나. 260905 에 Claude 앱이 자동 업데이트로 자기를 껐는데 이 배경 프로세스가 같이 죽었다.
// 앱이 띄운 자식은 앱의 작업 개체(job object)에 묶여 있어서 detached 로 띄워도 함께 끌려간다.
// 예약 작업은 작업 스케줄러가 띄우니 그 사슬 밖이다. 5분마다 깨어나 죽은 묶음을 다시 세운다.
// 할 일이 없으면 자기 예약을 스스로 지운다. 상주하는 물건을 남기지 않는다.

const TASK_XML = () => {
  const start = new Date(Date.now() - 60000);
  const p = (n) => String(n).padStart(2, "0");
  const boundary = `${start.getFullYear()}-${p(start.getMonth() + 1)}-${p(start.getDate())}T${p(start.getHours())}:${p(start.getMinutes())}:00`;
  const user = `${process.env.USERDOMAIN || process.env.COMPUTERNAME}\\${process.env.USERNAME}`;
  const args = [
    "//B", "//Nologo",
    `"${path.join(HERE, "hidden-run.vbs")}"`,
    `"${process.execPath}"`,
    `"${SELF}"`,
    "watch",
    "--root", `"${OPS}"`,
  ].join(" ");
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>ops snsview-drip: 끊긴 조회수 분할 주문 묶음을 남은 회차부터 되살린다. 할 일이 없으면 스스로 지워진다.</Description>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <StartBoundary>${boundary}</StartBoundary>
      <Repetition><Interval>PT${WATCH_EVERY_MIN}M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>
      <Enabled>true</Enabled>
    </TimeTrigger>
    <LogonTrigger><Enabled>true</Enabled><UserId>${esc(user)}</UserId></LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author"><UserId>${esc(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>false</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec><Command>wscript.exe</Command><Arguments>${esc(args)}</Arguments></Exec>
  </Actions>
</Task>`;
};

// 예약 이름은 ops 폴더 위치로 정한다. --root 를 줬는지로 정하면 예약을 건 이름과
// 예약이 부른 쪽이 보는 이름이 어긋나서, 스스로 지우지 못한다 (예약 작업은 항상 --root 를 달고 부른다)
const taskName = () =>
  OPS === NATURAL_OPS ? TASK_NAME : TASK_NAME + "-" + createHash("sha1").update(OPS).digest("hex").slice(0, 8);

function schtasks(args, { quiet = true } = {}) {
  try {
    return { ok: true, out: execFileSync("schtasks", args, { encoding: "utf8", stdio: ["ignore", "pipe", quiet ? "pipe" : "inherit"] }) };
  } catch (e) {
    return { ok: false, out: ((e.stdout || "") + (e.stderr || "")).trim() };
  }
}

function guardInstalled() {
  return schtasks(["/Query", "/TN", taskName()]).ok;
}

function guardInstall({ log: verbose = false } = {}) {
  if (process.platform !== "win32") {
    if (verbose) console.log("되살리기 예약은 윈도우에서만 건다. 이 기계에서는 건너뛴다");
    return false;
  }
  const xml = path.join(WORK, ".watch-task.xml");
  fs.mkdirSync(WORK, { recursive: true });
  // schtasks /XML 은 UTF-16LE 만 읽는다. UTF-8 로 쓰면 "잘못된 XML" 이라고 되돌아온다
  fs.writeFileSync(xml, "﻿" + TASK_XML(), "utf16le");
  const r = schtasks(["/Create", "/TN", taskName(), "/XML", xml, "/F"]);
  if (!r.ok) {
    console.error("되살리기 예약을 못 걸었다. 묶음은 그대로 돌지만 앱이 꺼지면 멈춘다:\n  " + r.out.split("\n").slice(0, 3).join(" "));
    return false;
  }
  if (verbose) console.log(`되살리기 예약 ${taskName()} 걸었다 (${WATCH_EVERY_MIN}분마다 확인)`);
  return true;
}

function guardRemove({ log: verbose = false } = {}) {
  if (!guardInstalled()) return false;
  const r = schtasks(["/Delete", "/TN", taskName(), "/F"]);
  if (verbose) console.log(r.ok ? `되살리기 예약 ${taskName()} 지웠다` : "되살리기 예약을 못 지웠다: " + r.out.slice(0, 120));
  return r.ok;
}

// 예약 작업이 5분마다 부르는 것. 사람이 손으로 불러도 된다
function cmdWatch() {
  const pending = pendingBatches();
  if (!pending.length) {
    const removed = guardRemove();
    console.log(`${stamp()} 되살릴 묶음이 없다.` + (removed ? " 예약을 지웠다" : ""));
    return;
  }
  let revived = 0;
  for (const b of pending) {
    if (ownerAlive(b)) {
      console.log(`${stamp()} ${b.id} 는 pid ${b.pid} 가 돌리고 있다. 그대로 둔다 (${b.orders.length}/${b.runs})`);
      continue;
    }
    const pid = spawnRun(b.id);
    const s = loadState(b.id);
    s.pid = pid;
    s.heartbeatAt = Date.now();
    saveState(s);
    revived++;
    log(b.id, `되살렸다. ${b.orders.length}/${b.runs} 부터, 새 pid ${pid} (watch)`);
  }
  console.log(`${stamp()} 확인 ${pending.length}개, 되살림 ${revived}개`);
}

function cmdGuard() {
  const sub = positional[0] || "status";
  if (sub === "install") return void guardInstall({ log: true });
  if (sub === "remove") return void guardRemove({ log: true });
  const on = guardInstalled();
  console.log(`예약 이름  ${taskName()}`);
  console.log(`걸림 여부  ${on ? `걸려 있다 (${WATCH_EVERY_MIN}분마다)` : "안 걸려 있다"}`);
  if (on) {
    // 이름표(Next Run Time / 다음 실행 시간)로 찾으면 한국어 윈도우에서 안 걸린다.
    // CSV 는 열 순서가 언어와 상관없이 같아서 자리로 꺼낸다
    const q = schtasks(["/Query", "/TN", taskName(), "/FO", "CSV", "/V"]);
    const row = (q.out.split("\n")[1] || "").match(/"([^"]*)"/g)?.map((s) => s.slice(1, -1)) || [];
    if (row.length > 6) {
      console.log(`다음 실행   ${row[2]}`);
      console.log(`마지막 실행 ${row[5]} (결과 ${row[6]})`);
    }
  }
  const pending = pendingBatches();
  console.log(`되살릴 묶음 ${pending.length}개` + (pending.length ? ": " + pending.map((b) => `${b.id} ${b.orders.length}/${b.runs}${ownerAlive(b) ? " 진행" : " 끊김"}`).join(", ") : ""));
}

async function cmdStart() {
  const a = readPlanArgs();
  const p = await makePlan(a);
  const lines = planLines(a, p);
  if (p.total > p.bal.balance && !has("allow-short")) {
    console.log(lines.join("\n"));
    fail(`\n잔액이 ${won(p.total - p.bal.balance)} 모자란다. 충전하거나 --runs 를 줄인다. 잔액이 되는 데까지만 돌리려면 --allow-short 를 붙인다.`, 3);
  }
  // 같은 링크로 돌고 있는 묶음이 있으면 겹쳐 넣지 않는다
  const dup = listBatches().find((b) => !b.done && !b.stopped && b.link === a.link && pidAlive(b.pid));
  if (dup && !has("force")) fail(`같은 링크로 이미 돌고 있는 묶음이 있다: ${dup.id} (${dup.orders.length}/${dup.runs}). 겹쳐 넣으려면 --force`, 3);

  const id = newBatchId(a.link);
  const state = {
    id,
    ...a,
    serviceName: p.svc.name,
    rate: p.svc.rate,
    unitCost: p.unitCost,
    total: p.total,
    balanceAtStart: p.bal.balance,
    createdAt: stamp(),
    startedAt: null,
    nextAt: null,
    pid: null,
    orders: [],
    errors: [],
    stopped: false,
    paused: null,
    done: false,
    doneAt: null,
  };
  saveState(state);
  fs.writeFileSync(path.join(batchDir(id), "plan.txt"), lines.join("\n") + "\n", "utf8");
  console.log(lines.join("\n"));
  console.log(`\n묶음 ${id}`);
  if (has("foreground")) {
    await runLoop(id);
    return;
  }
  const pid = spawnRun(id);
  state.pid = pid;
  state.heartbeatAt = Date.now();
  saveState(state);
  guardInstall({ log: true });
  console.log(`배경에서 돈다 (pid ${pid}). 진행은 node "${SELF}" status ${id}`);
  console.log(`기록  ${path.join(batchDir(id), "log.txt")}`);
  // 첫 주문이 들어갔는지 잠깐 지켜본다. 키가 틀렸거나 API 가 막히면 여기서 바로 보인다
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const s = readJson(statePath(id));
    if (s?.orders?.length) {
      const o = s.orders[0];
      console.log(`첫 주문 들어감: 주문번호 ${o.orderId}, ${num(s.qty)}회, ${won(s.unitCost)}`);
      return;
    }
    if (s?.paused || s?.errors?.length) {
      console.log(`첫 주문에서 걸렸다: ${s.paused || s.errors.at(-1)?.msg}. 기록 파일을 본다`);
      process.exitCode = 4;
      return;
    }
  }
  console.log("20초 안에 첫 주문 기록이 안 생겼다. run.err.txt 와 log.txt 를 본다");
}

async function runLoop(id) {
  let s = loadState(id);
  if (s.done) {
    log(id, "이미 끝난 묶음이다");
    return;
  }
  if (s.pid !== process.pid && ownerAlive(s)) {
    log(id, `다른 프로세스(pid ${s.pid})가 이미 이 묶음을 돌리고 있다. 이 프로세스는 빠진다`);
    return;
  }
  s.pid = process.pid;
  s.heartbeatAt = Date.now();
  s.stopped = false;
  s.paused = null;
  if (!s.startedAt) s.startedAt = stamp();
  saveState(s);
  log(id, `시작. ${num(s.qty)}회 × ${num(s.runs)}번, ${fmtDur(s.everySec)} 간격, 이미 들어간 주문 ${s.orders.length}건, pid ${process.pid}`);

  let consecutiveErrors = 0;
  let shortWaits = 0;
  // 이어 받을 때 곧바로 넣지 않는다. 직전 주문 또는 실패한 시도에서 간격만큼 지난 뒤가 다음 회차다.
  // 실패 직후 프로세스가 다시 뜨면 직전 주문만 봐서는 곧바로 재시도해 `link_duplicate` 가 반복된다 (260905 실측)
  let next = Date.now();
  const lastAt = [s.orders.at(-1)?.at, s.errors.at(-1)?.at]
    .filter(Boolean)
    .sort((a, b) => new Date(a.replace(" ", "T")) - new Date(b.replace(" ", "T")))
    .at(-1);
  if (lastAt) {
    const due = new Date(lastAt.replace(" ", "T")).getTime() + s.everySec * 1000;
    if (Number.isFinite(due) && due > next) {
      next = due;
      log(id, `직전 시도가 ${lastAt} 이라 다음 회차는 ${stamp(new Date(next))} 부터다`);
    }
  }

  while (true) {
    // 멈춤 표식은 파일로 온다 (stop 명령)
    s = loadState(id);
    if (s.stopped) {
      s.pid = null;
      saveState(s);
      log(id, `멈춤 (stop 명령). ${s.orders.length}/${s.runs}`);
      return;
    }
    if (s.orders.length >= s.runs) {
      s.done = true;
      s.doneAt = stamp();
      s.pid = null;
      saveState(s);
      const spent = s.orders.reduce((a, o) => a + (o.charge ?? s.unitCost), 0);
      log(id, `묶음 완료. ${s.orders.length}번, 총 ${num(s.orders.length * s.qty)}회, ${won(spent)}. 마지막 주문번호 ${s.orders.at(-1)?.orderId}`);
      return;
    }

    // 회차 시각까지 기다린다. 15초마다 stop 을 보고 심장박동을 찍는다
    while (Date.now() < next) {
      s.nextAt = stamp(new Date(next));
      s.heartbeatAt = Date.now();
      saveState(s);
      await sleep(Math.min(15000, next - Date.now()));
      const fresh = readJson(statePath(id));
      if (fresh?.stopped) {
        fresh.pid = null;
        saveState(fresh);
        log(id, `멈춤 (stop 명령). ${fresh.orders.length}/${fresh.runs}`);
        return;
      }
    }

    const n = s.orders.length + 1;

    // 잔액부터 본다. 모자라면 한 회차씩 기다리며 충전을 기다린다. 12회차(기본 1시간) 지나면 접는다
    let bal;
    try {
      bal = await getBalance(id);
    } catch (e) {
      consecutiveErrors++;
      s.errors.push({ at: stamp(), n, msg: "잔액 조회 실패: " + e.message });
      saveState(s);
      log(id, `${n}/${s.runs} 잔액 조회 실패: ${e.message} (연속 ${consecutiveErrors})`);
      if (consecutiveErrors >= 5) {
        s.paused = "API 오류 반복";
        s.pid = null;
        saveState(s);
        log(id, "API 오류가 5번 연속이라 멈춘다. 원인을 보고 resume 으로 이어 간다");
        process.exitCode = 4;
        return;
      }
      next = Date.now() + Math.min(s.everySec, 120) * 1000;
      continue;
    }
    if (bal.balance < s.unitCost) {
      shortWaits++;
      s.paused = `잔액 부족 (${won(bal.balance)} < ${won(s.unitCost)})`;
      saveState(s);
      log(id, `${n}/${s.runs} 잔액 ${won(bal.balance)} 로 회당 ${won(s.unitCost)} 이 안 된다. 충전을 기다린다 (${shortWaits}/12)`);
      if (shortWaits >= 12) {
        s.pid = null;
        saveState(s);
        log(id, "잔액 부족이 12회차 이어져 멈춘다. 충전한 뒤 resume 으로 이어 간다");
        process.exitCode = 3;
        return;
      }
      next = Date.now() + s.everySec * 1000;
      continue;
    }
    shortWaits = 0;
    s.paused = null;

    // 주문
    const scheduledAt = next;
    try {
      const orderId = await addOrder(s.service, s.link, s.qty, id);
      consecutiveErrors = 0;
      s = loadState(id);
      s.orders.push({ n, orderId, at: stamp(), balanceBefore: bal.balance, charge: s.unitCost });
      s.lastOrderAt = stamp();
      saveState(s);
      log(id, `${n}/${s.runs} 주문번호 ${orderId}, ${num(s.qty)}회, ${won(s.unitCost)}, 잔액 ${won(bal.balance)} → ${won(bal.balance - s.unitCost)}`);
    } catch (e) {
      consecutiveErrors++;
      s.errors.push({ at: stamp(), n, msg: e.message });
      saveState(s);
      log(id, `${n}/${s.runs} 주문 실패: ${e.message} (연속 ${consecutiveErrors})`);
      if (consecutiveErrors >= 5) {
        s.paused = "주문 오류 반복: " + e.message;
        s.pid = null;
        saveState(s);
        log(id, "주문 오류가 5번 연속이라 멈춘다. 원인을 보고 resume 으로 이어 간다");
        process.exitCode = 4;
        return;
      }
      // 시간 초과였으면 서버에는 들어갔을 수 있다. 다음 회차 간격만큼 기다렸다가 간다. 곧바로 다시 넣지 않는다
      next = Date.now() + s.everySec * 1000;
      continue;
    }

    // 다음 회차. 지난 회차의 예정 시각 기준으로 간격을 더해 밀림이 쌓이지 않게 한다
    let gap = s.everySec;
    if (s.jitter) gap = gap * (1 + (Math.random() * 2 - 1) * s.jitter);
    next = Math.max(scheduledAt + gap * 1000, Date.now() + 1000);
  }
}

async function cmdStatus() {
  const id = positional[0] || listBatches().at(-1)?.id;
  if (!id) fail("묶음이 없다. node snsview-drip.mjs start 로 만든다");
  const s = loadState(id);
  const alive = pidAlive(s.pid);
  const spent = s.orders.reduce((a, o) => a + (o.charge ?? s.unitCost), 0);
  console.log(`묶음   ${s.id}`);
  console.log(`대상   ${s.link}`);
  console.log(`설정   ${num(s.qty)}회 × ${num(s.runs)}번, ${fmtDur(s.everySec)} 간격, 상품 ${s.service} ${s.serviceName}`);
  console.log(`진행   ${s.orders.length}/${s.runs} 주문, ${num(s.orders.length * s.qty)}회, ${won(spent)} 씀`);
  console.log(
    `상태   ` +
      (s.done
        ? `완료 (${s.doneAt})`
        : s.stopped
          ? "멈춤 (stop)"
          : s.paused
            ? `멈춤: ${s.paused}` + (alive ? " (대기 중)" : " (프로세스 없음, resume 으로 이어 간다)")
            : alive
              ? `돌고 있음 (pid ${s.pid}), 다음 회차 ${s.nextAt || "곧"}`
              : "프로세스가 없다. resume 으로 이어 간다")
  );
  if (s.errors.length) console.log(`오류   ${s.errors.length}건, 마지막: ${s.errors.at(-1).at} ${s.errors.at(-1).msg}`);
  if (s.orders.length) {
    const first = s.orders[0];
    const last = s.orders.at(-1);
    console.log(`주문   첫 ${first.at} #${first.orderId} … 마지막 ${last.at} #${last.orderId}`);
  }
  if (has("api") && s.orders.length) {
    const ids = s.orders.map((o) => o.orderId);
    const st = await getStatuses(ids, id);
    const byStatus = {};
    let charged = 0;
    for (const oid of ids) {
      const r = st[oid] || {};
      byStatus[r.status || r.error || "?"] = (byStatus[r.status || r.error || "?"] || 0) + 1;
      charged += Number(r.charge || 0);
    }
    console.log(`서버   ` + Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join(", ") + `, 청구 합계 ${won(charged)}`);
    try {
      const bal = await getBalance(id);
      console.log(`잔액   ${won(bal.balance)}`);
    } catch {}
  }
  console.log(`기록   ${path.join(batchDir(id), "log.txt")}`);
}

function cmdStop() {
  const id = positional[0];
  if (!id) fail("멈출 묶음 id 가 필요하다. 목록은 list");
  const s = loadState(id);
  if (s.done) return console.log("이미 끝난 묶음이다");
  s.stopped = true;
  saveState(s);
  console.log(`${id} 에 멈춤 표식을 적었다. 돌고 있으면 15초 안에 멈춘다. (${s.orders.length}/${s.runs})`);
}

async function cmdResume() {
  const id = positional[0];
  if (!id) fail("이어 갈 묶음 id 가 필요하다. 목록은 list");
  const s = loadState(id);
  if (s.done) return console.log("이미 끝난 묶음이다");
  if (pidAlive(s.pid)) return console.log(`이미 돌고 있다 (pid ${s.pid})`);
  s.stopped = false;
  s.paused = null;
  saveState(s);
  if (has("foreground")) return runLoop(id);
  const pid = spawnRun(id);
  s.pid = pid;
  s.heartbeatAt = Date.now();
  saveState(s);
  guardInstall({ log: true });
  console.log(`${id} 를 이어서 돌린다 (pid ${pid}). ${s.orders.length}/${s.runs} 부터`);
}

function cmdList() {
  const all = listBatches();
  if (!all.length) return console.log("묶음이 없다");
  for (const b of all) {
    const st = b.done ? "완료" : b.stopped ? "멈춤" : b.paused ? "멈춤(" + b.paused + ")" : pidAlive(b.pid) ? "진행" : "끊김";
    console.log(`${b.id}  ${st}  ${b.orders.length}/${b.runs} × ${num(b.qty)}회  ${b.link}`);
  }
}

function help() {
  const lines = [];
  for (const l of fs.readFileSync(SELF, "utf8").split("\n").slice(1)) {
    if (!l.startsWith("//")) break;
    lines.push(l.replace(/^\/\/ ?/, ""));
  }
  console.log(lines.join("\n"));
}

const commands = { check: cmdCheck, plan: cmdPlan, start: cmdStart, run: () => runLoop(positional[0] || fail("run 에는 묶음 id 가 필요하다")), status: cmdStatus, stop: cmdStop, resume: cmdResume, list: cmdList, watch: cmdWatch, guard: cmdGuard, help };
if (!commands[cmd]) {
  help();
  process.exitCode = 2;
} else {
  try {
    await commands[cmd]();
  } catch (e) {
    if (e instanceof ExitError) process.exitCode = e.code;
    else {
      console.error(e.message || e);
      process.exitCode = 1;
    }
  }
}
