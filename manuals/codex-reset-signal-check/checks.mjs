#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const manual = await readFile(join(here, 'MANUAL.md'), 'utf8');

const required = [
  '- **부르는 말**:',
  '- **미리 허가**:',
  '- **런너**:',
  '- **제어층**:',
  '- **한 번에 걸리는 시간**:',
  'https://x.com/thsottiaux',
  'how-banked-codex-resets-work',
  '근거 점수',
  '발생 확률',
];

for (const text of required) {
  if (!manual.includes(text)) throw new Error(`MANUAL.md 필수 내용 누락: ${text}`);
}

if (/C:[\\/](?:dev|Users)/i.test(manual)) {
  throw new Error('MANUAL.md에 기계별 절대경로가 들어 있다');
}

const test = spawnSync(process.execPath, [join(here, 'scripts', 'check-signals.mjs'), '--self-test'], {
  encoding: 'utf8',
});
process.stdout.write(test.stdout);
process.stderr.write(test.stderr);
if (test.status !== 0) process.exit(test.status || 1);

console.log('PASS — Codex 초기화 조짐 확인 매뉴얼');
