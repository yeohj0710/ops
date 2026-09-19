import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
if(!process.argv[2]||!path.isAbsolute(process.argv[2]))throw Error('절대경로 입력 폴더가 필요합니다.');
const root=await fs.realpath(process.argv[2]),work=path.join(root,'etc/capcut-retouch');
const records=JSON.parse(await fs.readFile(path.join(work,'sources.json'),'utf8'));
const hash=async p=>{const h=createHash('sha256');for await(const b of createReadStream(p))h.update(b);return h.digest('hex');};
const results=[];
for(const r of records){const source=path.resolve(root,r.relative);if(!source.startsWith(root+path.sep))throw Error('원본 경로가 입력 폴더를 벗어납니다.');const sourceOk=await hash(source)===r.sha256;const backupOk=r.backup?await hash(path.join(work,r.backup))===r.sha256:null;results.push({relative:r.relative,sourceOk,backupOk});}
await fs.writeFile(path.join(work,'integrity.json'),JSON.stringify({checkedAt:new Date().toISOString(),results},null,2));
console.log(JSON.stringify({sources:results.length,unchanged:results.filter(x=>x.sourceOk).length,verifiedBackups:results.filter(x=>x.backupOk).length}));
if(results.some(x=>!x.sourceOk||x.backupOk===false))process.exitCode=1;
