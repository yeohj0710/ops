#!/usr/bin/env node
// 모두 가상 값이다. 실제 계정·기획안·원문·자격증명은 넣지 않는다.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { STATUS, hash, json } from './io.mjs';
import { planHash, REQUIRED_CRITERIA } from './plan.mjs';

export function example() {
  const config={version:1,account:'예시 계정',accounts:['예시 계정'],asOf:'2026-09-26',
    sources:{public:'inputs/reels.json',private:'inputs/plan-data.json',beatsCsv:'inputs/beats.csv'},
    benchmarks:'benchmarks.json',externalReferences:[],referenceOverlays:[],brandNames:['예시상표'],
    selection:{minViews:500000,maxAgeMonths:3,minContentScore:.7,minFormatScore:.7,count:1},
    limits:{maxCharactersPerSecond:9},
    notion:{dataSourceId:'00000000-0000-0000-0000-000000000001',titleProperty:'이름',statusProperty:'상태',accountProperty:'계정',identityProperty:'자동화 ID',
      schema:{이름:{type:'title'},상태:{type:'status',options:[STATUS]},계정:{type:'select',options:['예시 계정']},'자동화 ID':{type:'rich_text'}}}};
  const benchmark={id:'BENCHMARK-EXAMPLE',account:'예시 계정',title:'가상 게시 완료 기준',notionUrl:'https://example.org/benchmark',publishedUrl:'https://example.org/published',status:'published',accepted:true,videoViewed:true,
    screenplay:'실물 종이를 두 칸으로 나누고 정면에서 짧게 묻고 답한다. 앞 장면의 질문을 다음 장면의 행동으로 답한다.',
    criteria:REQUIRED_CRITERIA.map(id=>({id,label:id,evidence:'첫 장면의 종이 두 칸과 다음 장면의 손동작이 이어진다.'}))};
  const content={id:'CONTENT',url:'https://example.org/content',account:'예시 원본',title:'종이를 두 칸으로 나누는 시연',topic:'정리',posted:'2026-08-20',measured:'2026-09-01',views:700000,ad:'no',contentScore:.9,formatScore:.8,
    lines:[{id:'CONTENT:L1',at:0,text:'종이를 두 칸으로 나눠요.',source:'가상 대사'},{id:'CONTENT:L2',at:5,text:'왼쪽과 오른쪽에 하나씩 놓아요.',source:'가상 대사'}],facts:[],beats:[]};
  const format={...content,id:'FORMAT',url:'https://example.org/format',title:'예시상표가 있는 원본 메타데이터',topic:'수납',
    lines:[{id:'FORMAT:L1',at:0,text:'어느 쪽에 둘까요?',source:'가상 대사'},{id:'FORMAT:L2',at:5,text:'이쪽 칸에 둬요.',source:'가상 대사'}],
    beats:[{id:'FORMAT:B1',start:0,end:5,role:'질문',dialogue:'어느 쪽에 둘까요?',caption:'어느 쪽?',visual:'종이 두 칸을 정면에서 가리킨다.'},{id:'FORMAT:B2',start:5,end:10,role:'시연',dialogue:'이쪽 칸에 둬요.',caption:'이쪽',visual:'종이 위로 손을 내려 물건을 놓는다.'}]};
  const identity='rp-'+hash({account:config.account,content:content.id,format:format.id}).slice(0,24);
  const packet={identity,account:config.account,refs:{content:content.id,format:format.id},content,format,benchmarks:[benchmark],brandNames:config.brandNames};
  const plan={version:1,packetId:identity,account:config.account,title:'종이 두 칸 정리',author:'작성자 예시',status:STATUS,refs:packet.refs,benchmarkIds:[benchmark.id],seconds:10,
    scenes:[{id:'S1',start:0,end:5,role:'질문',dialogue:'종이를 두 칸으로 나눠볼까요?',action:'흰 종이 가운데 선을 긋고 두 칸을 가리킨다.',camera:'책상 위 고정 정면',caption:'두 칸으로 나누기',edit:'손가락이 멈추면 다음 컷으로 전환',contentIds:['CONTENT:L1'],formatBeatIds:['FORMAT:B1'],claimIds:[]},
      {id:'S2',start:5,end:10,role:'시연',dialogue:'왼쪽과 오른쪽에 하나씩 놓아요.',action:'왼쪽에는 동그라미, 오른쪽에는 세모를 놓는다.',camera:'같은 구도에서 손과 종이 근접',caption:'하나씩 놓기',edit:'완성한 두 칸을 마지막 1초 유지',contentIds:['CONTENT:L2'],formatBeatIds:['FORMAT:B2'],claimIds:[]}],
    claims:[],evidence:[],editorNotes:'손동작과 대사를 동시에 시작한다. 두 번째 컷에서도 종이 위치를 유지한다.',
    formatComparison:[{formatBeatId:'FORMAT:B1',sceneIds:['S1'],retained:'질문하며 두 칸을 가리키는 화면',changed:'질문 대상을 종이 구획으로 변경',reason:'내용 원본의 분류 동작을 같은 질문 슬롯에 넣었다.'},
      {formatBeatId:'FORMAT:B2',sceneIds:['S2'],retained:'질문 직후 손으로 답하는 시연',changed:'물건 대신 모양 두 개를 놓는다.',reason:'같은 손 이동과 정지 시간을 촬영할 수 있다.'}],
    editorialReview:{reviewer:'검토자 예시',authorSession:'fictional-author-session',reviewerSession:'fictional-review-session',independent:true,decision:'pass',reviewedAt:'2026-09-26T10:00:00Z',reviewedPlanHash:'',
      criteria:REQUIRED_CRITERIA.map(id=>({id,benchmarkId:benchmark.id,sceneIds:['S1','S2'],benchmarkEvidence:'첫 질문의 종이 두 칸을 두 번째 손동작으로 완성한다.',planEvidence:'S1의 질문과 S2의 손동작이 이어진다. 실제 낭독 속도는 검토자가 확인해야 한다.',verdict:'pass'}))}};
  plan.editorialReview.reviewedPlanHash=planHash(plan);
  plan.editorialReview.reviewedPacketHash=hash(packet);
  return {notice:'계약 설명용 가상 예제이며 실제 검토 증거로 사용하지 않습니다.',config,benchmarkSnapshot:{version:1,benchmarks:[benchmark]},packet,plan,
    fetchEvidence:{tool:'mcp__codex_apps__notion_fetch',arguments:{id:'실제 생성 페이지 ID'},fetchedAt:'실제 조회 시각',response:'실제 인증된 커넥터의 원본 응답 객체를 그대로 저장'},
    reviewRules:'검토자가 실제로 읽은 뒤 기준별 근거를 작성합니다. 예제의 pass 값을 복사하지 않습니다.'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)console.log(json(example()));
