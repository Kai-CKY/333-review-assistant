import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { RelationalRepository } from '../src/storage/relational-repository.js';
import { readRelationalData } from '../src/storage/relational-codec.js';
import { readDatabaseFile } from '../src/storage/database-file.js';
import { openRepository } from '../src/storage/open-repository.js';
import { createSeedData } from '../src/repository.js';
import { syncSavedKnowledge } from '../src/knowledge/library.js';
import { conversationScope, ConversationMemory } from '../src/agent/memory.js';
import { ensureUploadTranscriptions, UploadCorrections } from '../src/knowledge/upload-corrections.js';
import { ReviewReminders } from '../src/feishu/reminders.js';
import { ReviewConsole } from '../src/review-console.js';
import { startServer } from './helpers/http-server.js';

async function fixture(t,learningKind='forgotten') {
  const folder=await mkdtemp(path.join(tmpdir(),'333-relational-'));
  const closers=[];
  t.after(async()=>{for(const close of closers)await close();await rm(folder,{recursive:true,force:true});});
  const scope=conversationScope({appId:'app-test',chatType:'group',chatId:'oc_test'});
  const policy={appId:'app-test',groupId:'oc_test',learnerId:'ou_test',scopeKeys:[scope.key]};
  const data=createSeedData();data.knowledgePoints=[];data.reviewStates=[];data.memoryEvents=[];data.reviewLogs=[];
  data.agentMemory={version:1,streams:{[scope.key]:{scope,sessionId:'session',archivedIds:[]}},sessions:{session:{id:'session',scopeKey:scope.key,createdAt:'2026-10-04T01:00:00Z',events:[]}},notes:{}};
  const id='KP-1234abcd',item={id:'K1',title:'教学原则',text:'循序渐进'};
  data.photoKnowledge={schemaVersion:1,documents:{[id]:{id,scopeKey:scope.key,learningKind,uploadedAt:'2026-10-04T01:00:00Z',title:'资料',currentVersion:1,revisions:[{version:1,title:'资料',confirmedBy:'learner',savedAt:'2026-10-04T01:00:00Z',items:[item]}]}},drafts:{[id]:{id,scopeKey:scope.key,sessionId:'session',status:'saved',sourceUploadedAt:'2026-10-04T01:00:00Z',assets:[],reads:[],actions:[],versions:[{version:1,content:{title:'资料',items:[item]}}]}},events:[]};
  data.extraState={nested:{flags:[true,false],zero:0,nil:null,empty:[]}};
  syncSavedKnowledge(data,policy);ensureUploadTranscriptions(data);
  const file=path.join(folder,'runtime.sqlite'),repository=new RelationalRepository(file,{knowledgePolicy:policy});
  await repository.save(data);closers.push(()=>{if(repository.db.open)repository.close();});
  return {repository,data,file,scope,policy,id,closers};
}

test('approved relational format preserves domain state, nested residual fields, notes, archives and restart',async t=> {
  const {repository,data,file,scope,policy,closers}=await fixture(t);
  assert.deepEqual(readRelationalData(repository.db),data);
  const memory=new ConversationMemory(repository);
  await Promise.all([memory.append(scope,{type:'turn',user:'学习内容',assistant:'复习建议',eventId:'m1'}),memory.remember(scope,'明天回顾','n1')]);
  await memory.reset(scope);await memory.append(scope,{type:'turn',user:'新的会话',assistant:'已记下'});
  const before=await repository.read();
  assert.equal(Object.keys(before.agentMemory.sessions).length,2);
  assert.equal(repository.db.prepare('SELECT count(*) n FROM conversation_events').get().n,2);
  assert.deepEqual(await readDatabaseFile(file),before);
  repository.close();
  const reopened=await openRepository(file,{knowledgePolicy:policy});closers.push(()=>reopened.close());
  assert.equal(reopened.format,'relational-v1');assert.deepEqual(await reopened.read(),before);
  assert.deepEqual(reopened.db.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('OCR correction updates Agent retrieval and versioned source without resetting reviews; stale saves roll back',async t=> {
  const {repository,id}=await fixture(t);
  const first=await repository.read(),point=first.knowledgePoints[0];
  await repository.recordReview({knowledgePointId:point.id,rating:'good',reviewedOn:'2026-10-04'});
  const before=await repository.read(),service=new UploadCorrections(repository),current=before.uploadTranscriptions[id];
  const body={expectedVersion:1,title:current.title,items:current.items.map(i=>({...i,text:'校正后的原文：循序渐进'}))};
  await service.save(id,body,{id:'web:admin',role:'admin'});
  const after=await repository.read();
  assert.deepEqual(after.reviewStates,before.reviewStates);assert.deepEqual(after.reviewLogs,before.reviewLogs);
  assert.equal(after.photoKnowledge.documents[id].currentVersion,2);
  assert.equal(after.photoKnowledge.documents[id].revisions[0].items[0].text,'循序渐进');
  assert.equal(after.uploadTranscriptions[id].history[0].items[0].text,'循序渐进');
  assert.equal((await repository.searchPoints('校正后的原文'))[0].text.includes('校正后的原文'),true);
  await assert.rejects(service.save(id,body,{id:'web:admin',role:'admin'}),e=>e.statusCode===409);
  await assert.rejects(service.save(id,{...body,expectedVersion:2},{id:'learner',role:'learner'}),e=>e.statusCode===403);
  assert.deepEqual(await repository.read(),after);
});

test('new learning starts tomorrow, forgotten starts today, and corrections never create fake reviews',async t=> {
  const {repository,id}=await fixture(t,'learn');
  const data=await repository.read();assert.equal(data.reviewStates[0].nextReviewOn,'2026-10-05');
  assert.equal(data.reviewStates[0].stage,'new');assert.equal(data.reviewLogs.length,0);
  const before=structuredClone(data.reviewStates),s=new UploadCorrections(repository),u=data.uploadTranscriptions[id];
  await s.save(id,{expectedVersion:1,title:'校正标题',items:u.items},{id:'web:admin',role:'admin'});
  assert.deepEqual((await repository.read()).reviewStates,before);
});

test('daily reminder sends once at configured Beijing time, survives restart and leaves review state unchanged',async t=> {
  const {repository}=await fixture(t);const sent=[];
  await repository.mutate(d=>{d.reminderSettings={enabled:true,time:'09:00'};});
  const before=(await repository.read()).reviewStates;
  const options={repository,chatId:'oc_test',learnerId:'ou_test',send:async(...args)=>{sent.push(args);return {messageId:'notice-1'}},now:()=>new Date('2026-10-04T01:00:10Z')};
  await new ReviewReminders(options).tick();await new ReviewReminders(options).tick();
  assert.equal(sent.length,1);assert.equal((await repository.read()).reminderDeliveries['2026-10-04'].status,'sent');
  assert.deepEqual((await repository.read()).reviewStates,before);assert.equal((await repository.read()).reviewLogs.length,0);
  await repository.mutate(d=>{d.reminderSettings.enabled=false;});
  await new ReviewReminders({...options,now:()=>new Date('2026-10-05T01:00:10Z')}).tick();assert.equal(sent.length,1);
});

test('live console and correction APIs require admin login and enforce version checks and origin',async t=> {
  const {repository,file,policy,closers}=await fixture(t);repository.close();
  const server=await startServer(file,{WEB_ADMIN_USERS:'tester',FEISHU_APP_ID:policy.appId,FEISHU_TEST_GROUP_ID:policy.groupId,FEISHU_LEARNER_OPEN_ID:policy.learnerId});closers.push(()=>server.stop());
  assert.equal((await fetch(server.url+'/api/console')).status,401);
  const cookie=(await server.login()).headers.get('set-cookie').split(';')[0],headers={cookie,'Content-Type':'application/json'};
  const view=await (await fetch(server.url+'/api/console',{headers})).json();assert.equal(view.uploads.length,1);assert.equal(view.points.length,1);
  assert.equal((await fetch(server.url+'/console/',{headers})).status,200);
  const upload=view.uploads[0],body=JSON.stringify({expectedVersion:upload.version,title:'校正标题',items:upload.items});
  assert.equal((await fetch(server.url+`/api/uploads/${upload.id}/corrections`,{method:'POST',headers:{...headers,Origin:'https://outside.example'},body})).status,403);
  assert.equal((await fetch(server.url+`/api/uploads/${upload.id}/corrections`,{method:'POST',headers,body})).status,200);
  assert.equal((await fetch(server.url+`/api/uploads/${upload.id}/corrections`,{method:'POST',headers,body})).status,409);
});
