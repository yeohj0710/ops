import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export function normalizeAccount(value) {
  let s=String(value??'').trim().toLowerCase();
  if (/^(https?:\/\/)?(www\.)?instagram\.com\//.test(s)) {
    s=s.replace(/^(https?:\/\/)?(www\.)?instagram\.com\//,'').split(/[/?#]/)[0];
  }
  return s.replace(/^@/,'').trim();
}
const keys=xs=>(xs??[]).map(normalizeAccount).filter(Boolean);
export function reconcileSources(input) {
  const before=keys(input.beforeAccounts),after=keys(input.afterAccounts);
  const form=[...new Set(keys(input.responseAccounts))],assigned=new Set(keys(input.assignedAccounts));
  const afterSet=new Set(after),count=(xs,k)=>xs.filter(x=>x===k).length;
  const lost=[...new Set(before)].filter(k=>count(after,k)<count(before,k));
  const missing=form.filter(k=>!afterSet.has(k));
  const missingAssignments=form.filter(k=>!assigned.has(k));
  const mailProblems=['wellnessbox.me@gmail.com','wellnessbox.official@gmail.com'].filter(x=>input.verifiedMailAccounts?.includes(x)!==true);
  return {ok:!lost.length&&!missing.length&&!missingAssignments.length&&!mailProblems.length,
    responseAccountCount:form.length,matchedMainCount:form.length-missing.length,
    matchedAssignmentCount:form.length-missingAssignments.length,missingAccounts:missing,
    missingAssignments,lostExistingAccounts:lost,unverifiedMailAccounts:mailProblems,
    addedAccounts:[...afterSet].filter(k=>!before.includes(k))};
}
function selfTest(){
  const mail=['wellnessbox.me@gmail.com','wellnessbox.official@gmail.com'];
  const base={beforeAccounts:['@old'],afterAccounts:['old','new'],responseAccounts:['https://www.instagram.com/new/?x=1'],assignedAccounts:['@new'],verifiedMailAccounts:mail};
  assert.equal(reconcileSources(base).ok,true);
  assert.deepEqual(reconcileSources({...base,afterAccounts:['new']}).lostExistingAccounts,['old']);
  assert.deepEqual(reconcileSources({...base,afterAccounts:['old']}).missingAccounts,['new']);
  assert.deepEqual(reconcileSources({...base,assignedAccounts:[]}).missingAssignments,['new']);
  assert.equal(reconcileSources({...base,verifiedMailAccounts:[mail[0]]}).ok,false);
  assert.deepEqual(reconcileSources({...base,beforeAccounts:['old','old']}).lostExistingAccounts,['old']);
  assert.equal(normalizeAccount(' http://instagram.com/___sooran '),'___sooran');
  console.log('reconcile-domestic-sources: 7 tests passed');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  if(process.argv.includes('--self-test'))selfTest();
  else{const result=reconcileSources(JSON.parse(fs.readFileSync(process.argv[2],'utf8')));if(process.argv[3])fs.writeFileSync(process.argv[3],JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));if(!result.ok)process.exitCode=1;}
}
