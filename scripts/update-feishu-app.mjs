import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as lark from '@larksuiteoapi/node-sdk';
import QRCode from 'qrcode';
import qr from 'qrcode-terminal';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(projectRoot, '.env.local');
const qrImagePath = path.join(projectRoot, '.data', 'feishu-update-qr.png');

function parseEnvironment(content) {
  return Object.fromEntries(content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/))
    .filter(Boolean)
    .map((match) => [match[1], match[2]]));
}

function updateEnvironment(content, values) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const remaining = new Set(Object.keys(values));
  const next = lines.map((line) => {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=.*/);
    if (!match || !remaining.has(match[1])) return line;
    remaining.delete(match[1]);
    return `${match[1]}=${values[match[1]]}`;
  });
  for (const key of remaining) next.push(`${key}=${values[key]}`);
  return `${next.filter((line, index, all) => line || index < all.length - 1).join('\n')}\n`;
}

async function persistRefreshedCredentials(current, result) {
  const values = {
    FEISHU_APP_ID: result.client_id,
    FEISHU_APP_SECRET: result.client_secret
  };
  const next = updateEnvironment(current, values);
  const temporaryPath = `${envPath}.tmp`;
  await writeFile(temporaryPath, next, { encoding: 'utf8', mode: 0o600 });
  await rename(temporaryPath, envPath);
}

let current;
try {
  current = await readFile(envPath, 'utf8');
} catch (error) {
  if (error.code === 'ENOENT') {
    console.error('没有找到 .env.local。请先运行 npm run feishu:create 创建应用。');
    process.exit(1);
  }
  throw error;
}

const appId = parseEnvironment(current).FEISHU_APP_ID?.trim();
if (!appId) {
  console.error('.env.local 中没有 FEISHU_APP_ID，无法确认要更新哪一个应用。');
  process.exit(1);
}

console.log('\n即将为现有复习助手开通群消息接收（包含无需 @ 的消息）、成员读取与 DONE 回执。');
console.log('请用拥有这个应用的飞书账号扫码确认；如果手机上登录了两个账号，请先切换到应用归属账号。\n');

let qrWritePromise = Promise.resolve();
try {
  const result = await lark.registerApp({
    appId,
    source: '333-review-assistant-permission-update',
    addons: {
      preset: false,
      scopes: {
        tenant: ['im:message.reactions:write_only', 'im:chat.members:read', 'im:message.group_at_msg:readonly', 'im:message.group_msg', 'im:message:send_as_bot', 'im:resource', 'im:message.history:readonly']
      },
      events: { items: { tenant: ['im.message.receive_v1'] } }
    },
    onQRCodeReady({ url, expireIn }) {
      console.log(`授权链接：${url}`);
      console.log(`二维码有效期约 ${expireIn} 秒。`);
      qrWritePromise = mkdir(path.dirname(qrImagePath), { recursive: true })
        .then(() => QRCode.toFile(qrImagePath, url, { width: 720, margin: 3, errorCorrectionLevel: 'M' }))
        .then(() => console.log(`二维码 PNG 已导出到 ${qrImagePath}`));
      void qrWritePromise.catch((error) => console.error(`无法导出二维码 PNG：${error.message}`));
      console.log('\n请勿转发此二维码；过期或扫描失败时，重新运行本命令。');
    },
    onStatusChange({ status }) {
      if (status === 'slow_down') console.log('正在等待授权确认，请稍候…');
      if (status === 'domain_switched') console.log('已根据扫码账号切换到对应飞书租户。');
    }
  });

  await qrWritePromise;
  if (result.client_id !== appId) throw new Error('授权结果不是预期的现有应用，未写入任何凭据');
  await persistRefreshedCredentials(current, result);
  console.log('\n权限更新已确认，新凭据已安全写回 .env.local，终端未输出 App Secret。');
  console.log('下一步：重启机器人；若已配置限定群测，机器人会在目标账号加入指定群后询问今日学习情况。');
} catch (error) {
  console.error(`权限更新未完成：${error.code ?? 'unknown'} — ${error.description ?? error.message}`);
  process.exitCode = 1;
}
