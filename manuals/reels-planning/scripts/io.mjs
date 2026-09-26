import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const CODE_ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 드라이브에 복사한 매뉴얼은 저장소가 아니다. 존재하는 .git 경계만 저장소로 취급한다.
function repositoryRoot(start) {
  let cursor=start;
  while(true) {
    if(fs.existsSync(path.join(cursor,'.git')))return cursor;
    const parent=path.dirname(cursor);if(parent===cursor)return null;cursor=parent;
  }
}
export const REPO = repositoryRoot(CODE_ROOT);
export const STATUS = '작성 완료(검토 대기)';
export function fail(code, message) { throw Object.assign(new Error(message), { code }); }
export function need(ok, code, message) { if (!ok) fail(code, message); }
export const nonempty = x => typeof x === 'string' && x.trim().length > 0;
export const list = x => Array.isArray(x) ? x : [];
export function canonical(x) {
  if (Array.isArray(x)) return x.map(canonical);
  if (x && typeof x === 'object') return Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])]));
  return x;
}
export const hash = x => createHash('sha256').update(typeof x === 'string' || Buffer.isBuffer(x) ? x : JSON.stringify(canonical(x))).digest('hex');
export const json = x => JSON.stringify(x, null, 2) + '\n';
export const read = f => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
export const fileHash = f => hash(fs.readFileSync(f));
export const inside = (parent, child) => { const r = path.relative(parent, child); return !r || (!r.startsWith('..' + path.sep) && r !== '..' && !path.isAbsolute(r)); };
export function realDestination(p) {
  const absolute = path.resolve(p); let ancestor = absolute;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  return path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, absolute));
}
export function outsideRepo(p) {
  need(!inside(fs.realpathSync(REPO||CODE_ROOT), realDestination(p)), 'PRIVATE_RUNTIME', '설정과 실행 자료는 공개 저장소 또는 매뉴얼 코드 폴더 밖에 둡니다.');
  return path.resolve(p);
}
export function secureFile(run, relative) {
  const root = realDestination(run), target = realDestination(path.resolve(run, relative));
  need(inside(root, target) && root !== target, 'PATH_ESCAPE', '실행 폴더 밖에는 쓸 수 없습니다.');
  return target;
}
// 기존 파일은 내용 해시별로 보존한다. 같은 결과를 다시 쓰면 파일 시각도 바뀌지 않는다.
export function save(run, relative, data, dryRun = false) {
  const target = secureFile(run, relative);
  const bytes = typeof data === 'string' ? data : json(data);
  const old = fs.existsSync(target) ? fs.readFileSync(target) : null;
  if (old && old.equals(Buffer.from(bytes))) return false;
  if (dryRun) return true;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (old) {
    const backup = secureFile(run, path.join('etc', 'backup', relative + '.' + hash(old) + '.bak'));
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, old, { flag: 'wx' });
  }
  const temp = target + `.tmp-${process.pid}`;
  try { fs.writeFileSync(temp, bytes, { flag: 'wx' }); fs.renameSync(temp, target); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  return true;
}
export function locked(run, dryRun, fn) {
  outsideRepo(run);
  if (dryRun) return fn();
  fs.mkdirSync(run, { recursive: true });
  const lock = secureFile(run, 'etc/pipeline.lock'); fs.mkdirSync(path.dirname(lock), { recursive: true });
  let fd;
  try { fd = fs.openSync(lock, 'wx'); }
  catch (e) { if (e.code === 'EEXIST') fail('RUN_LOCKED', '다른 실행 또는 중단된 잠금이 있습니다. PID를 확인한 뒤 잠금을 복구하세요.'); throw e; }
  fs.writeFileSync(fd, json({ pid: process.pid }));
  try { return fn(); } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
export function loadLedger(run) {
  const f = path.join(run, 'ledger.json');
  const ledger = fs.existsSync(f) ? read(f) : { version: 1, items: {} };
  need(ledger.version === 1 && ledger.items && !Array.isArray(ledger.items), 'LEDGER_INVALID', '원장 형식이 잘못됐습니다. 초기화하지 말고 복구하세요.');
  return ledger;
}
export function checkpoint(run, ledger, id, update, dryRun = false) {
  const previous = ledger.items[id] || {};
  need(previous.stage !== 'complete' || update.stage === 'complete', 'COMPLETE_IMMUTABLE', '완료한 항목은 새 실행 폴더에서 수정하세요.');
  ledger.items[id] = { ...previous, ...update };
  save(run, 'ledger.json', ledger, dryRun);
}
export function httpUrl(x) { try { const u = new URL(x); return u.protocol === 'https:' && !u.username && !u.password; } catch { return false; } }
export function dateValue(x) { const n = Date.parse(x); return Number.isFinite(n) ? n : NaN; }
export function parseCsv(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') { if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else if (quoted || !cell) quoted = !quoted; else cell += ch; }
    else if (!quoted && (ch === ',' || ch === '\n' || ch === '\r')) {
      row.push(cell); cell = '';
      if (ch !== ',') { rows.push(row); row = []; if (ch === '\r' && text[i + 1] === '\n') i++; }
    } else cell += ch;
  }
  need(!quoted, 'CSV_QUOTE', 'CSV 따옴표가 닫히지 않았습니다.');
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const headers = rows.shift() || [];
  return rows.filter(r => r.some(Boolean)).map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
}
