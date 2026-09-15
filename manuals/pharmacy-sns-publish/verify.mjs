import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {plan} from './plan.mjs';
export function verify(state) {
  const expected = plan(state.brand);
  if (!Array.isArray(state.actions) || state.actions.length !== 52) throw Error('행동은 52건이어야 합니다.');
  const seen = new Set();
  for (const item of expected.actions) {
    const matches = state.actions.filter(a=>a.id===item.id);
    if(matches.length!==1) throw Error(`누락 또는 중복: ${item.id}`);
    const a=matches[0];
    if(a.actor!==item.actor || a.target!==item.target || a.kind!==item.kind) throw Error(`대상 불일치: ${item.id}`);
    const allowedSkip = a.status==='skipped' && a.actor==='kmin.kyeong' && a.kind==='repost';
    if((a.status!=='done' && !allowedSkip) || typeof a.evidence!=='string' || !a.evidence.trim()) throw Error(`미완료 또는 근거 없음: ${item.id}`);
    if(a.kind==='post') {
      const url=state.posts?.[a.target];
      if(typeof url!=='string' || !/^https:\/\/www\.instagram\.com\/(p|reel)\/[^/]+\/?$/.test(url) || seen.has(url)) throw Error(`게시물 URL 누락 또는 중복: ${a.target}`);
      seen.add(url);
    }
  }
  return `기록 검사 통과: 게시물 4개, 기록 52건, 완료 ${state.actions.filter(a=>a.status==='done').length}건, 제외 ${state.actions.filter(a=>a.status==='skipped').length}건. 실제 UI 근거도 검토하세요.`;
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) console.log(verify(JSON.parse(fs.readFileSync(process.argv[2],'utf8'))));
