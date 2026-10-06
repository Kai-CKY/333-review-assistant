import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {RelationalRepository} from '../src/storage/relational-repository.js';
import {createSeedData,normalizeData} from '../src/repository.js';
import {RuntimeLedger,csvRequests} from '../src/runtime-ledger.js';
import {configureModelLedger,normalizeUsage,withModelContext,replayUsagePending} from '../src/model-usage.js';
import {ArkFeedbackProvider} from '../src/ark/feedback.js';
import {ArkStudyAgent} from '../src/ark/agent.js';
import {ManagementOperations} from '../src/management-operations.js';
import {ConversationMemory,conversationScope} from '../src/agent/memory.js';
import {createGroupConversation} from '../src/feishu/group-conversation.js';
import {sendReactionOnce,parseReply} from '../src/agent/reactions.js';
import {ReviewRecords} from '../src/review-records.js';
import {backupRuntime,restoreRuntime} from '../src/storage/runtime-backup.js';
import {todayKey} from '../src/domain/date.js';
import {startServer,testHash} from './helpers/http-server.js';

const model='doubao-seed-2-1-pro-260915';
const usage={prompt_tokens:1000,completion_tokens:400,prompt_tokens_details:{cached_tokens:200},completion_tokens_details:{reasoning_tokens:300}};
const actor={id:'web:manager',role:'admin'};
async function fixture(t){
  const dir=await mkdtemp(path.join(tmpdir(),'333-runtime-'));
  const repo=new RelationalRepository(path.join(dir,'review-assistant.sqlite'));
  const seed=createSeedData();normalizeData(seed);await repo.save(seed);
  const ledger=new RuntimeLedger(repo,{environment:'prod'});await ledger.initialize();configureModelLedger(ledger);
  t.after(async()=>{configureModelLedger(null);repo.close();await rm(dir,{recursive:true,force:true});});
  return {dir,repo,ledger};
}
function provider(content='{"text":"收到","reaction":"SMILE"}',rawUsage=usage){
  return new ArkFeedbackProvider({apiKey:'unit-only',modelId:model,fetchImpl:async()=>new Response(JSON.stringify({id:'response-unit',model,usage:rawUsage,choices:[{message:{content},finish_reason:'stop'}]}),{headers:{'Content-Type':'application/json'}})});
}

test('physical requests retain normalized usage before business parsing, and unknown usage is not zero',async t=>{
  const {ledger}=await fixture(t);
  assert.deepEqual(normalizeUsage(usage),{input:1000,output:400,cached:200,reasoning:300,usageStatus:'known'});
  const agent=new ArkStudyAgent({provider:provider('invalid')});
  await assert.rejects(withModelContext({taskId:'logical-job'},()=>agent.classify({message:'你好',profile:{role:'learner'}})));
  let rows=await ledger.rows('model_requests');assert.equal(rows.length,1);assert.equal(rows[0].businessStatus,'parse_failed');assert.equal(rows[0].taskId,'logical-job');
  assert.equal(rows[0].nanoCost,17040000);assert.equal(ledger.summary(rows).tokens,1400);
  assert.equal(ledger.repository.db.prepare('SELECT input_tokens FROM model_requests WHERE id=?').get(rows[0].id).input_tokens,1000);
  await provider('ok',undefined).complete({messages:[{role:'user',content:'hello'}]});
  // Explicitly remove usage: the provider helper's default parameter otherwise supplies it.
  const absent=new ArkFeedbackProvider({apiKey:'unit-only',modelId:model,fetchImpl:async()=>new Response(JSON.stringify({choices:[{message:{content:'ok'},finish_reason:'stop'}]}))});
  await absent.complete({messages:[{role:'user',content:'hello'}]});
  rows=await ledger.rows('model_requests');const missing=rows.find(r=>r.usageStatus==='unknown');assert.equal(missing.input,null);assert.equal(missing.nanoCost,null);
});

test('stream usage survives incomplete transport; retries share task but create separate charges',async t=>{
  const {ledger}=await fixture(t);
  const encoded=new TextEncoder().encode('data: '+JSON.stringify({id:'sse',model,usage,choices:[]})+'\n\ndata: {"broken":');
  const p=new ArkFeedbackProvider({apiKey:'unit-only',modelId:model,fetchImpl:async()=>new Response(new ReadableStream({start(c){c.enqueue(encoded);c.close();}}))});
  await withModelContext({taskId:'retry-task'},async()=>{
    for(let i=0;i<2;i++)await assert.rejects(p.complete({stream:true,messages:[{role:'user',content:'hello'}]}));
  });
  const rows=await ledger.rows('model_requests');assert.equal(rows.length,2);assert.equal(new Set(rows.map(r=>r.id)).size,2);assert.ok(rows.every(r=>r.taskId==='retry-task'&&r.usageStatus==='known'&&r.status==='failed'));assert.equal(ledger.summary(rows).nanoCost,34080000);
});

test('pricing versions preserve historical charges and warning budgets continue calls',async t=>{
  const {ledger}=await fixture(t);
  await ledger.budget({daily:0.001,monthly:0.001},actor);
  await provider().complete({messages:[{role:'user',content:'first'}]});
  const first=(await ledger.rows('model_requests'))[0];
  await ledger.price({model,tier:'default',input:60,cached:12,output:300,effectiveFrom:new Date(Date.now()-1000).toISOString(),source:'https://docs.volcengine.com/docs/ark/model-pricing'},actor);
  await ledger.put('model_requests',first.id,{...first,businessStatus:'success'});
  assert.equal((await ledger.get('model_requests',first.id)).nanoCost,first.nanoCost);
  await provider().complete({messages:[{role:'user',content:'second'}]});
  assert.equal((await ledger.rows('model_requests')).length,2);
  const v=await ledger.view();assert.equal(v.budget.policy,'warn_continue');assert.ok(v.alerts.some(a=>a.threshold===100));
  assert.equal((await ledger.get('model_requests',first.id)).priceVersion,first.priceVersion);
});

test('usage persistence failure spools actual usage and replays without another paid request',async t=>{
  const {ledger,dir}=await fixture(t);
  const put=ledger.put.bind(ledger);ledger.put=async(table,...args)=>{if(table==='model_requests')throw new Error('disk unavailable');return put(table,...args);};
  let calls=0;const p=provider();const fetch=p.fetchImpl;p.fetchImpl=async(...args)=>{calls++;return fetch(...args);};
  await p.complete({messages:[{role:'user',content:'hello'}]});
  assert.equal(calls,1);assert.match(await readFile(path.join(dir,'model-usage-pending.jsonl'),'utf8'),/prompt_tokens/);
  ledger.put=put;await replayUsagePending(ledger);const rows=await ledger.rows('model_requests');assert.equal(rows.length,1);assert.equal(rows[0].input,1000);assert.equal(rows[0].status,'success');
});

test('official statement preview has no writes; duplicates and scope do not double count charges',async t=>{
  const {ledger}=await fixture(t);await provider().complete({messages:[{role:'user',content:'hello'}]});
  const rows=await ledger.rows('model_requests'),day=todayKey();
  const input={environment:'prod',key:rows[0].key,from:day,to:day,tokens:1400,paidYuan:0.02,sourceName:'official.csv'};
  assert.equal((await ledger.importStatement(input,actor,{preview:true})).local.tokens,1400);assert.equal((await ledger.rows('cost_official_statements')).length,0);
  await ledger.importStatement(input,actor);assert.equal((await ledger.importStatement(input,actor)).idempotent,true);assert.equal((await ledger.rows('cost_official_statements')).length,1);
  assert.equal((await ledger.view()).summary.nanoCost,17040000);
  await assert.rejects(ledger.importStatement({...input,from:'2026-02-30'},actor));
  assert.match(csvRequests([{...rows[0],title:'=external()',nanoCost:null}]),/未知/);
  assert.equal((await ledger.view({environment:'test'})).summary.count,0);
});

test('management sends validate native mentions and preserve deduplication across restart and unknown delivery',async t=>{
  const {ledger,repo}=await fixture(t);let sends=0;
  const transport={group:async()=>({name:'测试群'}),members:async()=>[{member_id:'ou_learner',name:'羊羊'}],send:async()=>{sends++;return {message_id:'om_receipt'};},message:async()=>({items:[{message_id:'om_receipt',chat_id:'oc_test',body:{content:JSON.stringify({text:'<at user_id="ou_learner">羊羊</at> 提醒'})}}]})};
  const operations=new ManagementOperations(repo,ledger,{transport}),input={chatId:'oc_test',text:'提醒',mentions:['ou_learner'],requestId:'stable-request-1'};
  await assert.rejects(operations.preview({...input,mentions:['ou_unknown']}));
  const pair=await Promise.all([operations.execute(input,actor),operations.execute(input,actor)]);assert.equal(sends,1);assert.ok(pair.every(r=>r.messageId==='om_receipt'));
  const restarted=new ManagementOperations(repo,ledger,{transport});assert.equal((await restarted.execute(input,actor)).idempotent,true);assert.equal(sends,1);
  await assert.rejects(restarted.execute({...input,text:'变更正文'},actor),e=>e.statusCode===409);
  const failure=new ManagementOperations(repo,ledger,{transport:{...transport,send:async()=>{sends++;throw new Error('timeout');}}});
  const unknown={...input,requestId:'stable-request-2'};const result=await failure.execute(unknown,actor);assert.equal(result.status,'unknown');
  await failure.execute(unknown,actor);assert.equal(sends,2);
  assert.equal((await failure.reconcile(result.id,{messageId:'om_receipt'},actor)).status,'sent');assert.equal(sends,2);
  await assert.rejects(operations.execute({...input,requestId:'learner-call'}, {id:'learner',role:'learner'}),e=>e.statusCode===403);
});

test('Agent receives same-group management results after reset and excludes private summary and other groups',async t=>{
  const {ledger,repo}=await fixture(t);const operations=new ManagementOperations(repo,ledger,{transport:null});
  const input={requestId:'external-record-1',summary:'管理员私有摘要',publicText:'真实公开结果',evidence:'私有证据',occurredAt:new Date().toISOString(),chatId:'oc_test'};
  const result=await operations.record(input,actor);await assert.rejects(operations.record({...input,publicText:'不同结果'},actor),e=>e.statusCode===409);
  const memory=new ConversationMemory(repo),scope=conversationScope({appId:'333',chatType:'group',chatId:'oc_test'});await memory.reset(scope);
  assert.match(JSON.stringify(await memory.history(scope)),/真实公开结果/);assert.doesNotMatch(JSON.stringify(await memory.history(scope)),/管理员私有摘要|私有证据/);
  assert.doesNotMatch(JSON.stringify(await memory.history(conversationScope({appId:'333',chatType:'group',chatId:'oc_other'}))),/真实公开结果/);
  const requests=[],channel={send:async()=>{},rawClient:{im:{v1:{chatMembers:{get:async()=>({code:0,data:{items:[]}})}}}}};
  await createGroupConversation({repository:repo,provider:{isConfigured:()=>true,complete:async p=>{requests.push(p);return {content:'{"text":"收到","reaction":null}'};}},channel,chatId:'oc_test',logger:{warn(){}}})({senderId:'ou_manager',messageId:'om_incoming',content:'你好'});
  assert.match(JSON.stringify(requests),/真实公开结果/);assert.doesNotMatch(JSON.stringify(requests),/管理员私有摘要|私有证据/);
  assert.equal((await ledger.get('management_operations',result.id)).status,'recorded');
});

test('reaction uses original model call, rejects unknown icons and persists one claim per incoming message',async t=>{
  const {ledger,repo}=await fixture(t);const agent=new ArkStudyAgent({provider:provider()});
  const reply=await agent.chat({message:'你好',profile:{role:'learner'}});assert.equal(reply.reaction,'SMILE');assert.equal((await ledger.rows('model_requests')).length,1);
  assert.equal(parseReply('{"text":"收到","reaction":"DONE"}').reaction,null);
  let count=0;const channel={addReaction:async()=>{count++;throw new Error('no permission');}};
  assert.equal(await sendReactionOnce(repo,channel,'om_reaction','SMILE',{warn(){}}),false);
  await sendReactionOnce(repo,channel,'om_reaction','SMILE',{warn(){}});assert.equal(count,1);
  assert.equal((await repo.read()).reactionEvents.om_reaction.status,'failed');
});

test('review records link the exact raw answer and retain real timestamps without fabricating historical time',async t=>{
  const {repo}=await fixture(t);const data=await repo.read(),id=data.knowledgePoints[0].id;
  const attempt=await repo.saveAnswer({knowledgePointId:id,content:'我的原始答案',sourceId:'answer-unit',actorId:'web:learner',taskSnapshot:{prompt:'当时题目'}});
  const review=await repo.recordReview({knowledgePointId:id,rating:'good',sourceId:'review:answer-unit',actorId:'web:learner'});
  assert.equal(review.reviewLog.attemptId,attempt.id);assert.ok(Number.isFinite(Date.parse(review.reviewLog.reviewedAt)));assert.equal(review.state.lastRating,'good');
  await assert.rejects(repo.recordReview({knowledgePointId:data.knowledgePoints[1].id,rating:'good',attemptId:attempt.id}),/关联无效/);
  await repo.mutate(d=>{d.reviewLogs.push({id:'historical',knowledgePointId:id,rating:'hard',reviewedOn:todayKey(),nextReviewOn:todayKey()});});
  const view=await new ReviewRecords(repo).view();assert.equal(view.records.find(r=>r.id===review.reviewLog.id).attempt.content,'我的原始答案');assert.equal(view.records.find(r=>r.id==='historical').reviewedAt,null);
  assert.equal(repo.db.prepare('SELECT attempt_id FROM review_logs WHERE id=?').get(review.reviewLog.id).attempt_id,attempt.id);
});

test('native runtime backup and restore preserve cost ledger, operations and relational migration',async t=>{
  const {dir,repo,ledger}=await fixture(t);
  await provider().complete({messages:[{role:'user',content:'hello'}]});await ledger.put('management_operations','operation-native',{status:'recorded',summary:'已执行'});
  await repo.recordReview({knowledgePointId:(await repo.read()).knowledgePoints[0].id,rating:'good'});
  await backupRuntime({databaseFile:repo.filePath,outputDir:path.join(dir,'backup'),serverStopped:true});
  const restored=await restoreRuntime({backupDir:path.join(dir,'backup'),outputDir:path.join(dir,'restore')});
  const other=new RelationalRepository(restored.databaseFile);try{const l=new RuntimeLedger(other);assert.equal((await l.rows('model_requests')).length,1);assert.equal((await l.get('management_operations','operation-native')).summary,'已执行');assert.equal((await other.read()).reviewLogs.length,1);assert.equal(other.db.pragma('integrity_check',{simple:true}),'ok');}finally{other.close();}
  await assert.rejects(restoreRuntime({backupDir:path.join(dir,'backup'),outputDir:path.join(dir,'bad-json'),sqlite:false}),/native_restore/);
});

test('HTTP limits cost and management to admin while learner calendar assets remain accessible',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'333-role-')),server=await startServer(path.join(dir,'review-assistant.sqlite'),{WEB_USERS:`tester:${testHash},manager:${testHash}`,WEB_ADMIN_USERS:'manager'});
  t.after(async()=>{await server.stop();await rm(dir,{recursive:true,force:true});});
  const learner={cookie:(await server.login()).headers.get('set-cookie').split(';')[0]};
  for(const route of ['/api/console/costs','/api/console/operations','/api/console/review-records','/console/cost/'])assert.equal((await fetch(server.url+route,{headers:learner})).status,403,route);
  for(const route of ['/api/calendar','/calendar.html','/calendar-workspace.css','/calendar.css','/calendar.js'])assert.equal((await fetch(server.url+route,{headers:learner})).status,200,route);
  const admin={cookie:(await server.login('manager')).headers.get('set-cookie').split(';')[0],'Content-Type':'application/json'};
  assert.equal((await fetch(server.url+'/api/console/costs',{headers:admin})).status,200);
  const budget=await fetch(server.url+'/api/console/costs/budget',{method:'POST',headers:admin,body:JSON.stringify({daily:1,monthly:10})});assert.equal(budget.status,200);assert.equal((await budget.json()).policy,'warn_continue');
  assert.equal((await fetch(server.url+'/api/reviews',{method:'POST',headers:admin,body:'{}'})).status,403);
  assert.equal((await fetch(server.url+'/api/console/operations/record',{method:'POST',headers:{...admin,Origin:'https://foreign.example'},body:'{}'})).status,403);
});
