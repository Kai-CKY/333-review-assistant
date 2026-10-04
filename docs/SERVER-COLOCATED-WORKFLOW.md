# 同一台服务器上的开发、测试和正式发布

这份流程允许通过 SSH 在同一台服务器开发，但**测试实例与正式实例分开**。正式目录是 `/www/wwwroot/333-review-assistant`，测试目录是 `/www/wwwroot/333-review-assistant-staging`（分支 `codex/server-staging`）。两者分别使用 `.env.local` / `.env.staging.local`、`runtime-data/` / `staging-runtime-data/`、回环端口 3333 / 3334。测试群 ID 是 `oc_7db22a9c09c82f077f554dc4601db9cf`。若复用正式飞书应用，测试与正式机器人应分时运行；不能让两个实例同时连接同一应用。

当前服务器只有 896 MiB 内存，且未安装宿主机 Node/npm。2026-10-01 在服务器上执行 `docker build` 编译 `better-sqlite3` 时，正式容器被 OOM 终止，随后已用原镜像及原数据目录重建并恢复健康。测试 Compose 因此复用已构建的正式镜像，仅把测试工作树的 `apps/api` 与 `apps/web` 以只读方式挂载进去；`package-lock.json` 改变后不得继续复用旧镜像，应在 CI 或内存充足的构建机生成新镜像。正式发布也不能在这台服务器上直接执行 `docker compose up --build`。

本机登录服务器时使用本项目的专用私钥和已核对的主机指纹：

```powershell
ssh -i .data/ssh/id_ed25519_codex_333 -o IdentitiesOnly=yes -o UserKnownHostsFile=.data/ssh-known-hosts root@39.107.65.232
```

测试网页仅供 SSH 隧道访问：另开一个本机终端运行 `ssh -N -L 3334:127.0.0.1:3334 -i .data/ssh/id_ed25519_codex_333 -o IdentitiesOnly=yes -o UserKnownHostsFile=.data/ssh-known-hosts root@39.107.65.232`，再打开 `http://127.0.0.1:3334`。测试账号名是 `staging-admin`；随机生成的密码只保存在本机 Git 忽略的 `.data/staging-login.txt`。

## 首次准备

1. 只读记录正式工作树提交、未提交改动、容器和镜像 ID、数据卷及备份状态。先处理服务器已有的本地补丁，不覆盖它们。
2. 测试工作树已经建好；在该分支上开发，不在正在服务用户的正式工作树直接改文件。服务器已生成独立的 GitHub SSH 公钥 `/root/.ssh/id_ed25519_333_review_github.pub`；仓库所有者需将其加入该仓库的 Deploy Keys 并允许写入，之后才能从服务器推送功能分支。不要把私人访问令牌写进远程 URL。
3. 测试 `.env.staging.local` 已建立独立 Web 账号与会话密钥，复用了正式飞书应用及方舟服务的凭据，但 `FEISHU_ENABLED=false`、`FEISHU_DM_MODE=disabled`，正式机器人仍在运行。`compose.staging.yaml` 把数据固定在测试工作树的 `staging-runtime-data/`，绑定 `127.0.0.1:3334`，不挂载正式数据卷。
4. 正式实例继续运行时，只测试测试实例的 Web/API。群测开始前，先与使用者确认正式机器人可以暂时停服，运行 `scripts/server-switch-feishu-group-test.py prepare` 备份正式环境文件，并把正式实例的飞书连接关闭、测试实例的群聊连接打开。依次用 `docker compose up -d --no-build --force-recreate app` 重建正式 Web 实例和测试实例；正式 Web 仍可用，仅在重建时短暂中断。测试环境保留 `FEISHU_DM_MODE=disabled` 和上述测试群 ID，私聊不会进测试数据。群测期间正式群和正式私聊暂时不可用；测试群消息仅写入测试数据目录。
5. 在测试工作树执行 `docker compose -f compose.staging.yaml config --quiet`，用 `cmp` 核对依赖锁文件与正式目录相同，然后启动：

   ```bash
   cmp package-lock.json /www/wwwroot/333-review-assistant/package-lock.json
   APP_REVISION="$(git rev-parse HEAD)" docker compose -f compose.staging.yaml up -d --no-build
   docker compose -f compose.staging.yaml ps
   ```

   若工作树还有未提交改动，`APP_REVISION` 只能表示基线提交，不能代表全部测试代码；先提交再做发布候选验证。测试实例的网页经 SSH 隧道连接到服务器 `127.0.0.1:3334`，不开放公网端口。

## 每次功能改进

1. SSH 进入测试工作树，在功能分支修改；本机或 GitHub CI 运行 `npm test` 与检索回归，服务器依赖不变时使用只读代码挂载运行测试实例。把改动提交并推到 GitHub 功能分支，等待该提交的 CI 通过。GitHub 保存提交历史及 CI 结果，服务器不成为唯一代码副本。
2. 在飞书测试群验证群聊文本、图片、称呼、上下文、联网核验及错误恢复等群内功能。测试群只隔离群消息入口；本项目的答题、四档自评和学习记录仍走绑定账号私聊或 Web，这些流程要在**测试实例**的私聊/Web 和独立数据上另行验收。群测不可写入正式学习库。
3. 测试通过后把同一提交合并至 `main`，核对 CI；正式目录先备份运行数据并确认工作树状态，再按明确提交快进更新。部署只重建正式实例，不复制测试 `.env.staging.local` 或 `staging-runtime-data/`。
4. 正式部署时写入 `APP_REVISION`，核对管理员 `GET /api/runtime` 返回的构建提交、容器状态与健康检查，再完成正式 Web/私聊/群聊的低影响冒烟验证。只在这一步让正式应用处理真实群。若失败，按备份与回滚方案恢复，不能把 Git 回退等同于数据回退。

## 群测结束后恢复正式机器人

当前群测的正式环境原件保存在 `/root/.333-review-ops/production-env-before-group-test-20261001`，权限为 600。先关闭测试飞书连接，再恢复正式飞书连接，避免同一应用同时建立两个长连接：

```bash
python3 /root/.333-review-ops/switch-feishu-group-test.py restore
cd /www/wwwroot/333-review-assistant-staging
APP_REVISION="$(git rev-parse HEAD)" docker compose -f compose.staging.yaml up -d --no-build --force-recreate app
cd /www/wwwroot/333-review-assistant
docker compose up -d --no-build --force-recreate app
docker compose ps
curl -fsS http://127.0.0.1:3333/api/health
```

确认正式容器日志中飞书长连接已建立、测试容器健康且 `FEISHU_ENABLED=false` 后，才算恢复完成。恢复原正式配置不等于发布本次功能分支；功能代码须另按 CI 与镜像交付流程发布。

## 边界

同一台主机仍共享 CPU、内存、磁盘和网络；测试模型请求也可能产生费用。测试实例设置资源上限和独立告警后再进行较大规模试验。测试群不覆盖网页登录、数据库迁移、定时备份、重启恢复和正式应用权限，这些项目仍需各自验证。生产发布目前由人工确认，后续可把同一套确定提交、备份、部署和验收命令接入 GitHub Actions 的受控部署任务。
