import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openRepository } from './storage/open-repository.js';
import { StudyService } from './study-service.js';
import { startFeishuBot } from './feishu/bot.js';
import { ArkFeedbackProvider } from './ark/feedback.js';
import { ArkStudyAgent } from './ark/agent.js';
import { createWebAuth } from './web-auth.js';
import { KnowledgeWorkspace } from './knowledge/workspace-service.js';
import { ClarificationService } from './knowledge/clarifications.js';
import { SourcePhotoService } from './knowledge/source-service.js';
import { SourcePhotoModel } from './knowledge/source-model.js';
import { SourcePhotoVerifier } from './knowledge/source-verifier.js';
import { readKnowledgePage } from './knowledge/source-pages.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, '../../web');
const repository = await openRepository(process.env.DATA_FILE ? path.resolve(process.env.DATA_FILE) : path.resolve(__dirname, '../../../.data/review-assistant.json'));
const modelProvider = new ArkFeedbackProvider();
const studyAgent = new ArkStudyAgent({ provider: modelProvider, repository });
const webAuth = createWebAuth();
const studyService = new StudyService(repository, { modelProvider });
const knowledgeWorkspace = new KnowledgeWorkspace(repository);
const clarificationService = new ClarificationService({ repository });
const sourcePhotoService = new SourcePhotoService({ repository, model: new SourcePhotoModel(modelProvider), verifier: new SourcePhotoVerifier({ repository }), logger: console });
const feedbackService = studyService.feedbackService;
let startupFeedbackRecovery = { queuedJobIds: [], interruptedJobIds: [] };
await sourcePhotoService.reconcile();
try {
  // Reconcile before listen() so only work left by an earlier process can be
  // classified as interrupted. Recovered queued jobs are processed after the
  // server becomes available below.
  startupFeedbackRecovery = await feedbackService.reconcilePending();
} catch (error) {
  console.warn('Feedback-job startup reconciliation is unavailable:', error.code ?? error.message);
}
const port = Number(process.env.PORT ?? 3333);
// Keep the backend private even with application authentication.
// Containers set HOST=0.0.0.0 and
// are published back to the host's loopback interface in compose.yaml.
const host = process.env.HOST ?? '127.0.0.1';
let feishuBotStatus = { status: 'not_started' };

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
};

const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'same-origin');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (request.method === 'GET' && url.pathname === '/api/health') return handleApi(request, response, url);
    if (request.method === 'POST' && url.pathname === '/api/login') {
      const retryAfter = webAuth.consumeAttempt(request);
      if (retryAfter) {
        response.setHeader('Retry-After', retryAfter);
        return sendJson(response, 429, { error: '尝试过于频繁，请稍后重试。' });
      }
      if (!webAuth.validMutation(request)) return sendJson(response, 403, { error: '请从本站登录页面提交。' });
      const result = await webAuth.login(await readJson(request));
      if (result.cookie) response.setHeader('Set-Cookie', result.cookie);
      if (result.retryAfter) response.setHeader('Retry-After', result.retryAfter);
      return sendJson(response, result.status, result.error ? { error: result.error } : { user: result.user });
    }
    const session = webAuth.authenticate(request);
    if (request.method === 'GET' && ['/login', '/login.html', '/login.js', '/styles.css'].includes(url.pathname)) {
      if (session && ['/login', '/login.html'].includes(url.pathname)) return redirect(response, '/');
      return await serveStatic(response, url.pathname === '/login' ? '/login.html' : url.pathname);
    }
    if (!session) {
      if (url.pathname.startsWith('/api/')) return sendJson(response, 401, { error: '请先登录。' });
      return redirect(response, '/login');
    }
    if (!['GET', 'HEAD'].includes(request.method) && !webAuth.validMutation(request)) {
      return sendJson(response, 403, { error: '请从本站页面提交 JSON 请求。' });
    }
    if (request.method === 'GET' && url.pathname === '/api/session') return sendJson(response, 200, { user: session.user, role: session.role });
    const sourcePage = url.pathname.match(/^\/api\/knowledge-sources\/(KP-[a-f0-9]{8})\/pages\/([1-9][0-9]{0,5})$/);
    if (request.method === 'GET' && sourcePage) {
      const { bytes, mime } = await readKnowledgePage(repository, sourcePage[1], Number(sourcePage[2]), { withType: true });
      response.writeHead(200, { 'Content-Type': mime, 'Content-Disposition': `inline; filename="${sourcePage[1]}.${mime === 'application/pdf' ? 'pdf' : 'jpg'}"` });
      return response.end(bytes);
    }
    if (request.method === 'POST' && url.pathname === '/api/logout') {
      response.setHeader('Set-Cookie', webAuth.logout(request));
      return sendJson(response, 200, { ok: true });
    }
    if (url.pathname === '/api/pdf-imports' || url.pathname.startsWith('/api/pdf-imports/')) {
      return sendJson(response, 410, { error: 'PDF 已改为离线解析。请在本地核对后导入资料；已入库教材仍可从知识索引查看原文。' });
    }
    const materialWrite = url.pathname === '/api/knowledge-v2/search' ||
      /^\/api\/knowledge-v2\/points\/[^/]+\/(answer-reviews|relations)$/.test(url.pathname);
    if (session.role === 'admin' && !['GET', 'HEAD'].includes(request.method) && !(request.method === 'POST' && materialWrite)) {
      return sendJson(response, 403, { error: '管理员仅查看羊羊的数据，不能代替她作答或自评。' });
    }
    const actor = { id: `web:${session.user}`, role: session.role };
    if (url.pathname.startsWith('/api/knowledge-v2/')) {
      const route = url.pathname.slice('/api/knowledge-v2'.length);
      if (request.method === 'GET' && route === '/photo-jobs') return sendJson(response, 200, await sourcePhotoService.list(actor, Object.fromEntries(url.searchParams)));
      const photoJob = route.match(/^\/photo-jobs\/(KP-[a-f0-9]{8})(?:\/(retry))?$/);
      if (photoJob && request.method === 'GET' && !photoJob[2]) return sendJson(response, 200, await sourcePhotoService.getVisible(photoJob[1], actor));
      if (photoJob && request.method === 'POST' && photoJob[2] === 'retry') return sendJson(response, 200, await sourcePhotoService.retry(photoJob[1], actor));
      if (request.method === 'GET' && route === '/clarifications') return sendJson(response, 200, await clarificationService.list(Object.fromEntries(url.searchParams), actor));
      if (request.method === 'POST' && route === '/clarifications/next') return sendJson(response, 200, await clarificationService.next(null, actor));
      if (request.method === 'POST' && route === '/clarifications/answers') {
        const input = await readJson(request);
        return sendJson(response, 200, await clarificationService.answer(input.invitationId, { text: input.text, idempotencyKey: input.idempotencyKey }, actor));
      }
      if (request.method === 'POST' && route === '/clarifications/defer') {
        const input = await readJson(request);
        return sendJson(response, 200, await clarificationService.defer(input.invitationId, actor));
      }
      if (request.method === 'GET' && route === '/sources') return sendJson(response, 200, await knowledgeWorkspace.sources());
      if (request.method === 'GET' && route === '/points') return sendJson(response, 200, await knowledgeWorkspace.list(Object.fromEntries(url.searchParams)));
      if (request.method === 'POST' && route === '/search') {
        const input = await readJson(request);
        return sendJson(response, 200, await knowledgeWorkspace.search(input.query, { textbookOnly: input.textbookOnly === true, limit: input.limit }));
      }
      if (request.method === 'POST' && route === '/spot-checks') {
        const clarification = await clarificationService.next(null, actor);
        return sendJson(response, 200, clarification ? { type: 'clarification', ...clarification } : await knowledgeWorkspace.spotCheck(actor));
      }
      const match = route.match(/^\/points\/([^/]+)(?:\/(graph|excerpt|answer-reviews|enrollment|relations))?$/);
      if (match) {
        const id = decodeURIComponent(match[1]), action = match[2];
        if (request.method === 'GET' && !action) return sendJson(response, 200, await knowledgeWorkspace.get(id));
        if (request.method === 'GET' && action === 'graph') return sendJson(response, 200, await knowledgeWorkspace.graph(id));
        if (request.method === 'GET' && action === 'excerpt') return sendJson(response, 200, await knowledgeWorkspace.excerpt(id, url.searchParams.has('version') ? url.searchParams.get('version') : undefined));
        if (request.method === 'POST' && action === 'answer-reviews') return sendJson(response, 200, await knowledgeWorkspace.reviewAnswer(id, await readJson(request, 1048576), actor));
        if (request.method === 'POST' && action === 'enrollment') return sendJson(response, 200, await knowledgeWorkspace.enroll(id, actor));
        if (request.method === 'POST' && action === 'relations') return sendJson(response, 200, await knowledgeWorkspace.addRelation(id, await readJson(request), actor));
      }
      return sendJson(response, 404, { error: 'route not found' });
    }
    if (request.method === 'POST' && url.pathname === '/api/practice-sessions') {
      const input = await readJson(request);
      return sendJson(response, 201, await studyService.startPractice(input.knowledgePointId, actor.id));
    }
    if (url.pathname.startsWith('/api/')) {
      await handleApi(request, response, url, actor);
      return;
    }
    await serveStatic(response, url.pathname);
  } catch (error) {
    console.error('HTTP request failed:', error.statusCode || 'internal_error');
    sendJson(response, error.statusCode || 500, { error: error.statusCode ? error.message : '请求失败，请稍后重试。' });
  }
});

async function handleApi(request, response, url, actor) {
  if (request.method === 'GET' && url.pathname === '/api/health') {
    return sendJson(response, 200, { status: 'ok' });
  }

  if (request.method === 'GET' && url.pathname === '/api/dashboard') {
    return sendJson(response, 200, await studyService.getDashboard(url.searchParams.get('date') ?? undefined));
  }

  if (request.method === 'GET' && url.pathname === '/api/knowledge-points') {
    const data = await repository.read();
    return sendJson(response, 200, data.knowledgePoints.filter(point => !point.archived && !point.hidden).map((point) => ({
      ...point,
      state: data.reviewStates.find((item) => item.knowledgePointId === point.id) ?? null,
      timeline: [
        ...data.memoryEvents.filter(event => event.knowledgePointId === point.id),
        ...data.reviewLogs.filter(log => log.knowledgePointId === point.id).map(log => ({ type: 'review', on: log.reviewedOn, rating: log.rating, nextReviewOn: log.nextReviewOn }))
      ].sort((a, b) => a.on.localeCompare(b.on))
    })));
  }

  if (request.method === 'POST' && url.pathname === '/api/reviews') {
    const body = await readJson(request);
    const result = await studyService.recordReview(body);
    return sendJson(response, 201, result);
  }

  if (request.method === 'POST' && url.pathname === '/api/answer-attempts') {
    const body = await readJson(request);
    const session = body.practiceSessionId ? await studyService.practiceSession(body.practiceSessionId, actor.id, body.knowledgePointId) : null;
    const selectedTask = session?.task || await studyService.getPracticeTask(body.knowledgePointId);
    const attempt = await studyService.saveAnswer({ knowledgePointId: body.knowledgePointId, content: body.content,
      sourceId: body.sourceId, practiceSessionId: session?.id, taskSnapshot: selectedTask });
    const task = attempt.taskSnapshot || selectedTask;
    const queued = await feedbackService.enqueue({
      attempt,
      task,
      idempotencyKey: `web:feedback:${attempt.id}`,
      channel: 'web'
    });
    void feedbackService.process(queued.job.id).catch((error) => {
      console.warn(`Feedback job ${queued.job.id} could not be processed:`, error.code ?? error.message);
    });
    return sendJson(response, 202, {
      attempt,
      job: queued.job,
      message: '答案已保存，正在生成反馈；它不会自动改变自评或复习排程。'
    });
  }

  const feedbackJobMatch = url.pathname.match(/^\/api\/feedback-jobs\/([^/]+)$/);
  if (request.method === 'GET' && feedbackJobMatch) {
    const result = await feedbackService.get(decodeURIComponent(feedbackJobMatch[1]));
    if (!result) return sendJson(response, 404, { error: 'feedback job not found' });
    return sendJson(response, 200, result);
  }

  return sendJson(response, 404, { error: 'route not found' });
}

async function readJson(request, limit = 65536) {
  let raw = '';
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('请求内容过大。'), { statusCode: 413 });
    chunks.push(chunk);
  }
  raw = Buffer.concat(chunks).toString('utf8');
  try {
    const body = raw ? JSON.parse(raw) : {};
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid body');
    return body;
  } catch {
    throw Object.assign(new Error('请求必须是 JSON 对象。'), { statusCode: 400 });
  }
}

async function serveStatic(response, pathname) {
  const requestedPath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.resolve(webRoot, `.${decodeURIComponent(requestedPath)}`);
  const relative = path.relative(webRoot, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return sendJson(response, 403, { error: 'forbidden' });
  try {
    const content = await readFile(filePath);
    response.writeHead(200, { 'content-type': mimeTypes[path.extname(filePath)] ?? 'application/octet-stream' });
    response.end(content);
  } catch (error) {
    if (error.code === 'ENOENT') return sendJson(response, 404, { error: 'not found' });
    throw error;
  }
}

function sendJson(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function redirect(response, location) {
  response.writeHead(303, { location });
  response.end();
}

server.listen(port, host, () => {
  console.log(`333 review assistant is running at http://localhost:${server.address().port} (bound to ${host})`);
  void sourcePhotoService.processQueued().catch(error => console.warn('Recovered photo jobs could not be processed:', error.code ?? error.message));
  if (startupFeedbackRecovery.interruptedJobIds.length) {
    console.warn(`${startupFeedbackRecovery.interruptedJobIds.length} interrupted feedback job(s) were marked failed safely.`);
  }
  if (startupFeedbackRecovery.queuedJobIds.length) {
    void feedbackService.processQueued(startupFeedbackRecovery.queuedJobIds)
      .catch((error) => console.warn('Recovered feedback jobs could not be processed:', error.code ?? error.message));
  }
  startFeishuBot({ studyService, repository, feedbackService, modelProvider, studyAgent, sourcePhotoService, logger: console })
    .then((result) => { feishuBotStatus = result; })
    .catch((error) => {
      feishuBotStatus = { status: 'error', message: error.message };
      console.error('Feishu bot did not start:', error.message);
    });
});
