import test from 'node:test';
import assert from 'node:assert/strict';
import {quote,topUp,formatQuote} from './quote.mjs';

const packs=[{id:'100',credits:100,usd:6.25},{id:'200',credits:200,usd:12},{id:'500',credits:500,usd:26},{id:'1000',credits:1000,usd:49}];
const now=new Date('2026-09-26T09:00:00Z');
const price=()=>({source_url:'https://higgsfield.ai/ko/pricing',observed_at:now.toISOString(),verified_for_request_id:'test',packs,fx:{krw_per_usd:1355.05,rate_date:'2026-09-25',checked_at:now.toISOString(),source_url:'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml'}});
const job=()=>({request_id:'test',title:'검증용 견적',settings:{model:'test',duration_seconds:5,count:1},balance_credits:100,stages:[{name:'동영상',count:1,max_attempts:1,credits_min:30,credits_max:30,quote_kind:'live',observed_at:now.toISOString(),source:'검증용 실시간 견적'}]});
test('30 credits has replacement cost but no new cash payment',()=>{const q=quote(job(),price(),now);assert.equal(q.replacement_cost.max.usd,1.88);assert.equal(q.replacement_cost.max.krw,2541);assert.equal(q.additional_topup.usd,0);assert.equal(q.grants_spending_authority,false);assert.match(formatQuote(q),/충전 불필요/);});
test('all stages and retry ceiling included',()=>{const j=job();j.stages.push({name:'시작 이미지',count:2,max_attempts:3,credits_min:2,credits_max:3,quote_kind:'reference',source:'참고표'});const q=quote(j,price(),now);assert.deepEqual(q.credits,{min:34,max:36,cap:48});assert.equal(q.quote_usable,false);});
test('fractional shortage and smallest cash combination',()=>{assert.equal(topUp(0.01,packs).usd,6.25);assert.equal(topUp(150,packs).usd,12);assert.equal(topUp(800,packs).usd,44.25);assert.equal(topUp(1000,packs).usd,49);});
test('matches brute force for representative shortages',()=>{for(const need of [1,99.5,201,599,800,1001]){let best=Infinity;for(let a=0;a<13;a++)for(let b=0;b<7;b++)for(let c=0;c<4;c++)for(let d=0;d<3;d++)if(100*a+200*b+500*c+1000*d>=need)best=Math.min(best,6.25*a+12*b+26*c+49*d);assert.equal(topUp(need,packs).usd,best);}});
test('missing and invalid prices fail closed',()=>{for(const value of [null,-1,NaN]){const j=job();j.stages[0].credits_max=value;assert.throws(()=>quote(j,price(),now));}const j=job();j.stages[0].count=1.5;assert.throws(()=>quote(j,price(),now));});
test('cached price is not a current request quote',()=>{const p=price();p.verified_for_request_id=null;assert.equal(quote(job(),p,now).quote_usable,false);});
test('old option quote cannot pass as current',()=>{const j=job();j.stages[0].observed_at='2026-09-25T09:00:00Z';assert.equal(quote(j,price(),now).quote_usable,false);});
test('unknown FX and balance remain unknown',()=>{const p=price();p.fx=null;const j=job();j.balance_credits=null;const q=quote(j,p,now);assert.equal(q.additional_topup,null);assert.equal(q.replacement_cost.max.krw,null);assert.equal(q.quote_usable,false);});
