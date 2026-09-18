import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as lark from '@larksuiteoapi/node-sdk';
import QRCode from 'qrcode';
import qr from 'qrcode-terminal';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(projectRoot, '.env.local');
const qrImagePath = path.join(projectRoot, '.data', 'feishu-create-qr.png');

function updateEnvironment(content, values) {
  const lines = content ? content.replace(/\r\n/g, '\n').split('\n') : [];
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

async function persistCredentials(result) {
  let current = '';
  try {
    current = await readFile(envPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const testerOpenId = result.user_info?.open_id ?? '';
  const next = updateEnvironment(current, {
    FEISHU_ENABLED: 'false',
    FEISHU_APP_ID: result.client_id,
    FEISHU_APP_SECRET: result.client_secret,
    FEISHU_TESTER_OPEN_ID: testerOpenId
  });
  const temporaryPath = `${envPath}.tmp`;
  await writeFile(temporaryPath, next, { encoding: 'utf8', mode: 0o600 });
  await rename(temporaryPath, envPath);
  return Boolean(testerOpenId);
}

console.log('\n即将创建“333 AI 复习助手”飞书自建应用。');
console.log('请先在手机飞书中切换到你希望拥有该应用的账号，再扫描下方二维码。');
console.log('二维码授权页显示的账号和租户，就是应用实际归属；电脑浏览器当前登录哪个账号不会决定归属。\n');

try {
  const result = await lark.registerApp({
    createOnly: true,
    appPreset: {
      name: '333 AI 复习助手 · {user} 测试',
      desc: '个人考研 333 复习机器人：任务、作答与间隔复习自评。'
    },
    addons: {
      preset: false,
      scopes: {
        tenant: [
          'im:message:send_as_bot',
          'im:message.p2p_msg:readonly',
          'im:message.reactions:write_only',
          'im:chat.members:read'
        ]
      },
      events: {
        items: { tenant: ['im.message.receive_v1'] }
      },
      callbacks: {
        items: ['card.action.trigger']
      }
    },
    onQRCodeReady({ url, expireIn }) {
      console.log(`授权链接：${url}`);
      console.log(`二维码有效期约 ${expireIn} 秒。`);
      qr.generate(url, { small: true });
      void mkdir(path.dirname(qrImagePath), { recursive: true })
        .then(() => QRCode.toFile(qrImagePath, url, { width: 720, margin: 3, errorCorrectionLevel: 'M' }))
        .then(() => console.log(`二维码 PNG 已导出到 ${qrImagePath}`))
        .catch((error) => console.error(`无法导出二维码 PNG：${error.message}`));
      console.log('\n请勿转发此二维码；过期或扫描失败时，重新运行此命令生成新的二维码。');
    },
    onStatusChange({ status }) {
      if (status === 'slow_down') console.log('正在等待授权确认，请稍候…');
      if (status === 'domain_switched') console.log('已根据所选账号切换到对应飞书租户。');
    }
  });

  const hasTesterBinding = await persistCredentials(result);
  console.log('\n应用创建已完成，凭据已写入被 Git 忽略的 .env.local，终端未输出 App Secret。');
  if (hasTesterBinding) {
    console.log('扫码确认的账号已自动绑定为首测账号；机器人将忽略其他人的私聊消息。');
  } else {
    console.log('平台没有返回扫码账号标识。请先在 .env.local 填写 FEISHU_TESTER_OPEN_ID，再启动机器人。');
  }
  console.log('下一步：在飞书开发者后台把“事件”和“回调”都切换为长连接接收，再把 FEISHU_ENABLED 改为 true。');
} catch (error) {
  console.error(`创建未完成：${error.code ?? 'unknown'} — ${error.description ?? error.message}`);
  process.exitCode = 1;
}
