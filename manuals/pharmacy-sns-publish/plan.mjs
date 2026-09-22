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
    add('self-like',owner,owner);
    for (const actor of owners) if (actor !== owner) add('mutual-like',actor,owner);
    for (const actor of ['kmin.kyeong','yakdae.saram']) for (const kind of ['like','save','repost','comment']) add(kind,actor,owner);
    for (const kind of ['like','save','comment']) add(kind,'lovellliiil',owner);
    // 반응 계정끼리 삼각형 DM 공유. 한 건이 나머지 두 계정에게 보내는 것을 뜻한다.
    for (const actor of ['kmin.kyeong','yakdae.saram','lovellliiil']) add('share',actor,owner);
    // lovellliiil 만 바깥 팔로우 계정 10명 남짓에게 더 보낸다.
    add('share-out','lovellliiil',owner);
  }
  for (const a of actions) if (a.actor === 'kmin.kyeong' && a.kind === 'repost') { a.status='skipped'; a.evidence='2026-09-15 사용자 확인: kmin.kyeong 리포스트·재공유 기능 없음. 수행 대상 제외.'; }
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
