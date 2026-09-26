import fs from 'node:fs';
import path from 'node:path';
import { read, need, nonempty, list, hash, fileHash, outsideRepo, httpUrl, dateValue, parseCsv } from './io.mjs';

export function loadConfig(file) {
  outsideRepo(file);
  const c = read(file), base = path.dirname(path.resolve(file));
  need(nonempty(c.account) && Number.isFinite(dateValue(c.asOf)), 'CONFIG_ACCOUNT_DATE', 'account와 고정 asOf 날짜가 필요합니다.');
  for (const k of ['public', 'private', 'beatsCsv']) need(nonempty(c.sources?.[k]), 'CONFIG_SOURCE', `sources.${k} 경로가 필요합니다.`);
  need(nonempty(c.benchmarks), 'CONFIG_BENCHMARKS', 'benchmarks 경로가 필요합니다.');
  const resolve = p => path.resolve(base, p);
  c.sources = Object.fromEntries(Object.entries(c.sources).map(([k, v]) => [k, resolve(v)]));
  c.benchmarks = resolve(c.benchmarks);
  c.externalReferences = list(c.externalReferences).map(resolve);
  c.referenceOverlays = list(c.referenceOverlays).map(resolve);
  c.accounts = Array.from(new Set([c.account,...list(c.accounts)]));
  c.selection = { minViews: 500000, maxAgeMonths: 3, minContentScore: .7, minFormatScore: .7, count: 3, ...c.selection };
  for (const k of ['minViews', 'maxAgeMonths', 'minContentScore', 'minFormatScore', 'count',...(c.selection.maxAgeDays===undefined?[]:['maxAgeDays'])]) need(Number.isFinite(c.selection[k]) && c.selection[k] >= 0, 'CONFIG_SELECTION', `selection.${k} 값이 잘못됐습니다.`);
  need(Number.isInteger(c.selection.maxAgeMonths),'CONFIG_SELECTION','maxAgeMonths는 정수입니다.');
  need(Number.isInteger(c.selection.count) && c.selection.count >= 1, 'CONFIG_COUNT', 'count는 1 이상의 정수입니다.');
  c.brandNames = list(c.brandNames);
  need(c.brandNames.every(nonempty), 'CONFIG_BRANDS', 'brandNames는 브랜드명 문자열 배열입니다.');
  return c;
}

export function loadBenchmarks(c) {
  const doc = read(c.benchmarks), bs = Array.isArray(doc) ? doc : doc.benchmarks;
  need(Array.isArray(bs) && bs.length > 0, 'BENCHMARK_EMPTY', '게시 완료 기준 기획안이 필요합니다.');
  const ids = new Set();
  for (const b of bs) {
    need(nonempty(b.id) && !ids.has(b.id), 'BENCHMARK_ID', '기준 기획안 ID가 없거나 중복됐습니다.'); ids.add(b.id);
    if (b.status === '업로드 완료') {
      need(nonempty(b.statusEvidence) && Number.isFinite(dateValue(b.verifiedAt)) && nonempty(b.page), 'BENCHMARK_STATUS_EVIDENCE', `${b.id}: 업로드 상태 조회 근거가 필요합니다.`);
      b.notionUrl=b.url; b.screenplay=b.content; b.accepted=true;
      b.publicationEvidence='notion-uploaded-status';
      b.criteria=list(doc.criteria).map(id=>({id,label:id,evidence:list(b.standards).join('\n')}));
    }
    need(nonempty(b.account) && b.accepted === true && ['published','업로드 완료'].includes(b.status), 'BENCHMARK_ACCEPTANCE', `${b.id}: 채택·게시된 기획안만 기준으로 씁니다.`);
    need(httpUrl(b.notionUrl) && (httpUrl(b.publishedUrl) || b.publicationEvidence==='notion-uploaded-status') && nonempty(b.title) && nonempty(b.screenplay), 'BENCHMARK_SOURCE', `${b.id}: 원문·게시 확인 근거와 실제 기획안 전문이 필요합니다.`);
    need(list(b.criteria).length > 0 && b.criteria.every(x => nonempty(x.id) && nonempty(x.label) && nonempty(x.evidence)), 'BENCHMARK_CRITERIA', `${b.id}: 항목별 기준 근거가 필요합니다.`);
    need(new Set(b.criteria.map(x => x.id)).size === b.criteria.length, 'BENCHMARK_CRITERIA_DUPLICATE', `${b.id}: 기준 항목 ID가 중복됐습니다.`);
  }
  return bs;
}

function validBeats(beats) {
  let end = 0; const ids = new Set();
  return beats.length > 0 && beats.every(b => {
    const ok = nonempty(b.id) && !ids.has(b.id) && Number.isFinite(b.start) && Number.isFinite(b.end) && b.start >= end - .05 && b.start >= 0 && b.end > b.start && nonempty(b.role) && nonempty(b.visual);
    ids.add(b.id); end = b.end; return ok;
  });
}
export function validateExternal(doc, file) {
  need(doc.version === 1 && Array.isArray(doc.references), 'EXTERNAL_SHAPE', '외부 레퍼런스는 version:1, references 배열이 필요합니다.');
  const seen = new Set();
  for (const r of doc.references) {
    need(nonempty(r.id) && !seen.has(r.id) && httpUrl(r.url), 'EXTERNAL_ID', '외부 원본 ID·HTTPS URL이 없거나 ID가 중복됐습니다.'); seen.add(r.id);
    const sourceUrl=new URL(r.url), instagram=/(^|\.)instagram\.com$/i.test(sourceUrl.hostname);
    need(!['image','carousel','캐러셀','카드뉴스'].includes(r.mediaType) && (!instagram || /^\/(?:[^/]+\/)?reels?\/[^/]+\/?$/.test(sourceUrl.pathname)), 'EXTERNAL_NOT_REEL', '카드뉴스와 /p/ 게시물은 릴스 원본으로 등록하지 않습니다. 실제 릴스 주소와 영상 자료를 확인하세요.');
    const p = r.provenance;
    need(p && p.sourceUrl === r.url && nonempty(p.reviewedBy) && Number.isFinite(dateValue(p.reviewedAt)), 'EXTERNAL_PROVENANCE', `${r.id}: 출처 확인자와 확인일이 필요합니다.`);
    for (const k of ['transcript', 'visual']) {
      const v = p[k];
      need(v?.verified === true && nonempty(v.method) && nonempty(v.artifact) && /^[a-f0-9]{64}$/i.test(v.sha256 || ''), 'EXTERNAL_PROVENANCE', `${r.id}: ${k} 출처·검수·해시가 필요합니다.`);
      const artifact = path.resolve(path.dirname(file), v.artifact);
      need(fs.existsSync(artifact) && fileHash(artifact) === v.sha256, 'EXTERNAL_HASH', `${r.id}: ${k} 원본 파일 해시가 다릅니다.`);
    }
    need(list(r.lines).length > 0 && r.lines.every(l => nonempty(l.id) && nonempty(l.text) && Number.isFinite(l.at) && l.at >= 0), 'EXTERNAL_TRANSCRIPT', `${r.id}: 시간과 ID가 있는 대사가 필요합니다.`);
    need(new Set(r.lines.map(l => l.id)).size === r.lines.length, 'EXTERNAL_TRANSCRIPT', `${r.id}: 대사 ID가 중복됐습니다.`);
    need(validBeats(list(r.beats)), 'EXTERNAL_BEATS', `${r.id}: 실제 비트 시간·역할·화면 관찰이 필요합니다.`);
    need(nonempty(r.topic) && nonempty(r.title) && Number.isFinite(dateValue(r.posted)) && Number.isFinite(dateValue(r.measured)) && Number.isFinite(r.views) && r.views >= 0 && ['no', 'yes', 'unknown'].includes(r.ad), 'EXTERNAL_METRICS', `${r.id}: 주제·게시일·측정일·조회수·광고 확인값이 필요합니다.`);
    need(['contentScore','formatScore'].every(k => Number.isFinite(r[k]) && r[k] >= 0 && r[k] <= 1), 'EXTERNAL_SCORE', `${r.id}: 0~1 적합도 점수가 필요합니다.`);
    need(list(r.brandNames).every(nonempty),'EXTERNAL_BRANDS',`${r.id}: brandNames는 문자열 배열이어야 합니다.`);
    need(list(r.facts).every(f=>f&&nonempty(f.id)&&nonempty(f.quote)),'EXTERNAL_FACTS',`${r.id}: 사실 카드에는 ID와 원문 quote가 필요합니다.`);
  }
  return doc.references;
}
const normal = t => String(t).normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
function bigrams(t) { t = normal(t); return new Set(Array.from({ length: Math.max(0,t.length-1) }, (_,i) => t.slice(i,i+2))); }
function similarity(a,b) { const x=bigrams(a), y=bigrams(b); return x.size && y.size ? [...x].filter(v=>y.has(v)).length / new Set([...x,...y]).size : 0; }
const duplicateText = (a,b) => similarity(a.lines.map(x=>x.text).join(' '),b.lines.map(x=>x.text).join(' ')) >= .8;
const seconds = r => r.beats.at(-1)?.end || (r.lines.at(-1)?.at || 0) + 3;
const uniq = x => [...new Set(x)];

export function loadReferences(c) {
  const pub = read(c.sources.public), priv = read(c.sources.private);
  need(Array.isArray(pub.rows) && priv.sources && Array.isArray(priv.rows), 'JEV_SHAPE', 'Jev rows/sources 형식이 잘못됐습니다.');
  const raw = parseCsv(fs.readFileSync(c.sources.beatsCsv, 'utf8')), byCode = new Map();
  for (const b of raw) {
    if (!byCode.has(b.shortcode)) byCode.set(b.shortcode, []);
    byCode.get(b.shortcode).push({ id: `${b.shortcode}:B${b['번호']}`, start: Number(b['시작초']), end: Number(b['끝초']), role: b['기능'], dialogue: b['할말'], caption: b['화면자막'], visual: b['화면'], provenance: 'raw-beats-csv' });
  }
  const refs = pub.rows.map(r => {
    const source = priv.sources[r.c]?.story || {};
    const lines = list(source.lines).map((l,i) => ({ ...l, id: `${r.c}:L${i+1}` }));
    const facts = list(source.facts).map((f,i) => ({ ...f, id: `${r.c}:F${i+1}` }));
    return { id:r.c, url:`https://www.instagram.com/reel/${r.c}/`, account:r.h, title:r.t, topic:r.cat, posted:r.posted, measured:r.measured, views:r.v, ad:r.ad, contentScore:r.s, formatScore:r.f, lines, facts, checked:list(source.checked), truncated:!!source.truncated,
      beats:(byCode.get(r.c) || []).sort((a,b)=>a.start-b.start), source:'jev', brandNames:[] };
  });
  for (const file of c.externalReferences) for (const r of validateExternal(read(file), file)) {
    need(!refs.some(x => x.id === r.id || x.url.replace(/\/$/,'') === r.url.replace(/\/$/,'')), 'EXTERNAL_DUPLICATE', `${r.id}: 기존 원본과 ID 또는 URL이 겹칩니다.`);
    refs.push({ ...r, facts:list(r.facts), checked:list(r.checked), source:'external' });
  }
  for (const file of c.referenceOverlays) {
    const doc=read(file); need(doc.version===1 && Array.isArray(doc.references),'OVERLAY_SHAPE','보정 파일은 version:1, references 배열이 필요합니다.');
    for(const overlay of doc.references) {
      const index=refs.findIndex(r=>r.id===overlay.id);
      need(index>=0,'OVERLAY_UNKNOWN','원본에 없는 ID는 externalReferences로 등록하세요.');
      const base=refs[index], merged={...base,...overlay,url:base.url,id:base.id};
      validateExternal({version:1,references:[merged]},file);
      need(!overlay.lines || hash(overlay.lines)===hash(base.lines) || nonempty(overlay.transcriptCorrectionReason),'OVERLAY_TRANSCRIPT_REASON','대사를 고치면 transcriptCorrectionReason을 남깁니다.');
      refs[index]={...merged,originalBeats:base.beats,source:base.source,overlayFileHash:fileHash(file)};
    }
  }
  need(new Set(refs.map(r=>r.id)).size === refs.length, 'SOURCE_DUPLICATE', '원본 ID가 중복됐습니다.');
  return refs;
}

export function prepare(c) {
  const benchmarks = loadBenchmarks(c), refs = loadReferences(c), cutoff=dateValue(c.asOf), s=c.selection;
  const day=new Date(cutoff),first=new Date(Date.UTC(day.getUTCFullYear(),day.getUTCMonth()-s.maxAgeMonths,1));
  const last=new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth()+1,0)).getUTCDate();
  const calendarCutoff=Date.UTC(first.getUTCFullYear(),first.getUTCMonth(),Math.min(day.getUTCDate(),last));
  const earliest=s.maxAgeDays===undefined?calendarCutoff:cutoff-s.maxAgeDays*86400000;
  const sourceLedger=refs.map(r => {
    const reasons=[]; const age=(cutoff-dateValue(r.posted))/86400000;
    if (!Number.isFinite(r.views) || r.views < s.minViews) reasons.push('views');
    if (!Number.isFinite(age) || age < 0 || dateValue(r.posted)<earliest) reasons.push('published-date');
    if (!Number.isFinite(dateValue(r.measured)) || dateValue(r.measured)>cutoff+86400000) reasons.push('measurement-date');
    if (r.ad !== 'no') reasons.push('advertisement-unverified');
    const content=reasons.length===0 && r.contentScore>=s.minContentScore && r.lines.length>0 && !r.truncated;
    const format=reasons.length===0 && r.formatScore>=s.minFormatScore && validBeats(r.beats);
    return {id:r.id,content,format,reasons:[...reasons,...(!r.lines.length?['no-dialogue']:[]),...(r.truncated?['truncated-dialogue']:[]),...(!validBeats(r.beats)?['no-usable-raw-beats']:[])]};
  });
  const contentIds=new Set(sourceLedger.filter(r=>r.content).map(r=>r.id)), formatIds=new Set(sourceLedger.filter(r=>r.format).map(r=>r.id));
  const pairs=[], rejected=[];
  const manual=list(s.pairs), manualIds=new Set(manual.flatMap(p=>[p.content,p.format]));
  for(const p of manual) {
    need(refs.some(r=>r.id===p.content)&&refs.some(r=>r.id===p.format),'PAIR_UNKNOWN','수동 조합에 없는 원본 ID가 있습니다.');
    need(nonempty(p.reason)&&nonempty(p.reviewedBy)&&Number.isFinite(dateValue(p.reviewedAt)),'PAIR_REVIEW','수동 조합의 이유·검토자·검토일이 필요합니다.');
    need((contentIds.has(p.content)&&formatIds.has(p.format))||nonempty(p.eligibilityException),'PAIR_ELIGIBILITY','기준 밖 수동 조합은 eligibilityException 이유가 필요합니다.');
    need(!p.account||c.accounts.includes(p.account),'PAIR_ACCOUNT','수동 조합 계정은 config.accounts에 등록해야 합니다.');
  }
  for (const a of refs.filter(r=>contentIds.has(r.id)||manualIds.has(r.id))) for (const b of refs.filter(r=>formatIds.has(r.id)||manualIds.has(r.id))) {
    const pairKey=`${a.id}::${b.id}`;
    const chosen=manual.find(p=>p.content===a.id&&p.format===b.id);
    if(manual.length&&!chosen) continue;
    if(!a.lines.length || a.truncated || !validBeats(b.beats)) {rejected.push({pairKey,reason:'missing-dialogue-or-raw-beats'});continue;}
    if(a.id===b.id || a.url.replace(/\/$/,'')===b.url.replace(/\/$/,'')) {rejected.push({pairKey,reason:'same-reference'});continue;}
    if(duplicateText(a,b)) {rejected.push({pairKey,reason:'duplicate-dialogue'});continue;}
    const body=b.beats.filter(x=>! /훅|도입|CTA|마무리|브랜딩|엔딩|전환/i.test(x.role));
    const available=Math.max(a.facts.length, a.beats.filter(x=>! /훅|도입|CTA|마무리|엔딩/i.test(x.role)).length, Math.ceil(a.lines.length/2));
    const required=Math.max(body.length,1), slotFit=Math.min(available,required)/Math.max(available,required);
    const durationFit=Math.min(seconds(a),seconds(b))/Math.max(seconds(a),seconds(b));
    const sameTopic=normal(a.topic)===normal(b.topic), topicOverlap=similarity(a.title,b.title);
    if(!chosen&&(available<required/2 || durationFit<.3)) {rejected.push({pairKey,reason:'slot-duration-mismatch'});continue;}
    // 기계 점수는 구조 비교 우선순위이며 의미 적합도 합격 판정이 아니다.
    const score=Number((slotFit*.45+durationFit*.2+a.contentScore*.15+b.formatScore*.15+(sameTopic?.05:0)-topicOverlap*.1).toFixed(6));
    const account=chosen?.account||c.account,identity='rp-'+hash({account,content:a.id,format:b.id}).slice(0,24);
    pairs.push({identity,pairKey,account,score,selection:chosen?{mode:'reviewed',...chosen}:{mode:'ranked'},compatibility:{slotFit,durationFit,availableContentSlots:available,requiredFormatSlots:required,sameTopic,titleOverlap:topicOverlap,semanticQuality:'requires-independent-review'},
      refs:{content:a.id,format:b.id},content:a,format:b,benchmarks,brandNames:uniq([...c.brandNames,...list(a.brandNames),...list(b.brandNames)])});
  }
  pairs.sort((a,b)=>b.score-a.score||a.pairKey.localeCompare(b.pairKey,'en'));
  // 같은 내용으로 여러 편을 뽑지 않는다. 나머지 후보 점수도 보존한다.
  const selected=[], used=new Set();
  for(const p of pairs) if(selected.length<s.count&&!used.has(p.content.id)&&!selected.some(x=>duplicateText(x.content,p.content))) {selected.push(p);used.add(p.content.id);}
  const fingerprints=Object.fromEntries([...Object.values(c.sources),c.benchmarks,...c.externalReferences,...c.referenceOverlays].map(f=>[f,fileHash(f)]));
  for(const file of [...c.externalReferences,...c.referenceOverlays])for(const r of read(file).references)for(const kind of ['transcript','visual']) {
    const artifact=path.resolve(path.dirname(file),r.provenance[kind].artifact);fingerprints[artifact]=fileHash(artifact);
  }
  return {version:1,asOf:c.asOf,account:c.account,paidCalls:0,configHash:hash(c),fingerprints,selected,pairRanking:pairs.map(({identity,pairKey,score,compatibility})=>({identity,pairKey,score,compatibility})),sourceLedger,rejectedPairs:rejected};
}
