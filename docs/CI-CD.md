# CI/CD 策略

## 当前阶段

- CI 已启用：推送到 `main`、Pull Request 和手动触发都会安装锁定依赖、运行测试并构建 Docker 镜像。
- CD 暂不自动化：服务器继续使用 `git pull --ff-only` 和 `docker compose up -d --build` 手动发布。
- CI 不加载 `.env.local`，不接触飞书、模型或服务器密钥，也不会产生真实消息或付费模型调用。

## 为什么暂不自动发布

当前版本仍是单实例 JSON 数据存储，Web API 尚未实现登录鉴权，首次云部署、持久化备份和回滚流程也尚未完成验证。自动 CD 会扩大一次误提交的影响范围。完成首次部署并至少验证一次备份恢复和一次人工升级后，再增加带审批环境的 CD。

## 当前发布门禁

1. 本地 `npm test` 通过。
2. 推送代码并等待 GitHub Actions 的 `CI` 工作流成功。
3. 备份服务器 `runtime-data/review-assistant.json`。
4. 在服务器执行：

   ```bash
   git pull --ff-only
   sudo docker compose up -d --build
   sudo docker compose ps
   sudo docker compose logs --tail=100 app
   ```

5. 通过 SSH 隧道检查首页和 `/api/health`。

## 何时升级为自动 CD

满足以下条件后再自动化：应用已实现登录与访问控制；服务器部署和回滚至少人工成功一次；运行数据有定时备份与恢复演练；GitHub Environment 配置了生产审批；部署凭据仅具备目标服务器所需的最小权限。
