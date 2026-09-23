import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { hashPassword } from '../../src/web-auth.js';

export const testPassword = randomBytes(24).toString('hex');
export const testHash = await hashPassword(testPassword);
export async function startServer(file, overrides = {}) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../src/server.js', import.meta.url))], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATA_FILE: file, FEISHU_ENABLED: 'false', ARK_API_KEY: '',
      WEB_USERS: `tester:${testHash}`, WEB_ADMIN_USERS: '', WEB_SESSION_SECRET: randomBytes(32).toString('hex'), COOKIE_SECURE: 'false', TRUST_PROXY: 'false', WEB_SESSION_TTL_SECONDS: '604800',
      KNOWLEDGE_SCOPE_KEYS: '', FEISHU_APP_ID: '', FEISHU_TEST_GROUP_ID: '', FEISHU_TESTER_OPEN_ID: '', FEISHU_GROUP_TARGET_OPEN_ID: '', ...overrides },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('server startup timed out')); }, 10000);
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`server exited ${code}`)); });
    child.stdout.on('data', chunk => {
      const match = chunk.toString().match(/http:\/\/localhost:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0].replace('localhost', '127.0.0.1')); }
    });
    child.stderr.resume();
  });
  return {
    url,
    login: async (username = 'tester', password = testPassword) => fetch(`${url}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) }),
    stop: async () => { if (child.exitCode !== null) return; const exited = once(child, 'exit'); child.kill(); await exited; }
  };
}
