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

test('excludes exactly the preceding two calendar days and returns older points to the random pool',()=>{
  const data=fixture(10);
  data.reminderDeliveries={
    '2026-10-13':{knowledgePointIds:['p0']},
    '2026-10-14':{knowledgePointIds:['p1','p2']},
    '2026-10-15':{knowledgePointIds:['p3','p4']},
    '2026-10-17':{knowledgePointIds:['p5']}
  };
  const before=structuredClone(data);
  assert.deepEqual(sampleDailyReview(data,'2026-10-16',()=>0).map(p=>p.id),['p0','p5','p6','p7','p8']);
  assert.deepEqual(data,before);
});

test('calendar exclusion crosses year and leap-month boundaries',()=>{
  for(const [day,yesterday,twoDaysAgo,threeDaysAgo] of [
    ['2027-01-01','2026-12-31','2026-12-30','2026-12-29'],
    ['2028-03-01','2028-02-29','2028-02-28','2028-02-27']
  ]) {
    const data=fixture(3);
    data.reminderDeliveries={
      [yesterday]:{knowledgePointIds:['p0']},
      [twoDaysAgo]:{knowledgePointIds:['p1']},
      [threeDaysAgo]:{knowledgePointIds:['p2']}
    };
    assert.deepEqual(sampleDailyReview(data,day,()=>0).map(p=>p.id),['p2']);
  }
});

test('legacy delivery records without selected IDs do not prevent a new sample',()=>{
  const data=fixture(5);
  data.reminderDeliveries={'2026-10-15':{status:'sent',count:65},'2026-10-14':{status:'sent'}};
  assert.equal(sampleDailyReview(data,'2026-10-16').length,5);
});

function options(data,sent) {
  return {repository:{read:async()=>structuredClone(data),mutate:async fn=>fn(data)},
    chatId:'oc_test',learnerId:'ou_test',now:()=>new Date('2026-10-16T01:00:10Z'),pickIndex:size=>size-1,
    send:async(chat,payload)=>{sent.push(payload);return {messageId:'om_test'};}};
}

test('small pools never reuse recent claimed selections, including sending and failed deliveries',async()=>{
  const data=fixture(6),sent=[];
  data.reminderDeliveries={
    '2026-10-15':{status:'failed',knowledgePointIds:['p0','p1']},
    '2026-10-14':{status:'sending',knowledgePointIds:['p2','p3']}
  };
  const config=options(data,sent);
  await new ReviewReminders(config).tick();
  assert.deepEqual(data.reminderDeliveries['2026-10-16'].knowledgePointIds,['p5','p4']);
  assert.match(sent[0].text,/今天抽到这 2 个知识点/);
  await new ReviewReminders({...config,now:()=>new Date('2026-10-17T01:00:10Z')}).tick();
  assert.deepEqual(data.reminderDeliveries['2026-10-17'].knowledgePointIds,['p3','p2']);
  const empty=fixture(4),emptySent=[];
  empty.reminderDeliveries={
    '2026-10-15':{status:'failed',knowledgePointIds:['p0','p1']},
    '2026-10-14':{status:'sending',knowledgePointIds:['p2','p3']}
  };
  const previous=structuredClone(empty);
  await new ReviewReminders(options(empty,emptySent)).tick();
  assert.equal(emptySent.length,0);
  assert.deepEqual(empty,previous);
});

test('restarted reminders keep every rolling three-day window distinct and allow day-four reuse',async()=>{
  const data=fixture(15),sent=[],config={...options(data,sent),pickIndex:()=>0};
  const before=structuredClone(data.reviewStates);
  for(const day of ['2026-10-16','2026-10-17','2026-10-18','2026-10-19']) {
    const current={...config,now:()=>new Date(`${day}T01:00:10Z`)};
    await new ReviewReminders(current).tick();
    await new ReviewReminders({...current,pickIndex:()=>{throw new Error('must not resample');}}).tick();
  }
  const draws=Object.values(data.reminderDeliveries).map(record=>record.knowledgePointIds);
  assert.equal(sent.length,4);
  assert.equal(new Set(draws.slice(0,3).flat()).size,15);
  assert.equal(new Set(draws.slice(1,4).flat()).size,15);
  assert.deepEqual(draws[3],draws[0]);
  assert.deepEqual(data.reviewStates,before);assert.deepEqual(data.reviewLogs,[]);
});

test('message lists only the persisted five topics and restart does not resample or send again',async()=>{
  const data=fixture(),sent=[],config=options(data,sent),before=structuredClone(data.reviewStates);
  await new ReviewReminders(config).tick();
  const record=structuredClone(data.reminderDeliveries['2026-10-16']);
  assert.equal(record.status,'sent');assert.equal(record.selectionMode,'random_due');
  assert.equal(record.knowledgePointIds.length,5);assert.equal(sent.length,1);
  assert.equal(sent[0].text.split('\n').filter(line=>/^\d+\. /.test(line)).length,5);
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
