import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { LocalRepository } from '../src/repository.js';
import { PdfImportService, MineruParser, validatePdf } from '../src/knowledge/pdf-import.js';
import { conversationScope } from '../src/agent/memory.js';
import { exportKnowledge, restoreKnowledge } from '../src/knowledge/snapshot.js';
import { startServer, testHash } from './helpers/http-server.js';
import { downloadGroupPdf } from '../src/feishu/group-pdf.js';
import { Readable } from 'node:stream';
import { createGroupConversation } from '../src/feishu/group-conversation.js';

const scope = conversationScope({ appId: 'pdf-test', chatType: 'group', chatId: 'test-group' });
const other = conversationScope({ appId: 'pdf-test', chatType: 'group', chatId: 'other-group' });
const bytes = Buffer.from('%PDF-1.7\nfixture');
const parsed = { parserName: 'mineru', parserVersion: '3.4.5', pages: [
  { pageNumber: 1, blocks: [{ blockId: 'p1-b1', plainText: '课程标准：频次9。', bbox: [0,0,100,100] }] },
  { pageNumber: 2, blocks: [{ blockId: 'p2-b1', plainText: '概念图：频次8。' }] }
] };
async function fixture(parser) {
  const directory = await mkdtemp(path.join(tmpdir(), '333-pdf-test-'));
  const repository = new LocalRepository(path.join(directory, 'data.json'), { knowledgePolicy: { appId: 'pdf-test', groupId: 'test-group' } });
  const service = new PdfImportService({ repository, parser: parser || { configured: () => true, parse: async () => structuredClone(parsed) } });
  return { directory, repository, service };
}

test('PDF remains draft until confirmation; deduplicates, preserves pages, snapshots and shared projection', async () => {
  const { directory, repository, service } = await fixture();
  const input = { filename: '教材.pdf', bytes, actor: 'learner' };
  const first = await service.submit(scope, input);
  const duplicate = await service.submit(scope, input);
  assert.equal(first.id, duplicate.id);
  await service.tail;
  assert.equal((await service.get(scope, first.id)).status, 'ready');
  assert.equal((await repository.read()).knowledgePoints.filter(p => p.sourceDocumentId === first.id).length, 0);
  await assert.rejects(service.get(other, first.id), { statusCode: 404 });
  await assert.rejects(service.confirm(other, first.id, 'learner'), { statusCode: 404 });
  assert.equal((await service.confirm(scope, first.id, 'learner')).items, 2);
  assert.equal((await service.confirm(scope, first.id, 'learner')).duplicate, true);
  const data = await repository.read();
  const points = data.knowledgePoints.filter(p => p.sourceDocumentId === first.id);
  assert.equal(points.length, 2); assert.ok(points.every(p => !p.hidden && !p.archived && p.evidenceStatus === 'unresolved'));
  assert.equal(data.photoKnowledge.documents[first.id].revisions[0].items[1].sourcePage, 2);
  const snapshot = path.join(directory, 'snapshot');
  await exportKnowledge({ databaseFile: repository.filePath, outputDir: snapshot, knowledgePolicy: repository.knowledgePolicy });
  const restored = path.join(directory, 'restored', 'data.json');
  await restoreKnowledge({ databaseFile: restored, snapshotDir: snapshot });
  assert.deepEqual(await readFile(path.join(directory, 'restored', 'knowledge-library', first.id, 'source.pdf')), bytes);
});

test('PDF errors fail safely, allow retry, and interrupted jobs do not auto-replay', async () => {
  const { service, repository } = await fixture({ configured: () => true, parse: async () => { throw new Error('engine internal'); } });
  assert.throws(() => validatePdf('x.exe', bytes));
  assert.throws(() => validatePdf('x.pdf', Buffer.from('not a pdf')));
  const first = await service.submit(scope, { filename: 'x.pdf', bytes, actor: 'learner' });
  await service.tail;
  assert.equal((await service.get(scope, first.id)).status, 'failed');
  await assert.rejects(service.confirm(scope, first.id, 'learner'));
  const next = await service.submit(scope, { filename: 'x.pdf', bytes, actor: 'learner' });
  assert.notEqual(next.id, first.id); await service.tail;
  await repository.mutate(data => { data.pdfImports[next.id].status = 'running'; });
  await service.reconcile();
  assert.match((await service.get(scope, next.id)).error, /服务重启/);
});

test('parser rejects page gaps and empty output, maps limits, sends PDF to configured service only', async () => {
  let sent;
  const parser = new MineruParser({ url: 'http://parser:8010', fetchImpl: async (url, args) => { sent = { url, args }; return { ok: true, json: async () => parsed }; } });
  assert.equal((await parser.parse(bytes)).pages.length, 2);
  assert.equal(sent.url, 'http://parser:8010/parse'); assert.equal(JSON.parse(sent.args.body).base64, bytes.toString('base64'));
  parser.fetch = async () => ({ ok: true, json: async () => ({ ...parsed, pages: [{ pageNumber: 3, blocks: [] }] }) });
  await assert.rejects(parser.parse(bytes), /页码/);
  parser.fetch = async () => ({ ok: false, json: async () => ({ error: 'too_many_pages' }) });
  await assert.rejects(parser.parse(bytes), /30 页/);
});

test('HTTP PDF upload requires login, same-origin JSON and learner; saves after explicit review', async t => {
  const mock = createServer(async (req, res) => { for await (const _ of req) {} res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(req.url === '/health' ? { ready: true } : parsed)); });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  t.after(() => new Promise(resolve => mock.close(resolve)));
  const dir = await mkdtemp(path.join(tmpdir(), '333-pdf-http-'));
  const server = await startServer(path.join(dir, 'data.json'), { PDF_PARSER_URL: `http://127.0.0.1:${mock.address().port}`, FEISHU_APP_ID: 'pdf-test', FEISHU_TEST_GROUP_ID: 'test-group', WEB_USERS: `tester:${testHash},admin:${testHash}`, WEB_ADMIN_USERS: 'admin' });
  t.after(() => server.stop());
  assert.equal((await fetch(server.url + '/api/pdf-imports')).status, 401);
  const cookie = (await server.login()).headers.get('set-cookie').split(';')[0];
  const headers = { cookie, 'content-type': 'application/json' };
  const input = JSON.stringify({ filename: 'x.pdf', base64: bytes.toString('base64') });
  assert.equal((await fetch(server.url + '/api/pdf-imports', { method: 'POST', headers: { ...headers, origin: 'https://evil.invalid' }, body: input })).status, 403);
  const adminCookie = (await server.login('admin')).headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(server.url + '/api/pdf-imports', { method: 'POST', headers: { ...headers, cookie: adminCookie }, body: input })).status, 403);
  const response = await fetch(server.url + '/api/pdf-imports', { method: 'POST', headers, body: input });
  assert.equal(response.status, 202); const job = await response.json();
  for (let i = 0; i < 40; i++) {
    const result = await (await fetch(`${server.url}/api/pdf-imports/${job.id}`, { headers })).json();
    if (result.status === 'ready') break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const url = `${server.url}/api/pdf-imports/${job.id}/confirm`;
  assert.equal((await fetch(url, { method: 'POST', headers, body: '{}' })).status, 400);
  assert.equal((await fetch(url, { method: 'POST', headers, body: '{"reviewed":true}' })).status, 200);
  const points = await (await fetch(server.url + '/api/knowledge-points', { headers })).json();
  assert.equal(points.filter(p => p.sourceDocumentId === job.id).length, 2);
});

test('group PDF follows role and scope rules, requires delivered preview, and downloads attached resources', async () => {
  const f = await fixture(); const messages = [];
  const channel = { send: async (_id, value) => { messages.push(value.text); return { messageId: 'out' }; },
    rawClient: { im: { v1: { messageResource: { get: async () => ({ getReadableStream: () => Readable.from([bytes]) }) } } } } };
  const message = { chatId: 'test-group', senderId: 'learner', messageId: 'pdf1', rawContentType: 'file', content: 'file', resources: [{ type: 'file', fileName: 'x.pdf', fileKey: 'attached' }] };
  assert.deepEqual((await downloadGroupPdf(channel, message)).bytes, bytes);
  const group = createGroupConversation({ repository: f.repository, channel, chatId: 'test-group', appId: 'pdf-test', yangyangOpenId: 'learner', ownerOpenId: 'owner', pdfImports: f.service });
  await group({ ...message, senderId: 'stranger' }); assert.match(messages.at(-1), /仅已绑定/);
  await group(message); await f.service.tail;
  const job = (await f.service.list(scope))[0];
  const command = content => ({ ...message, rawContentType: 'text', content, resources: [] });
  await group(command(`确认PDF ${job.id}`)); assert.match(messages.at(-1), /先发送/);
  await group(command(`查看PDF ${job.id}`)); assert.match(messages.at(-1), /概念图/);
  await group({ ...command(`确认PDF ${job.id}`), senderId: 'owner' }); assert.match(messages.at(-1), /只有羊羊/);
  await group(command(`确认PDF ${job.id}`)); assert.equal((await f.service.get(scope, job.id)).status, 'saved');
});
