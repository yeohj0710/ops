import assert from 'node:assert/strict';
import {plan} from './plan.mjs';
import {verify} from './verify.mjs';
for(const brand of ['aroundpharm','mimipharm']) {
  const s=plan(brand);
  assert.equal(new Set(s.actions.map(a=>a.id)).size,52);
  assert.equal(s.actions.filter(a=>a.kind==='mutual-like').length,12);
  assert.equal(s.actions.filter(a=>a.kind==='story').length,4);
  assert.throws(()=>verify(s));
  for(const a of s.actions) { a.status='done';a.evidence='테스트용 근거, 실기 증빙 아님'; if(a.kind==='post') s.posts[a.target]=`https://www.instagram.com/p/test_${a.target}/`; }
  assert.match(verify(s),/52/);
  for(const alter of [x=>x.actions.pop(),x=>x.actions[0].status='blocked',x=>x.actions[0].evidence='',x=>x.actions[1]={...x.actions[0]},x=>x.actions[0].actor='wrong',x=>x.posts={}]) {
    const copy=structuredClone(s);alter(copy);assert.throws(()=>verify(copy));
  }
}
assert.throws(()=>plan('both'));
console.log('두 브랜드 정상 기록 및 누락·중복·막힘·잘못된 계정·URL 검사 통과');
