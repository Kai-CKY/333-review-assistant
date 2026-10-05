// Explicit DTO: never serialize a whole dashboard or task collection into a prompt.
export function compactRuntime(value = {}) {
  const d = value.dashboard || value;
  const tasks = d.tasks || d.todayTasks || [];
  return { subject: value.subject, access: value.access, date: d.date, completedToday: d.completedToday,
    selfReportedCompletedToday: d.selfReportedCompletedToday, taskCount: tasks.length,
    ...(d.reviewStats ? { reviewStats: Object.fromEntries(['enrolled', 'pending', 'scheduled', 'unstarted']
      .map(key => [key, Math.max(0, Math.floor(Number(d.reviewStats[key]) || 0))])) } : {}),
    todayTasks: tasks.slice(0, 5).map(t => ({ title: String(t.title || '').slice(0, 160), label: t.label })),
    weakPoints: (d.weakPoints || []).slice(0, 3).map(p => ({ title: String(p.title || '').slice(0, 160), mastery: p.mastery })),
    recentTaskCompletions: (d.recentTaskCompletions || []).slice(0, 3).map(e => ({ reportedOn: e.reportedOn, content: String(e.content || '').slice(0, 300) })),
    scopedMemoryNotes: (value.scopedMemoryNotes || []).slice(-4).map(s => String(s).slice(0, 300)),
    activeSession: value.activeSession ? { status: value.activeSession.status, taskTitle: String(value.activeSession.taskTitle || '').slice(0, 160) } : null };
}

export function guardContext(messages, maxBytes = 60000) {
  // UTF-8 bytes are a conservative engineering cap, not a claim of exact tokens.
  const textBytes = messages.reduce((total, m) => total + Buffer.byteLength(typeof m.content === 'string' ? m.content :
    JSON.stringify((m.content || []).filter(x => x.type === 'text'))), 0);
  if (textBytes > maxBytes) throw Object.assign(new Error('模型输入过长，请拆分当前资料或问题。'), { code: 'context_budget_exceeded' });
  return messages;
}

export function coachingReference(reference) {
  if (!reference) return { status: 'missing', instruction: '本题没有绑定参考，不得搜索相似题充当本题答案。' };
  const result = { knowledgePointId: reference.knowledgePointId, version: reference.version, evidenceStatus: reference.evidenceStatus,
    instruction: '仅提供渐进提示；省略内容不能当作不存在，不输出完整标准答案。' };
  if (reference.answer?.status !== 'reviewed') return { ...result, status: 'unreviewed', instruction: '尚无已核对答案，只给表达结构建议，不评价事实对错。' };
  result.status = 'reviewed'; result.items = []; result.evidence = [];
  for (const item of reference.answer.items) {
    const evidence = reference.answer.evidence.filter(e => item.evidenceIds.includes(e.id)).map(e => ({ id: e.id, title: e.title, quote: e.quote, sourceAnchors: e.sourceAnchors }));
    const next = { ...result, items: [...result.items, item], evidence: [...result.evidence, ...evidence] };
    if (Buffer.byteLength(JSON.stringify(next)) > 18000 || result.items.length >= 3) break;
    Object.assign(result, next);
  }
  result.truncated = result.items.length < reference.answer.items.length;
  return result;
}
