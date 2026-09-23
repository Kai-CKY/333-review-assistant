import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { isIP } from 'node:net';

const scrypt = promisify(scryptCallback);
const COOKIE = 'review_session';
const OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 };
const HASH_PATTERN = /^scrypt\$([a-f0-9]{32})\$([a-f0-9]{128})$/;

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64, OPTIONS);
  return `scrypt$${salt}$${key.toString('hex')}`;
}

function equal(left, right) {
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createWebAuth(env = process.env, { now = Date.now } = {}) {
  const users = new Map();
  for (const entry of (env.WEB_USERS || '').split(',').filter(Boolean)) {
    const separator = entry.indexOf(':');
    const name = entry.slice(0, separator).trim();
    const hash = entry.slice(separator + 1).trim();
    if (separator < 1 || !name || name.length > 80 || /[\s,:]/u.test(name) || !HASH_PATTERN.test(hash) || users.has(name)) {
      throw new Error('Invalid WEB_USERS: expected name:scrypt$salt$hash');
    }
    users.set(name, hash);
  }
  if (users.size > 2) throw new Error('WEB_USERS supports at most two shared-workspace accounts');
  const administrators = new Set((env.WEB_ADMIN_USERS || '').split(',').map(s => s.trim()).filter(Boolean));
  if ([...administrators].some(name => !users.has(name))) throw new Error('WEB_ADMIN_USERS must name configured WEB_USERS');
  const secret = env.WEB_SESSION_SECRET || '';
  if (users.size && Buffer.byteLength(secret) < 32) throw new Error('WEB_SESSION_SECRET must contain at least 32 bytes');
  const lifetime = Number(env.WEB_SESSION_TTL_SECONDS || 604800);
  if (!Number.isSafeInteger(lifetime) || lifetime < 60 || lifetime > 2592000) throw new Error('WEB_SESSION_TTL_SECONDS must be 60..2592000');
  for (const key of ['COOKIE_SECURE', 'TRUST_PROXY']) {
    if (env[key] && !['true', 'false'].includes(env[key])) throw new Error(`${key} must be true or false`);
  }
  const secure = env.COOKIE_SECURE === 'true';
  const sessions = new Map(); // Restart deliberately logs every browser out.
  const attempts = new Map();
  const dummy = `scrypt$${randomBytes(16).toString('hex')}$${randomBytes(64).toString('hex')}`;
  let activeHashes = 0;
  const sign = body => createHmac('sha256', secret).update(body).digest();
  const cookie = (value, age) => `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure ? '; Secure' : ''}`;

  function prune() {
    const time = now();
    for (const [id, session] of sessions) if (session.exp <= time) sessions.delete(id);
    for (const [ip, entry] of attempts) if (entry.until <= time) attempts.delete(ip);
  }

  function authenticate(request) {
    if (!users.size) return null;
    prune();
    const cookies = String(request.headers.cookie || '').split(';').map(c => c.trim()).filter(c => c.startsWith(`${COOKIE}=`));
    if (cookies.length !== 1) return null;
    const token = cookies[0].slice(COOKIE.length + 1);
    if (token.length > 2048) return null;
    const [body, signature, extra] = token.split('.');
    if (!body || !signature || extra !== undefined || !/^[\w-]+$/.test(body) || !/^[\w-]{43}$/.test(signature)) return null;
    if (!equal(sign(body), Buffer.from(signature, 'base64url'))) return null;
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      const session = sessions.get(payload.sid);
      if (!session || session.exp !== payload.exp || session.user !== payload.user || session.exp <= now() || !users.has(session.user)) return null;
      return { ...session, role: administrators.has(session.user) ? 'admin' : 'learner', sid: payload.sid };
    } catch { return null; }
  }

  function consumeAttempt(request) {
    prune();
    // X-Real-IP is trusted ONLY with explicit proxy configuration. Nginx must overwrite it.
    const forwarded = request.headers['x-real-ip'];
    const ip = env.TRUST_PROXY === 'true' && typeof forwarded === 'string' && isIP(forwarded)
      ? forwarded : request.socket.remoteAddress || 'unknown';
    if (!attempts.has(ip) && attempts.size >= 10000) return 60;
    const entry = attempts.get(ip) || { count: 0, until: now() + 60000 };
    attempts.set(ip, entry);
    if (entry.count >= 5) return Math.max(1, Math.ceil((entry.until - now()) / 1000));
    entry.count++;
    return 0;
  }

  async function login(input) {
    if (!users.size) return { status: 503, error: '登录尚未配置，请联系管理员。' };
    if (activeHashes >= 4) return { status: 429, error: '登录请求较多，请稍后重试。', retryAfter: 5 };
    if (typeof input?.username !== 'string' || typeof input?.password !== 'string' || input.username.length > 80 || input.password.length > 1024) {
      return { status: 401, error: '账号或密码不正确。' };
    }
    const name = input.username.trim();
    const hash = users.get(name) || dummy;
    const [, salt, expected] = hash.match(HASH_PATTERN);
    activeHashes++;
    let actual;
    try { actual = await scrypt(input.password, salt, 64, OPTIONS); } finally { activeHashes--; }
    if (!equal(actual, Buffer.from(expected, 'hex')) || !users.has(name)) return { status: 401, error: '账号或密码不正确。' };
    prune();
    const existing = [...sessions].filter(([, s]) => s.user === name);
    if (existing.length >= 20) sessions.delete(existing[0][0]);
    const sid = randomBytes(24).toString('base64url');
    const payload = { sid, user: name, exp: now() + lifetime * 1000 };
    sessions.set(sid, { user: name, exp: payload.exp });
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return { status: 200, user: name, cookie: cookie(`${body}.${sign(body).toString('base64url')}`, lifetime) };
  }

  function logout(request) {
    const session = authenticate(request);
    if (session) sessions.delete(session.sid);
    return cookie('', 0);
  }

  function validMutation(request) {
    if (request.headers['sec-fetch-site'] === 'cross-site') return false;
    if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') return false;
    const origin = request.headers.origin;
    return !origin || origin === `${secure ? 'https' : 'http'}://${request.headers.host}`;
  }

  return { authenticate, consumeAttempt, login, logout, validMutation };
}
