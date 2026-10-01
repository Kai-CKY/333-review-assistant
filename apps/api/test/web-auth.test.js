import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWebAuth } from '../src/web-auth.js';
import { startServer, testHash, testPassword } from './helpers/http-server.js';

async function fixture(t, env = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), '333-auth-'));
  const server = await startServer(path.join(directory, 'data.json'), env);
  t.after(async () => { await server.stop(); await rm(directory, { recursive: true, force: true }); });
  return server;
}

test('HTTP protects all application routes and static assets, leaves health and login public', async t => {
  const s = await fixture(t);
  for (const route of ['/api/dashboard', '/api/knowledge-points', '/api/feedback-jobs/fake', '/api/session', '/api/runtime', '/api/unknown']) {
    assert.equal((await fetch(s.url + route)).status, 401, route);
  }
  for (const route of ['/api/reviews', '/api/answer-attempts', '/api/logout']) {
    assert.equal((await fetch(s.url + route, { method: 'POST' })).status, 401, route);
  }
  for (const route of ['/', '/index.html', '/app.js', '/anything']) {
    const r = await fetch(s.url + route, { redirect: 'manual' });
    assert.equal(r.status, 303); assert.equal(r.headers.get('location'), '/login');
  }
  assert.deepEqual(await (await fetch(s.url + '/api/health')).json(), { status: 'ok' });
  for (const route of ['/login', '/login.js', '/styles.css']) assert.equal((await fetch(s.url + route)).status, 200);
});

test('login succeeds with signed cookie, rejects passwords/tampering, logout revokes replay', async t => {
  const s = await fixture(t);
  assert.equal((await s.login('tester', 'incorrect')).status, 401);
  assert.equal((await s.login('unknown', testPassword)).status, 401);
  const login = await s.login();
  assert.equal(login.status, 200);
  const setCookie = login.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Lax/); assert.match(setCookie, /Max-Age=604800/); assert.doesNotMatch(setCookie, /Secure/);
  const cookie = setCookie.split(';')[0];
  const headers = { cookie, 'Content-Type': 'application/json' };
  const dashboard = await fetch(s.url + '/api/dashboard', { headers });
  assert.equal(dashboard.status, 200); assert.equal(dashboard.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(s.url + '/app.js', { headers })).status, 200);
  assert.equal((await fetch(s.url + '/api/dashboard', { headers: { cookie: cookie + 'X' } })).status, 401);
  const dot = cookie.lastIndexOf('.');
  const tampered = cookie.slice(0, dot + 1) + (cookie[dot + 1] === 'A' ? 'B' : 'A') + cookie.slice(dot + 2);
  assert.equal((await fetch(s.url + '/api/dashboard', { headers: { cookie: tampered } })).status, 401, 'same-length forged HMAC is rejected');
  const logout = await fetch(s.url + '/api/logout', { method: 'POST', headers, body: '{}' });
  assert.equal(logout.status, 200); assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await fetch(s.url + '/api/dashboard', { headers })).status, 401, 'a copied pre-logout cookie is invalid');
});

test('login rate limit blocks the sixth IP attempt, ignoring untrusted forwarded IP', async t => {
  const s = await fixture(t);
  for (let i = 0; i < 5; i++) {
    const r = await fetch(s.url + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Real-IP': `10.0.0.${i + 1}`, 'X-Forwarded-For': `10.0.1.${i + 1}` }, body: JSON.stringify({ username: 'tester', password: 'bad' }) });
    assert.equal(r.status, 401);
  }
  const limited = await s.login();
  assert.equal(limited.status, 429); assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal((await fetch(s.url + '/api/health')).status, 200);
});

test('mutation requests reject cross-origin and form submissions; malformed/oversized JSON is bounded', async t => {
  const s = await fixture(t);
  const cookie = (await s.login()).headers.get('set-cookie').split(';')[0];
  for (const extra of [{ Origin: 'https://foreign.example' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Content-Type': 'text/plain' }]) {
    const r = await fetch(s.url + '/api/logout', { method: 'POST', headers: { cookie, 'Content-Type': 'application/json', ...extra }, body: '{}' });
    assert.equal(r.status, 403);
  }
  assert.equal((await fetch(s.url + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://foreign.example' }, body: '{}' })).status, 403);
  const headers = { cookie, 'Content-Type': 'application/json' };
  assert.equal((await fetch(s.url + '/api/reviews', { method: 'POST', headers, body: 'null' })).status, 400);
  assert.equal((await fetch(s.url + '/api/reviews', { method: 'POST', headers, body: 'x'.repeat(70000) })).status, 413);
});

test('missing configuration fails closed while health remains available', async t => {
  const s = await fixture(t, { WEB_USERS: '', WEB_SESSION_SECRET: '' });
  assert.equal((await s.login()).status, 503);
  assert.equal((await fetch(s.url + '/api/dashboard')).status, 401);
  assert.equal((await fetch(s.url + '/api/health')).status, 200);
});

test('expiry, restart invalidation, secure switch, two users and rate window reset', async () => {
  let clock = 100000;
  const env = { WEB_USERS: `羊羊:${testHash},admin:${testHash}`, WEB_SESSION_SECRET: 'unit-test-secret-'.repeat(3), WEB_SESSION_TTL_SECONDS: '60', COOKIE_SECURE: 'true' };
  const auth = createWebAuth(env, { now: () => clock });
  const result = await auth.login({ username: '羊羊', password: testPassword });
  assert.match(result.cookie, /; Secure/);
  const req = { headers: { cookie: result.cookie.split(';')[0] }, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(auth.authenticate(req).user, '羊羊');
  assert.equal((await auth.login({ username: 'admin', password: testPassword })).status, 200);
  assert.equal(createWebAuth(env, { now: () => clock }).authenticate(req), null);
  for (let i = 0; i < 5; i++) assert.equal(auth.consumeAttempt(req), 0);
  assert.equal(auth.consumeAttempt(req), 60);
  clock += 60000;
  assert.equal(auth.authenticate(req), null);
  assert.equal(auth.consumeAttempt(req), 0);
  assert.throws(() => createWebAuth({ WEB_USERS: 'user:plaintext' }), /Invalid WEB_USERS/);
  assert.throws(() => createWebAuth({ WEB_USERS: `user:${testHash}` }), /WEB_SESSION_SECRET/);
});

test('proxy IP trust is opt-in and invalid forwarded headers fall back to socket address', () => {
  const auth = createWebAuth({ TRUST_PROXY: 'true' });
  const request = ip => ({ headers: { 'x-real-ip': ip }, socket: { remoteAddress: '127.0.0.1' } });
  for (let i = 0; i < 5; i++) assert.equal(auth.consumeAttempt(request('10.1.1.1')), 0);
  assert.ok(auth.consumeAttempt(request('10.1.1.1')) > 0);
  assert.equal(auth.consumeAttempt(request('10.1.1.2')), 0);
  for (let i = 0; i < 5; i++) assert.equal(auth.consumeAttempt(request('invalid')), 0);
  assert.ok(auth.consumeAttempt(request('also-invalid')) > 0);
});

test('administrator Web account reads Yangyang data but cannot submit answers or ratings', async t => {
  const s = await fixture(t, { WEB_ADMIN_USERS: 'tester', APP_REVISION: 'abc123def456' });
  const cookie = (await s.login()).headers.get('set-cookie').split(';')[0];
  const headers = { cookie, 'Content-Type': 'application/json' };
  assert.equal((await (await fetch(s.url + '/api/session', { headers })).json()).role, 'admin');
  assert.deepEqual(await (await fetch(s.url + '/api/runtime', { headers })).json(), { revision: 'abc123def456' });
  assert.equal((await fetch(s.url + '/api/dashboard', { headers })).status, 200);
  for (const route of ['/api/reviews', '/api/answer-attempts']) assert.equal((await fetch(s.url + route, { method: 'POST', headers, body: '{}' })).status, 403);
  assert.equal((await fetch(s.url + '/api/logout', { method: 'POST', headers, body: '{}' })).status, 200);
});

test('learner cannot read the running build revision', async t => {
  const s = await fixture(t, { APP_REVISION: 'abc123def456' });
  const cookie = (await s.login()).headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(s.url + '/api/runtime', { headers: { cookie } })).status, 403);
});
