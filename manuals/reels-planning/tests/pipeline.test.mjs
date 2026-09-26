import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { example } from '../scripts/schema.mjs';
import { read, hash, fileHash, json, STATUS, save, secureFile, parseCsv } from '../scripts/io.mjs';
import { loadConfig, prepare, validateExternal } from '../scripts/data.mjs';
import { planHash, lintPlan, renderPlan } from '../scripts/plan.mjs';
import { notionRequests, checkDedupe, verifyReceipt, FETCH, QUERY, normalizeBody } from '../scripts/notion.mjs';
import { execute, checkRun } from '../scripts/pipeline.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const write=(f,d)=>{fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,typeof d==='string'?d:json(d));};
const refresh=p=>{p.editorialReview.reviewedPlanHash=planHash(p);return p;};
const codes=r=>r.errors.map(e=>e.code);
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reels-planning-test-'));
  t.after(()=>{const resolved=fs.realpathSync(dir);assert.equal(path.dirname(resolved),fs.realpathSync(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('reels-planning-test-'));fs.rmSync(resolved,{recursive:true,force:true});});
  const e=example(),config=path.join(dir,'config.json'),run=path.join(dir,'run');
  const rows=[e.packet.content,e.packet.format].map(r=>({c:r.id,h:r.account,t:r.title,cat:r.topic,posted:r.posted,measured:r.measured,v:r.views,ad:r.ad,s:r.contentScore,f:r.formatScore}));
  write(path.join(dir,e.config.sources.public),{rows});
  write(path.join(dir,e.config.sources.private),{rows,sources:Object.fromEntries([e.packet.content,e.packet.format].map(r=>[r.id,{story:{lines:r.lines,facts:[],truncated:false},form:{id:'GENERIC-NOT-REAL',slots:[{role:'잘못된 공통 틀',seconds:'0-90'}]}}]))});
  const cell=x=>'"'+String(x).replace(/"/g,'""')+'"';
  write(path.join(dir,e.config.sources.beatsCsv),'shortcode,번호,시작초,끝초,기능,할말,화면자막,화면\n'+e.packet.format.beats.map((b,i)=>[e.packet.format.id,i+1,b.start,b.end,b.role,b.dialogue,b.caption,b.visual].map(cell).join(',')).join('\n'));
  e.config.selection.pairs=[{content:'CONTENT',format:'FORMAT',account:e.config.account,reason:'가상 두 칸 질문에 두 칸 행동을 연결한다.',reviewedBy:'가상 선정자',reviewedAt:'2026-09-26T00:00:00Z'}];
  write(path.join(dir,e.config.benchmarks),e.benchmarkSnapshot);write(config,e.config);
  const args={config,'run-dir':run};
  return {...e,dir,run,config,args,c:()=>loadConfig(config),prepare:()=>{const result=execute({command:'prepare',...args});e.plan.editorialReview.reviewedPacketHash=hash(read(path.join(run,'packets',e.plan.packetId+'.json')));return result;},savePlan:p=>{const f=path.join(dir,'plan.json');write(f,p);return f;}};
}
function receiptEnvelope(requests,c,overrides={}) {
  const pageId='00000000-0000-0000-0000-000000000002',page=requests.create.arguments.pages[0];
  return {tool:FETCH,arguments:{id:pageId},fetchedAt:new Date().toISOString(),response:{content:[{type:'text',text:JSON.stringify({id:pageId,url:`https://www.notion.so/${pageId.replace(/-/g,'')}`,parent:{data_source_id:c.notion.dataSourceId},properties:page.properties,content:page.content,truncated:false,...overrides})}]}};
}
function dedupeEnvelope(requests,rows=[]) {return {tool:QUERY,arguments:requests.dedupe.arguments,fetchedAt:new Date().toISOString(),response:{content:[{type:'text',text:JSON.stringify({results:rows,has_more:false})}]}};}
function tree(dir) {if(!fs.existsSync(dir))return {};return Object.fromEntries(fs.readdirSync(dir,{recursive:true,withFileTypes:true}).filter(d=>d.isFile()).map(d=>{const f=path.join(d.parentPath||d.path,d.name);return [path.relative(dir,f),{hash:fileHash(f),mtime:fs.statSync(f).mtimeMs}];}));}

test('prepare preserves raw format beats, identities, benchmarks, and all source bytes',t=>{
  const f=fixture(t),before=Object.values(f.c().sources).map(fileHash),r=f.prepare();
  assert.equal(r.ok,true);assert.equal(r.paidCalls,0);assert.equal(r.selected.length,1);
  const packet=read(path.join(f.run,'packets',r.selected[0].identity+'.json'));
  assert.equal(packet.format.beats[0].id,'FORMAT:B1');assert.equal(packet.format.beats[0].end,5);
  assert.equal(packet.format.beats[0].visual,f.packet.format.beats[0].visual);
  assert.ok(!JSON.stringify(packet).includes('GENERIC-NOT-REAL'));
  assert.equal(packet.content.lines[0].id,'CONTENT:L1');assert.equal(packet.benchmarks[0].publishedUrl,'https://example.org/published');
  assert.deepEqual(Object.values(f.c().sources).map(fileHash),before);
});
test('prepare dry-run does not create run; retries preserve bytes and timestamps and authored plans',t=>{
  const f=fixture(t);const first=execute({command:'prepare',...f.args,'dry-run':true});assert.equal(fs.existsSync(f.run),false);
  const actual=f.prepare();assert.deepEqual(first.selected,actual.selected);
  const plan=path.join(f.run,'plans',actual.selected[0].identity+'.json');write(plan,{author:'사용자 작성 내용'});
  const before=tree(f.run);f.prepare();assert.deepEqual(tree(f.run),before);assert.equal(read(plan).author,'사용자 작성 내용');
});
test('three calendar months includes June 26 on September 26; explicit 90 days excludes it',t=>{
  const f=fixture(t),c=f.c();c.selection.pairs=[];
  const p=read(c.sources.public);p.rows[0].posted='2026-06-26';write(c.sources.public,p);
  let r=prepare(c);assert.ok(r.sourceLedger.find(r=>r.id==='CONTENT').content);
  c.selection.maxAgeDays=90;r=prepare(c);assert.ok(!r.sourceLedger.find(r=>r.id==='CONTENT').content);
  c.asOf='2026-05-31';delete c.selection.maxAgeDays;p.rows[0].posted='2026-02-28';p.rows.forEach(x=>x.measured='2026-05-01');write(c.sources.public,p);
  assert.ok(prepare(c).sourceLedger.find(r=>r.id==='CONTENT').content);
});
test('pair selection rejects identical and copied references, respects source slot fit',t=>{
  const f=fixture(t),c=f.c();c.selection.pairs[0].format='CONTENT';c.selection.pairs[0].eligibilityException='가상 실패 검사';
  let r=prepare(c);assert.equal(r.selected.length,0);
  const d=read(c.sources.private);d.sources.FORMAT.story.lines=d.sources.CONTENT.story.lines;write(c.sources.private,d);c.selection.pairs[0].format='FORMAT';
  r=prepare(c);assert.equal(r.selected.length,0);assert.equal(r.rejectedPairs[0].reason,'duplicate-dialogue');
});
test('raw beats absent does not fall back to generic templates',t=>{
  const f=fixture(t),c=f.c();c.selection.pairs=[];write(c.sources.beatsCsv,'shortcode,번호,시작초,끝초,기능,할말,화면자막,화면\n');
  assert.equal(prepare(c).selected.length,0);
});
test('Notion uploaded-status benchmark is preserved without pretending video was viewed',t=>{
  const f=fixture(t),c=f.c();const b={...f.benchmarkSnapshot.benchmarks[0],page:'fixture-page',url:'https://example.org/benchmark',status:'업로드 완료',verifiedAt:'2026-09-26',statusEvidence:'조회된 상태',videoViewed:false,content:'가상 실제 기획안 전문',standards:['첫 장면의 손동작과 다음 답변을 연결한다.']};delete b.screenplay;delete b.publishedUrl;
  write(c.benchmarks,{benchmarks:[b],criteria:['hook']});const p=prepare(c).selected[0];assert.equal(p.benchmarks[0].videoViewed,false);assert.equal(p.benchmarks[0].publicationEvidence,'notion-uploaded-status');
});
test('external ingestion requires transcript and visual artifacts with matching hashes',t=>{
  const f=fixture(t),artifact=path.join(f.dir,'source.txt');write(artifact,'가상 원본');
  const provenance={sourceUrl:f.packet.format.url,reviewedBy:'검토자',reviewedAt:'2026-09-26',transcript:{verified:true,method:'텍스트 대조',artifact,sha256:fileHash(artifact)},visual:{verified:true,method:'원본 화면 확인',artifact,sha256:fileHash(artifact)}};
  const doc={version:1,references:[{...f.packet.format,provenance}]};const file=path.join(f.dir,'external.json');write(file,doc);
  assert.equal(validateExternal(doc,file).length,1);
  const originalUrl=doc.references[0].url;
  doc.references[0].url='https://www.instagram.com/p/example/';
  assert.throws(()=>validateExternal(doc,file),{code:'EXTERNAL_NOT_REEL'});
  doc.references[0].url=originalUrl;doc.references[0].mediaType='carousel';
  assert.throws(()=>validateExternal(doc,file),{code:'EXTERNAL_NOT_REEL'});
  delete doc.references[0].mediaType;
  doc.references[0].provenance.visual.sha256='0'.repeat(64);
  assert.throws(()=>validateExternal(doc,file),{code:'EXTERNAL_HASH'});
  doc.references[0].provenance.visual.verified=false;assert.throws(()=>validateExternal(doc,file),{code:'EXTERNAL_PROVENANCE'});
});
test('valid short source-shaped screenplay passes with two scenes and reference brand unchanged',()=>{
  const e=example(),r=lintPlan(e.plan,e.packet,e.config);assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.semanticQuality,'not-machine-proven');
  const body=renderPlan(e.plan,e.packet);assert.match(body,/<table header-row="true">/);assert.match(body,/<td>장면 설명<\/td><td>대사\/자막<\/td>/);assert.match(body,/예시상표가 있는 원본 메타데이터/);
});
test('lint reports missing screenplay, source IDs, invented refs, bad status, duration and speech rate',()=>{
  const mutations=[['SCREENPLAY',p=>p.scenes[0].action=''],['CONTENT_MAPPING',p=>p.scenes[0].contentIds=[]],['FORMAT_MAPPING',p=>p.scenes[0].formatBeatIds=['invented']],['REFERENCE_ID',p=>p.refs.content='invented'],['STATUS',p=>p.status='업로드 완료'],['SCENE_TIMING',p=>p.scenes[1].start=4],['SPEAKING_RATE',p=>p.scenes[0].dialogue='긴 문장 '.repeat(50)]];
  for(const [code,change] of mutations){const e=example();change(e.plan);refresh(e.plan);assert.ok(codes(lintPlan(e.plan,e.packet,e.config)).includes(code),code);}
});
test('lint rejects duplicate content pair ledger and absent original format comparison',()=>{
  const e=example();let r=lintPlan(e.plan,e.packet,e.config,{items:{other:{account:e.plan.account,content:'CONTENT',stage:'complete'}}});assert.ok(codes(r).includes('DUPLICATE_CONTENT'));
  e.plan.formatComparison=[];refresh(e.plan);assert.ok(codes(lintPlan(e.plan,e.packet,e.config)).includes('FORMAT_COVERAGE'));
});
test('brand and forbidden punctuation fail generated copy but original metadata is retained',()=>{
  for(const [text,code] of [['예시상표','BRAND_IN_SCRIPT'],['이것·저것','COPY_PUNCTUATION'],['이것—저것','COPY_PUNCTUATION']]){const e=example();e.plan.scenes[0].dialogue=text;refresh(e.plan);assert.ok(codes(lintPlan(e.plan,e.packet,e.config)).includes(code));}
});
test('unsupported dosage/rank claims must be excluded from screenplay, with verification item',()=>{
  const e=example();e.plan.claims=[{id:'C1',text:'수치를 단정한다.',sourceIds:['CONTENT:L1'],sceneIds:['S1'],evidenceIds:[],disposition:'supported'}];e.plan.scenes[0].claimIds=['C1'];refresh(e.plan);
  assert.ok(codes(lintPlan(e.plan,e.packet,e.config)).includes('FACTUAL_EVIDENCE'));
  e.plan.claims[0]={...e.plan.claims[0],sceneIds:[],disposition:'excluded-pending-verification',verificationNeeded:'공식 근거 확인'};e.plan.scenes[0].claimIds=[];refresh(e.plan);
  assert.equal(lintPlan(e.plan,e.packet,e.config).ok,true);
  e.plan.scenes[0].dialogue=e.plan.claims[0].text;refresh(e.plan);assert.ok(codes(lintPlan(e.plan,e.packet,e.config)).includes('UNVERIFIED_IN_SCRIPT'));
});
test('independent criterion evidence is required and any plan edit invalidates review hash',()=>{
  const e=example();e.plan.editorialReview.reviewer=e.plan.author;assert.ok(codes(lintPlan(e.plan,e.packet,e.config)).includes('INDEPENDENT_REVIEW'));
  e.plan.editorialReview.reviewer='다른 검토자';e.plan.editorialReview.criteria=[];assert.ok(codes(lintPlan(e.plan,e.packet,e.config)).includes('REVIEW_CRITERION'));
  const d=example();d.plan.title='다른 제목';assert.ok(codes(lintPlan(d.plan,d.packet,d.config)).includes('REVIEW_VERSION'));
  const changed=example();changed.packet.format.beats[0].visual='다른 화면';assert.ok(codes(lintPlan(changed.plan,changed.packet,changed.config)).includes('REVIEW_PACKET_VERSION'));
});
test('Notion requests use actual schema; title marker fallback dedupes changed titles',()=>{
  const e=example(),body=renderPlan(e.plan,e.packet),r=notionRequests(e.plan,e.packet,e.config,body);
  assert.equal(r.create.arguments.parent.data_source_id,e.config.notion.dataSourceId);assert.equal(r.create.arguments.pages[0].properties['상태'],STATUS);assert.equal(r.create.arguments.pages[0].properties['자동화 ID'],e.packet.identity);
  delete e.config.notion.identityProperty;const fallback=notionRequests(e.plan,e.packet,e.config,body);assert.match(fallback.create.arguments.pages[0].properties['이름'],/\[rp-/);assert.match(fallback.dedupe.arguments.data.query,/instr/);
  e.config.notion.statusProperty='없는 상태';assert.throws(()=>notionRequests(e.plan,e.packet,e.config,body),{code:'NOTION_PROPERTY'});
});
test('dedupe rejects nonempty, wrong-query and truncated raw evidence',()=>{
  const e=example(),r=notionRequests(e.plan,e.packet,e.config,renderPlan(e.plan,e.packet));
  assert.ok(checkDedupe(dedupeEnvelope(r),r).evidenceHash);
  assert.throws(()=>checkDedupe(dedupeEnvelope(r,[{url:'https://example.org/existing'}]),r),{code:'DUPLICATE_NOTION'});
  const wrong=dedupeEnvelope(r);wrong.arguments={};assert.throws(()=>checkDedupe(wrong,r),{code:'EVIDENCE_REQUEST'});
  const cut=dedupeEnvelope(r);cut.response.content[0].text=JSON.stringify({results:[],truncated:true});assert.throws(()=>checkDedupe(cut,r),{code:'EVIDENCE_INCOMPLETE'});
});
test('receipt requires fetched ID, parent, status, marker and exact substantive content',()=>{
  const e=example(),r=notionRequests(e.plan,e.packet,e.config,renderPlan(e.plan,e.packet));
  assert.equal(verifyReceipt(receiptEnvelope(r,e.config),r,e.config).status,STATUS);
  for(const [change,code] of [[{id:'00000000-0000-0000-0000-000000000003'},'RECEIPT_ID'],[{parent:{data_source_id:'00000000-0000-0000-0000-000000000004'}},'RECEIPT_PARENT'],[{properties:{...r.create.arguments.pages[0].properties,상태:'업로드 완료'}},'RECEIPT_PROPERTY'],[{content:'다른 본문'},'RECEIPT_MARKER'],[{content:r.create.arguments.pages[0].content+'빠진 내용'},'RECEIPT_CONTENT'],[{truncated:true},'EVIDENCE_INCOMPLETE']]) assert.throws(()=>verifyReceipt(receiptEnvelope(r,e.config,change),r,e.config),{code});
  assert.throws(()=>verifyReceipt({tool:'create',response:{id:'fake'},fetchedAt:new Date().toISOString()},r,e.config),{code:'EVIDENCE_TOOL'});
});
test('receipt reads raw enhanced-Markdown fetch including parent-data-source and properties',()=>{
  const e=example(),r=notionRequests(e.plan,e.packet,e.config,renderPlan(e.plan,e.packet)),env=receiptEnvelope(r,e.config);
  const page=JSON.parse(env.response.content[0].text);
  env.response.content[0].text=JSON.stringify({url:page.url,text:`Here is fetch\n<page url="${page.url}">\n<ancestor-path><parent-data-source url="collection://${e.config.notion.dataSourceId}"/></ancestor-path>\n<properties>\n${JSON.stringify(page.properties)}\n</properties>\n<content>\n${page.content}\n</content>\n</page>`});
  assert.equal(verifyReceipt(env,r,e.config).identity,r.identity);
});
test('Notion table serialization normalizes only layout, and retains every cell and its order',()=>{
  const e=example(),r=notionRequests(e.plan,e.packet,e.config,renderPlan(e.plan,e.packet));
  const content=r.create.arguments.pages[0].content.replace('<table header-row="true">','<table header-row="true">\n<colgroup>\n<col width="338">\n<col width="338">\n</colgroup>').replace(/<tr><td>/g,'<tr>\n<td>').replace(/<\/td><td>/g,'</td>\n<td>').replace(/<\/td><\/tr>/g,'</td>\n</tr>');
  assert.equal(verifyReceipt(receiptEnvelope(r,e.config,{content}),r,e.config).status,STATUS);
  assert.throws(()=>verifyReceipt(receiptEnvelope(r,e.config,{content:content.replace('대사/자막','잘못된 셀')}),r,e.config),{code:'RECEIPT_CONTENT'});
});
test('CLI full lifecycle is idempotent and complete only after authoritative receipt; tampering fails checks',t=>{
  const f=fixture(t);f.prepare();const planFile=f.savePlan(f.plan);
  let r=execute({command:'render',...f.args,plan:planFile});assert.ok(r.ok);
  const base=path.join(f.run,'drafts',f.plan.packetId),requests=read(path.join(base,'notion-requests.json'));
  assert.throws(()=>checkRun(f.c(),f.run),{code:'NOT_COMPLETE'});
  const dedupe=path.join(f.dir,'dedupe.json');write(dedupe,dedupeEnvelope(requests));
  r=execute({command:'publish',...f.args,plan:planFile,dedupe});assert.equal(r.executed,false);assert.equal(read(path.join(f.run,'ledger.json')).items[f.plan.packetId].stage,'awaiting-notion');
  const evidence=path.join(f.dir,'receipt-evidence.json');write(evidence,receiptEnvelope(requests,f.c()));
  r=execute({command:'receipt',...f.args,plan:planFile,evidence});assert.equal(r.stage,'complete');
  const before=tree(f.run);execute({command:'receipt',...f.args,plan:planFile,evidence});assert.deepEqual(tree(f.run),before);assert.equal(checkRun(f.c(),f.run).ok,true);
  const check=spawnSync(process.execPath,[path.join(HERE,'../checks.mjs'),'--config',f.config,'--run-dir',f.run],{encoding:'utf8'});assert.equal(check.status,0,check.stderr);
  const stored=read(path.join(base,'plan.json'));stored.title='변조';write(path.join(base,'plan.json'),stored);assert.throws(()=>checkRun(f.c(),f.run),{code:'PLAN_LINT_FAILED'});
});
test('dry-run render/publish/receipt never changes ledger, artifacts, or timestamps',t=>{
  const f=fixture(t);f.prepare();const plan=f.savePlan(f.plan),before=tree(f.run);
  execute({command:'render',...f.args,plan,'dry-run':true});assert.deepEqual(tree(f.run),before);
  const packet=read(path.join(f.run,'packets',f.plan.packetId+'.json')),requests=notionRequests(f.plan,packet,f.c(),renderPlan(f.plan,packet));
  const dedupe=path.join(f.dir,'dedupe.json'),evidence=path.join(f.dir,'evidence.json');write(dedupe,dedupeEnvelope(requests));write(evidence,receiptEnvelope(requests,f.c()));
  execute({command:'publish',...f.args,plan,dedupe,'dry-run':true});execute({command:'receipt',...f.args,plan,evidence,'dry-run':true});assert.deepEqual(tree(f.run),before);
});
test('changes back up original bytes, reject path escape and never replace malformed ledger',t=>{
  const f=fixture(t);save(f.run,'one.json',{value:1});save(f.run,'one.json',{value:2});const files=tree(f.run);assert.equal(Object.keys(files).filter(p=>p.includes('backup')).length,1);
  assert.throws(()=>secureFile(f.run,'../outside.json'),{code:'PATH_ESCAPE'});
  write(path.join(f.run,'ledger.json'),{version:999,items:{important:'preserve'}});const before=fileHash(path.join(f.run,'ledger.json'));assert.throws(()=>f.prepare(),{code:'LEDGER_INVALID'});assert.equal(fileHash(path.join(f.run,'ledger.json')),before);
});
test('changed upstream source and packet tampering require reprepare',t=>{
  const f=fixture(t);f.prepare();const plan=f.savePlan(f.plan),packetFile=path.join(f.run,'packets',f.plan.packetId+'.json');const p=read(packetFile);p.format.beats[0].end=6;write(packetFile,p);
  assert.throws(()=>execute({command:'lint',...f.args,plan}),{code:'PACKET_CHANGED'});
  f.prepare();write(f.c().sources.beatsCsv,fs.readFileSync(f.c().sources.beatsCsv,'utf8')+'\n');assert.throws(()=>execute({command:'lint',...f.args,plan}),{code:'SOURCE_CHANGED'});
});
test('CSV preserves quoted multiline dialogue and escaped quote; body equality keeps substantive differences',()=>{
  assert.deepEqual(parseCsv('\uFEFFa,b\r\n"first\nsecond","say ""yes"""\r\n'),[{a:'first\nsecond',b:'say "yes"'}]);
  assert.equal(normalizeBody('one\r\n\r\ntwo\n'),'one\ntwo');assert.notEqual(normalizeBody('one two'),normalizeBody('one three'));
});
test('copied manual without git accepts sibling agent report runtime, while code folder stays protected',t=>{
  const f=fixture(t),copied=path.join(f.dir,'agent','업무','reels-planning','scripts'),run=path.join(f.dir,'agent','보고','릴스 기획안','etc','검증');
  fs.mkdirSync(copied,{recursive:true});
  for(const name of fs.readdirSync(path.join(HERE,'../scripts')))if(name.endsWith('.mjs'))fs.copyFileSync(path.join(HERE,'../scripts',name),path.join(copied,name));
  const r=spawnSync(process.execPath,[path.join(copied,'pipeline.mjs'),'prepare','--config',f.config,'--run-dir',run,'--dry-run'],{encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).ok,true);assert.equal(fs.existsSync(run),false);
  const forbidden=spawnSync(process.execPath,[path.join(copied,'pipeline.mjs'),'prepare','--config',f.config,'--run-dir',path.join(copied,'private'),'--dry-run'],{encoding:'utf8'});
  assert.equal(forbidden.status,1);assert.equal(JSON.parse(forbidden.stderr).error.code,'PRIVATE_RUNTIME');
});
