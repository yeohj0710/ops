import fs from 'node:fs';
import {pathToFileURL} from 'node:url';

const positive=x=>typeof x==='number'&&Number.isFinite(x)&&x>0;
const nonnegative=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0;
const filled=x=>typeof x==='string'&&x.trim().length>0;
const list=x=>Array.isArray(x)?x:[];
const equal=(a,b)=>Math.abs(a-b)<0.000001;

export function checkPlan(plan){
  const errors=[],warnings=[];
  if(!plan||typeof plan!=='object')return {valid:false,ready_for_quote:false,errors:['제작 계획 객체가 필요합니다.'],warnings};
  for(const key of ['title','purpose','subject','audience','message','visual_bible'])if(!filled(plan[key]))errors.push(`${key}: 제작 기준을 적으세요.`);
  if(!['place_promo','product','brand_service','explainer','event','narrative'].includes(plan.purpose))errors.push('purpose: 영상 목적 하나를 선택하세요.');
  if(!['real','fictional','stylized'].includes(plan.authenticity))errors.push('authenticity: 실제·가상·스타일 연출을 선택하세요.');
  const duration=plan.delivery?.duration_seconds;
  if(!positive(duration))errors.push('완성 영상의 길이가 필요합니다.');
  for(const field of ['ratio','resolution'])if(!filled(plan.delivery?.[field]))errors.push(`delivery.${field}: 납품 규격이 필요합니다.`);
  if(['music','sfx','voice'].some(k=>typeof plan.delivery?.[k]!=='boolean'))errors.push('음악·효과음·음성의 사용 여부를 각각 정하세요.');
  if((plan.delivery?.music||plan.delivery?.sfx||plan.delivery?.voice)&&!filled(plan.audio_plan))errors.push('음향 제작·편집 계획이 필요합니다.');
  const refs=new Map();
  for(const r of list(plan.references)){
    if(!r||!filled(r.id)||refs.has(r.id)){errors.push('참조 ID가 없거나 중복됩니다.');continue;}
    refs.set(r.id,r);
    if(!filled(r.source))errors.push(`${r.id}: 파일 경로나 출처 주소가 없습니다.`);
  }
  const shots=new Map();let end=0;
  for(const s of list(plan.shots)){
    if(!s||!filled(s.id)||shots.has(s.id)){errors.push('컷 ID가 없거나 중복됩니다.');continue;}
    shots.set(s.id,s);
    if(!nonnegative(s.start)||!positive(s.end)||s.end<=s.start)errors.push(`${s.id}: 시작·끝 시각이 잘못됐습니다.`);
    else {if(!equal(s.start,end))errors.push(`${s.id}: 타임라인에 빈틈 또는 겹침이 있습니다.`);end=s.end;}
    for(const k of ['reason','subject','action','camera','video_prompt'])if(!filled(s[k]))errors.push(`${s.id}: ${k}를 적으세요.`);
    if(plan.authenticity==='real'&&!list(s.reference_ids).length)errors.push(`${s.id}: 실제 대상의 참조가 필요합니다.`);
    for(const id of list(s.reference_ids)){
      const ref=refs.get(id);if(!ref)errors.push(`${s.id}: 알 수 없는 참조 ${id}.`);
      else if(ref.verified!==true)errors.push(`${s.id}: 참조 ${id}의 내용 확인이 필요합니다.`);
    }
  }
  if(!shots.size)errors.push('컷이 없습니다.');
  if(positive(duration)&&!equal(end,duration))errors.push(`타임라인 ${end}초와 목표 ${duration}초가 다릅니다.`);
  const requests=list(plan.requests),seen=new Set(),coverage=new Map();
  let generated=0,videoCount=0,knownLimits=true;
  const counts={image:0,video:0,audio:0};
  for(const r of requests){
    if(!r||!filled(r.id)||seen.has(r.id)){errors.push('생성 요청 ID가 없거나 중복됩니다.');continue;}seen.add(r.id);
    if(!Object.hasOwn(counts,r.kind)){errors.push(`${r.id}: 요청 종류를 확인하세요.`);continue;}
    if(!Number.isInteger(r.count)||r.count<1){errors.push(`${r.id}: 요청 수량은 양의 정수여야 합니다.`);continue;}
    counts[r.kind]+=r.count;
    for(const id of list(r.reference_ids))if(!refs.has(id))errors.push(`${r.id}: 알 수 없는 참조 ${id}.`);
    if(new Set(list(r.reference_ids)).size!==list(r.reference_ids).length)errors.push(`${r.id}: 참조 ID가 중복됩니다.`);
    if(r.kind!=='video')continue;
    videoCount+=r.count;
    if(!positive(r.generated_seconds))errors.push(`${r.id}: 실제 생성 길이가 필요합니다.`);
    else generated+=r.generated_seconds*r.count;
    let used=0;
    if(!list(r.shot_ids).length)errors.push(`${r.id}: 사용할 컷 ID가 없습니다.`);
    for(const id of list(r.shot_ids)){
      const s=shots.get(id);if(!s){errors.push(`${r.id}: 알 수 없는 컷 ${id}.`);continue;}
      coverage.set(id,(coverage.get(id)||0)+1);used+=s.end-s.start;
      for(const ref of list(s.reference_ids))if(!list(r.reference_ids).includes(ref))errors.push(`${r.id}: ${id}의 참조 ${ref}가 업로드 목록에 없습니다.`);
    }
    if(positive(r.generated_seconds)&&used>r.generated_seconds+0.000001)errors.push(`${r.id}: 생성 길이가 사용할 컷 길이보다 짧습니다.`);
    const cap=r.limits;
    if(cap?.verified!==true){knownLimits=false;warnings.push(`${r.id}: 현재 모델의 입력·길이·여러 컷 지원을 확인하세요.`);continue;}
    if(!filled(cap.source)||!filled(cap.checked_at)||!Number.isFinite(Date.parse(cap.checked_at))||!filled(r.model))errors.push(`${r.id}: 모델 사양의 출처·확인 시각·모델명이 필요합니다.`);
    if(!positive(cap.min_seconds)||!positive(cap.max_seconds)||cap.min_seconds>cap.max_seconds)errors.push(`${r.id}: 모델의 최소·최대 길이가 잘못됐습니다.`);
    if(!Number.isInteger(cap.max_references)||cap.max_references<0)errors.push(`${r.id}: 최대 참조 수를 확인하세요.`);
    if(r.generated_seconds<cap.min_seconds||r.generated_seconds>cap.max_seconds)errors.push(`${r.id}: 생성 길이가 모델 지원 범위를 벗어났습니다.`);
    if(list(r.reference_ids).length>cap.max_references)errors.push(`${r.id}: 모델의 최대 참조 수를 넘었습니다.`);
    if(list(r.shot_ids).length>1&&cap.multi_shot!==true)errors.push(`${r.id}: 여러 컷 생성이 확인되지 않은 모델입니다.`);
  }
  if(!videoCount)errors.push('영상 생성 요청이 없습니다. 편집만 하는 작업은 기존 편집 절차를 쓰세요.');
  for(const id of shots.keys())if(coverage.get(id)!==1)errors.push(`${id}: 생성 요청에 정확히 한 번 연결해야 합니다.`);
  if(generated>duration)warnings.push(`완성 ${duration}초와 별개로 생성할 영상은 ${generated}초입니다. 이 요청 수와 길이로 견적을 받으세요.`);
  if(plan.delivery?.music&&videoCount>1)warnings.push('여러 클립의 음악이 새로 시작되지 않도록 전체 음악과 편집 연결을 확인하세요.');
  return {valid:errors.length===0,ready_for_quote:errors.length===0&&knownLimits,errors,warnings,
    final_seconds:duration??null,generated_video_seconds:generated,request_counts:counts,shot_count:shots.size,
    quality_verified:false,grants_spending_authority:false,generation_calls:0};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{const [input,output]=process.argv.slice(2);if(!input)throw Error('사용법: node plan-check.mjs shot-plan.json [plan-check.json]');
    const result=checkPlan(JSON.parse(fs.readFileSync(input,'utf8')));
    if(output)fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
    console.log(JSON.stringify(result,null,2));if(!result.valid)process.exitCode=1;
  }catch(e){console.error(e.message);process.exitCode=1;}
}
