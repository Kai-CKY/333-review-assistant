import test from 'node:test';
import assert from 'node:assert/strict';
import { ReviewReminders, sampleDailyReview } from '../src/feishu/reminders.js';

function fixture(count=65) {
  return {
    knowledgePoints:Array.from({length:count},(_,i)=>({id:`p${i}`,title:`题目${i}`,practiceEligible:true})),
    reviewStates:Array.from({length:count},(_,i)=>({knowledgePointId:`p${i}`,nextReviewOn:'2026-10-15',mastery:0.3})),
    reviewLogs:[],reminderSettings:{enabled:true,time:'09:00'}
  };
}

test('daily sample selects five distinct due eligible points, can reach the tail and leaves inputs unchanged',()=>{
  const data=fixture();
  data.knowledgePoints[64].archived=true;
  data.knowledgePoints[63].hidden=true;
  data.knowledgePoints[62].practiceEligible=false;
  data.reviewStates[61].nextReviewOn='2026-10-17';
  const before=structuredClone(data);
  assert.deepEqual(sampleDailyReview(data,'2026-10-16',size=>size-1).map(p=>p.id),['p60','p59','p58','p57','p56']);
  const selected=sampleDailyReview(data,'2026-10-16');
  assert.equal(selected.length,5);assert.equal(new Set(selected.map(p=>p.id)).size,5);
  assert.ok(selected.every(p=>Number(p.id.slice(1))<=60));
  assert.deepEqual(data,before);
});

test('fewer than five candidates sends the available points; no due points sends nothing',async()=>{
  assert.equal(sampleDailyReview(fixture(3),'2026-10-16').length,3);
  assert.equal(sampleDailyReview(fixture(),'2026-10-14').length,0);
  const data=fixture(0),sent=[];
  await new ReviewReminders(options(data,sent)).tick();
  assert.equal(sent.length,0);
});

function options(data,sent) {
  return {repository:{read:async()=>structuredClone(data),mutate:async fn=>fn(data)},
    chatId:'oc_test',learnerId:'ou_test',now:()=>new Date('2026-10-16T01:00:10Z'),pickIndex:size=>size-1,
    send:async(chat,payload)=>{sent.push(payload);return {messageId:'om_test'};}};
}

test('message lists only the persisted five topics and restart does not resample or send again',async()=>{
  const data=fixture(),sent=[],config=options(data,sent),before=structuredClone(data.reviewStates);
  await new ReviewReminders(config).tick();
  const record=structuredClone(data.reminderDeliveries['2026-10-16']);
  assert.equal(record.status,'sent');assert.equal(record.selectionMode,'random_due');
  assert.equal(record.knowledgePointIds.length,5);assert.equal(sent.length,1);
  assert.match(sent[0].text,/今天随机抽查 5 个/);
  for(const title of record.titles)assert.ok(sent[0].text.includes(title));
  assert.ok(!sent[0].text.includes('65 个'));assert.ok(!sent[0].text.includes('今天复习什么'));
  await new ReviewReminders({...config,pickIndex:()=>{throw new Error('must not resample');}}).tick();
  assert.equal(sent.length,1);assert.deepEqual(data.reminderDeliveries['2026-10-16'],record);
  assert.deepEqual(data.reviewStates,before);assert.deepEqual(data.reviewLogs,[]);
});

test('uncertain delivery retains selected IDs and suppresses automatic retry',async()=>{
  const data=fixture(),sent=[],config=options(data,sent);
  config.send=async()=>{sent.push('attempt');throw new Error('timeout');};config.logger={warn(){}};
  await new ReviewReminders(config).tick();
  assert.equal(data.reminderDeliveries['2026-10-16'].status,'failed');
  assert.equal(data.reminderDeliveries['2026-10-16'].knowledgePointIds.length,5);
  await new ReviewReminders(config).tick();assert.equal(sent.length,1);
});

test('time and pause controls still apply; next day draws a fresh sample without changing reviews',async()=>{
  const data=fixture(),sent=[],config=options(data,sent);
  await new ReviewReminders({...config,now:()=>new Date('2026-10-16T00:59:59Z')}).tick();
  assert.equal(sent.length,0);
  data.reminderSettings.enabled=false;await new ReviewReminders(config).tick();assert.equal(sent.length,0);
  data.reminderSettings.enabled=true;await new ReviewReminders(config).tick();
  await new ReviewReminders({...config,now:()=>new Date('2026-10-17T01:00:10Z'),pickIndex:()=>0}).tick();
  assert.equal(sent.length,2);
  assert.notDeepEqual(data.reminderDeliveries['2026-10-16'].knowledgePointIds,data.reminderDeliveries['2026-10-17'].knowledgePointIds);
  assert.deepEqual(data.reviewStates,fixture().reviewStates);
});
