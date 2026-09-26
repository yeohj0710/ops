import fs from 'node:fs';
import {spawn, spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline';

// Inventory only. No thread, model turn, tool call, or configuration mutation.
const allow=JSON.parse(fs.readFileSync(new URL('../readonly-tools.json',import.meta.url),'utf8'));
const found=process.env.CODEX_BIN || (process.platform==='win32'
  ? spawnSync('where.exe',['codex'],{encoding:'utf8',windowsHide:true}).stdout?.trim().split(/\r?\n/)[0]
  : 'codex');
if(!found)throw Error('Codex 실행 파일을 찾지 못했습니다. CODEX_BIN에 절대경로를 지정하세요.');
const config=spawnSync(found,['mcp','get','higgsfield','--json'],{encoding:'utf8',windowsHide:true});
if(config.status!==0)throw Error('Higgsfield MCP 설정을 읽지 못했습니다. 공식 서버 등록 상태를 확인하세요.');
const cfg=JSON.parse(config.stdout);
if(!cfg.enabled || cfg.transport?.url!=='https://mcp.higgsfield.ai/mcp')throw Error('공식 Higgsfield MCP 주소와 활성화 상태를 확인하세요.');
if(!Array.isArray(cfg.enabled_tools) || !cfg.enabled_tools.length || cfg.enabled_tools.some(x=>!allow.includes(x)))throw Error('조회 허용 목록이 없거나 허용하지 않은 도구가 있습니다. 생성하지 말고 설정부터 확인하세요.');
const child=spawn(found,['app-server','--stdio'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
const pending=new Map(); let seq=0;
const rl=createInterface({input:child.stdout});
const timer=setTimeout(()=>{for(const p of pending.values())p.reject(Error('MCP 도구 조회가 45초 안에 끝나지 않았습니다.'));child.kill();},45000);
child.stderr.on('data',()=>{});
child.on('error',e=>{for(const p of pending.values())p.reject(e);});
child.on('exit',()=>{for(const p of pending.values())p.reject(Error('MCP 점검 프로세스가 종료됐습니다.'));});
rl.on('line',line=>{let m;try{m=JSON.parse(line);}catch{return;}const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}});
function rpc(method,params){
 if(!['initialize','mcpServerStatus/list'].includes(method))throw Error('조회 전용 점검에서 허용하지 않는 요청입니다.');
 return new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({method,id,params})+'\n');});
}
try {
 await rpc('initialize',{clientInfo:{name:'higgsfield_readonly_doctor',version:'1.0.0'},capabilities:{experimentalApi:true}});
 child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
 let cursor, server;
 do {const r=await rpc('mcpServerStatus/list',{limit:100,detail:'toolsAndAuthOnly',...(cursor?{cursor}:{})});server=r.data?.find(x=>x.name==='higgsfield');cursor=r.nextCursor;}while(!server&&cursor);
 if(!server?.serverInfo || server.toolsError)throw Error('MCP 연결 또는 목록 조회 실패. OAuth 로그인 상태를 확인하세요.');
 const visible=Object.values(server.tools||{});
 const bad=visible.filter(x=>!allow.includes(x.name)||x.annotations?.readOnlyHint!==true);
 if(bad.length || !visible.length)throw Error('조회 도구 목록이 예상과 다릅니다. 생성 없이 목록을 확인하세요.');
 for(const name of cfg.enabled_tools)if(!visible.some(x=>x.name===name))throw Error('서버에서 허용 도구를 찾지 못했습니다: '+name);
 console.log(JSON.stringify({ok:true,server:server.serverInfo.name,authStatus:server.authStatus,enabled_tools:visible.map(x=>x.name).sort(),model_turns:0,generation_calls:0,tool_calls:0},null,2));
}catch(e){console.error(e.message);process.exitCode=1;}
finally{clearTimeout(timer);rl.close();child.stdin.end();child.kill();}
