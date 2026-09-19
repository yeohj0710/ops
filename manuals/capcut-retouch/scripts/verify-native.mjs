import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);
const root=path.resolve(process.argv[2]);
const work=path.join(root,'etc/capcut-retouch');
const sources=JSON.parse(await fs.readFile(path.join(work,'sources.json'),'utf8'));
const selected=new Set(process.argv.slice(3)); const outputs=(await fs.readdir(path.join(root,'보정 완료'))).filter(n=>!selected.size||selected.has(n.replace('_보정.mp4','')));
const results=[];
for(const name of outputs.filter(n=>/^IMG_\d+_보정\.mp4$/.test(n))){
 const src=sources.find(s=>path.basename(s.relative)===name.replace('_보정.mp4','.MOV'));
 if(!src)continue;
 const output=path.join(root,'보정 완료',name);
 try{
  const p=JSON.parse((await run('ffprobe',['-v','error','-show_streams','-show_format','-of','json',output],{maxBuffer:8000000})).stdout);
  const v=p.streams.find(s=>s.codec_type==='video');
  const a=p.streams.find(s=>s.codec_type==='audio');
  const original=src.probe.streams.find(s=>s.codec_type==='video');
  const duration=Number(src.probe.format.duration); const rate=x=>{const [n,d]=x.split('/').map(Number);return n/d;}; const expectedFps=rate(original.r_frame_rate)>45?60:30;
  const decode=await run('ffmpeg',['-v','error','-i',output,'-f','null','-'],{maxBuffer:8000000});
  const delta=Number(p.format.duration)-duration;
  results.push({file:path.basename(src.relative),output:name,width:v.width,height:v.height,fps:v.avg_frame_rate,expectedFps,fpsPassed:Math.abs(rate(v.avg_frame_rate)-expectedFps)<0.01,duration:Number(p.format.duration),sourceDuration:duration,deltaSeconds:delta,audio:!!a,decodePassed:!decode.stderr.trim(),geometryPassed:Math.max(v.width,v.height)===Math.max(original.width,original.height)&&Math.min(v.width,v.height)===Math.min(original.width,original.height),durationPassed:Math.abs(delta)<0.12});
 }catch(e){results.push({output:name,error:e.message});}
}
let previous=[];try{previous=JSON.parse(await fs.readFile(path.join(work,'native-qa.json'),'utf8')).results;}catch{} const checked=new Set(results.map(x=>x.output));const merged=previous.filter(x=>!checked.has(x.output)).concat(results);await fs.writeFile(path.join(work,'native-qa.json'),JSON.stringify({checkedAt:new Date().toISOString(),results:merged},null,2));
console.log(JSON.stringify(results,null,2));
