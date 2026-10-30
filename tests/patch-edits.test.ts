import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {materializeEdits} from '../server/patch-edits.js';
import {canonicalPlan,checkPatch} from '../server/patch.js';
import {defaults} from '../server/config.js';
import type {Snapshot} from '../server/github.js';
import {ModelClient,preparePatchRequest,type Analysis} from '../server/model.js';
function fixture(text:string){
 const source:Snapshot={repo:'owner/repo',commit:'a'.repeat(40),issue:{number:1,title:'test',body:'',url:'https://github.com/owner/repo/issues/1'},files:[{path:'src/main.js',content:text,url:''}],gaps:[],capturedAt:''};
 const plan=canonicalPlan({steps:['edit'],allowedPaths:['src/main.js'],allowDependencies:false,allowSensitive:false},'task',1,source,{});
 return {source,plan};
}
for(const text of ['one\ntwo\nthree\n','one\ntwo\nthree','two\n','two'])test('exact edits produce source-checked Git-applicable diff: '+JSON.stringify(text),()=>{
 const {source,plan}=fixture(text),patch=materializeEdits({edits:[{path:'src/main.js',oldText:'two',newText:'second\nextra'}],prTitle:'fix',prBody:'UNVERIFIED NOT_RUN'},source,plan);
 assert.equal(checkPatch(patch,plan,source,defaults).checks.sourceHunks,'PASS');
 const dir=mkdtempSync(join(tmpdir(),'scout-edit-'));
 try{mkdirSync(join(dir,'src'));writeFileSync(join(dir,'src/main.js'),text);const result=spawnSync('git',['apply','--check','-'],{cwd:dir,input:patch.diff,encoding:'utf8'});assert.equal(result.status,0,result.stderr);}finally{rmSync(dir,{recursive:true,force:true});}
});
test('ambiguous, missing, overlapping and outside-scope edits fail closed',()=>{
 const {source,plan}=fixture('same\nsame\nunique\n');
 const build=(edits:unknown[])=>materializeEdits({edits,prTitle:'fix',prBody:'test'},source,plan);
 for(const oldText of ['same','absent',''])assert.throws(()=>build([{path:'src/main.js',oldText,newText:'new'}]));
 assert.throws(()=>build([{path:'../secret',oldText:'unique',newText:'new'}]),/SCOPE/);
 assert.throws(()=>build([{path:'src/main.js',oldText:'unique',newText:'new'},{path:'src/main.js',oldText:'nique',newText:'new'}]),/OVERLAP/);
 assert.throws(()=>build([{path:'src/main.js',oldText:'unique\n',newText:'unique'}]),/EOF/);
});
test('multiple nonoverlapping edits use original coordinates and retain dependency validation',()=>{
 const {source,plan}=fixture('first\nkeep\nlast\n');
 const patch=materializeEdits({edits:[{path:'src/main.js',oldText:'first',newText:'changed'},{path:'src/main.js',oldText:'last',newText:"import x from 'new-package'"}],prTitle:'fix',prBody:'test'},source,plan);
 assert.throws(()=>checkPatch(patch,plan,source,defaults),/DEPENDENCY/);
});
test('model structured edits reach the existing strict checker without a second model call',async()=>{
 const {source,plan}=fixture('const value = 1;\n');let calls=0;
 const analysis:Analysis={summary:'summary',recommendation:'NEEDS_REVIEW',rationale:'reason',uncertainties:['not tested'],evidence:[{path:'src/main.js',quote:'const value = 1;'}],plan:['old suggestion']};
 const request=preparePatchRequest(source,analysis,plan,defaults);
 assert.deepEqual(request.input.analysis.evidence,[]);
 assert.deepEqual(request.input.analysis.plan,[]);
 assert.equal(analysis.evidence.length,1);
 const model=new ModelClient(async(_url,init)=>{
  calls++;const body=JSON.parse(init.body as string);assert.match(body.messages[0].content,/oldText/);
  return {usage:{total_tokens:10},choices:[{finish_reason:'stop',message:{content:JSON.stringify({edits:[{path:'src/main.js',oldText:'const value = 1;',newText:'const value = 2;'}],prTitle:'fix',prBody:'UNVERIFIED NOT_RUN'})}}]};
 },{MODEL_API_KEY:'fixture-key'});
 const patch=await model.generatePatch(source,analysis,plan,{...defaults,model:'deepseek-flash'},new AbortController().signal,()=>{});
 assert.equal(checkPatch(patch,plan,source,defaults).checks.sourceHunks,'PASS');assert.equal(calls,1);
});
