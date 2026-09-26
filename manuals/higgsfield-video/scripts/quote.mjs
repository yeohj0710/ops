import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';

const finite=(n,label,min=0)=>{if(typeof n!=='number'||!Number.isFinite(n)||n<min)throw Error(`${label}: ${min} 이상의 숫자가 필요합니다.`);return n;};
const whole=(n,label)=>{finite(n,label,1);if(!Number.isInteger(n))throw Error(`${label}: 정수가 필요합니다.`);return n;};
const money=n=>Math.round((n+Number.EPSILON)*100)/100;
const gcd=(a,b)=>b?gcd(b,a%b):a;

// Cheapest combination among the observed packs only. Does not purchase anything.
export function topUp(shortage,packs){
  if(shortage<=0)return {credits:0,usd:0,packs:[]};
  const unit=packs.map(p=>p.credits).reduce(gcd);
  const target=Math.ceil(shortage/unit), limit=target+Math.max(...packs.map(p=>p.credits/unit));
  if(limit>1000000)throw Error('충전 조합이 너무 큽니다. 현재 가격표에서 큰 패키지를 확인하세요.');
  const dp=Array(limit+1).fill(Infinity), prev=Array(limit+1);dp[0]=0;
  for(let n=1;n<=limit;n++)for(const p of packs){const step=p.credits/unit,cents=Math.round(p.usd*100);if(n>=step&&dp[n-step]+cents<dp[n]){dp[n]=dp[n-step]+cents;prev[n]=p;}}
  let best=target;for(let n=target;n<=limit;n++)if(dp[n]<dp[best])best=n;
  const result=new Map();let n=best;
  while(n>0){const p=prev[n];if(!p)throw Error('충전 조합 계산 실패.');result.set(p.id,(result.get(p.id)||0)+1);n-=p.credits/unit;}
  return {credits:best*unit,usd:dp[best]/100,packs:[...result].map(([id,count])=>({id,count}))};
}

export function quote(job,pricing,now=new Date()){
  if(!job.request_id||!job.title)throw Error('request_id와 title이 필요합니다.');
  if(!job.settings||typeof job.settings!=='object'||!Object.keys(job.settings).length)throw Error('모델·길이·비율·수량 등 settings를 적으세요.');
  if(!Array.isArray(job.stages)||!job.stages.length)throw Error('전처리부터 납품까지 stages를 적으세요.');
  if(!pricing.source_url?.startsWith('https://higgsfield.ai/'))throw Error('Higgsfield 공식 충전 가격 출처가 필요합니다.');
  if(!pricing.observed_at||!Number.isFinite(Date.parse(pricing.observed_at)))throw Error('충전 가격 확인 시각이 필요합니다.');
  if(!Array.isArray(pricing.packs)||!pricing.packs.length)throw Error('충전 패키지가 필요합니다.');
  const ids=new Set();for(const p of pricing.packs){if(!p.id||ids.has(p.id))throw Error('패키지 ID가 없거나 중복됩니다.');ids.add(p.id);whole(p.credits,'충전 크레딧');finite(p.usd,'충전 가격',0.01);if(Math.abs(p.usd*100-Math.round(p.usd*100))>1e-7)throw Error('충전 가격은 센트 단위로 적으세요.');}
  const basis=pricing.packs.find(p=>p.id===job.cost_basis_pack_id)||[...pricing.packs].sort((a,b)=>a.credits-b.credits)[0];
  if(job.cost_basis_pack_id&&!ids.has(job.cost_basis_pack_id))throw Error('선택한 충전 패키지가 현재 가격표에 없습니다.');
  const warnings=[];
  const stages=job.stages.map(s=>{
    if(!s.name||!s.source)throw Error('단계 이름과 견적 출처가 필요합니다.');
    const count=whole(s.count,'수량'),attempts=whole(s.max_attempts,'최대 시도 수');
    finite(s.credits_min,'최소 크레딧');finite(s.credits_max,'최대 크레딧');
    if(s.credits_min>s.credits_max)throw Error('최소 크레딧이 최대보다 큽니다.');
    if(!['local','live','reference'].includes(s.quote_kind))throw Error('견적 종류는 local, live, reference 중 하나입니다.');
    if(s.quote_kind==='local'&&s.credits_max!==0)throw Error('로컬 단계의 크레딧은 0이어야 합니다.');
    if(s.quote_kind==='live'&&(!s.observed_at||!Number.isFinite(Date.parse(s.observed_at))))throw Error('실시간 견적의 확인 시각이 필요합니다.');
    if(s.quote_kind==='reference')warnings.push(`${s.name}: 참고 견적입니다. 해당 옵션의 실시간 견적이 필요합니다.`);
    return {...s,initial_min:s.credits_min*count,initial_max:s.credits_max*count,maximum:s.credits_max*count*attempts};
  });
  const total={min:stages.reduce((n,s)=>n+s.initial_min,0),max:stages.reduce((n,s)=>n+s.initial_max,0),cap:stages.reduce((n,s)=>n+s.maximum,0)};
  const balance=job.balance_credits===null?null:finite(job.balance_credits,'현재 잔액');
  const fx=pricing.fx;
  if(fx){finite(fx.krw_per_usd,'원/달러 환율',0.01);if(!fx.rate_date||!fx.source_url||!fx.checked_at)throw Error('환율 기준일·출처·조회 시각이 필요합니다.');}
  else warnings.push('원화 환율을 확인하지 못했습니다. USD만 계산했습니다.');
  const unitUsd=basis.usd/basis.credits;
  const convert=n=>({usd:money(n*unitUsd),krw:fx?Math.round(n*unitUsd*fx.krw_per_usd):null});
  const cash=balance===null?null:topUp(Math.max(0,total.cap-balance),pricing.packs);
  const today=now.toISOString().slice(0,10);
  const sameDay=date=>date&&Number.isFinite(Date.parse(date))&&new Date(date).toISOString().slice(0,10)===today;
  const liveForRequest=pricing.verified_for_request_id===job.request_id&&sameDay(pricing.observed_at);
  if(!liveForRequest)warnings.push('저장된 충전 가격입니다. 이번 요청의 계정 화면에서 다시 확인하세요.');
  if(now.toISOString().slice(0,10)!==new Date(pricing.observed_at).toISOString().slice(0,10))warnings.push('충전 가격 확인일이 오늘과 다릅니다. 현재 할인과 세금을 다시 확인하세요.');
  if(balance===null)warnings.push('현재 잔액을 확인하지 못해 추가 충전액은 계산하지 않았습니다.');
  if(pricing.tax_included!==true)warnings.push('표시액은 세금·해외결제 수수료 제외입니다. 결제 총액은 충전 화면에서 확인하세요.');
  if(fx)warnings.push(`원화는 ${fx.rate_date} 기준환율의 참고액입니다. 카드 청구 환율과 다를 수 있습니다.`);
  return {request_id:job.request_id,title:job.title,settings:job.settings,quote_fingerprint:createHash('sha256').update(JSON.stringify({job,pricing})).digest('hex'),stages,credits:total,balance_credits:balance,
    balance_after_first_range:balance===null?null:{min:balance-total.max,max:balance-total.min},
    basis:{...basis,usd_per_credit:unitUsd},replacement_cost:{min:convert(total.min),max:convert(total.max),cap:convert(total.cap)},
    additional_topup:cash?{...cash,krw:fx?Math.round(cash.usd*fx.krw_per_usd):null}:null,
    pricing_source:pricing.source_url,pricing_observed_at:pricing.observed_at,fx:fx||null,
    quote_usable:liveForRequest&&stages.every(s=>s.quote_kind==='local'||(s.quote_kind==='live'&&sameDay(s.observed_at)))&&balance!==null,
    submits_generation:false,grants_spending_authority:false,warnings};
}

export function formatQuote(q){
  const cost=c=>`$${c.usd.toFixed(2)}${c.krw===null?' / 원화 미확인':` / 약 ${c.krw.toLocaleString('ko-KR')}원`}`;
  const range=(a,b)=>a===b?`${a}`:`${a}~${b}`;
  const initialCost=q.credits.min===q.credits.max?cost(q.replacement_cost.max):`${cost(q.replacement_cost.min)} ~ ${cost(q.replacement_cost.max)}`;
  const cash=q.additional_topup;
  return [`# ${q.title}`, '', `설정: ${Object.entries(q.settings).map(([k,v])=>`${k}=${v}`).join(', ')}`, '', '| 단계 | 수량 | 1회 합계 크레딧 | 최대 시도 |', '| --- | ---: | ---: | ---: |',
    ...q.stages.map(s=>`| ${s.name} | ${s.count} | ${range(s.initial_min,s.initial_max)} | ${s.max_attempts} |`),'',
    `- 최초 생성: ${range(q.credits.min,q.credits.max)}크레딧. 최대 시도 포함 상한: ${q.credits.cap}크레딧.`,
    `- 환산 기준: ${q.basis.credits}크레딧 / $${q.basis.usd.toFixed(2)}, 1크레딧 $${q.basis.usd_per_credit.toFixed(6)}.`,
    `- 최초 사용분 환산: ${initialCost}. 상한 ${cost(q.replacement_cost.cap)}.`,
    `- 현재 잔액: ${q.balance_credits??'미확인'}크레딧.`,
    `- 추가 충전 후보: ${cash?`${cash.credits}크레딧 / ${cost(cash)}${cash.packs.length?' / '+cash.packs.map(p=>`${p.id} × ${p.count}`).join(', '):' (충전 불필요)'}`:'잔액 확인 후 계산'}.`,
    '- 충전 후보는 확인한 패키지 조합 중 최소 결제액입니다. 더 큰 맞춤 패키지나 새 할인은 포함하지 않습니다.',
    `- 가격 출처: ${q.pricing_source} (${q.pricing_observed_at}).`,
    ...q.warnings.map(w=>`- ${w}`),'- 이 계산은 생성·충전·승인을 실행하지 않습니다. 현재 사용자 승인과 요청 범위는 에이전트가 대조합니다.',''].join('\n');
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{const [jobPath,pricingPath,outPath]=process.argv.slice(2);if(!jobPath||!pricingPath)throw Error('사용법: node quote.mjs 요청.json 충전가격.json [견적.json]');
    const q=quote(JSON.parse(fs.readFileSync(jobPath,'utf8')),JSON.parse(fs.readFileSync(pricingPath,'utf8')));
    if(outPath)fs.writeFileSync(outPath,JSON.stringify(q,null,2)+'\n',{flag:'wx'});
    console.log(formatQuote(q));
  }catch(e){console.error(e.message);process.exitCode=1;}
}
