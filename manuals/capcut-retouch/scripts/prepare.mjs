import fs from 'node:fs/promises';
import {createReadStream, constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
if(!process.argv[2] || !path.isAbsolute(process.argv[2])) throw Error('절대경로 입력 폴더가 필요합니다.');
const root=await fs.realpath(process.argv[2]);
const work=path.join(root,'etc/capcut-retouch');
await fs.mkdir(work,{recursive:true});
const hash=async p=>{const h=createHash('sha256');for await(const b of createReadStream(p))h.update(b);return h.digest('hex');};
const walk=async d=>{let out=[];for(const e of await fs.readdir(d,{withFileTypes:true})){if(e.name==='etc')continue;const p=path.join(d,e.name);if(e.isDirectory())out.push(...await walk(p));else if(/\.mov$/i.test(e.name))out.push(p);}return out;};
const ledgerPath=path.join(work,'sources.json');
let ledger=JSON.parse(await fs.readFile(ledgerPath,'utf8').catch(()=>'[]'));
const args=process.argv.slice(3),projectNames=[];
const sampleArgs=[];for(let i=0;i<args.length;i++){if(args[i]==='--project'){const name=args[++i];if(!name||/[\\/]/.test(name)||name==='..')throw Error('프로젝트 이름을 확인하세요.');projectNames.push(name);}else sampleArgs.push(args[i]);}
const samples=new Set(sampleArgs);const backupAll=samples.size===0;
for(const source of await walk(root)){
 const rel=path.relative(root,source),stat=await fs.stat(source);
 let item=ledger.find(x=>x.relative===rel);
 if(item){if(item.bytes!==stat.size||item.mtimeMs!==stat.mtimeMs)throw Error('Source changed: '+rel);if((!backupAll&&!samples.has(path.basename(source)))||item.backup)continue;}
 const sha256=await hash(source);
 const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',source],{encoding:'utf8',windowsHide:true,maxBuffer:4000000}));
 item={relative:rel,bytes:stat.size,mtimeMs:stat.mtimeMs,sha256,probe,backup:null,retouchStatus:'not-started'};
 if(backupAll||samples.has(path.basename(source))){
  const backup=path.join(work,'backup','sources',rel);await fs.mkdir(path.dirname(backup),{recursive:true});
  try{await fs.copyFile(source,backup,constants.COPYFILE_EXCL);}catch(e){if(e.code!=='EEXIST')throw e;}
  if(await hash(backup)!==sha256)throw Error('Backup hash mismatch: '+rel);
  item.backup=path.relative(work,backup);
  const frames=path.join(work,'frames');await fs.mkdir(frames,{recursive:true});
  for(const second of [2,6]){
   const dest=path.join(frames,path.parse(source).name+'-'+second+'.jpg');
   try{await fs.access(dest);}catch{execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-n','-ss',String(second),'-i',backup,'-frames:v','1','-vf','scale=540:-2','-q:v','3',dest],{windowsHide:true,stdio:'pipe'});}
  }
 }
 const prior=ledger.findIndex(x=>x.relative===rel);if(prior>=0)ledger[prior]=item;else ledger.push(item);await fs.writeFile(ledgerPath,JSON.stringify(ledger,null,2));
}
if(projectNames.length&&!process.env.LOCALAPPDATA)throw Error('프로젝트 백업에는 LOCALAPPDATA 경로가 필요합니다.');
const projects=projectNames.length?path.join(process.env.LOCALAPPDATA,'CapCut/User Data/Projects/com.lveditor.draft'):null;
const projectBackup=path.join(work,'backup','capcut-projects');
await fs.mkdir(projectBackup,{recursive:true});
const projectManifest=[];
async function backupTree(src,dest){for(const e of await fs.readdir(src,{withFileTypes:true})){const a=path.join(src,e.name),b=path.join(dest,e.name);if(e.isDirectory()){await fs.mkdir(b,{recursive:true});await backupTree(a,b);}else{const sha256=await hash(a);try{await fs.copyFile(a,b,constants.COPYFILE_EXCL);}catch(e){if(e.code!=='EEXIST')throw e;}if(await hash(b)!==sha256)throw Error('Project backup differs: '+a);projectManifest.push({relative:path.relative(projects,a),sha256});}}}
for(const name of projectNames){await fs.mkdir(path.join(projectBackup,name),{recursive:true});await backupTree(path.join(projects,name),path.join(projectBackup,name));}
const index=projects?path.join(projects,'root_meta_info.json'):null;if(projectNames.length)try{await fs.copyFile(index,path.join(projectBackup,'root_meta_info.json'),constants.COPYFILE_EXCL);}catch(e){if(e.code!=='EEXIST')throw e;}
if(projectNames.length)await fs.writeFile(path.join(work,'project-backup.json'),JSON.stringify(projectManifest,null,2));
console.log(JSON.stringify({sources:ledger.length,bytes:ledger.reduce((s,x)=>s+x.bytes,0),sampleBackups:ledger.filter(x=>x.backup).length,projectFiles:projectManifest.length,retouched:0}));
