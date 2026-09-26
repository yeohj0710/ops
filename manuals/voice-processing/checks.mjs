import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const task = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const { config, job } = task.input ?? {};
if (![config, job].every(v => typeof v === 'string' && path.isAbsolute(v))) {
  throw new Error('input.config와 input.job에 절대경로가 필요합니다.');
}
const runtime = JSON.parse(fs.readFileSync(config, 'utf8'));
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'scripts', 'voice_jobs.py');
const result = spawnSync(runtime.python, [script, '--config', config, 'check', job], { stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
