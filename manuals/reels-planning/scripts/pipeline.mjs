#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { need, read, save, hash, fileHash, json, locked, outsideRepo, loadLedger, checkpoint, secureFile } from './io.mjs';
import { loadConfig, prepare, validateExternal } from './data.mjs';
import { scaffold, lintPlan, renderPlan, planHash } from './plan.mjs';
import { notionRequests, checkDedupe, verifyReceipt } from './notion.mjs';

export function parseArgs(argv) {
  const [command,...rest]=argv, a={command};
  for(let i=0;i<rest.length;i++) {
    const key=rest[i];need(key.startsWith('--'),'CLI_ARGUMENT',`알 수 없는 인자: ${key}`);
    need(['--config','--run-dir','--plan','--packet','--evidence','--dedupe','--file','--dry-run'].includes(key),'CLI_ARGUMENT',`알 수 없는 옵션: ${key}`);
    need(a[key.slice(2)]===undefined,'CLI_ARGUMENT',`옵션 중복: ${key}`);
    if(key==='--dry-run')a['dry-run']=true;
    else {need(rest[i+1]&&!rest[i+1].startsWith('--'),'CLI_ARGUMENT',`${key} 값이 필요합니다.`);a[key.slice(2)]=rest[++i];}
  }
  return a;
}
function context(a) {
  need(a.config&&a['run-dir'],'CLI_ARGUMENT','--config와 --run-dir을 지정하세요.');
  const c=loadConfig(path.resolve(a.config)),run=outsideRepo(a['run-dir']);
  return {c,run,dry:!!a['dry-run']};
}
function prepared(c,run) {
  const manifest=read(path.join(run,'prepared.json'));
  need(manifest.configHash===hash(c),'PREPARE_STALE','설정이 바뀌었습니다. 같은 run-dir에서 prepare를 다시 실행하세요.');
  for(const [f,h] of Object.entries(manifest.fingerprints))need(fs.existsSync(f)&&fileHash(f)===h,'SOURCE_CHANGED','준비 후 자료가 바뀌었습니다. 변경을 확인한 뒤 prepare를 다시 실행하세요.');
  return manifest;
}
function readPlan(a,c,run) {
  need(a.plan,'CLI_ARGUMENT','--plan을 지정하세요.');
  outsideRepo(a.plan);
  const manifest=prepared(c,run),plan=read(a.plan);
  need(manifest.packets?.[plan.packetId],'PACKET_UNKNOWN','준비한 패킷 목록에 없는 packetId입니다.');
  const packet=read(secureFile(run,`packets/${plan.packetId}.json`));
  need(hash(packet)===manifest.packets[plan.packetId],'PACKET_CHANGED','패킷이 준비 이후 직접 수정됐습니다. 원본 보정 파일을 사용하세요.');
  const previous=loadLedger(run).items[packet.identity];
  need(previous?.stage!=='awaiting-notion'||previous.planHash===planHash(plan),'PENDING_REVISION','생성 결과 확인 전에는 해당 대본을 바꿀 수 없습니다. 먼저 기존 페이지를 조회하세요.');
  return {plan,packet};
}
function artifactBase(packet) {return `drafts/${packet.identity}`;}
function assertReport(report) {need(report.ok,'PLAN_LINT_FAILED',`대본 검사에서 ${report.errors.length}개 항목이 막혔습니다. lint-report.json을 확인하세요.`);}
function reviewedArtifacts(c,run,plan,packet,dry,ledger) {
  const base=artifactBase(packet),report=lintPlan(plan,packet,c,ledger);
  save(run,`${base}/lint-report.json`,report,dry);
  assertReport(report);
  const body=renderPlan(plan,packet),requests=notionRequests(plan,packet,c,body);
  save(run,`${base}/plan.json`,plan,dry);save(run,`${base}/기획안.md`,body,dry);
  save(run,`${base}/notion-requests.json`,requests,dry);
  save(run,`${base}/notion-dedupe-request.json`,requests.dedupe,dry);
  return {base,report,requests};
}
function recordBase(packet,plan) {return {account:packet.account,content:packet.refs.content,format:packet.refs.format,planHash:planHash(plan)};}

export function checkRun(c,run) {
  const manifest=prepared(c,run),ledger=loadLedger(run),items=[];
  need(Object.keys(manifest.packets).length>0,'NO_PACKETS','준비한 기획안이 없습니다.');
  for(const identity of Object.keys(manifest.packets)) {
    const entry=ledger.items[identity]; need(entry?.stage==='complete','NOT_COMPLETE',`${identity}: 노션 조회 검증이 완료되지 않았습니다.`);
    const packet=read(secureFile(run,`packets/${identity}.json`));need(hash(packet)===manifest.packets[identity],'PACKET_CHANGED','저장 패킷이 달라졌습니다.');
    const base=artifactBase(packet),plan=read(secureFile(run,`${base}/plan.json`));
    const report=lintPlan(plan,packet,c,ledger);assertReport(report);
    const requests=notionRequests(plan,packet,c,renderPlan(plan,packet));
    const envelope=read(secureFile(run,`${base}/notion-fetch-evidence.json`));
    const receipt=verifyReceipt(envelope,requests,c);
    need(entry.planHash===planHash(plan)&&entry.receiptHash===hash(receipt)&&hash(read(secureFile(run,`${base}/receipt.json`)))===hash(receipt),'LEDGER_MISMATCH','원장과 실제 검증 영수증이 다릅니다.');
    items.push({identity,url:receipt.url,status:receipt.status});
  }
  return {ok:true,items,paidCalls:0,semanticQuality:'independent-review-recorded-not-machine-proven',evidenceScope:'saved-authenticated-fetch-response'};
}

export function execute(a) {
  if(a.command==='review-hash') {need(a.plan,'CLI_ARGUMENT','--plan을 지정하세요.');outsideRepo(a.plan);return {planHash:planHash(read(a.plan)),...(a.packet?{packetHash:hash(read(a.packet))}:{})};}
  const {c,run,dry}=context(a);
  if(a.command==='check')return checkRun(c,run);
  need(['prepare','ingest','lint','render','publish','receipt'].includes(a.command),'CLI_COMMAND','prepare, ingest, lint, review-hash, render, publish, receipt, check 중 하나를 지정하세요.');
  return locked(run,dry,()=>{
    const ledger=loadLedger(run);
    if(a.command==='ingest') {
      need(a.file,'CLI_ARGUMENT','--file을 지정하세요.');outsideRepo(a.file);
      const doc=read(a.file),refs=validateExternal(doc,path.resolve(a.file));
      // artifact 상대경로가 달라지지 않게 등록 목록만 저장한다. 원본은 복사하거나 수정하지 않는다.
      const registered={path:path.resolve(a.file),sha256:fileHash(a.file),ids:refs.map(r=>r.id)};
      save(run,`ingested/${hash(registered).slice(0,24)}.json`,registered,dry);
      return {ok:true,dryRun:dry,registered,next:'config.externalReferences에 이 경로를 추가한 뒤 prepare를 실행하세요.',paidCalls:0};
    }
    if(a.command==='prepare') {
      const result=prepare(c),packets={};
      const before=fs.existsSync(path.join(run,'prepared.json'))?read(path.join(run,'prepared.json')):null;
      for(const [id,item] of Object.entries(ledger.items)) if(['awaiting-notion','complete'].includes(item.stage)) {
        const fresh=result.selected.find(p=>p.identity===id);
        need(fresh&&before?.packets?.[id]===hash(fresh),'PUBLISHED_INPUT_CHANGE','게시 준비 또는 완료한 패킷은 새 실행 폴더에서 변경하세요.');
      }
      for(const packet of result.selected) {
        packets[packet.identity]=hash(packet);save(run,`packets/${packet.identity}.json`,packet,dry);
        const planPath=secureFile(run,`plans/${packet.identity}.json`);
        if(!fs.existsSync(planPath))save(run,`plans/${packet.identity}.json`,scaffold(packet),dry);
        if(!ledger.items[packet.identity])checkpoint(run,ledger,packet.identity,{stage:'prepared',account:packet.account,content:packet.refs.content,format:packet.refs.format},dry);
      }
      for(const [id,item] of Object.entries(ledger.items)) if(!packets[id]&&['prepared','reviewed'].includes(item.stage))checkpoint(run,ledger,id,{stage:'superseded'},dry);
      const {selected,...manifest}=result;
      save(run,'config.snapshot.json',c,dry);
      save(run,'prepared.json',{...manifest,packets},dry);
      save(run,'source-ledger.jsonl',result.sourceLedger.map(x=>JSON.stringify(x)).join('\n')+'\n',dry);
      return {ok:result.selected.length>0,dryRun:dry,selected:result.selected.map(p=>({identity:p.identity,refs:p.refs,account:p.account,selection:p.selection,score:p.score})),candidatePairs:result.pairRanking.length,checkedSources:result.sourceLedger.length,paidCalls:0,warnings:result.selected.length<c.selection.count?['요청 수만큼 서로 다른 내용 조합을 찾지 못했습니다. 기준을 임의로 낮추지 않았습니다.']:[]};
    }
    const {plan,packet}=readPlan(a,c,run),base=artifactBase(packet),report=lintPlan(plan,packet,c,ledger);
    save(run,`${base}/lint-report.json`,report,dry);
    if(a.command==='lint')return {...report,dryRun:dry,reportPath:path.join(run,base,'lint-report.json')};
    assertReport(report);
    const {requests}=reviewedArtifacts(c,run,plan,packet,dry,ledger);
    if(a.command==='render') {
      if(!['awaiting-notion','complete'].includes(ledger.items[packet.identity]?.stage))checkpoint(run,ledger,packet.identity,{...recordBase(packet,plan),stage:'reviewed'},dry);
      return {ok:true,dryRun:dry,identity:packet.identity,markdown:path.join(run,base,'기획안.md'),dedupeRequest:path.join(run,base,'notion-dedupe-request.json'),paidCalls:0};
    }
    if(a.command==='publish') {
      if(ledger.items[packet.identity]?.stage==='complete') return {ok:true,alreadyComplete:true,receipt:ledger.items[packet.identity].receipt,paidCalls:0};
      need(a.dedupe,'DEDUPE_REQUIRED','인증된 노션 중복 조회 결과를 --dedupe로 지정하세요.');
      const evidence=read(a.dedupe),dedupe=checkDedupe(evidence,requests);
      need(Date.now()-Date.parse(evidence.fetchedAt)>=-60000&&Date.now()-Date.parse(evidence.fetchedAt)<=15*60000,'DEDUPE_STALE','중복 조회가 15분을 넘었습니다. 생성 직전에 다시 조회하세요.');
      const prior=ledger.items[packet.identity];
      need(prior?.stage!=='awaiting-notion'||prior.requestHash===requests.requestHash,'PENDING_REVISION','생성 결과를 확인하기 전에 같은 조합의 대본을 바꿀 수 없습니다. 먼저 receipt를 확인하세요.');
      save(run,`${base}/notion-dedupe-evidence.json`,evidence,dry);
      save(run,`${base}/notion-create-request.json`,requests.create,dry);
      checkpoint(run,ledger,packet.identity,{...recordBase(packet,plan),stage:'awaiting-notion',requestHash:requests.requestHash,dedupe,receipt:null},dry);
      return {ok:true,dryRun:dry,stage:'awaiting-notion',operationRequest:path.join(run,base,'notion-create-request.json'),executed:false,paidCalls:0,note:'도구 실행은 현재 인증된 호스트 에이전트가 맡습니다. 완료는 receipt에서 검증합니다.'};
    }
    need(a.evidence,'RECEIPT_REQUIRED','실제 페이지 재조회 결과를 --evidence로 지정하세요.');
    const envelope=read(a.evidence),receipt=verifyReceipt(envelope,requests,c);
    // 조회 근거와 영수증을 먼저 보존한 뒤 원장을 완료로 바꾼다. 중단돼도 재실행할 수 있다.
    save(run,`${base}/notion-fetch-evidence.json`,envelope,dry);save(run,`${base}/receipt.json`,receipt,dry);
    checkpoint(run,ledger,packet.identity,{...recordBase(packet,plan),stage:'complete',requestHash:requests.requestHash,receiptHash:hash(receipt),receipt:receipt.url},dry);
    return {ok:true,dryRun:dry,stage:'complete',receipt,paidCalls:0};
  });
}
export function main(argv=process.argv.slice(2)) {
  if(!argv.length||argv.includes('--help')||argv[0]==='help') {
    console.log(`릴스 기획안 CLI (Node 내장 모듈, 유료 호출 없음)\nprepare --config <JSON> --run-dir <DIR> [--dry-run]\ningest --config <JSON> --run-dir <DIR> --file <외부원본JSON>\nlint|render --config <JSON> --run-dir <DIR> --plan <JSON> [--dry-run]\nreview-hash --plan <JSON>\npublish --config <JSON> --run-dir <DIR> --plan <JSON> --dedupe <조회증거JSON>\nreceipt --config <JSON> --run-dir <DIR> --plan <JSON> --evidence <페이지조회증거JSON>\ncheck --config <JSON> --run-dir <DIR>\n\nprepare 출력: packets/<packetId>.json, plans/<packetId>.json\n작업 결과: drafts/<packetId>/, ledger.json. 기존 파일은 etc/backup/에 보존합니다.\n조회 증거: {tool, arguments, fetchedAt, response: <원본 커넥터 응답>}\n전체 예제: node scripts/schema.mjs`);return;
  }
  try {const result=execute(parseArgs(argv));console.log(json(result));if(result.ok===false)process.exitCode=1;}
  catch(e) {console.error(json({ok:false,error:{code:e.code||'UNEXPECTED',message:e.message},paidCalls:0}));process.exitCode=1;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main();
