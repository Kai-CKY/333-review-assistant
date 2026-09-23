# 应用登录与知识同步验收

> 本文记录较早一次 58 项测试验收；其中显示版本号、待核验不排程及不改动飞书目录的描述已被用户后续要求替代。当前验收与部署边界见 [身份、日期与网页闭环验收](IDENTITY-AND-MEMORY-ACCEPTANCE-2026-09-23.md)。

日期：2026-09-23。代码已在本地实现，尚未推送或部署到云端。

## 自动化

- `npm test`：58 项通过，0 失败（原 47 项 + 新增 11 项）。
- 登录测试覆盖：匿名 API 拒绝、页面跳转、公开健康检查与登录资源、正确/错误凭据、同长度伪造 HMAC 拒绝、登出撤销旧 cookie、会话过期、重启失效、Secure 开关、双账号、每分钟五次限速、代理 IP 信任、跨源提交拒绝、请求体上限、无配置时关闭访问。
- 知识测试覆盖：已保存版本自动导入、范围隔离、待核验内容不排程、移除条目归档、修订保留学习历史、并发读写保留变更、Web/私聊/群检索、反馈证据快照不被后续修订改写。
- 原有飞书与知识保存测试仍通过；未调用真实飞书或付费模型。
- `git diff --check` 通过。

## curl 与浏览器

使用临时目录、临时随机账号、禁用飞书和模型的独立进程，不改本机/云端真实学习数据。

| curl 操作 | 实际结果 |
| --- | --- |
| 匿名 GET /api/dashboard | 401 |
| POST /api/login | 200，获得 cookie |
| 携带 cookie GET /api/dashboard | 200 |
| POST /api/logout | 200 |
| 登出后重放原 cookie GET /api/dashboard | 401 |

内置浏览器实测：匿名首页转到登录页；错误密码提示；正确登录进入工作台；知识快照中的 10 条生物学内容自动显示；展开显示原文、v1、入库时间和待核验状态；登出返回登录页。已检查登录页截图，样式与现有工作台一致。

以现有 `.env.local` 的知识范围配置对本地数据副本计算，同样得到 10 条入库内容，0 条可排程（均原本为 unresolved）。本次没有修改其审核状态。修复了知识快照没有考试日期时页面显示 NaN 的问题，改为“待设置”。

## Docker 与部署边界

- `docker compose config --quiet` 通过。
- 本机 Docker 引擎不可用。尝试启动 Docker Desktop 后仍无法连接 Linux Engine；因此 **未完成镜像构建、compose 启动及容器 healthy 验收**。健康接口已通过真实 HTTP 自动测试，不能把它等同于容器验收。
- 未修改 `compose.yaml`，后端端口仍为 `127.0.0.1:3333:3333`。
- 未修改 `apps/api/src/feishu/` 下任何文件；没有改动运行时依赖或锁文件。
- 未修改生产 `.env.local`、线上 Nginx 或线上数据。生产账号/会话密钥需要按 README 配置；配置和线上验收完成前保留现有 Basic Auth。
- HTTP 上的应用登录不会加密传输；HTTPS 就绪后开启 `COOKIE_SECURE=true`。

部署步骤见 [PRIVATE-TEST-DEPLOYMENT.md](PRIVATE-TEST-DEPLOYMENT.md)，后续学习流程待拍板方案见 [LEARNING-FLOW-PROPOSAL.md](LEARNING-FLOW-PROPOSAL.md)。
