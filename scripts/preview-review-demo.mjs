import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const candidate = path.resolve(root, process.env.REVIEW_DEMO_DATA || '.data/local-review/20261004-manual-uploads');
const tables = new Map();
async function table(name) {
  if (!tables.has(name)) tables.set(name, JSON.parse(await readFile(path.join(candidate, 'tables', `${name}.json`), 'utf8')));
  return tables.get(name);
}
async function loadDemo() {
tables.clear();
const [report, points, states, scopes, sessions, events, notes, profiles, people, identities, observations, learning, jobs, versions, assets, jobEvents, transcriptions, correctionVersions] = await Promise.all([
  readFile(path.join(candidate, 'migration-report.json'), 'utf8').then(JSON.parse),
  ...['knowledge_points', 'review_states', 'conversation_scopes', 'conversation_sessions', 'conversation_events', 'memory_notes', 'learner_profiles', 'people', 'channel_identities', 'identity_observations', 'learning_events', 'processing_jobs', 'draft_versions', 'assets', 'job_events', 'upload_transcriptions', 'upload_transcription_versions'].map(table)
]);
const originalDir = path.join(report.backupPath, 'original');
const pointById = new Map(points.map(p => [p.id, p]));
const scopeById = new Map(scopes.map(s => [s.id, s]));
const identityByExternal = new Map(identities.map(i => [i.external_id, people.find(p => p.id === i.person_id)]));
const speaker = id => identityByExternal.get(id)?.display_name || '成员';
const excerpt = (text, max = 400) => String(text || '').slice(0, max);
const real = {
  mode: 'real', capturedAt: report.capturedAt, report,
  profile: profiles[0]?.snapshot || {},
  people: people.map(p => ({ id: p.id, name: p.display_name, role: p.role, identity: identities.find(i => i.person_id === p.id)?.external_id || '', appId: identities.find(i => i.person_id === p.id)?.app_id || '', observedAt: null, labels: observations.filter(o => o.person_id === p.id).map(o => o.label), evidence: '服务器显式账号绑定', history: [{ at: report.capturedAt, title: '当前绑定已读取', detail: '来自本次服务器配置快照；原始绑定时间未记录。' }] })),
  points: points.map(p => {
    const state = states.find(s => s.knowledge_point_id === p.id);
    return { id: p.id, uploadId: p.source_id, title: p.title, text: p.body || '', source: p.snapshot.sourceTitle || p.snapshot.sourceLabel || '迁移存量', scope: scopeById.get(p.scope_id)?.chat_type || 'unknown', sourceVersion: p.source_version, uploadedAt: p.uploaded_at, hidden: Boolean(p.hidden), origin: p.origin_status, eligible: Boolean(state), kind: state?.pending_forgotten ? 'forgotten' : state ? 'review' : 'record', due: state?.next_review_on || null, interval: state?.interval_days ?? null, lastReviewedOn: state?.last_reviewed_on || null, lastRating: state?.last_rating || null, stage: state?.stage || null, history: learning.filter(e => e.knowledge_point_id === p.id).map(e => ({ at: e.on_date, title: e.event_type === 'forgotten_upload' ? '上传时发现遗忘' : e.event_type, detail: '原有日期已保留；不是已完成复习。' })), citations: p.snapshot.citations || [], sourceAnchors: p.snapshot.sourceAnchors || [] };
  }),
  sessions: sessions.map(s => ({ id: s.id, scopeId: s.scope_id, scope: scopeById.get(s.scope_id)?.chat_type || 'unknown', createdAt: s.created_at, archivedAt: s.archived_at, current: Boolean(s.is_current), events: events.filter(e => e.session_id === s.id).map(e => ({ id: e.id, type: e.event_type, at: e.occurred_at, speaker: e.event_type === 'outbound' ? '助手' : speaker(e.sender_id), text: e.text || (e.event_type === 'source_photo_input' ? '上传图片资料' : '资料处理事件'), assistant: e.assistant_text, hasImages: e.snapshot.hasImages, sourceEventId: e.source_event_id })) })),
  notes: notes.map(n => ({ id: n.id, scope: scopeById.get(n.scope_id)?.chat_type, text: n.text, status: n.status, at: n.created_at, sourceId: n.source_id })),
  jobs: jobs.map(j => ({ id: j.id, title: j.snapshot.sourceContent?.title || versions.find(v => v.job_id === j.id)?.snapshot.title || j.id, status: j.status, at: j.created_at, versions: versions.filter(v => v.job_id === j.id).length, assets: j.snapshot.assets || [] })),
  assets: assets.map(a => {
    const linkedJobs = [...new Set(jobEvents.filter(e => e.event_type === 'assets' && e.snapshot?.sha256 === a.sha256).map(e => e.job_id))];
    const uploads = linkedJobs.map(id => {
      const job = jobs.find(j => j.id === id);
      // Explicit upload metadata only; file/backup/processing times are not upload times.
      const uploadedAt = job?.snapshot.sourceUploadedAt || points.find(p => p.source_id === id && p.uploaded_at)?.uploaded_at || null;
      return { jobId: id, uploadedAt, scope: scopeById.get(job?.scope_id)?.chat_type || 'unknown', title: job?.snapshot.sourceContent?.title || points.find(p => p.source_id === id)?.snapshot.sourceTitle || '原始上传图片' };
    });
    return { id: a.id, name: path.basename(a.relative_path), size: a.byte_size, isImage: a.relative_path.startsWith('knowledge-assets/'), uploads };
  }),
  uploads: jobs.map(j => {
    const transcription = transcriptions.find(t => t.job_id === j.id);
    const links = jobEvents.filter(e => e.job_id === j.id && e.event_type === 'assets').map(e => e.snapshot?.sha256);
    return { id: j.id, title: transcription?.title || '上传图片', uploadedAt: j.snapshot.sourceUploadedAt || points.find(p => p.source_id === j.id && p.uploaded_at)?.uploaded_at || null, scope: scopeById.get(j.scope_id)?.chat_type || 'unknown', status: j.status, version: transcription?.version || 1, items: transcription?.items || [], assets: assets.filter(a => links.includes(a.sha256)).map(a => ({ id: a.id, size: a.byte_size })), history: correctionVersions.filter(v => v.job_id === j.id).map(v => ({ version: v.version, at: v.edited_at, actor: v.actor, title: v.title })) };
  }),
  contextUsage: [], reminderTime: null
};
return real;
}
let real = await loadDemo();
const assets = await table('assets');
const originalDir = path.join(real.report.backupPath, 'original');
let mutationQueue = Promise.resolve();
function saveCorrection(body) {
  return new Promise((resolve, reject) => {
    const child = spawn('python', [path.join(root, 'scripts', 'edit-review-transcription.py'), 'save', '--candidate', candidate], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', bytes => { output += bytes.toString('utf8'); });
    child.stderr.on('data', bytes => { errors += bytes.toString('utf8'); });
    child.once('error', reject);
    child.once('close', code => { try { const result = JSON.parse(output); code ? reject(Object.assign(new Error(result.error || 'save_failed'), { code: result.error })) : resolve(result); } catch { reject(new Error(errors ? 'candidate_write_failed' : 'save_failed')); } });
    child.stdin.end(Buffer.from(JSON.stringify(body), 'utf8'));
  });
}

const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (!['127.0.0.1', 'localhost'].includes(String(request.headers.host).split(':')[0])) { response.writeHead(403); return response.end(); }
    const correctionRoute = url.pathname.match(/^\/api\/uploads\/(KP-[a-f0-9]{8})\/corrections$/);
    if (request.method === 'POST' && correctionRoute) {
      if (request.headers.origin !== `http://${request.headers.host}` || !String(request.headers['content-type']).startsWith('application/json')) { response.writeHead(403); return response.end(); }
      let size = 0, chunks = [];
      for await (const chunk of request) { size += chunk.length; if (size > 4 * 1024 * 1024) { response.writeHead(413); return response.end(); } chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      body.jobId = correctionRoute[1];
      const operation = mutationQueue.then(async () => { const saved = await saveCorrection(body); real = await loadDemo(); return saved; });
      mutationQueue = operation.catch(() => {});
      try { const saved = await operation; response.setHeader('Content-Type', 'application/json; charset=utf-8'); return response.end(JSON.stringify({ ...saved, data: real })); }
      catch (error) { response.writeHead(error.code === 'version_conflict' ? 409 : 400, { 'Content-Type': 'application/json; charset=utf-8' }); return response.end(JSON.stringify({ error: error.code || error.message })); }
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405); return response.end(); }
    if (url.pathname === '/api/demo') { response.setHeader('Content-Type', 'application/json; charset=utf-8'); return response.end(JSON.stringify(real)); }
    const assetRoute = url.pathname.match(/^\/assets\/(asset-[a-f0-9]{24})$/);
    if (assetRoute) {
      const asset = assets.find(a => a.id === assetRoute[1] && a.relative_path.startsWith('knowledge-assets/'));
      if (!asset) { response.writeHead(404); return response.end(); }
      const bytes = await readFile(path.join(originalDir, ...asset.relative_path.split('/')));
      const mime = bytes[0] === 0x89 ? 'image/png' : bytes[0] === 0xff ? 'image/jpeg' : 'image/webp';
      response.setHeader('Content-Type', mime); return response.end(bytes);
    }
    const domainRoutes = { '/scheduler.js': 'scheduler.js', '/date.js': 'date.js' };
    if (domainRoutes[url.pathname]) { response.setHeader('Content-Type', 'text/javascript; charset=utf-8'); return response.end(await readFile(path.join(root, 'apps', 'api', 'src', 'domain', domainRoutes[url.pathname]))); }
    const routes = { '/': ['index.html', 'text/html'], '/styles.css': ['styles.css', 'text/css'], '/app.js': ['app.js', 'text/javascript'], '/sample.js': ['sample.js', 'text/javascript'], '/upload-workspace.js': ['upload-workspace.js', 'text/javascript'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
    const route = routes[url.pathname];
    if (!route) { response.writeHead(404); return response.end('Not found'); }
    response.setHeader('Content-Type', `${route[1]}; charset=utf-8`);
    response.end(await readFile(path.join(root, 'prototypes', 'review-console', route[0])));
  } catch (error) { console.error(error.code || error.message); response.writeHead(500); response.end('本地数据读取失败'); }
});
const port = Number(process.env.REVIEW_DEMO_PORT || 3340);
server.listen(port, '127.0.0.1', () => console.log(`本地样板：http://127.0.0.1:${port}\n新版数据：${candidate}\n仅本机访问；不会写入线上或发送飞书消息。`));
