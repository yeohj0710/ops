import fs from 'node:fs';
import path from 'node:path';
import {verify} from './verify.mjs';
const task=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
if(!task.snsState || !path.isAbsolute(task.snsState)) throw Error('태스크 snsState에 실행 기록의 절대 경로를 넣으세요.');
console.log(verify(JSON.parse(fs.readFileSync(task.snsState,'utf8'))));
