import { need, nonempty, list, hash, STATUS, dateValue, httpUrl } from './io.mjs';

export const CREATE='mcp__codex_apps__notion_notion_create_pages';
export const FETCH='mcp__codex_apps__notion_fetch';
export const QUERY='mcp__codex_apps__notion_query_data_sources';
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{32}$/i.test(x.replace(/-/g,''));
const idOf=x=>String(x||'').replace(/-/g,'').match(/[a-f0-9]{32}(?=\?|$|\/)/i)?.[0]?.toLowerCase();
const propName=x=>/^(id|url)$/i.test(x)?'userDefined:'+x:x;
export function schemaConfig(c) {
  const n=c.notion;
  need(n&&uuid(n.dataSourceId),'NOTION_PARENT','실제 노션 dataSourceId가 필요합니다.');
  const schema=n.schema?.properties||n.schema;
  need(schema&&typeof schema==='object'&&!Array.isArray(schema),'NOTION_SCHEMA','조회한 속성 스키마 객체가 필요합니다.');
  for(const [key,type] of [['titleProperty','title'],['statusProperty','status']]) {
    const p=schema[n[key]], actual=typeof p==='string'?p:p?.type;
    need(nonempty(n[key])&&(actual===type||(type==='status'&&actual==='select')),'NOTION_PROPERTY',`${key}의 실제 속성 이름·형식을 확인하세요.`);
  }
  const p=schema[n.statusProperty],opts=p?.options||p?.[p?.type]?.options;
  need(list(opts).some(x=>(typeof x==='string'?x:x.name)===STATUS),'NOTION_STATUS_OPTION',`실제 상태 선택지에 ${STATUS}가 있어야 합니다.`);
  for(const k of ['accountProperty','identityProperty']) if(n[k]) need(schema[n[k]],'NOTION_PROPERTY',`${k} 속성이 실제 스키마에 없습니다.`);
  if(n.identityProperty) need(['text','rich_text'].includes(schema[n.identityProperty]?.type||schema[n.identityProperty]),'NOTION_IDENTITY_TYPE','식별자는 text/rich_text 속성이어야 합니다.');
  return {...n,schema};
}
function validateProperties(properties,schema) {
  for(const [name,value] of Object.entries(properties)) {
    const p=schema[name],type=p?.type||p;
    need(p,'NOTION_UNKNOWN_PROPERTY',`${name} 속성이 스키마에 없습니다.`);
    if(['title','text','rich_text','select','status','url'].includes(type)) need(typeof value==='string','NOTION_PROPERTY_VALUE',`${name}는 문자열이어야 합니다.`);
    else if(type==='number') need(Number.isFinite(value),'NOTION_PROPERTY_VALUE',`${name}는 숫자여야 합니다.`);
    else if(type==='checkbox') need(['__YES__','__NO__'].includes(value),'NOTION_PROPERTY_VALUE',`${name} 체크값이 잘못됐습니다.`);
    else if(['multi_select','relation'].includes(type)) need(Array.isArray(value)&&value.every(nonempty),'NOTION_PROPERTY_VALUE',`${name}는 문자열 배열이어야 합니다.`);
    else need(false,'NOTION_PROPERTY_TYPE',`${name}의 ${type} 형식은 현재 지원하지 않습니다. 별도 속성 매핑이 필요합니다.`);
    const opts=p?.options||p?.[type]?.options;
    if(['select','status','multi_select'].includes(type)&&opts) for(const v of Array.isArray(value)?value:[value]) need(opts.some(o=>(typeof o==='string'?o:o.name)===v),'NOTION_PROPERTY_OPTION',`${name}에 ${v} 선택지가 없습니다.`);
  }
}
export function notionRequests(plan,packet,c,body) {
  const n=schemaConfig(c),identity=packet.identity;
  const props={...n.extraProperties,[n.titleProperty]:n.identityProperty?plan.title:`${plan.title} [${identity}]`,[n.statusProperty]:STATUS};
  if(n.accountProperty) props[n.accountProperty]=n.schema[n.accountProperty]?.type==='multi_select'?[plan.account]:plan.account;
  if(n.identityProperty) props[n.identityProperty]=identity;
  validateProperties(props,n.schema);
  const properties=Object.fromEntries(Object.entries(props).map(([k,v])=>[propName(k),v]));
  const create={tool:CREATE,arguments:{parent:{data_source_id:n.dataSourceId},pages:[{properties,content:body}]}};
  const table=`collection://${n.dataSourceId}`,column=(n.identityProperty||n.titleProperty).replace(/"/g,'""');
  const query=n.identityProperty?`SELECT url FROM "${table}" WHERE "${column}" = ?`:`SELECT url FROM "${table}" WHERE instr("${column}", ?) > 0`;
  const dedupe={tool:QUERY,arguments:{data:{mode:'sql',data_source_urls:[table],query,params:[n.identityProperty?identity:`[${identity}]`]}}};
  return {version:1,identity,bodyHash:hash(normalizeBody(body)),create,dedupe,requestHash:hash(create),instructions:['현재 호스트의 인증된 Notion 커넥터로 요청을 실행합니다.','생성 응답이 아니라 FETCH로 다시 읽은 페이지를 receipt에 전달합니다.','실행 여부가 불명확하면 생성 요청을 재실행하지 말고 dedupe를 다시 조회합니다.']};
}
export function unwrapResult(envelope,tool,expectedArguments) {
  need(envelope?.tool===tool&&envelope.response&&!envelope.response.isError,'EVIDENCE_TOOL','인증된 커넥터의 도구 이름과 원본 response를 보존해야 합니다.');
  need(Number.isFinite(dateValue(envelope.fetchedAt)),'EVIDENCE_TIME','fetchedAt 조회 시각이 필요합니다.');
  if(expectedArguments) need(hash(envelope.arguments)===hash(expectedArguments),'EVIDENCE_REQUEST','조회 요청이 생성된 L1 요청과 다릅니다.');
  let r=envelope.response;
  if(r.structuredContent) r=r.structuredContent;
  else if(Array.isArray(r.content)) {
    const texts=r.content.filter(x=>x.type==='text').map(x=>x.text);
    need(texts.length===1,'EVIDENCE_RESPONSE','한 번의 원본 조회 응답이 필요합니다.');
    try {r=JSON.parse(texts[0]);} catch {r={text:texts[0]};}
  }
  need(!r.isError&&!r.error&&r.truncated!==true&&r.has_more!==true&&!(r.unknown_block_count>0)&&!list(r.unknown_block_ids).length,'EVIDENCE_INCOMPLETE','실패·잘림·누락이 있는 조회 결과로 완료 처리할 수 없습니다.');
  return r;
}
export function checkDedupe(envelope,requests) {
  const r=unwrapResult(envelope,QUERY,requests.dedupe.arguments);
  const rows=Array.isArray(r)?r:r.results??r.rows??r.data?.rows;
  need(Array.isArray(rows),'DEDUPE_ROWS','원본 SQL 조회의 results 또는 rows 배열이 필요합니다.');
  need(rows.length===0,'DUPLICATE_NOTION','같은 식별자의 노션 페이지가 있습니다. 새로 만들지 말고 기존 페이지를 fetch해 receipt로 확인하세요.');
  return {queryHash:hash(requests.dedupe),evidenceHash:hash(envelope),fetchedAt:envelope.fetchedAt};
}
// Notion은 빈 줄을 제거한다. 글자·순서·문장부호는 그대로 비교한다.
export function normalizeBody(s) {
  return String(s).replace(/\r\n/g,'\n').replace(/<table\b[^>]*>([\s\S]*?)<\/table>/g,(_,inner)=>{
    // fetch는 표를 여러 줄로 직렬화하고 colgroup 폭을 넣는다. 셀 순서와 내용은 보존한다.
    const rows=[...inner.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map(r=>[...r[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(c=>c[1].trim().replace(/<br\s*\/>/g,'<br>')));
    return `TABLE:${JSON.stringify(rows)}`;
  }).split('\n').map(l=>l.trimEnd()).filter(l=>l.trim()!=='').join('\n').trim();
}
function scalar(x) {
  if(typeof x==='string'||typeof x==='number'||x===null||Array.isArray(x)) return x;
  if(x?.status) return x.status.name;
  if(x?.select) return x.select.name;
  if(x?.title) return x.title.map(t=>t.plain_text??t.text?.content??'').join('');
  if(x?.rich_text) return x.rich_text.map(t=>t.plain_text??t.text?.content??'').join('');
  if(x?.multi_select) return x.multi_select.map(t=>t.name);
  return x;
}
export function verifyReceipt(envelope,requests,c) {
  const r=unwrapResult(envelope,FETCH),n=schemaConfig(c),text=typeof r.text==='string'?r.text:'';
  let pageId=r.id||r.page_id||r.url, parent=r.parent?.data_source_id||r.data_source_id,properties=r.properties,body=typeof r.content==='string'?r.content:undefined;
  if(text) {
    pageId ||= text.match(/<page\b[^>]*url="([^"]+)"/)?.[1];
    parent ||= text.match(/<(?:parent-data-source|data-source)\b[^>]*url="collection:\/\/([^"]+)"/)?.[1];
    const rawProps=text.match(/<properties>\s*([\s\S]*?)\s*<\/properties>/)?.[1];
    if(!properties&&rawProps) {try{properties=JSON.parse(rawProps);}catch{need(false,'RECEIPT_PROPERTIES','노션 properties JSON을 읽지 못했습니다.');}}
    body ??= text.match(/<content>\n?([\s\S]*?)\n?<\/content>/)?.[1];
    need(!/<unknown\b|truncated="true"|unknown_block_count="[1-9]/i.test(text),'EVIDENCE_INCOMPLETE','본문에 알 수 없거나 잘린 블록이 있습니다.');
  }
  need(idOf(pageId)&&idOf(pageId)===idOf(envelope.arguments?.id),'RECEIPT_ID','조회한 페이지 ID와 응답 ID가 다릅니다.');
  need(idOf(parent)===idOf(n.dataSourceId),'RECEIPT_PARENT','페이지의 실제 부모 데이터 소스가 다릅니다.');
  need(properties&&typeof properties==='object','RECEIPT_PROPERTIES','조회된 실제 속성이 필요합니다.');
  const expected=requests.create.arguments.pages[0];
  for(const [key,value] of Object.entries(expected.properties)) need(hash(scalar(properties[key]??properties[key.replace(/^userDefined:/,'')]))===hash(value),'RECEIPT_PROPERTY',`${key} 속성이 요청값과 다릅니다.`);
  need(typeof body==='string'&&body.includes(`reels-planning:${requests.identity}`),'RECEIPT_MARKER','조회 본문에 해당 기획안 식별자가 없습니다.');
  need(hash(normalizeBody(body))===requests.bodyHash,'RECEIPT_CONTENT','조회 본문이 렌더링한 기획안과 다릅니다. 빠진 내용·편집 차이를 확인하세요.');
  return {pageId:idOf(pageId),url:httpUrl(r.url)?r.url:`https://www.notion.so/${idOf(pageId)}`,dataSourceId:n.dataSourceId,status:STATUS,identity:requests.identity,requestHash:requests.requestHash,bodyHash:requests.bodyHash,evidenceHash:hash(envelope),fetchedAt:envelope.fetchedAt};
}
