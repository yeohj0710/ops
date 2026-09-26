import test from 'node:test';
import assert from 'node:assert/strict';
import {checkPlan} from './plan-check.mjs';

function fixture(){
  const shots=Array.from({length:10},(_,i)=>({id:`S${i+1}`,start:i*2,end:i*2+2,reason:'고유한 공간 경험',subject:'테스트 공간',action:'장소를 이용하는 동작',camera:'짧은 옆 이동',reference_ids:['R1'],video_prompt:'검증용 프롬프트'}));
  return {title:'검증용 20초 장소 영상',purpose:'place_promo',subject:'가상 테스트 공간',audience:'방문 예정자',message:'공간의 특징을 경험한다',authenticity:'real',visual_bible:'낮, 자연광',delivery:{duration_seconds:20,ratio:'16:9',resolution:'1080p',music:true,sfx:true,voice:false},audio_plan:'편집에서 음악 한 곡을 연결',references:[{id:'R1',source:'test-reference.png',verified:true}],shots,requests:shots.map(s=>({id:'V'+s.id,kind:'video',shot_ids:[s.id],reference_ids:['R1'],count:1,generated_seconds:4,model:'검증용 모델',limits:{verified:true,source:'test-only capability fixture',checked_at:'2026-09-26T00:00:00Z',min_seconds:4,max_seconds:10,max_references:1,multi_shot:false}}))};
}
test('20-second edit has 40 billable generated seconds',()=>{const r=checkPlan(fixture());assert.equal(r.valid,true);assert.equal(r.generated_video_seconds,40);assert.equal(r.request_counts.video,10);assert.equal(r.grants_spending_authority,false);});
test('gaps and overlaps are rejected',()=>{for(const start of [1,3]){const p=fixture();p.shots[1].start=start;assert.equal(checkPlan(p).valid,false);}});
test('missing and unchecked references are rejected',()=>{const p=fixture();p.references[0].verified=false;assert.equal(checkPlan(p).valid,false);p.references=[];assert.equal(checkPlan(p).valid,false);});
test('reference limits and generated duration limits are enforced',()=>{const p=fixture();p.requests[0].limits.max_references=0;assert.equal(checkPlan(p).valid,false);p.requests[0].limits.max_references=1;p.requests[0].generated_seconds=2;assert.equal(checkPlan(p).valid,false);});
test('single-shot model cannot silently accept a montage',()=>{const p=fixture();p.requests[0].shot_ids.push('S2');p.requests.splice(1,1);assert.equal(checkPlan(p).valid,false);});
test('duplicate submission coverage is rejected',()=>{const p=fixture();p.requests.push({...p.requests[0],id:'DUP'});assert.equal(checkPlan(p).valid,false);});
test('unknown capabilities never become ready for quote',()=>{const p=fixture();p.requests[0].limits.verified=false;assert.equal(checkPlan(p).ready_for_quote,false);});
test('fictional product can omit real-place references',()=>{const p=fixture();p.purpose='product';p.authenticity='fictional';p.references=[];p.shots.forEach(s=>s.reference_ids=[]);p.requests.forEach(r=>r.reference_ids=[]);assert.equal(checkPlan(p).valid,true);});
test('unknown request kind fails without crashing',()=>{const p=fixture();p.requests[0].kind='constructor';assert.equal(checkPlan(p).valid,false);});
