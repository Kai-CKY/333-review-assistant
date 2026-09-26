import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalRepository } from './repository.js';
import { StudyService } from './study-service.js';
import { startFeishuBot } from './feishu/bot.js';
import { ArkFeedbackProvider } from './ark/feedback.js';
import { ArkStudyAgent } from './ark/agent.js';
import { createWebAuth } from './web-auth.js';
import { PdfImportService, pdfScope, MAX_PDF_BYTES } from './knowledge/pdf-import.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, '../../web');
const repository = new LocalRepository(process.env.DATA_FILE ? path.resolve(process.env.DATA_FILE) : path.resolve(__dirname, '../../../.data/review-assistant.json'));
const modelProvider = new ArkFeedbackProvider();
const studyAgent = new ArkStudyAgent({ provider: modelProvider, repository });
const webAuth = createWebAuth();
const studyService = new StudyService(repository, { modelProvider });
const pdfImports = new PdfImportService({ repository });
await pdfImports.reconcile();
const feedbackService = studyService.feedbackService;
let startupFeedbackRecovery = { queuedJobIds: [], interruptedJobIds: [] };
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
    if (request.method === 'POST' && url.pathname === '/api/logout') {
      response.setHeader('Set-Cookie', webAuth.logout(request));
      return sendJson(response, 200, { ok: true });
    }
    if (session.role === 'admin' && !['GET', 'HEAD'].includes(request.method)) {
      return sendJson(response, 403, { error: '管理员仅查看羊羊的数据，不能代替她作答或自评。' });
    }
    if (url.pathname.startsWith('/api/pdf-imports')) {
      const scope = pdfScope();
      if (request.method === 'GET' && url.pathname === '/api/pdf-imports') return sendJson(response, 200, { parser: await pdfImports.parser.health(), jobs: await pdfImports.list(scope) });
      if (request.method === 'POST' && url.pathname === '/api/pdf-imports') {
        const body = await readJson(request, Math.ceil(MAX_PDF_BYTES * 4 / 3) + 4096);
        if (typeof body.base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.base64)) return sendJson(response, 400, { error: 'PDF 编码无效。' });
        const job = await pdfImports.submit(scope, { filename: body.filename, bytes: Buffer.from(body.base64, 'base64'), actor: `web:${session.user}` });
        return sendJson(response, 202, job);
      }
      const match = url.pathname.match(/^\/api\/pdf-imports\/(KP-[a-f0-9]{8})(?:\/(source|confirm))?$/);
      if (match) {
        const job = await pdfImports.get(scope, match[1]);
        if (request.method === 'GET' && !match[2]) return sendJson(response, 200, job);
        if (request.method === 'GET' && match[2] === 'source') {
          const bytes = await readFile(path.join(pdfImports.root, job.id, 'source.pdf'));
          response.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="source.pdf"' });
          return response.end(bytes);
        }
        if (request.method === 'POST' && match[2] === 'confirm') {
          const body = await readJson(request);
          if (body.reviewed !== true) return sendJson(response, 400, { error: '请先核对原文并确认待核验存档。' });
          return sendJson(response, 200, await pdfImports.confirm(scope, job.id, `web:${session.user}`));
        }
      }
      return sendJson(response, 404, { error: 'route not found' });
    }
    if (url.pathname.startsWith('/api/')) {
      await handleApi(request, response, url);
      return;
    }
    await serveStatic(response, url.pathname);
  } catch (error) {
    console.error('HTTP request failed:', error.statusCode || 'internal_error');
    sendJson(response, error.statusCode || 500, { error: error.statusCode ? error.message : '请求失败，请稍后重试。' });
  }
});

async function handleApi(request, response, url) {
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
    const attempt = await studyService.saveAnswer(body);
    const task = await studyService.getPracticeTask(attempt.knowledgePointId);
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
      message: '答案已保存，正在生成结构性提示；它不会自动改变自评或复习排程。'
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
  if (startupFeedbackRecovery.interruptedJobIds.length) {
    console.warn(`${startupFeedbackRecovery.interruptedJobIds.length} interrupted feedback job(s) were marked failed safely.`);
  }
  if (startupFeedbackRecovery.queuedJobIds.length) {
    void feedbackService.processQueued(startupFeedbackRecovery.queuedJobIds)
      .catch((error) => console.warn('Recovered feedback jobs could not be processed:', error.code ?? error.message));
  }
  startFeishuBot({ studyService, repository, feedbackService, modelProvider, studyAgent, pdfImports, logger: console })
    .then((result) => { feishuBotStatus = result; })
    .catch((error) => {
      feishuBotStatus = { status: 'error', message: error.message };
      console.error('Feishu bot did not start:', error.message);
    });
});
