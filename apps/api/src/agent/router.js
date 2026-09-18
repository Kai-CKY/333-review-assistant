const vagueAnswerMessages = new Set(['不知道', '我不知道', '不会', '我不会', '不确定', '没思路', '想不起来', '忘了', '有点懵']);
const vagueRatings = new Set(['还行', '一般', '差不多', '还可以', '不太好说']);
const conversationOnlyMessages = new Set([
  '你好', '您好', '嗨', '哈喽', 'hello', 'hi', '在吗',
  '早上好', '中午好', '下午好', '晚上好', '晚安',
  '谢谢', '谢谢你', '辛苦了', '收到', '好的', '好'
]);

function normalized(content) {
  return String(content ?? '').trim().replace(/[。！!？?]+$/, '').trim();
}

function reportDayOffset(value) {
  if (/前天/.test(value)) return -2;
  if (/昨天|昨日/.test(value)) return -1;
  return 0;
}

function looksLikeQuestion(value, raw) {
  return /[？?]$/.test(raw)
    || /^(?:为什么|怎么|如何|什么|哪|是否|能不能|可不可以|请问|我想问)/.test(value)
    || /(?:吗|呢)$/.test(value);
}

function looksLikeAnswer(value) {
  if (value.length < 7) return false;
  const signals = [
    /(?:首先|其次|再次|最后|一是|二是|三是|第一|第二|第三|[（(]?\d+[）)、.)])/.test(value),
    /(?:包括|分为|是指|认为|具有|体现|形成|促进|应当|应该|应|原因|意义|特点|原则|规律|观点|代表|核心|作用|要求|关系|区别|联系|依据|分别)/.test(value),
    /(?:教育|教学|德育|课程|学生|教师|学校|本位论|起源论)/.test(value),
    /[，,；;：:]/.test(value)
  ].filter(Boolean).length;
  return signals >= 2;
}

export function explicitAnswerFrom(content) {
  const match = String(content ?? '').trim().match(/^(?:答案|作答|我的答案)\s*[：:]\s*(.+)$/s);
  return match?.[1]?.trim() || null;
}

export function explicitQuestionFrom(content) {
  const match = String(content ?? '').trim().match(/^(?:问|问题|我想问)\s*[：:]\s*(.+)$/s);
  return match?.[1]?.trim() || null;
}

export function parseNaturalRating(content) {
  const value = normalized(content);
  if (/^(?:我)?(?:完全)?(?:没想起来|想不起来|全忘了|完全不会|忘光了)$/.test(value)) return 'again';
  if (/^(?:我)?(?:想起来)?(?:很吃力|很费劲|比较模糊|勉强想起)$/.test(value)) return 'hard';
  if (/^(?:我)?(?:基本掌握|基本会了|大概记得|能想起来)$/.test(value)) return 'good';
  if (/^(?:我)?(?:很熟练|很轻松|很稳|完全掌握)$/.test(value)) return 'easy';
  return null;
}

export function deterministicConversationReply(content) {
  const value = normalized(content).toLowerCase();
  if (['你好', '您好', '嗨', '哈喽', 'hello', 'hi', '在吗', '早上好', '中午好', '下午好', '晚上好'].includes(value)) {
    return '羊羊，我在。你可以告诉我今天完成了什么，或直接说“今天学什么”。';
  }
  if (['谢谢', '谢谢你', '辛苦了'].includes(value)) return '不客气。今天哪怕只完成一个小闭环，也值得记下来。';
  if (['收到', '好的', '好'].includes(value)) return '好，我在。完成一项后直接告诉我，我会替你记入复盘备案。';
  return null;
}

export function completionReportFrom(content) {
  const raw = String(content ?? '').trim();
  const value = normalized(content);
  if (!raw || /^(?:答案|作答|我的答案|问|问题|我想问)\s*[：:]/.test(raw)) return null;
  if (/[？?]$/.test(raw) || /(?:完成了?|做完了?|学完了?|复习了?|背了?|看了?|刷了?|整理了?).*(?:多少|什么|没有|没|吗|没吗)/.test(value)) return null;
  if (/(?:完成|做|学|复习|背|看|刷|整理|听|写).*(?:多少|什么|几)(?:道|个|章|节|次|项|份|页)?(?:题)?(?:了)?$/.test(value)) return null;
  if (/计划|打算|准备|预计|希望|争取|尚未|还没|如果|假如|要是|明天|后天|下周|没有完成|没完成|未完成|没有做完|没做完/.test(value)) return null;
  if (/(?:要|想|将|会)(?:去|再|先)?(?:完成|做完|学完|复习|背|看|刷|整理|听|写)/.test(value)) return null;
  if (/(?:没|未|没有)(?:有)?(?:完成|做完|学完|复习|背|看|刷|整理|听|写)/.test(value)) return null;
  const explicitSummary = raw.match(/^(?:(?:我来)?(?:汇报|总结)(?:一下)?(?:我)?(?:今天|今日|昨天|昨日|前天)?(?:的)?(?:任务)?完成情况|(?:我)?(?:今天|今日|昨天|昨日|前天)?(?:的)?(?:任务)?完成情况)\s*(?:是|如下)?\s*[：:]?\s*(.+)$/s);
  const explicitRecord = raw.match(/^\/?记录\s*[：:]?\s+(.+)$/s);
  const selfReportContext = /^(?:我(?:今天|今日|昨天|昨日|前天|刚刚|刚才|已经)?|今天|今日|昨天|昨日|前天|刚刚|刚才|已经|已完成|任务完成情况|完成情况|\/?记录(?:\s|[：:]))/.test(value);
  if (!explicitSummary?.[1]?.trim() && !explicitRecord?.[1]?.trim() && !selfReportContext) return null;
  if (!explicitSummary?.[1]?.trim() && !explicitRecord?.[1]?.trim() && /^我(?:觉得|认为|听说|看到|发现|知道|问)/.test(value)) return null;
  const completedAction = /(?:完成了|做完了?|学完了?|复习完了?|复习了|背完了?|背了|看完了?|刷完了?|刷了|整理完了?|整理了|听完了?|写完了?)/.test(value);
  const learningAction = /(?:做了|学习了|读了|看了|听了|写了).{0,24}(?:章|节|题|卷|课|视频|知识点|笔记|提纲|真题|模拟题|单词|教育学|心理学|教育史|教原|教心)/.test(value);
  const alreadyCompleted = /(?:已经|已)\s*(?:完成|做完|学完|复习完|背完|看完|刷完|整理完|听完|写完)/.test(value);
  const allCompleted = /(?:任务|计划).{0,8}(?:全部|都)?完成了?$/.test(value);
  if (!explicitSummary?.[1]?.trim() && !explicitRecord?.[1]?.trim() && !completedAction && !learningAction && !alreadyCompleted && !allCompleted) return null;
  return {
    content: (explicitRecord?.[1]?.trim() || raw).slice(0, 2_000),
    dayOffset: reportDayOffset(value)
  };
}

export function routeActiveMessage(content, sessionStatus) {
  const raw = String(content ?? '').trim();
  const value = normalized(content);
  if (sessionStatus === 'awaiting_answer') {
    if (/^(?:答案|作答|我的答案)\s*[：:]\s*$/s.test(raw)) return { type: 'empty_answer' };
    const answer = explicitAnswerFrom(content);
    if (answer) return { type: 'submit_answer', answer };
    const question = explicitQuestionFrom(content);
    if (question) return { type: 'coach', question };
    const navigation = deterministicNaturalIntent(content);
    if (navigation?.type === 'start_task') return { type: 'start_blocked' };
    if (navigation) return { type: 'navigation', intent: navigation.type };
    if (/提示|没看懂|不懂|不理解|不知道|不会用|什么意思|怎么答|如何作答|解释一下|再说一点|多说一点|讲讲|想听.*讲|能不能.*(?:讲|说|解释)|可不可以.*(?:讲|说|解释)|换一题|换题|太难|好难/.test(value) || vagueAnswerMessages.has(value)) {
      return { type: 'coach', question: raw };
    }
    if (
      conversationOnlyMessages.has(value.toLowerCase())
      || /焦虑|紧张|压力|坚持不下去|不想学|没状态|状态|好累|太累|困了|烦躁|崩溃|想休息|休息|心情|让我再想想|再想想|等一下|等会|稍等|还没写完|我明白了|我懂了|知道了/.test(value)
    ) {
      return { type: 'chat' };
    }
    if (/我想(?:聊聊|讨论)|只是(?:聊聊|讨论)/.test(value)) return { type: 'chat' };
    if (/(?:不要|别|暂不|先不)(?:保存|提交)|不是(?:最终)?答案|并非答案|还没想好|不确定|只是(?:举个|一个)?例子|还要再想/.test(value)) {
      return { type: 'ambiguous' };
    }
    if (/[？?]$/.test(raw) && value.length <= 20 && !/^(?:为什么|怎么|如何|什么|哪|是否|能不能|可不可以|请问|我想问)/.test(value)) {
      return { type: 'ambiguous' };
    }
    if (looksLikeQuestion(value, raw)) return { type: 'coach', question: raw };
    if (looksLikeAnswer(value)) return { type: 'submit_answer', answer: raw };
    return { type: 'ambiguous' };
  }
  if (sessionStatus === 'awaiting_rating') {
    const rating = parseNaturalRating(content);
    if (rating) return { type: 'rate', rating };
    const navigation = deterministicNaturalIntent(content);
    if (navigation?.type === 'start_task') return { type: 'start_blocked' };
    if (navigation) return { type: 'navigation', intent: navigation.type };
    if (vagueRatings.has(value)) return { type: 'rating_ambiguous' };
    return { type: 'chat' };
  }
  return { type: 'busy' };
}

export function deterministicNaturalIntent(content) {
  const value = normalized(content);
  if (/^(?:(?:(?:看|查看|显示|打开)(?:一下)?(?:我的)?|我(?:最近|这周|本周|今天|今日)?)(?:最近)?(?:任务)?完成(?:情况|记录|历史)|我最近(?:完成|做完|学完|复习)了什么)(?:呢|啊|呀)?$/.test(value)) return { type: 'show_completions' };
  if (/^(?:(?:我)?(?:今天|今日)(?:要|该|应该|想)?(?:学什么|怎么学|复习什么|怎么安排|有(?:哪些|什么)任务|的?任务)|(?:看|查看|显示)(?:一下)?(?:今天|今日)任务)(?:呢|啊|呀)?$/.test(value)) return { type: 'show_today' };
  if (/^(?:(?:我)?(?:今天|今日)?(?:的)?(?:进度|完成了多少|做了几题|做了多少)|(?:看|查看|显示)(?:一下)?(?:我的)?进度)(?:呢|啊|呀)?$/.test(value)) return { type: 'show_progress' };
  if (/^(?:(?:我)?(?:最近|目前|现在)?(?:哪里|哪些|什么地方)?(?:最)?(?:薄弱|容易忘|不会|不熟)|(?:看|查看|显示)(?:一下)?(?:我的)?(?:薄弱点|弱项|易忘点))(?:呢|啊|呀)?$/.test(value)) return { type: 'show_weaknesses' };
  if (/^(?:你)?(?:怎么用|能做什么|可以做什么|有哪些功能|帮助|使用帮助)(?:呢|啊|呀)?$/.test(value)) return { type: 'help' };
  const practicePatterns = [
    /^练(?!习)(?:一下)?\s*[：:，,]?\s*(.+)$/,
    /^练习(?:一下)?(?!的|是|中|时|基本要求)\s*[：:，,]?\s*(.+)$/,
    /^考我(?:一下)?\s*[：:，,]?\s*(.+)$/,
    /^开始(?:练习|复习)(?:一下)?\s*[：:，,]?\s*(.+)$/
  ];
  for (const pattern of practicePatterns) {
    const match = value.match(pattern);
    if (match?.[1]?.trim()) return { type: 'start_task', query: match[1].trim() };
  }
  return null;
}
