import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {relocated} from './background.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const base = path.resolve(here, '../../../../etc/capcut-background/tests');
await fs.mkdir(base, {recursive: true});
const root = await fs.mkdtemp(path.join(base, 'case-'));
const work = path.join(root, 'etc/capcut-retouch/background');
const replacement = path.join(root, 'etc/capcut-replacement');
const hash = text => createHash('sha256').update(text).digest('hex');
const json = async (p, value) => {await fs.mkdir(path.dirname(p), {recursive:true}); await fs.writeFile(p, JSON.stringify(value));};
const run = (...args) => execFileSync(process.execPath, [path.join(here, 'background.mjs'), ...args], {encoding:'utf8', windowsHide:true});
const read = async name => JSON.parse(await fs.readFile(path.join(work, name), 'utf8'));
let passed = 0;
async function worker() {
  await json(path.join(work, 'lock.json'), {pid:process.pid, token:'test-token'});
  run('worker', root, 'check', 'test-token');
  return read('state.json');
}
try {
  assert.equal(relocated('G:/old/source/a.mov', ['G:/old'], root), path.join(root,'source/a.mov'));
  assert.throws(() => relocated('G:/elsewhere/a.mov', ['G:/old'], root));
  assert.throws(() => relocated('G:/old/source/a.mov', ['G:/old','G:/old/source'], root));
  passed++;

  await fs.mkdir(path.join(root,'source'), {recursive:true});
  await fs.writeFile(path.join(root,'source/a.mov'), 'retouched');
  await fs.mkdir(path.join(replacement,'backup'), {recursive:true});
  await fs.writeFile(path.join(replacement,'backup/a.mov'), 'original');
  await json(path.join(replacement,'plan.json'), {roots:['G:/old'],items:[{target:'G:/old/source/a.mov'}]});
  const ledger = {status:'completed', items:[{target:'G:/old/source/a.mov', backup:'G:/old/etc/capcut-replacement/backup/a.mov',
    kind:'full',status:'completed',outputHash:hash('retouched'),originalHash:hash('original')}]};
  await json(path.join(replacement,'state.json'), ledger);
  assert.equal((await worker()).status, 'completed');
  assert.equal((await read('report.json')).replacements[0].outputMatches, true);
  assert.equal((await read('report.json')).backgroundRetouchVerified, false);
  passed++;

  await fs.writeFile(path.join(root,'source/a.mov'), 'changed');
  assert.equal((await worker()).status, 'needs-review');
  assert.equal((await read('report.json')).replacements[0].outputMatches, false);
  assert.equal((await read('report.json')).replacements[0].outputStatus, 'hash-mismatch');
  assert.equal(await fs.readFile(path.join(replacement,'backup/a.mov'),'utf8'), 'original');
  passed++;

  await fs.mkdir(path.join(root,'moved'), {recursive:true});
  await fs.rename(path.join(root,'source/a.mov'), path.join(root,'moved/a.mov'));
  await fs.writeFile(path.join(root,'moved/a.mov'), 'retouched');
  assert.equal((await worker()).status, 'completed');
  assert.equal((await read('report.json')).replacements[0].outputStatus, 'moved-hash-matched');
  assert.equal((await read('report.json')).replacements[0].target, path.join('moved','a.mov'));
  await fs.mkdir(path.join(root,'copy'), {recursive:true});
  await fs.copyFile(path.join(root,'moved/a.mov'),path.join(root,'copy/a.mov'));
  assert.equal((await worker()).status, 'needs-review');
  assert.equal((await read('report.json')).replacements[0].outputStatus, 'ambiguous-moved-copies');
  await fs.unlink(path.join(root,'copy/a.mov'));
  await fs.writeFile(path.join(root,'moved/a.mov'), 'different');
  assert.equal((await worker()).status, 'needs-review');
  assert.equal((await read('report.json')).replacements[0].outputStatus, 'missing');
  passed++;

  ledger.items[0].target = 'G:/outside/a.mov';
  await json(path.join(replacement,'state.json'), ledger);
  assert.equal((await worker()).status, 'failed');
  passed++;

  await json(path.join(work,'lock.json'), {pid:process.pid,token:'live-owner'});
  assert.equal(JSON.parse(run('start',root,'check')).status, 'already-running');
  assert.equal((await read('lock.json')).token, 'live-owner');
  assert.throws(() => run('start',root,'retouch'));
  passed++;

  assert.throws(() => execFileSync(process.execPath,[path.join(here,'prepare.mjs'),root],{windowsHide:true,stdio:'pipe'}), /보정본 교체 기록/);
  assert.equal(await fs.readFile(path.join(replacement,'backup/a.mov'),'utf8'), 'original');
  passed++;
  console.log(JSON.stringify({passed, failed:0}));
} finally {
  const resolved = path.resolve(root);
  if (!resolved.startsWith(path.resolve(base)+path.sep)) throw Error('테스트 정리 경로가 범위를 벗어났습니다.');
  await fs.rm(resolved,{recursive:true,force:true});
}
