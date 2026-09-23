export function feishuIdentityConfig(env = process.env) {
  const clean = value => String(value || '').trim();
  const learnerId = clean(env.FEISHU_LEARNER_OPEN_ID || env.FEISHU_TESTER_OPEN_ID || env.FEISHU_GROUP_TARGET_OPEN_ID);
  const ownerId = clean(env.FEISHU_OWNER_OPEN_ID);
  const dmMode = clean(env.FEISHU_DM_MODE) || 'allowlist';
  if (!['open', 'allowlist', 'disabled'].includes(dmMode)) throw new Error('FEISHU_DM_MODE must be open, allowlist or disabled');
  if (ownerId && ownerId === learnerId) throw new Error('FEISHU_OWNER_OPEN_ID and learner identity must be different');
  const dmAllowlist = [...new Set([learnerId, ownerId].filter(Boolean))];
  return { learnerId, ownerId, dmMode, dmAllowlist };
}

export function identifySender(openId, config) {
  if (openId && openId === config.ownerId) return { role: 'admin', name: '系统管理员', displayName: '管理员' };
  if (openId && openId === config.learnerId) return { role: 'learner', name: '李羊羊', displayName: '羊羊' };
  return { role: 'unbound', name: null, displayName: '未绑定用户' };
}

export function canReceivePrivate(openId, config) {
  return Boolean(openId && config.dmMode !== 'disabled' && (config.dmMode === 'open' || config.dmAllowlist.includes(openId)));
}

export function identityDescription(identity, { chatType, openId, chatId, threadId }) {
  const role = { admin: '系统管理员（可查看羊羊的学习数据，不代替羊羊作答或自评）', learner: '学习者：羊羊', unbound: '未绑定（不会按羊羊或管理员处理）' }[identity.role];
  return `当前身份：${role}\n会话类型：${chatType === 'group' ? '群聊' : '私聊'}${threadId ? '，独立话题' : ''}` +
    (chatType === 'p2p' ? `\n你的 open_id：${openId}\n当前 chat_id：${chatId}\n身份由服务器账号绑定决定，自我介绍只用于称呼。` : '\n群成员按各自账号识别；私聊记录不会带入本群。');
}
