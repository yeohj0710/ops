import fs from 'node:fs/promises';
import {createReadStream, openSync, closeSync} from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const read = async (p, fallback) => {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
};
const alive = pid => {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
};
async function atomic(p, value) {
  const temp = p + '.' + process.pid + '.tmp';
  await fs.writeFile(temp, JSON.stringify(value, null, 2));
  await fs.rename(temp, p);
}
async function sha256(p) {
  const h = createHash('sha256');
  for await (const b of createReadStream(p)) h.update(b);
  return h.digest('hex');
}

// A moved root may be remapped only through a recorded root, never a basename guess.
export function relocated(recordedPath, recordedRoots, currentRoot) {
  const src = path.win32.normalize(recordedPath);
  const choices = recordedRoots.map(r => path.win32.normalize(r)).filter(r => {
    const relative = path.win32.relative(r, src);
    return relative && !relative.startsWith('..') && !path.win32.isAbsolute(relative);
  });
  if (choices.length !== 1) throw Error('기록 경로의 기준 폴더가 하나가 아닙니다: ' + recordedPath);
  return path.resolve(currentRoot, ...path.win32.relative(choices[0], src).split('\\'));
}

async function check(root) {
  const replacement = path.join(root, 'etc/capcut-replacement');
  const state = await read(path.join(replacement, 'state.json'), null);
  const plan = await read(path.join(replacement, 'plan.json'), null);
  const work = path.join(root, 'etc/capcut-retouch');
  const history = await read(path.join(work, 'state.json'), {});
  const sources = await read(path.join(work, 'sources.json'), []);
  const result = {checkedAt: new Date().toISOString(), root, replacements: [], originalBackups: [],
    recordedExports: history.desktop?.completed?.length || 0,
    recordedExclusions: history.desktop?.excluded?.length || 0,
    backgroundRetouchVerified: false, retouchNeedsDesktop: true};
  const cached = new Map();
  async function digest(file) {
    if (!cached.has(file)) cached.set(file, sha256(file).catch(e => {
      if (e.code === 'ENOENT') return null;
      throw e;
    }));
    return cached.get(file);
  }
  async function matches(file, expected) {
    if (!/^[a-f0-9]{64}$/i.test(expected || '')) return false;
    return (await digest(file))?.toLowerCase() === expected.toLowerCase();
  }
  let candidates;
  async function resolveOutput(recorded, expected) {
    const current = await digest(recorded);
    if (current !== null) return {file:recorded, status:current === expected ? 'matched' : 'hash-mismatch'};
    // 이름은 후보를 좁히는 데만 쓴다. 해시가 같은 단일 파일만 이동된 결과로 인정한다.
    if (!candidates) {
      candidates = new Map();
      async function index(dir) {
        for (const entry of await fs.readdir(dir, {withFileTypes:true})) {
          if (entry.isSymbolicLink() || entry.name.toLowerCase() === 'etc') continue;
          const file = path.join(dir, entry.name);
          if (entry.isDirectory()) await index(file);
          else if (entry.isFile()) {
            const name = entry.name.toLowerCase();
            if (!candidates.has(name)) candidates.set(name, []);
            candidates.get(name).push(file);
          }
        }
      }
      await index(root);
    }
    const found = [];
    for (const file of candidates.get(path.basename(recorded).toLowerCase()) || []) {
      if (await matches(file, expected)) found.push(file);
    }
    return found.length === 1 ? {file:found[0], status:'moved-hash-matched'}
      : {file:recorded, status:found.length ? 'ambiguous-moved-copies' : 'missing',
        candidates:found.map(file=>path.relative(root,file))};
  }
  if (state) {
    if (!plan?.roots?.length || !Array.isArray(plan.items) || !Array.isArray(state.items) || !state.items.length) {
      throw Error('교체 기록에 대상 목록이나 기준 폴더가 없습니다.');
    }
    const expectedTargets = new Set(plan.items.map(x=>path.win32.normalize(x.target).toLowerCase()));
    if (expectedTargets.size !== state.items.length || state.items.some(x=>!expectedTargets.has(path.win32.normalize(x.target).toLowerCase()))) {
      throw Error('교체 계획과 상태 기록의 대상 목록이 다릅니다.');
    }
    const seen = new Set();
    for (const item of state.items) {
      const target = relocated(item.target, plan.roots, root);
      const backup = relocated(item.backup, plan.roots, root);
      if (seen.has(target)) throw Error('교체 기록의 경로가 중복됩니다: ' + target);
      seen.add(target);
      const output = await resolveOutput(target, item.outputHash);
      result.replacements.push({target: path.relative(root, output.file), recordedTarget:path.relative(root,target),
        outputStatus:output.status, candidates:output.candidates, backup: path.relative(root, backup),
        kind: item.kind, completed: item.status === 'completed',
        outputMatches: ['matched','moved-hash-matched'].includes(output.status),
        backupMatches: await matches(backup, item.originalHash || item.originalSha256)});
    }
  }
  for (const source of sources) {
    const backup = source.backup && path.resolve(work, source.backup);
    const rel = backup && path.relative(work, backup);
    if (!backup || rel.startsWith('..') || path.isAbsolute(rel)) {
      result.originalBackups.push({source: source.relative, backupMatches: false});
      continue;
    }
    result.originalBackups.push({source: source.relative, backupMatches: await matches(backup, source.sha256)});
  }
  result.passed = (!state || state.status === 'completed') && result.replacements.every(x => x.completed && x.outputMatches && x.backupMatches)
    && result.originalBackups.every(x => x.backupMatches);
  result.replacementCount = result.replacements.length;
  result.originalBackupCount = result.originalBackups.length;
  result.scope = '교체 파일과 백업의 SHA-256 대조. 얼굴 보정·전체 디코딩 검수는 별도 단계.';
  result.nextAction = !result.passed ? '불일치 파일 확인. 재보정·교체 금지.'
    : state ? '검증한 교체 파일은 재보정 제외. 새 영상만 매뉴얼에 따라 처리.'
    : '매뉴얼에 따라 입력 영상을 준비하고 화면 사용 가능 시간에 Retouch 실행.';
  return result;
}

async function main() {
  const [command, input, stage = 'check', ...extra] = process.argv.slice(2);
  if (!['start', 'status', 'worker'].includes(command) || !input || !path.isAbsolute(input)) {
    throw Error('사용법: node background.mjs start|status "<입력 절대경로>" [check|prepare] [영상 파일명]');
  }
  const root = await fs.realpath(input);
  if (!(await fs.stat(root)).isDirectory()) throw Error('입력은 폴더여야 합니다.');
  const dir = path.join(root, 'etc/capcut-retouch/background');
  const stateFile = path.join(dir, 'state.json'), lockFile = path.join(dir, 'lock.json');
  const state = await read(stateFile, null), lock = await read(lockFile, null);
  if (command === 'status') {
    console.log(JSON.stringify({state, runnerAlive: alive(lock?.pid)}, null, 2));
    return;
  }
  if (!['check', 'prepare'].includes(stage)) throw Error('지원 단계는 check와 prepare입니다. 보정·렌더링은 실행하지 않습니다.');
  await fs.mkdir(dir, {recursive: true});
  if (command === 'start') {
    if (lock) {
      const launching = lock.phase === 'launching' && Date.now() - Date.parse(lock.createdAt) < 60000;
      if (alive(lock.pid) || alive(lock.childPid) || launching) {
        console.log(JSON.stringify({status: 'already-running', pid: lock.pid, stateFile}));
        return;
      }
      await fs.mkdir(path.join(dir, 'backup'), {recursive: true});
      await atomic(path.join(dir, 'backup/stale-lock.json'), lock);
      await fs.unlink(lockFile);
    }
    const token = randomUUID();
    const lease = await fs.open(lockFile, 'wx');
    await lease.writeFile(JSON.stringify({token, pid: process.pid, phase: 'launching', createdAt: new Date().toISOString()}));
    await lease.close();
    if (state) {
      await fs.mkdir(path.join(dir, 'backup'), {recursive: true});
      await atomic(path.join(dir, 'backup/previous-state.json'), state);
    }
    const previousReport = await read(path.join(dir, 'report.json'), null);
    if (previousReport) {
      await fs.mkdir(path.join(dir, 'backup'), {recursive:true});
      await atomic(path.join(dir, 'backup/previous-report.json'), previousReport);
    }
    const log = openSync(path.join(dir, 'runner.log'), 'a');
    try {
      const child = spawn(process.execPath, [SELF, 'worker', root, stage, token, ...extra],
        {detached: true, windowsHide: true, stdio: ['ignore', log, log]});
      await new Promise((resolve, reject) => {child.once('spawn', resolve); child.once('error', reject);});
      child.unref();
      console.log(JSON.stringify({status: 'started', pid: child.pid, stage, stateFile, backgroundRetouch: false}));
    } catch (e) {
      if ((await read(lockFile, {})).token === token) await fs.unlink(lockFile);
      throw e;
    } finally {closeSync(log);}
    return;
  }
  const [token, ...files] = extra;
  if (!token || lock?.token !== token) throw Error('백그라운드 실행 잠금이 일치하지 않습니다.');
  await atomic(lockFile, {...lock, pid: process.pid, phase: 'running'});
  const job = {status: 'running', pid: process.pid, stage, root, startedAt: new Date().toISOString(),
    next_check_at: new Date(Date.now()+15*60*1000).toISOString(), backgroundRetouch: false};
  try {
    await atomic(stateFile, job);
    if (stage === 'check') {
      const report = await check(root);
      await atomic(path.join(dir, 'report.json'), report);
      Object.assign(job, {status: report.passed ? 'completed' : 'needs-review', report: path.join(dir, 'report.json'),
        replacements: report.replacementCount, originalBackups: report.originalBackupCount, nextAction: report.nextAction});
    } else {
      const child = spawn(process.execPath, [path.join(path.dirname(SELF), 'prepare.mjs'), root, ...files],
        {windowsHide: true, stdio: ['ignore', 'inherit', 'inherit']});
      if(child.pid)await atomic(lockFile, {...lock, pid: process.pid, childPid: child.pid, phase: 'running'});
      await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolve() : reject(Error('준비 단계 종료 코드: ' + code)));
      });
      Object.assign(job, {status: 'ready-for-desktop', nextAction: '백업 준비 완료. Retouch와 내보내기에는 화면 조작이 필요합니다.'});
    }
  } catch (e) {job.status = 'failed'; job.error = e.message;}
  finally {
    job.finishedAt = new Date().toISOString();
    job.next_check_at = null;
    await atomic(stateFile, job);
    if ((await read(lockFile, {})).token === token) await fs.unlink(lockFile);
  }
  console.log(JSON.stringify(job));
}
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  main().catch(e => {console.error(e.message); process.exitCode = 1;});
}
