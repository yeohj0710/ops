import fs from 'node:fs';

// Public ECB reference feed only. No account or billing request.
const url='https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
try{
  const response=await fetch(url,{signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw Error(`환율 조회 HTTP ${response.status}`);
  const xml=await response.text();
  const date=xml.match(/time=['"]([^'"]+)['"]/)[1];
  const rate=c=>Number(xml.match(new RegExp(`currency=['"]${c}['"]\\s+rate=['"]([^'"]+)['"]`))[1]);
  const usd=rate('USD'),krw=rate('KRW');if(!(usd>0&&krw>0))throw Error('환율 값이 잘못됐습니다.');
  const value={krw_per_usd:krw/usd,rate_date:date,checked_at:new Date().toISOString(),source_url:url,kind:'ECB_reference_not_card_settlement'};
  if(process.argv[2])fs.writeFileSync(process.argv[2],JSON.stringify(value,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify(value,null,2));
}catch(e){console.error('원화 환산을 갱신하지 못했습니다. USD 견적을 유지하고 환율을 미확인으로 표시하세요. '+e.message);process.exitCode=1;}
