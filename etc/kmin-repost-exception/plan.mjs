import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
export function plan(brand) {
  if (!['aroundpharm', 'mimipharm'].includes(brand)) throw Error('브랜드는 aroundpharm 또는 mimipharm이어야 합니다.');
  const owners = ['official', 'jp', 'cn', 'global'].map(s => `${brand}_${s}`);
  const actions = [];
  const add = (kind, actor, target) => actions.push({id:`${kind}:${actor}:${target}`,kind,actor,target,status:'pending',evidence:''});
  for (const owner of owners) {
    add('post',owner,owner); add('story',owner,owner);
    for (const actor of owners) if (actor !== owner) add('mutual-like',actor,owner);
    for (const actor of ['kmin.kyeong','yakdae.saram']) for (const kind of ['like','save','repost','comment']) add(kind,actor,owner);
  }
  return {brand,posts:{},actions};
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [, ,brand,destination] = process.argv;
  const state = plan(brand);
  if (!destination || !path.isAbsolute(destination)) throw Error('계획 파일의 절대 경로가 필요합니다.');
  fs.mkdirSync(path.dirname(destination),{recursive:true});
  fs.writeFileSync(destination,JSON.stringify(state,null,2)+'\n',{flag:'wx'});
  console.log(`계획 ${state.actions.length}건: ${destination}`);
}
