# 开发与线上运行操作单

本机代码来自 GitHub；本机 `.env.local` 和 `.data/local-dev/` 只供开发。线上 `.env.local`、`runtime-data/`、容器与 Nginx 是另一套状态。两边不自动同步运行数据，不用 Git 覆盖生产数据库或密钥。仓库里已提交的 `.data/knowledge-export/` 是知识快照，不等于当前线上运行库。

## 本机开发

1. `npm ci` 安装锁文件依赖；Node.js 至少 20。按 README 设置本机独立的 Web 登录账号和会话密钥；默认保持 `FEISHU_ENABLED=false`、`ARK_API_KEY=`。设置 `DATA_FILE=.data/local-dev/review-assistant.json`，使开发数据与其他本机数据也分开。
2. `npm run dev`，打开 `http://127.0.0.1:3333`。`GET /api/health` 为 200、未登录 `GET /api/dashboard` 为 401、登录后为 200，才算本机基础启动成功。
3. 修改代码后运行 `npm test` 和 `npm run knowledge:evaluate -- --scale 1000`。涉及镜像时，还要在 Docker 引擎可用时执行仓库 CI 中的镜像构建与冒烟测试。
4. 每项修复从独立分支提交 PR。合并前确认 CI 对**同一提交**通过；不要把本机通过当成线上已更新。

## 线上问题交接给开发 Agent

线上 Agent 先用只读操作收集一份事故记录，再交给开发 Agent。至少包含：发生时间与时区、用户看到的现象、可脱敏的请求或任务 ID、复现步骤、线上实际运行版本、相关时间段日志、容器状态、影响范围，以及最近一次部署时间。日志、配置和数据样本先脱敏，不输出密码、API Key、Cookie、完整聊天或学习内容。

版本要分清三件事：GitHub `main` 的提交、服务器工作树的 `git rev-parse HEAD`、正在运行的容器镜像。它们可能不同。新镜像通过管理员登录后的 `GET /api/runtime` 报告构建时写入的 `APP_REVISION`；该接口返回 `unknown` 时不能推断线上版本，需核对容器镜像 ID 与部署记录。只有工作树干净、构建参数来自该提交时，`APP_REVISION` 才能准确标识镜像代码。

线上 Agent 可按服务器实际目录，以只读方式执行并回报摘要：`git status --short`、`git rev-parse HEAD`、`docker compose ps`、`docker compose images`、`docker compose logs --since=30m --tail=200 app`，以及 `runtime-data/` 文件大小和修改时间。`GET /api/health` 只证明 HTTP 进程可响应；还需核对业务接口、飞书连接、模型错误和数据持久化。不要把完整运行库复制给开发环境；本项目当前生产数据主要是单实例 JSON 文件，缺少数据库级只读授权，数据核查应由线上 Agent 执行指定查询并返回脱敏统计或样本。

当提供线上 SSH 目标和确认的项目目录后，可为开发 Agent 配置受限只读 SSH 查询或统一日志/监控入口。先接入版本、容器状态、日志和只读统计；部署写权限单独留给发布流水线。所有线上查询都标注环境、时间与运行版本，避免把旧日志或本地数据当成当前生产状态。

## 发布与回滚

当前仓库只有 CI，没有自动 CD。现阶段先保持人工决定是否上线；让固定流水线执行备份、部署**已经通过 CI 的确切提交/镜像**、健康与登录后业务冒烟、记录镜像 ID/提交、失败回滚。部署前先核对服务器工作区本地补丁和运行数据备份，不能为了部署执行 `git reset --hard`。生产已使用单实例持久 JSON 数据，回滚代码不自动回滚数据结构或记录。此服务器只有 896 MiB 内存，已实测本地构建会使正式容器 OOM；发布镜像必须在 CI 或更大内存的构建机生成。

在现有手动部署期间，先确认服务器工作区干净、提交与 CI 结果匹配、备份可用，并且目标镜像已由外部构建后交付到服务器，再运行：

```bash
docker compose up -d --no-build
docker compose ps
```

随后用管理员账号查询 `/api/runtime`，确认返回的提交与发布目标一致，再完成业务冒烟。`APP_REVISION` 是构建信息，不含密钥；不要把真实密钥写入镜像构建参数。若部署失败，按已有生产操作单恢复服务和必要的数据备份。自动 CD 上线前，先验证备份恢复、回滚、镜像版本核对和服务器本地补丁清理，再配置生产发布凭据及审批规则。
