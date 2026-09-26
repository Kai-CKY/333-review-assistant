# CI/CD 策略

## 当前阶段

- CI 已启用：推送到 `main`、Pull Request 和手动触发都会安装锁定依赖、运行测试并构建 Docker 镜像。
- CD 暂不自动化：服务器手动发布通过 CI 的准确提交。仅在分支未分叉、工作区干净时使用 `git pull --ff-only`；发生过回滚时先按本次发布操作单核对状态。
- CI 不加载 `.env.local`，不接触飞书、模型或服务器密钥，也不会产生真实消息或付费模型调用。
- PDF 解析已改为离线，默认 CI 不构建 MinerU、不下载 OCR 模型。CI 增加轻量检索回归；生产镜像仅包含学习应用。
- 镜像构建后，在容器里分别使用临时 JSON 和 SQLite 启动应用，验证健康检查、登录、知识接口与 PDF 撤回边界，检查 Alpine 的原生 SQLite 依赖可运行。
- 本次知识库版本的回滚衔接、提交边界与发布步骤见 [知识库 V2 发布操作单](RELEASE-KNOWLEDGE-V2-OFFLINE-PDF.md)。本地等价检查与 GitHub Actions 远端结果分别记录。

## 为什么暂不自动发布

当前版本仍是单实例 JSON 数据存储。Web API 已实现应用登录，但本次登录版本的云端发布、持久化备份恢复和回滚尚需实际验证。自动 CD 会扩大一次误提交的影响范围。完成上述验证后，再增加带审批环境的 CD。

## 当前发布门禁

当前阿里云实例的首次登录/身份迁移请按 [服务器升级操作单](SERVER-UPGRADE-WEB-LOGIN.md) 执行；其中包含现有五处补丁归档、数据备份、Web 账号配置和移除 Basic Auth 的顺序。

1. 本地 `npm test` 通过。
2. 推送代码并等待 GitHub Actions 的 `CI` 工作流成功。
3. 备份服务器 `runtime-data/review-assistant.json`。
4. 确认服务器分支可快进、工作区干净且完成备份后，在服务器执行；回滚过的环境优先采用本次发布操作单中的明确 SHA 流程：

   ```bash
   git pull --ff-only
   sudo docker compose up -d --build
   sudo docker compose ps
   sudo docker compose logs --tail=100 app
   ```

5. 通过 SSH 隧道检查 `/api/health` 为 200、匿名 `/api/dashboard` 为 401；浏览器登录后可见真实知识，登出后重放旧 cookie 返回 401。确认容器为 healthy，再按部署说明撤除 Nginx Basic Auth。

## 何时升级为自动 CD

满足以下条件后再自动化：应用已实现登录与访问控制；服务器部署和回滚至少人工成功一次；运行数据有定时备份与恢复演练；GitHub Environment 配置了生产审批；部署凭据仅具备目标服务器所需的最小权限。
