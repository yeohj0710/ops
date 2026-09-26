import { STATUS, hash, list, nonempty, httpUrl, dateValue } from './io.mjs';

export const REQUIRED_CRITERIA=['hook','formatFidelity','spokenKorean','shootability','factualGrounding','brandFree'];
export function planHash(plan) { const { editorialReview, ...body }=plan; return hash(body); }
export function scaffold(packet) {
  return {version:1,packetId:packet.identity,account:packet.account,title:'',author:'',status:STATUS,
    refs:packet.refs,benchmarkIds:packet.benchmarks.map(b=>b.id),seconds:0,
    scenes:[],claims:[],evidence:[],formatComparison:[],editorNotes:'',
    editorialReview:{reviewer:'',reviewerSession:'',authorSession:'',independent:false,decision:'pending',reviewedAt:'',reviewedPlanHash:'',reviewedPacketHash:'',criteria:[]}};
}

export function lintPlan(plan, packet, config, ledger={items:{}}) {
  const errors=[],warnings=[];
  const issue=(code,path,message)=>errors.push({code,path,message});
  const check=(ok,code,path,message)=>{if(!ok)issue(code,path,message);};
  if(!plan||typeof plan!=='object'||Array.isArray(plan)) return {ok:false,errors:[{code:'PLAN_OBJECT',path:'',message:'plan.json 객체가 필요합니다.'}],warnings,semanticQuality:'not-machine-proven'};
  for(const key of ['title','author','editorNotes']) check(nonempty(plan[key]),'REQUIRED_TEXT',key,`${key}가 비어 있습니다.`);
  check(plan.version===1,'PLAN_VERSION','version','version은 1입니다.');
  check(plan.packetId===packet.identity,'PACKET_ID','packetId','준비 패킷 ID와 다릅니다.');
  check(plan.account===packet.account,'ACCOUNT','account','준비한 계정과 다릅니다.');
  check(plan.status===STATUS,'STATUS','status',`상태는 ${STATUS}만 허용합니다.`);
  check(plan.refs?.content===packet.content.id&&plan.refs?.format===packet.format.id,'REFERENCE_ID','refs','실제 패킷의 두 원본 ID를 사용해야 합니다.');
  check(plan.refs?.content!==plan.refs?.format,'SAME_REFERENCE','refs','내용·형식 원본은 달라야 합니다.');
  const previous=ledger.items[packet.identity];
  check(!previous||previous.stage!=='complete'||previous.planHash===planHash(plan),'ALREADY_COMPLETE','packetId','이미 완료한 조합을 바꾸려면 새 실행에서 의도적으로 검토하세요.');
  for(const [id,item] of Object.entries(ledger.items)) if(id!==packet.identity&&item.account===plan.account&&item.content===plan.refs?.content&&['reviewed','awaiting-notion','complete'].includes(item.stage)) issue('DUPLICATE_CONTENT','refs.content','이 실행에서 같은 내용 원본을 이미 사용했습니다.');
  const benchmarks=new Map(packet.benchmarks.map(b=>[b.id,b]));
  check(list(plan.benchmarkIds).length>0&&plan.benchmarkIds.every(id=>benchmarks.has(id)),'BENCHMARK_IDS','benchmarkIds','실제 게시 기준 ID가 필요합니다.');
  const scenes=list(plan.scenes), sourceIds=new Set([...packet.content.lines,...list(packet.content.facts)].map(l=>l.id));
  const beatIds=new Set(packet.format.beats.map(b=>b.id)), sceneIds=new Set(), claimIds=new Set();
  check(scenes.length>0,'SCREENPLAY','scenes','장면별 실제 대본이 필요합니다.');
  const limits={minSeconds:5,maxSeconds:180,maxCharactersPerSecond:9,...config.limits};
  check(Number.isFinite(plan.seconds)&&plan.seconds>=limits.minSeconds&&plan.seconds<=limits.maxSeconds,'DURATION','seconds',`${limits.minSeconds}~${limits.maxSeconds}초 범위가 필요합니다.`);
  let end=0;
  for(const [i,raw] of scenes.entries()) {
    const s=raw||{},loc=`scenes[${i}]`;
    check(nonempty(s.id)&&!sceneIds.has(s.id),'SCENE_ID',loc+'.id','장면 ID가 없거나 중복됐습니다.'); sceneIds.add(s.id);
    for(const k of ['role','action','camera','edit']) check(nonempty(s[k])&&!/^(TODO|TBD|미정|작성 예정)$/i.test(s[k].trim()),'SCREENPLAY',`${loc}.${k}`,`촬영 가능한 ${k} 설명이 필요합니다.`);
    check(typeof s.dialogue==='string'&&typeof s.caption==='string'&&(nonempty(s.dialogue)||nonempty(s.caption)),'DIALOGUE',loc,'실제 대사 또는 화면 자막이 필요합니다.');
    check(Number.isFinite(s.start)&&Number.isFinite(s.end)&&Math.abs(s.start-end)<=.05&&s.end>s.start,'SCENE_TIMING',loc,'시간이 겹치거나 비어 있습니다. 앞 장면 끝과 이어야 합니다.');
    const dur=s.end-s.start; end=s.end;
    if(nonempty(s.dialogue)&&dur>0) check(s.dialogue.replace(/\s/g,'').length/dur<=limits.maxCharactersPerSecond,'SPEAKING_RATE',loc+'.dialogue','이 시간에 말하기 어려운 대사입니다. 대사를 줄이거나 시간을 늘리세요.');
    check(list(s.contentIds).length>0&&s.contentIds.every(id=>sourceIds.has(id)),'CONTENT_MAPPING',loc+'.contentIds','실제 내용 대사·사실 ID를 연결해야 합니다.');
    check(list(s.formatBeatIds).length>0&&s.formatBeatIds.every(id=>beatIds.has(id)),'FORMAT_MAPPING',loc+'.formatBeatIds','실제 형식 비트 ID를 연결해야 합니다.');
    check(Array.isArray(s.claimIds),'CLAIM_MAPPING',loc+'.claimIds','사실 주장 ID 배열이 필요합니다. 주장이 없으면 빈 배열입니다.');
  }
  check(Number.isFinite(end)&&Math.abs(end-plan.seconds)<=.05,'TOTAL_TIMING','seconds','마지막 장면 끝과 전체 길이가 다릅니다.');
  const evs=list(plan.evidence), evidenceIds=new Set();
  for(const [i,e] of evs.entries()) {
    check(e&&nonempty(e.id)&&!evidenceIds.has(e.id)&&httpUrl(e.url)&&nonempty(e.quote)&&nonempty(e.checkedBy)&&Number.isFinite(dateValue(e.checkedAt)),'EVIDENCE',`evidence[${i}]`,'공식 근거 URL, 실제 확인 문구, 확인자와 날짜가 필요합니다.'); evidenceIds.add(e?.id);
  }
  const speech=scenes.map(s=>[s?.dialogue,s?.caption].filter(Boolean).join('\n')).join('\n');
  for(const [i,c] of list(plan.claims).entries()) {
    if(!c){issue('CLAIM',`claims[${i}]`,'주장 객체가 필요합니다.');continue;}
    check(nonempty(c.id)&&!claimIds.has(c.id)&&nonempty(c.text),'CLAIM',`claims[${i}]`,'고유한 주장 ID와 문장이 필요합니다.');claimIds.add(c.id);
    check(list(c.sourceIds).length>0&&c.sourceIds.every(id=>sourceIds.has(id)),'CLAIM_SOURCE',`claims[${i}]`,'영상 주장에도 원문 ID가 필요합니다.');
    check(['supported','excluded-pending-verification'].includes(c.disposition),'CLAIM_DISPOSITION',`claims[${i}]`,'주장은 supported 또는 excluded-pending-verification으로 구분합니다.');
    if(c.disposition==='supported') {
      check(list(c.evidenceIds).length>0&&c.evidenceIds.every(id=>evidenceIds.has(id)),'FACTUAL_EVIDENCE',`claims[${i}]`,'대사에 쓰는 사실은 확인한 외부 근거와 연결해야 합니다.');
      check(list(c.sceneIds).length>0&&c.sceneIds.every(id=>sceneIds.has(id)),'CLAIM_SCENES',`claims[${i}]`,'주장을 쓰는 장면 ID가 필요합니다.');
      for(const id of list(c.sceneIds)) check(list(scenes.find(s=>s?.id===id)?.claimIds).includes(c.id),'CLAIM_BIDIRECTIONAL',`claims[${i}]`,'장면과 주장 연결이 서로 일치해야 합니다.');
    } else {
      check(!list(c.sceneIds).length&&nonempty(c.verificationNeeded)&&!speech.includes(c.text),'UNVERIFIED_IN_SCRIPT',`claims[${i}]`,'미확인 주장·용량·순위는 대사에서 제외하고 확인할 사항을 적으세요.');
      warnings.push({code:'CLAIM_EXCLUDED',message:`${c.id}: 촬영 대사에서 제외했습니다. ${c.verificationNeeded||''}`});
    }
  }
  for(const [i,s] of scenes.entries()) for(const id of list(s?.claimIds)) {
    const claim=list(plan.claims).find(c=>c?.id===id);
    check(claimIds.has(id)&&claim?.disposition==='supported'&&list(claim?.sceneIds).includes(s.id),'CLAIM_MAPPING',`scenes[${i}].claimIds`,'없거나 미확인된 주장 ID를 장면에 쓸 수 없습니다.');
  }
  // 원문 메타데이터는 그대로 둔다. 브랜드 사전의 한계는 독립 검토의 brandFree 항목에서 확인한다.
  const generated=[plan.title,speech,...scenes.map(s=>s?.action||'')].join('\n').normalize('NFKC').toLowerCase();
  const copy=[plan.title,plan.editorNotes,...scenes.flatMap(s=>[s?.dialogue,s?.caption,s?.action,s?.camera,s?.edit,s?.role])].filter(Boolean).join('\n');
  check(!/[·—]/.test(copy),'COPY_PUNCTUATION','scenes','생성 문구에는 가운뎃점과 줄표를 쓰지 않습니다.');
  for(const brand of [...list(packet.brandNames),...list(config.brandNames)]) check(!generated.includes(brand.normalize('NFKC').toLowerCase()),'BRAND_IN_SCRIPT','scenes',`생성 대사·자막·촬영 지시에 브랜드명 ${brand}가 있습니다.`);
  const comparison=list(plan.formatComparison), covered=new Set();
  for(const [i,f] of comparison.entries()) {
    check(f&&beatIds.has(f.formatBeatId)&&!covered.has(f.formatBeatId),'FORMAT_COMPARISON',`formatComparison[${i}]`,'원본 비트별 비교는 한 번씩 필요합니다.');covered.add(f?.formatBeatId);
    check(nonempty(f?.retained)&&nonempty(f?.changed)&&nonempty(f?.reason),'FORMAT_COMPARISON',`formatComparison[${i}]`,'유지한 부분, 바꾼 부분, 이유를 구체적으로 적으세요.');
    const actual=scenes.filter(s=>list(s?.formatBeatIds).includes(f?.formatBeatId)).map(s=>s.id).sort();
    check(JSON.stringify([...list(f?.sceneIds)].sort())===JSON.stringify(actual),'FORMAT_COMPARISON',`formatComparison[${i}].sceneIds`,'장면의 형식 비트 연결과 비교표가 다릅니다.');
    if(!actual.length) check(f?.omitted===true,'FORMAT_OMISSION',`formatComparison[${i}]`,'원본 비트를 생략하면 omitted:true와 이유를 적으세요.');
  }
  check([...beatIds].every(id=>covered.has(id)),'FORMAT_COVERAGE','formatComparison','모든 원본 비트를 비교해야 합니다. 생략도 이유를 남기세요.');
  const review=plan.editorialReview||{};
  check(review.independent===true&&nonempty(review.reviewer)&&review.reviewer.trim().toLowerCase()!==String(plan.author).trim().toLowerCase()&&nonempty(review.authorSession)&&nonempty(review.reviewerSession)&&review.authorSession!==review.reviewerSession,'INDEPENDENT_REVIEW','editorialReview','작성자와 다른 검토자·세션의 검토가 필요합니다.');
  check(review.decision==='pass'&&review.reviewedPlanHash===planHash(plan)&&Number.isFinite(dateValue(review.reviewedAt)),'REVIEW_VERSION','editorialReview','현재 대본 해시에 대한 검토 통과 기록이 필요합니다.');
  check(review.reviewedPacketHash===hash(packet),'REVIEW_PACKET_VERSION','editorialReview.reviewedPacketHash','현재 원본과 기준 스냅샷을 포함한 패킷 해시로 검토해야 합니다.');
  const criteria=new Set([...REQUIRED_CRITERIA,...list(plan.benchmarkIds).flatMap(id=>list(benchmarks.get(id)?.criteria).map(x=>x.id))]);
  for(const id of criteria) {
    const entries=list(review.criteria).filter(r=>r?.id===id);
    check(entries.length>0&&entries.every(r=>r.verdict==='pass'&&list(plan.benchmarkIds).includes(r.benchmarkId)&&nonempty(r.benchmarkEvidence)&&nonempty(r.planEvidence)&&list(r.sceneIds).length>0&&r.sceneIds.every(s=>sceneIds.has(s))),'REVIEW_CRITERION',`editorialReview.criteria.${id}`,`${id}: 기준 기획안과 이번 장면의 구체적인 비교 근거가 필요합니다.`);
  }
  for(const b of packet.benchmarks) if(b.videoViewed===false) warnings.push({code:'BENCHMARK_VIDEO_NOT_VIEWED',message:`${b.id}: 노션의 업로드 완료 상태와 기획안만 확인했습니다. 영상 재생 검증은 없습니다.`});
  warnings.push({code:'SEMANTIC_REVIEW_BOUNDARY',message:'검토 기록과 구조를 검사했습니다. 의미 적합도·의학적 진실·조회수 성과를 기계가 입증하지 않습니다.'});
  return {ok:errors.length===0,errors,warnings,planHash:planHash(plan),semanticQuality:'not-machine-proven',independentReviewRecorded:review.decision==='pass'&&errors.every(e=>!e.code.startsWith('REVIEW')&&e.code!=='INDEPENDENT_REVIEW')};
}

// Notion 문서 구문이 원문 문자열을 명령이나 블록으로 해석하지 않도록 이스케이프한다.
export const escapeMd=s=>String(s??'').replace(/[\\*~`$\[\]<>{}|^]/g,'\\$&').replace(/\r?\n/g,'<br>');
export function renderPlan(plan,packet) {
  const p=[],line=(label,value)=>p.push(`${label}: ${escapeMd(value)}`);
  line('기획안 식별자',`reels-planning:${packet.identity}`); line('대본 해시',planHash(plan));
  line('계정',plan.account);line('상태',plan.status);line('길이',`${plan.seconds}초`);
  p.push('## 레퍼런스');
  for(const [label,ref] of [['내용',packet.content],['형식',packet.format]]) {line(label,`${ref.title} (${ref.id})`);p.push(`[${label} 원본](${ref.url})`);line('측정',`${ref.views}회 / 게시 ${ref.posted} / 조회수 측정 ${ref.measured}`);}
  p.push('## 게시 완료 기준');
  for(const b of packet.benchmarks.filter(x=>plan.benchmarkIds.includes(x.id))) {p.push(`[${escapeMd(b.title)}](${b.notionUrl})`);line('확인 범위',b.videoViewed===false?'노션 업로드 완료 상태와 기획안. 영상 재생 미확인.':'저장된 기준 스냅샷');if(b.publishedUrl)p.push(`[게시 영상](${b.publishedUrl})`);}
  p.push('## 촬영 대본');
  p.push('<table header-row="true">\n<tr><td>장면 설명</td><td>대사/자막</td></tr>');
  for(const s of plan.scenes) {
    const left=[`${s.id} / ${s.start}~${s.end}초 / ${s.role}`,`동작과 소품: ${s.action}`,`카메라: ${s.camera}`,`편집: ${s.edit}`,`내용 출처: ${s.contentIds.join(', ')}`,`형식 비트: ${s.formatBeatIds.join(', ')}`];
    const right=[`대사: ${s.dialogue||'없음'}`,`자막: ${s.caption||'없음'}`,`사실 주장: ${s.claimIds.join(', ')||'없음'}`];
    p.push(`<tr><td>${left.map(escapeMd).join('<br>')}</td><td>${right.map(escapeMd).join('<br>')}</td></tr>`);
  }
  p.push('</table>');
  p.push('## 편집자 노트');p.push(escapeMd(plan.editorNotes));
  p.push('## 형식 원본 비교');
  for(const f of plan.formatComparison) {const b=packet.format.beats.find(x=>x.id===f.formatBeatId);line('원본 비트',`${b.id} / ${b.start}~${b.end}초 / ${b.role}`);line('원본 화면',b.visual);line('연결 장면',f.sceneIds.join(', ')||'생략');line('유지',f.retained);line('변경',f.changed);line('이유',f.reason);}
  p.push('## 사실 확인');
  for(const c of plan.claims) {line(c.id,c.text);line('처리',c.disposition==='supported'?'근거 확인':'대사에서 제외, 추가 확인 필요');line('내용 출처',c.sourceIds.join(', '));line('근거',list(c.evidenceIds).join(', ')||c.verificationNeeded);}
  for(const e of plan.evidence) {p.push(`[${escapeMd(e.id)} 근거](${e.url})`);line('확인 문구',e.quote);line('확인',`${e.checkedBy} / ${e.checkedAt}`);}
  p.push('## 독립 검토');line('검토자',plan.editorialReview.reviewer);line('검토일',plan.editorialReview.reviewedAt);
  for(const r of plan.editorialReview.criteria) {line('항목',`${r.id} / ${r.benchmarkId} / ${r.sceneIds.join(', ')}`);line('기준 근거',r.benchmarkEvidence);line('이번 기획안 근거',r.planEvidence);line('판정',r.verdict);}
  p.push('기계 검사는 누락과 출처 연결을 확인합니다. 실제 촬영 품질과 의학적 타당성은 별도 검토가 필요합니다.');
  return p.join('\n\n')+'\n';
}
