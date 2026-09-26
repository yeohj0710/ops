#!/usr/bin/env node
import path from 'node:path';
import { read, need, json } from './scripts/io.mjs';
import { loadConfig } from './scripts/data.mjs';
import { checkRun, parseArgs } from './scripts/pipeline.mjs';

try {
  const arg=process.argv[2]||process.env.OPS_TASK;
  let config,run;
  if(arg&&!arg.startsWith('--')) {
    const task=read(arg),input=task.inputs||task.input||{};
    config=input.config;run=input.runDir||input['run-dir'];
  } else {const a=parseArgs(['check',...process.argv.slice(2)]);config=a.config;run=a['run-dir'];}
  need(config&&run,'CHECK_CONFIG','task.inputs.config와 task.inputs.runDir 또는 --config와 --run-dir이 필요합니다.');
  console.log(json(checkRun(loadConfig(path.resolve(config)),path.resolve(run))));
}catch(e){console.error(json({ok:false,error:{code:e.code||'UNEXPECTED',message:e.message}}));process.exitCode=1;}
