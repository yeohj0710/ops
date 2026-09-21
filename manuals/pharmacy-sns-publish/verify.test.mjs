import assert from 'node:assert/strict';
import {plan} from './plan.mjs';
import {verify} from './verify.mjs';
for(const brand of ['aroundpharm','mimipharm']) {
  const s=plan(brand);
  assert.equal(s.actions.filter(a=>a.status==='skipped').length,4);
  assert.equal(new Set(s.actions.map(a=>a.id)).size,68);
  assert.equal(s.actions.filter(a=>a.kind==='mutual-like').length,12);
  assert.equal(s.actions.filter(a=>a.kind==='story').length,4);
  assert.equal(s.actions.filter(a=>a.actor==='lovellliiil').length,12);
  assert.equal(s.actions.filter(a=>a.kind==='comment').length,12);
  assert.throws(()=>verify(s));
  for(const a of s.actions) { if(a.status!=='skipped') a.status='done';a.evidence='테스트용 근거, 실기 증빙 아님'; if(a.kind==='post') s.posts[a.target]=`https://www.instagram.com/p/test_${a.target}/`; }
  assert.match(verify(s),/68/);
  // 스토리 막힘과 게시물당 댓글 1건만 남기는 것은 정상 종료 상태다.
  const real=structuredClone(s);
  for(const a of real.actions) if(a.kind==='story') a.status='blocked';
  for(const a of real.actions) if(a.kind==='comment' && a.actor!=='yakdae.saram') a.status='blocked';
  assert.match(verify(real),/댓글 1\/1\/1\/1건/);
  for(const alter of [
    x=>x.actions.pop(),
    x=>x.actions[0].status='skipped',
    x=>x.actions.find(a=>a.kind==='repost' && a.actor==='yakdae.saram').status='skipped',
    x=>x.actions.find(a=>a.status==='skipped').evidence='',
    x=>x.actions[0].status='blocked',
    x=>x.actions.find(a=>a.kind==='like').status='blocked',
    x=>{for(const a of x.actions) if(a.kind==='comment') a.status='blocked';},
    x=>x.actions[0].evidence='',
    x=>x.actions[1]={...x.actions[0]},
    x=>x.actions[0].actor='wrong',
    x=>x.posts={},
  ]) {
    const copy=structuredClone(s);alter(copy);assert.throws(()=>verify(copy));
  }
}
assert.throws(()=>plan('both'));
console.log('두 브랜드 정상 기록 및 누락·중복·막힘·잘못된 계정·URL 검사 통과');
