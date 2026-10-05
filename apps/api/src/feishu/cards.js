function titleCard(title, template = 'blue') {
  return {
    schema: '2.0',
    header: { template, title: { tag: 'plain_text', content: title } },
    body: { elements: [] }
  };
}

function button(label, value, type = 'default') {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type,
    width: 'fill',
    behaviors: [{ type: 'callback', value }]
  };
}

function actionRow(actions) {
  return {
    tag: 'column_set',
    horizontal_spacing: '8px',
    horizontal_align: 'left',
    columns: actions.map((item) => ({
      tag: 'column',
      width: 'weighted',
      weight: 1,
      vertical_align: 'top',
      elements: [item]
    }))
  };
}

function percent(value) {
  return `${Math.round(Number(value ?? 0) * 100)}%`;
}

function safeUserMarkdown(value, maximum = 260) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  const clipped = text.length <= maximum ? text : `${text.slice(0, maximum)}…`;
  return clipped
    .replace(/</g, '＜')
    .replace(/>/g, '＞')
    .replace(/([\\`*_[\]~])/g, '\\$1');
}

export function todayPlanCard(dashboard) {
  const card = titleCard(`今日回忆 · 已完成 ${dashboard.completedToday} 次`);
  if (!dashboard.tasks.length) {
    card.body.elements.push({ tag: 'markdown', content: '今天的计划已经完成。适合花一分钟回想今天最不确定的一个点。' });
    return card;
  }
  card.body.elements.push({
    tag: 'markdown',
    content: `${dashboard.reviewStats ? `待复习 **${dashboard.reviewStats.pending}** 个知识点，以下是今日推荐。\n` : ''}先选一个知识点。回忆得不完整也没关系，系统会按你的自评安排下一次复习。`
  });
  dashboard.tasks.forEach((task, index) => {
    card.body.elements.push({
      tag: 'markdown',
      content: `**${index + 1}. ${task.title}**\n${task.label} · 约 ${task.estimatedMinutes} 分钟 · 掌握度 ${percent(task.mastery)} · ${task.source}`
    });
    card.body.elements.push(actionRow([
      button('开始回忆', { v: '1', action: 'start_task', taskId: task.id }, index === 0 ? 'primary' : 'default')
    ]));
  });
  card.body.elements.push(actionRow([
    button('查看薄弱点', { v: '1', action: 'show_weaknesses' }),
    button('帮助', { v: '1', action: 'show_help' })
  ]));
  return card;
}

export function taskPromptCard(session) {
  const card = titleCard(`01 提取 · ${session.task.title}`, 'wathet');
  card.body.elements.push({
    tag: 'markdown',
    content: `${session.task.prompt}\n\n请**直接发送一条文字答案**。不完整没关系，关键词、结构或例子都可以。`
  });
  card.body.elements.push(actionRow([
    button('给我一个提示', { v: '1', action: 'ask_hint', sessionId: session.id }, 'primary'),
    button('取消本题', { v: '1', action: 'cancel_session', sessionId: session.id })
  ]));
  return card;
}

export function taskSuggestionCard(task) {
  const card = titleCard('找到一个练习 · 请确认', 'wathet');
  card.body.elements.push({
    tag: 'markdown',
    content: `**${task.title}**\n${task.prompt}\n\n来源：${task.source}。点击后才会真正开始并改变当前答题会话。`
  });
  card.body.elements.push(actionRow([
    button('开始这个知识点', { v: '1', action: 'start_practice', knowledgePointId: task.knowledgePointId }, 'primary'),
    button('返回今日任务', { v: '1', action: 'show_today' })
  ]));
  return card;
}

export function answerIntentCard(session, messageId) {
  const card = titleCard('这句话怎么处理？', 'yellow');
  card.body.elements.push({
    tag: 'markdown',
    content: '我不确定你是在提交答案，还是想继续提问。确认前不会保存，也不会改变复习记录。'
  });
  card.body.elements.push(actionRow([
    button('作为答案提交', { v: '1', action: 'confirm_pending_answer', sessionId: session.id, messageId }, 'primary'),
    button('当作问题聊聊', { v: '1', action: 'pending_as_question', sessionId: session.id, messageId })
  ]));
  return card;
}

export function answerSavedCard(session, { feedbackEnabled = false } = {}) {
  const card = titleCard('02 组织 · 答案已保存', 'turquoise');
  card.body.elements.push({
    tag: 'markdown',
    content: feedbackEnabled
      ? `已保存「${session.task.title}」的回忆内容。豆包会另发一条结构性提示；它不会替你打分或改变复习计划。请按真实回忆感受选择一项。`
      : `已保存「${session.task.title}」的回忆内容。模型尚未配置，因此不会假装给你评分。请按真实回忆感受选择一项。`
  });
  card.body.elements.push(actionRow([
    button('完全想不起来', { v: '1', action: 'rate', sessionId: session.id, rating: 'again' }, 'danger'),
    button('想起来很吃力', { v: '1', action: 'rate', sessionId: session.id, rating: 'hard' })
  ]));
  card.body.elements.push(actionRow([
    button('基本掌握', { v: '1', action: 'rate', sessionId: session.id, rating: 'good' }, 'primary'),
    button('很熟练', { v: '1', action: 'rate', sessionId: session.id, rating: 'easy' }, 'primary')
  ]));
  return card;
}

export function modelFeedbackCard(feedback) {
  const card = titleCard('豆包提示 · 仅作结构性参考', 'purple');
  card.body.elements.push({
    tag: 'markdown',
    content: `${feedback}\n\n*当前使用演示/未审核资料，不影响自评和复习排程。*`
  });
  return card;
}

export function ratingCompleteCard({ session, result, completedToday }) {
  const card = titleCard('03 校准 · 已完成', 'green');
  card.body.elements.push({
    tag: 'markdown',
    content: `「${session.task.title}」已记录。下次复习：**${result.state.nextReviewOn}**。今天已完成 **${completedToday}** 次。`
  });
  card.body.elements.push(actionRow([
    button('查看今日任务', { v: '1', action: 'show_today' }, 'primary'),
    button('查看薄弱点', { v: '1', action: 'show_weaknesses' })
  ]));
  return card;
}

export function completionRecordedCard(entry) {
  const card = titleCard('已记入 · 最近完成', 'green');
  card.body.elements.push({
    tag: 'markdown',
    content: `**${entry.reportedOn} · 羊羊自报**\n${safeUserMarkdown(entry.content)}\n\n这条记录用于以后复盘，不会自动修改掌握度或复习日期。`
  });
  card.body.elements.push(actionRow([
    button('查看最近完成', { v: '1', action: 'show_completions' }, 'primary'),
    button('撤销这条', { v: '1', action: 'void_completion', completionId: entry.id })
  ]));
  return card;
}

export function completionVoidedCard(entry) {
  const card = titleCard('已撤销 · 未计入备案', 'grey');
  card.body.elements.push({
    tag: 'markdown',
    content: `**${entry.reportedOn}**\n${safeUserMarkdown(entry.content)}\n\n这条自报记录已撤销；复习掌握度和排程始终没有变化。`
  });
  card.body.elements.push(actionRow([
    button('查看最近完成', { v: '1', action: 'show_completions' }, 'primary'),
    button('查看今日任务', { v: '1', action: 'show_today' })
  ]));
  return card;
}

export function completionHistoryCard(entries) {
  const card = titleCard('最近的任务完成情况', 'green');
  if (!entries.length) {
    card.body.elements.push({ tag: 'markdown', content: '还没有自报完成记录。可以直接说：“我今天完成了教育学第一章和 30 道题。”' });
    return card;
  }
  entries.slice(0, 8).forEach((entry) => {
    card.body.elements.push({
      tag: 'markdown',
      content: `**${entry.reportedOn}** · ${safeUserMarkdown(entry.content)}`
    });
  });
  card.body.elements.push({
    tag: 'markdown',
    content: '*以上均为羊羊的自报备案，用于复盘；不会自动改变记忆自评或复习排程。*'
  });
  return card;
}

export function sessionCancelledCard(session) {
  const card = titleCard('本题已取消', 'grey');
  card.body.elements.push({ tag: 'markdown', content: `「${session.task.title}」没有保存答案，也没有改变复习安排。` });
  card.body.elements.push(actionRow([button('返回今日任务', { v: '1', action: 'show_today' }, 'primary')]));
  return card;
}

export function weaknessCard(points) {
  const card = titleCard('需要固化 · 易忘清单', 'orange');
  if (!points.length) {
    card.body.elements.push({ tag: 'markdown', content: '完成几次回忆后，这里会出现需要优先巩固的知识点。' });
    return card;
  }
  points.forEach((point, index) => {
    card.body.elements.push({
      tag: 'markdown',
      content: `**${index + 1}. ${point.title}** · 当前掌握度 ${percent(point.mastery)}`
    });
    card.body.elements.push(actionRow([
      button('练习这个', { v: '1', action: 'start_weakness', knowledgePointId: point.id }, index === 0 ? 'primary' : 'default')
    ]));
  });
  return card;
}

export function helpCard() {
  const card = titleCard('羊羊的 333 复习助手');
  card.body.elements.push({
    tag: 'markdown',
    content: '可以直接说“今天学什么”“我最近哪里薄弱”“练教育的起源”，也可以汇报“我今天完成了教育学第一章和 30 道题”。\n\n答题中用 `答案：……` 明确提交，用 `问：……` 继续追问；输入 `/记录` 可查看最近完成，其他命令有 `/今日`、`/薄弱`、`/进度`、`/继续`、`/取消`。'
  });
  card.body.elements.push(actionRow([button('查看今日任务', { v: '1', action: 'show_today' }, 'primary')]));
  return card;
}

export function infoCard(title, content, template = 'grey') {
  const card = titleCard(title, template);
  card.body.elements.push({ tag: 'markdown', content });
  return card;
}
