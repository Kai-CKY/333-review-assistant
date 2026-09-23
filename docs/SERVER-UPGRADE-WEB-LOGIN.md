# 现有云服务器：首次升级到应用登录版

适用目录：`/www/wwwroot/333-review-assistant`。当前只有 CI，没有 CD：推送不会修改云服务器。先等 GitHub Actions 对本次提交的 CI 通过，再手动发布。后续普通发布可简化，本次需要迁移身份及服务器补丁。

## 1. 保留外层鉴权，备份当前状态

在服务器终端执行（按当前部署通常需要 root 或相应 Docker/文件权限）：

```bash
set -e
cd /www/wwwroot/333-review-assistant
umask 077
release_stamp=$(date +%Y%m%d-%H%M%S)
backup_dir="/www/backup/333-review-assistant/$release_stamp"
mkdir -p "$backup_dir"
git rev-parse HEAD > "$backup_dir/old-commit.txt"
git diff --binary HEAD > "$backup_dir/server-changes.patch"
cp -p .env.local "$backup_dir/env.local"
cp -p /www/server/panel/vhost/nginx/39.107.65.232.conf "$backup_dir/nginx.conf"
old_image=$(docker compose images -q app)
test -n "$old_image"
docker tag "$old_image" "333-review-assistant:rollback-$release_stamp"
printf '%s\n' "333-review-assistant:rollback-$release_stamp" > "$backup_dir/old-image.txt"
printf '备份目录：%s\n' "$backup_dir"
```

备份目录含密钥，不上传 Git 或聊天。此时先不关闭 Nginx Basic Auth。

## 2. 归档五处临时补丁，拉取代码

```bash
git status --short
git diff HEAD -- apps/api/src/feishu/bot.js
```

核对确实只有此前说明的五处 DM 开放补丁后执行：

```bash
git stash push -m "server-dm-before-web-login-$release_stamp" -- apps/api/src/feishu/bot.js
git switch main
git pull --ff-only origin main
git log -1 --oneline
```

若还有其他改动，先单独核对，不能用 `reset --hard` 清除。**不要再执行 stash pop**：新代码的 `FEISHU_DM_MODE` 与角色检查已替代这五处修改。`git log` 显示的提交必须与 Actions 已通过的提交一致；如果 main 又更新了，先检查新提交 CI。

若私有仓库拉取提示无权限，需要恢复该仓库的只读 Deploy Key 或服务器 Git 凭据。不要把 PAT 放进 remote URL、文档或聊天记录。

## 3. 配置应用账号和飞书角色

先为你和羊羊分别生成密码哈希，执行两次下列命令；密码输入隐藏，输出只有 scrypt 哈希。服务器不必另装 Node：

```bash
docker run --rm -it -v "$PWD:/work:ro" -w /work node:20-alpine node scripts/hash-web-password.mjs
docker run --rm node:20-alpine node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

第二条生成独立会话密钥。在服务器编辑现有 `.env.local`，只新增或调整以下字段，**不要复制模板覆盖原配置**：

```dotenv
WEB_USERS='admin:<你的scrypt哈希>,yangyang:<羊羊的scrypt哈希>'
WEB_ADMIN_USERS=admin
WEB_SESSION_SECRET=<刚生成的随机会话密钥>
WEB_SESSION_TTL_SECONDS=604800
COOKIE_SECURE=false
TRUST_PROXY=true
FEISHU_DM_MODE=open
FEISHU_LEARNER_OPEN_ID=<羊羊在该应用下的open_id>
FEISHU_OWNER_OPEN_ID=<你在该应用下的open_id>
```

占位符必须换成真实值，`WEB_USERS` 整段保留单引号，避免 `$` 被 Compose 插值。管理员账号只读，羊羊账号可作答自评。`TRUST_PROXY=true` 的前提是现有 Nginx 已覆盖 `X-Real-IP`，后端仍只绑定回环地址。当前 HTTP IP 访问保持 `COOKIE_SECURE=false`。

保留现有飞书 App ID/Secret、Ark 密钥和可用模型 `doubao-seed-2-1-pro-260915`；不要改成该账号未开通的 Turbo。群聊保留 `FEISHU_GROUP_CHAT_ENABLED=true` 和正确的 `FEISHU_TEST_GROUP_ID`，如需启用该功能。

**不知道两个 open_id 时**：这两个新字段暂时留空，勿填占位符；若旧 `FEISHU_TESTER_OPEN_ID` / `FEISHU_GROUP_TARGET_OPEN_ID` 有值，必须先核实属于羊羊，否则清空。先启动新版，两人分别私聊 `/身份` 获取各自 ID，再填写并执行 `docker compose up -d --force-recreate app`。未绑定用户只会收到绑定提示，不会被自动当作羊羊。

## 4. 构建、短暂停服备份数据、启动

```bash
chmod 600 .env.local
docker compose config --quiet
docker compose build app
docker compose stop app
tar -czf "$backup_dir/runtime-data.tar.gz" runtime-data
docker compose up -d app
docker compose ps
docker compose logs --tail=100 app
```

先构建再停服务，减少停机时间。停服后的整目录备份同时保留 JSON 和知识附件。若备份失败，先修复备份；需要恢复旧服务时可用 `docker compose start app` 重新启动原容器。发布不使用 `down -v`，不恢复 Git 中的知识快照覆盖运行库。

等待健康检查变成 `healthy`，检查回环接口：

```bash
curl -i http://127.0.0.1:3333/api/health
curl -i http://127.0.0.1:3333/api/dashboard
```

依次预期 200、401。health 只验证应用存活，不能替代登录及模型验收。

## 5. 验证登录，再撤外层弹窗

通过原公网入口先输入现有 Basic Auth，再进入应用登录；也可使用 SSH 隧道。验证管理员只读、羊羊登录后能查看真实知识、退出后不能读取 API。两人分别在飞书私聊和指定群发送 `/身份`，确认角色与会话类型正确。需要记录一次真实学习测试时，由羊羊完成作答、自评，确认时间线与下次日期持久化。

全部通过后，在宝塔站点配置中移除对应反代块的两行 `auth_basic` / `auth_basic_user_file`。保留 `location ^~ /`、原超时和代理头；不要改端口绑定。

```bash
/www/server/nginx/sbin/nginx -t
/www/server/nginx/sbin/nginx -s reload
```

重新开无痕窗口，确认看到应用登录页，无凭据 `/api/dashboard` 为 401，登录后为 200，退出后旧会话失效。

如果需要回滚到旧版，先恢复外层 Basic Auth 并测试/reload Nginx，再恢复旧镜像和备份配置；数据恢复需要停服务且先另存升级后的数据，避免丢失发布后的学习记录。不要在公网暴露旧版无鉴权 API。

## 以后普通发布

没有服务器补丁或配置迁移时：等目标提交 CI 通过 → 核对并备份 → `git pull --ff-only origin main` → `docker compose up -d --build` → 健康及登录验收。CI 构建的镜像当前仅用于验证，没有发布镜像仓库，也不会触发服务器更新。
