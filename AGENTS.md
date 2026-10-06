# 本项目的 Codex 工作约定

## 连接云服务器

- 用户希望在**本机 Codex** 中通过 SSH 管理旧线上服务器。不要把 Codex 桌面应用的「设置 → 连接 → SSH 远程项目」当成当前工作方式；远端未安装 Codex CLI，普通 SSH 管理不需要安装或登录它。
- 本机 Windows 的 OpenSSH 别名为 `review-assistant-prod`，指向 `root@39.107.65.232:22`。别名定义在 `C:\Users\devuser\.ssh\config`，使用本机专用私钥 `C:\Users\devuser\Documents\Codex\333-review-assistant\.data\ssh\id_ed25519_codex_333` 和已核对的 `C:\Users\devuser\Documents\Codex\333-review-assistant\.data\ssh-known-hosts`。私钥和凭据均不得写入 Git 或聊天回复。
- 用户已核对旧服务器 SSH 主机指纹 `SHA256:995Y8GqYuOjqI4maO8OYV4CuGzf/MbmVF/nh9npUEBg`。若指纹变化，先停下并核对，不要关闭主机密钥检查。
- 开始本项目的新会话时，主动做一次只读连通性检查：`ssh -o BatchMode=yes review-assistant-prod 'hostname'`。随后按当前任务读取服务器状态，不要把旧会话的状态当成实时状态。连接是按需运行的 SSH 命令，不是常驻会话。
- 当前 Codex 沙盒账户可能读不到 Windows 用户的 SSH 配置或私钥；通过工具的 `require_escalated` 权限运行 SSH 命令即可使用已配置的 `devuser` 凭据。不要为绕过沙盒而放宽私钥 ACL、复制或重新生成私钥。若 SSH 失败，先区分本机文件权限、主机指纹和服务端认证错误。

## 服务器上的项目布局

- 正式目录：`/www/wwwroot/333-review-assistant`，`main` 分支，`compose.yaml`，`.env.local`，`runtime-data/`，容器 `333-review-assistant-app-1`，仅本机监听 `127.0.0.1:3333`。
- 隔离测试目录：`/www/wwwroot/333-review-assistant-staging`，`codex/server-staging` 分支，`compose.staging.yaml`，`.env.staging.local`，`staging-runtime-data/`，容器 `333-review-staging-app-1`，仅本机监听 `127.0.0.1:3334`。测试 Web 可经 SSH 隧道访问；不要开放测试端口到公网。
- 两个实例目前复用同一个飞书应用，不能同时启用飞书长连接。2026-10-04 核对时正式实例 `FEISHU_ENABLED=true`、测试实例 `FEISHU_ENABLED=false`，两个容器均健康。每次操作前重新核对实际状态；切换群测时遵循 `docs/SERVER-COLOCATED-WORKFLOW.md`，测试结束恢复正式连接。
- 测试工作树的 GitHub `origin` 是 `git@github.com:Kai-CKY/333-review-assistant.git`；服务器上已有用于此仓库的独立部署密钥。用 SSH remote 推送功能分支，不把 GitHub token 放进远程 URL 或文件。
- 旧服务器只有约 896 MiB 内存。此前在上面执行 Docker 构建时曾导致正式容器因内存不足退出。不要在这台服务器直接运行 `docker compose up --build`；依赖或镜像变化应在 CI 或内存充足的构建机处理。

## 新会话和后续开发

1. 先查看本机 `git status`，保留已有未提交修改；再用 SSH 只读检查服务器两个工作树的 Git 状态、容器健康和所需日志。不要因为本机检出与服务器不同就覆盖其中一边。
2. 在隔离测试目录或功能分支开发，先完成适当测试、推送 GitHub 并核对 CI，再考虑正式发布。正式目录和 `runtime-data/` 承载真实服务与数据，不用它们做试验。
3. 正式发布前记录明确提交、备份运行数据并确认可回滚；发布后核对容器、`/api/health`、版本信息和飞书实际响应。测试数据、测试环境文件不得覆盖正式数据和配置。
4. 详细的同机测试、飞书切换和发布流程见 `docs/SERVER-COLOCATED-WORKFLOW.md`；开发与线上排障交接见 `docs/DEV-PROD-OPERATIONS.md`。遇到这些文档与服务器现状不一致时，以实时检查结果为准并更新文档。

## 已确认的产品范围（2026-10-04）

- 永久只有羊羊一名学习者和项目管理者，不增加学习者或建设多人产品。管理员默认可查看全部数据，包括私聊和备注，不再请求查看范围确认；查看权限不等于代替羊羊作答、自评。
- 所有知识点及需要提醒、记录的内容由羊羊手动在群里上传，主要为当天学习或发现遗漏／遗忘的照片。系统按记忆算法安排并定时提醒背诵复习。当前四档算法不是 FSRS，不把上传或自报完成当作真实复习完成。
- 本轮先做本地日历、记忆及身份页面 demo，下载原始旧库和附件到本机，生成新版独立表候选。管理者检查页面样板及数据后，再修改线上应用和数据；不得将本地候选直接接入未适配的生产应用。
- 管理者已确认旧库 8 个来源不详知识点是生成示例，当前候选删除它们，以手动上传内容为基准。当前候选位于 `.data/local-review/20261004-manual-uploads/`，原始备份不变。原图以横向时间线连接可编辑转写和复习日历；本地文字校正保留版本，不重置上传时间或复习状态。
- 测试继续共用飞书应用，由管理者本人在群里执行同机小规模群测；沿用分时连接与独立测试数据目录。备份放在本机 `.data/local-backups/`，候选放在 `.data/local-review/`，不提交 Git。完整说明见 `docs/PROJECT-RULES-2026-10-04.md` 和 `docs/LOCAL-REVIEW-DEMO.md`。
- 管理者已于 2026-10-04 确认样板和数据设计，授权 review 后上线及迁移，不重复请求发布许可。正式格式是 `relational-v1`，文件 `/data/review-assistant.sqlite`；不可把旧整体 JSON 或早期 collections SQLite 当成新独立业务表。发布步骤与回滚见 `docs/RELEASE-REVIEW-CONSOLE-2026-10-04.md`。

## 待开发工作（2026-10-04）

- 管理者于 2026-10-05 确认：权威教材资料由管理者手动上传。不得把外部 PDF 核验链接或联网搜索结果自动当作教材权威来源；原有 3 条外部 PDF 核验引用已要求删除。教材转写先在本机进行，后续教材原图、转写、检索应保留手动提供原件的来源和页码。此要求不等于允许自动加入羊羊的学习／复习范围。

- 管理者要求先整理管理端临时操作对接的待办，并调查 Agent 响应临时需求、调用工具的能力差距。清单见 `docs/DEVELOPMENT-BACKLOG.md`，学习材料见 `docs/AGENT-TOOLING-RESEARCH-2026-10-04.md`。
- 另一个会话正在讨论“活水”功能；等相关功能全部敲定并汇总后统一开发。在此之前仅做需求整理、调查与文档，不提前修改应用、配置或线上数据，不部署。调查建议不等于已批准实现全部工具能力。

## 最新推进约定（2026-10-06）

- 管理者已认可本地管理者费用页布局，并要求删除侧栏宣传文案和同类口号。正式接入沿用精简版本，必要状态、金额口径与操作标签保留。
- 首版暂不开发现场 Agent 管理工具调用。管理者临时任务通过 Codex 和管理操作模块进行，现场 Agent 可读取相关实际操作结果。
- 成本预算仅告警，超额继续调用。每日／每月金额由管理员设置，不能把 demo 金额作为生产默认值。官方账单与本地模型估算分开。
- 管理者要求完整计划，集中审查可并行及相互关联内容，并授权后续开发无问题时提交和上线。当前有效计划见 `docs/DEVELOPMENT-BACKLOG.md` 文末“统一实施与审查计划”。明确范围完成审查、CI、隔离验收和可恢复备份后直接发布，不重复请求发布许可。此授权不等于批准猜测出来的活水规则或其他未定功能。
- 管理者随后确认：检查项目中其他方案，若没有找到活水具体方案就按没有处理。已查项目设计与实施文档、本机注册工作树和服务器 Markdown，未找到独立规格。本轮不开发活水或持续规则执行，也不再等待活水定稿作为开发前置条件。
- 管理者确认表情费用并入原模型回复与思考费用，管理页面不得单列表情费用。已授权开发、提交并通过 SSH 直接发布，通过检查后汇报，无需再次请求上线许可。
