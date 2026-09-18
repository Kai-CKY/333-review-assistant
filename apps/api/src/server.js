import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalRepository } from './repository.js';
import { StudyService } from './study-service.js';
import { startFeishuBot } from './feishu/bot.js';
import { ArkFeedbackProvider } from './ark/feedback.js';
import { ArkStudyAgent } from './ark/agent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, '../../web');
const repository = new LocalRepository(process.env.DATA_FILE ? path.resolve(process.env.DATA_FILE) : path.resolve(__dirname, '../../../.data/review-assistant.json'));
const modelProvider = new ArkFeedbackProvider();
const studyAgent = new ArkStudyAgent({ provider: modelProvider });
const studyService = new StudyService(repository, { modelProvider });
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
// Default to loopback so an unconfigured cloud deployment cannot expose the
// unauthenticated API to the public internet. Containers set HOST=0.0.0.0 and
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
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname.startsWith('/api/')) {
      await handleApi(request, response, url);
      return;
    }
    await serveStatic(response, url.pathname);
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: error.message || 'internal server error' });
  }
});

async function handleApi(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/health') {
    return sendJson(response, 200, {
      status: 'ok',
      storage: 'local-json',
      model: { provider: 'ark', status: studyService.isModelConfigured() ? 'configured' : 'not_configured' },
      feishu: feishuBotStatus
    });
  }

  if (request.method === 'GET' && url.pathname === '/api/dashboard') {
    return sendJson(response, 200, await studyService.getDashboard(url.searchParams.get('date') ?? undefined));
  }

  if (request.method === 'GET' && url.pathname === '/api/knowledge-points') {
    const data = await repository.read();
    return sendJson(response, 200, data.knowledgePoints.map((point) => ({
      ...point,
      state: data.reviewStates.find((item) => item.knowledgePointId === point.id) ?? null
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

async function readJson(request) {
  let raw = '';
  for await (const chunk of request) raw += chunk;
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error('invalid JSON body');
  }
}

async function serveStatic(response, pathname) {
  const requestedPath = pathname === '/' ? '/index.html' : pathname;
  const safePath = path.normalize(requestedPath).replace(/^([.][.][/\\])+/, '');
  const filePath = path.join(webRoot, safePath);
  if (!filePath.startsWith(webRoot)) return sendJson(response, 403, { error: 'forbidden' });
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

server.listen(port, host, () => {
  console.log(`333 review assistant is running at http://localhost:${server.address().port} (bound to ${host})`);
  if (startupFeedbackRecovery.interruptedJobIds.length) {
    console.warn(`${startupFeedbackRecovery.interruptedJobIds.length} interrupted feedback job(s) were marked failed safely.`);
  }
  if (startupFeedbackRecovery.queuedJobIds.length) {
    void feedbackService.processQueued(startupFeedbackRecovery.queuedJobIds)
      .catch((error) => console.warn('Recovered feedback jobs could not be processed:', error.code ?? error.message));
  }
  startFeishuBot({ studyService, repository, feedbackService, modelProvider, studyAgent, logger: console })
    .then((result) => { feishuBotStatus = result; })
    .catch((error) => {
      feishuBotStatus = { status: 'error', message: error.message };
      console.error('Feishu bot did not start:', error.message);
    });
});
