import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {plan} from './plan.mjs';
export function verify(state) {
  const expected = plan(state.brand);
  const total = expected.actions.length;
  if (!Array.isArray(state.actions) || state.actions.length !== total) throw Error(`행동은 ${total}건이어야 합니다.`);
  const seen = new Set();
  const commentsDone = {};
  for (const item of expected.actions) {
    const matches = state.actions.filter(a=>a.id===item.id);
    if(matches.length!==1) throw Error(`누락 또는 중복: ${item.id}`);
    const a=matches[0];
    if(a.actor!==item.actor || a.target!==item.target || a.kind!==item.kind) throw Error(`대상 불일치: ${item.id}`);
    const allowedSkip = a.status==='skipped' && a.actor==='kmin.kyeong' && a.kind==='repost';
    // 스토리는 PC 웹에 기능이 없을 수 있고, 댓글은 게시물마다 한 계정만 단다. 사유를 적은 blocked 를 종료 상태로 받는다.
    const allowedBlock = a.status==='blocked' && (a.kind==='story' || a.kind==='comment');
    if((a.status!=='done' && !allowedSkip && !allowedBlock) || typeof a.evidence!=='string' || !a.evidence.trim()) throw Error(`미완료 또는 근거 없음: ${item.id}`);
    if(a.kind==='comment') { commentsDone[a.target]=(commentsDone[a.target]||0)+(a.status==='done'?1:0); }
    if(a.kind==='post') {
      const url=state.posts?.[a.target];
      if(typeof url!=='string' || !/^https:\/\/www\.instagram\.com\/(p|reel)\/[^/]+\/?$/.test(url) || seen.has(url)) throw Error(`게시물 URL 누락 또는 중복: ${a.target}`);
      seen.add(url);
    }
  }
  for (const [target,n] of Object.entries(commentsDone)) if(n<1) throw Error(`댓글이 한 건도 없습니다: ${target}`);
  const by = k => state.actions.filter(a=>a.status===k).length;
  return `기록 검사 통과: 게시물 4개, 기록 ${total}건, 완료 ${by('done')}건, 막힘 ${by('blocked')}건, 제외 ${by('skipped')}건. 게시물당 댓글 ${Object.values(commentsDone).join('/')}건. 실제 UI 근거도 검토하세요.`;
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) console.log(verify(JSON.parse(fs.readFileSync(process.argv[2],'utf8'))));
