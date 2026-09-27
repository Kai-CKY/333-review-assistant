# 考研 333 AI 复习助手

这是一个可本地运行的 MVP。具备应用登录、最新入库知识同步、今日任务、主动回忆、四档自评、记忆时间线和 Web/飞书共享排程。羊羊是唯一学习者，系统管理员只查看她的学习数据；飞书按真实账号识别角色并隔离私聊、群聊及话题。

知识库 V2 已实现按 ID 固定练习依据、教材/遗忘记录分层、教材校正建议、已核对答案反馈、局部图谱与主动抽查。实际功能、验证和 SQLite 迁移步骤见 [本次实现说明](docs/KNOWLEDGE-V2-IMPLEMENTATION.md)；完整目标见 [设计方案](docs/KNOWLEDGE-V2-DESIGN.md) 与 [检索工具流程](docs/KNOWLEDGE-RETRIEVAL-TOOLS.md)。本地实现不代表已经部署上线。

飞书 Agent 支持卡片和自然语言互动；收到合法私聊后先加 DONE 对勾，常见短消息走本地快速回复，普通闲聊只调用一次豆包 Seed 2.1 Turbo。明确的“今天完成了……”会直接进入可撤销的复盘备案，但不会改变掌握度或复习排程。飞书首测与 Prompt 设计分别见 `docs/FEISHU-TESTING.md` 和 `docs/AGENT-PROMPT.md`。

Web 与飞书主观题进入同一个持久化反馈流程：先创建 `feedback_job` 和 `answer_feedback`，有已核对答案时按固定依据逐要点检查，否则只给结构提示。保留任务状态、幂等键、模型/提示词版本、资料快照和安全错误码；模型不改变自评或复习排程。

配置群内图片进入“独立识读两次→差异对齐→同范围教材比对→必要时联网核验→草稿→羊羊确认”的流程。教材校正需要显式发送“确认教材校正 编号 v版本”。修改建议形成待确认新版本，旧版保留。方舟联网搜索须账号开通；没有核验依据时不伪装成功或自动入库。

私聊、群、话题及 `/new` 后会话隔离；长期备注、完整历史和学科知识分层存储。群内可用“知识库”“知识库查询：关键词”查看已确认内容。当前知识库在本服务端持久保存，未自动同步飞书 Wiki。设计、指令和测试见 [图片知识与分层记忆](docs/PHOTO-KNOWLEDGE-AND-MEMORY.md)。

服务重启时会续跑遗留的 `queued` 任务；若任务在上一次进程中已进入 `running`，会保守地标为 `failed / worker_interrupted`，而不自动重放，以免重复产生模型调用费用。

## 本地运行

需要 Node.js 20 或更高版本。在项目目录运行：

```powershell
npm run dev
```

`dev` 会读取本机 Git 忽略的 `.env.local`，因此 Web 和飞书会使用同一份 Ark 配置。无模型试用时保留 `FEISHU_ENABLED=false` 和空 `ARK_API_KEY`，仍需配置下面的网页登录。`dev:demo` 不读取 `.env.local`，须由进程环境提供登录配置；没有账号时 Web 默认拒绝访问。

浏览器打开 `http://localhost:3333`。首次打开会在 `.data/review-assistant.json` 创建本地演示数据；这个文件承载本机数据，不会被 Git 跟踪。

知识库可通过 `npm run knowledge:export` 导出为 `.data/knowledge-export/` 下的完整快照，包含知识版本、OCR/核验记录、原图和归档文件。该目录已放行Git；私聊历史、学习记录、密钥和日志仍被排除。提交前需重新导出；云端运行数据不会自动同步到Git。首次部署可用 `npm run knowledge:restore -- --database /data/review-assistant.json` 恢复到尚不存在的数据库，不能覆盖云端已有数据。详见 [知识库保存与云端修改](docs/KNOWLEDGE-STORAGE-AND-CLOUD.md)。

## 验证

```powershell
npm test
```

## Web 登录配置

复制 `.env.example` 为 `.env.local`。用以下一条命令生成 scrypt 密码哈希（交互输入隐藏，不把密码写进命令历史）：

```text
node scripts/hash-web-password.mjs
```

将结果填入 `.env.local` 的 `WEB_USERS`，格式为 `账号:生成的哈希`，最多两个账号，以逗号分隔。**整段值用单引号包裹**，避免 Docker Compose 插值破坏哈希中的 `$`。这里不提供任何默认密码。两个账号访问同一份羊羊学习工作区，不是两套学生数据。

将你的 Web 登录账号名填入 `WEB_ADMIN_USERS`（逗号分隔）。管理员可查看学习数据、维护教材和参考答案/关系，不能提交羊羊的作答或自评。其余 Web 账号用于羊羊学习；Web 账号名不等于飞书身份，必须分别配置。

飞书推荐明确配置 `FEISHU_LEARNER_OPEN_ID`（羊羊）和 `FEISHU_OWNER_OPEN_ID`（系统管理员）。`FEISHU_DM_MODE=allowlist` 默认只接待两位已绑定用户；设为 `open` 可接待应用可见范围内用户，但未绑定用户不能查看学习数据或使用学习卡片。私聊发送 `/身份` 可查看自己的 open_id。旧 `FEISHU_TESTER_OPEN_ID` 仅作为学习者绑定的兼容兜底，不应填管理员账号。群聊仍需显式启用并限定群 ID。

知识索引显示最新已保存修正版。个人遗忘照片按上传日记录发现遗忘并安排复习；教材上传不表示学过或遗忘，需选择知识点加入学习范围。完成回忆后按实际自评计算下次日期。原排程规则见 [学习流程](docs/LEARNING-FLOW-PROPOSAL.md)，V2 差异以本次实现说明为准。

生成独立会话密钥并填入 `WEB_SESSION_SECRET`：

```text
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

会话 cookie 使用 HMAC-SHA256、HttpOnly、SameSite=Lax，默认 7 天；`WEB_SESSION_TTL_SECONDS` 可设为 60～2592000 秒。登出立即撤销该会话；服务重启会让所有浏览器重新登录。每个账号最多保留 20 个会话，超出时撤销最早的会话。当前 HTTP 使用 `COOKIE_SECURE=false`，启用 HTTPS 后改为 `true`。应用登录不会加密 HTTP 传输，公网正式使用仍应启用 HTTPS。

未登录 API 返回 401，页面跳转 `/login`；登录页及其 JS/CSS 是必要公开资源，`GET /api/health` 始终免鉴权并只返回存活状态。每个 IP 每分钟最多 5 次登录尝试；反代配置和撤除 Basic Auth 的步骤见[部署说明](docs/PRIVATE-TEST-DEPLOYMENT.md)。

## 入库知识自动更新

服务启动和每次数据读写会把允许范围内的最新已确认版本同步为知识点。网页“知识索引”展示入库内容、版本和核验状态，空闲可见页面每 30 秒刷新；答题或展开资料时暂停自动刷新，关闭后下一轮更新。飞书私聊陪练和群内知识问答读取最新入库资料，不需重启或重新挂载。

默认共享配置主群及羊羊私聊主会话中的入库知识，其他群/话题须配置 `KNOWLEDGE_SCOPE_KEYS`，不共享聊天或备注。待核验存档可标注不确定性供自主回忆；只有个人遗忘资料按上传日安排复习，教材不自动安排。已有资料后隐藏演示题库，原记录保留。修订不改学习历史。详见[知识同步说明](docs/KNOWLEDGE-STORAGE-AND-CLOUD.md)。

线上已有数据库时，使用 `knowledge:merge` 预览并增量合并已保存知识，不使用 `knowledge:restore` 覆盖运行库。具体命令及验证步骤见[线上知识更新操作单](docs/SERVER-KNOWLEDGE-UPDATE-2026-09-23.md)。

## 当前边界

PDF 已改为在开发电脑离线解析、核对后导入。生产环境没有 PDF 上传或解析服务，只读取已入库教材和原页。旧解析器代码仅保留为本地工具，见 [离线 PDF 流程](docs/ENABLE-PDF-PARSER.md)。

- 演示知识点只用于验证系统流程，不是最终的 333 权威题库。
- 当前调度器为可测试的四档间隔策略；接入 `ts-fsrs` 后会保留相同的调用接口。
- 未导入资料时仍显示演示知识点；真实资料以核验状态决定是否可练习，模型不冒充标准答案或评分。
- 日期初始化、记忆时间轴和主动复习提醒的后续方案见[三条学习流程提案](docs/LEARNING-FLOW-PROPOSAL.md)，尚待产品确认。
