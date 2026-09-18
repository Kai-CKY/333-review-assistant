import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { LocalRepository } from '../src/repository.js';
import { StudyService } from '../src/study-service.js';
import { todayKey } from '../src/domain/date.js';
import { readGroupHistory, saveHistoryProgress } from '../src/feishu/history-progress.js';

const chatId = 'oc_test', senderId = 'ou_learner';
const message = { message_id: 'om_progress', sender: { id: senderId, sender_type: 'user' }, msg_type: 'text', create_time: '1750000000000', body: { content: JSON.stringify({ text: '今天完成教育学第一章，做了20道题，3道错题。' }) } };

async function fixture() {
  const folder = await mkdtemp(path.join(tmpdir(), '333-integration-'));
  const file = path.join(folder, 'database.json');
  const repository = new LocalRepository(file);
  return { file, repository, studyService: new StudyService(repository) };
}

async function startServer(file) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/server.js', import.meta.url))], {
    env: { ...process.env, PORT: '0', DATA_FILE: file, FEISHU_ENABLED: 'false', ARK_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('server startup timed out')); }, 10000);
    child.once('error', (e) => { clearTimeout(timer); reject(e); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}`)); });
    child.stdout.on('data', (chunk) => {
      const match = chunk.toString().match(/http:\/\/localhost:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    child.stderr.resume();
  });
  return { url, stop: async () => { if (child.exitCode !== null) return; const exited = once(child, 'exit'); child.kill(); await exited; } };
}

test('Feishu history pagination, permission errors and incomplete reads are explicit', async () => {
  const calls = [];
  const client = { im: { v1: { message: { list: async ({ params }) => {
    calls.push(params);
    return params.page_token ? { code: 0, data: { items: [message], has_more: false } } : { code: 0, data: { items: [message], has_more: true, page_token: 'p2' } };
  } } } } };
  assert.equal((await readGroupHistory(client, chatId)).length, 1);
  assert.equal(calls[1].page_token, 'p2');
  await assert.rejects(readGroupHistory(client, chatId, { maxPages: 1 }), /history_incomplete/);
  client.im.v1.message.list = async () => ({ code: 99991672 });
  await assert.rejects(readGroupHistory(client, chatId), (e) => e.code === 99991672);
});

test('historical progress persists before acknowledgement, deduplicates retries and reaches real Web API after restart', async (t) => {
  const { file, repository, studyService } = await fixture();
  const before = await repository.read();
  const ackKeys = [];
  const client = { im: { v1: { message: { create: async (request) => {
    assert.equal((await repository.read()).taskCompletionLogs.length, 1, 'ack must follow durable write');
    ackKeys.push(request.data.uuid);
    if (ackKeys.length === 1) throw new Error('network interrupted');
    return { code: 0, data: { message_id: 'om_ack' } };
  } } } } };
  const input = { studyService, client, chatId, senderId, messages: [message], messageIds: [message.message_id], reportedOn: '2026-09-16' };
  await assert.rejects(saveHistoryProgress({ ...input, senderId: 'ou_other' }), /not_eligible/);
  await assert.rejects(saveHistoryProgress(input), /network interrupted/);
  const result = await saveHistoryProgress(input);
  assert.equal(result.entries[0].idempotent, true);
  assert.equal(ackKeys[0], ackKeys[1]);
  const after = await repository.read();
  assert.deepEqual(after.reviewStates, before.reviewStates);
  assert.deepEqual(after.reviewLogs, before.reviewLogs);
  assert.equal(after.taskCompletionLogs[0].sourceMetadata.messageId, message.message_id);
  assert.equal(after.taskCompletionLogs[0].reportedOn, '2026-09-16');
  let server = await startServer(file);
  t.after(async () => server.stop());
  const getDashboard = async () => (await fetch(`${server.url}/api/dashboard?date=2026-09-16`)).json();
  let dashboard = await getDashboard();
  assert.equal(dashboard.selfReportedCompletedToday, 1);
  assert.equal(dashboard.recentTaskCompletions[0].content, JSON.parse(message.body.content).text);
  assert.equal((await fetch(server.url)).status, 200);
  await server.stop();
  server = await startServer(file);
  dashboard = await getDashboard();
  assert.equal(dashboard.selfReportedCompletedToday, 1);
  const response = await fetch(`${server.url}/api/answer-attempts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ knowledgePointId: before.knowledgePoints[0].id, content: '集成测试答案', sourceId: 'integration-answer' }) });
  assert.equal(response.status, 202);
  const queued = await response.json();
  let feedback;
  const deadline = Date.now() + 3000;
  do {
    feedback = await (await fetch(`${server.url}/api/feedback-jobs/${queued.job.id}`)).json();
    if (!['queued', 'running'].includes(feedback.job.status)) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  assert.equal(feedback.job.status, 'failed', 'disabled model must not fake a successful feedback');
  assert.equal((await getDashboard()).selfReportedCompletedToday, 1);
});

test('learning date uses Shanghai timezone on UTC cloud hosts', () => {
  assert.equal(todayKey(new Date('2026-09-15T16:01:00Z')), '2026-09-16');
  assert.equal(todayKey(new Date('2026-09-16T15:59:00Z')), '2026-09-16');
});
