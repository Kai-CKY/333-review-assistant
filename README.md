# 考研 333 AI 复习助手

这是一个可本地运行的 MVP 骨架。当前已经具备：今日任务、主动回忆、四档记忆自评、复习间隔、错弱点标记、任务完成自报与复盘备案、适配 iPad 的 Web 界面，以及只服务李羊羊的飞书私聊学习 Agent。

飞书 Agent 支持卡片和自然语言互动；收到合法私聊后先加 DONE 对勾，常见短消息走本地快速回复，普通闲聊只调用一次豆包 Seed 2.1 Turbo。明确的“今天完成了……”会直接进入可撤销的复盘备案，但不会改变掌握度或复习排程。飞书首测与 Prompt 设计分别见 `docs/FEISHU-TESTING.md` 和 `docs/AGENT-PROMPT.md`。

Web 与飞书提交的主观题都会进入同一个本地持久化反馈流程：先创建 `feedback_job` 与关联 `answer_feedback`，再异步生成结构性提示。两者都会保留 `queued`、`running`、`succeeded` 或 `failed` 状态，以及幂等键、模型/提示词版本、资料快照和安全错误码；模型不会改变自评或复习排程。

配置群内的图片/图文消息现进入“独立识读两次→差异对齐→联网核验→文字草稿→羊羊确认”的知识流程。修改建议会形成待确认新版本，明确“修改并保存”会在重新核验后更新，旧版本保留。方舟联网搜索需要账号已开通；未开通时只生成待核验草稿，不会伪装搜索成功或自动入库。

私聊、群、话题及 `/new` 后会话隔离；长期备注、完整历史和学科知识分层存储。群内可用“知识库”“知识库查询：关键词”查看已确认内容。当前知识库在本服务端持久保存，未自动同步飞书 Wiki。设计、指令和测试见 [图片知识与分层记忆](docs/PHOTO-KNOWLEDGE-AND-MEMORY.md)。

服务重启时会续跑遗留的 `queued` 任务；若任务在上一次进程中已进入 `running`，会保守地标为 `failed / worker_interrupted`，而不自动重放，以免重复产生模型调用费用。

## 本地运行

需要 Node.js 20 或更高版本。在项目目录运行：

```powershell
npm run dev
```

`dev` 会读取本机 Git 忽略的 `.env.local`，因此 Web 和飞书会使用同一份 Ark 配置。若只是查看无模型的演示流程、尚未创建 `.env.local`，可运行 `npm run dev:demo`。

浏览器打开 `http://localhost:3333`。首次打开会在 `.data/review-assistant.json` 创建本地演示数据；这个文件承载本机数据，不会被 Git 跟踪。

知识库可通过 `npm run knowledge:export` 导出为 `.data/knowledge-export/` 下的完整快照，包含知识版本、OCR/核验记录、原图和归档文件。该目录已放行Git；私聊历史、学习记录、密钥和日志仍被排除。提交前需重新导出；云端运行数据不会自动同步到Git。首次部署可用 `npm run knowledge:restore -- --database /data/review-assistant.json` 恢复到尚不存在的数据库，不能覆盖云端已有数据。详见 [知识库保存与云端修改](docs/KNOWLEDGE-STORAGE-AND-CLOUD.md)。

## 验证

```powershell
npm test
```

## 当前边界

- 演示知识点只用于验证系统流程，不是最终的 333 权威题库。
- 当前调度器为可测试的四档间隔策略；接入 `ts-fsrs` 后会保留相同的调用接口。
- 当前知识点仍是演示资料，模型只给练习建议，不冒充标准答案或评分。
