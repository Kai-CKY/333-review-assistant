# 私有试运行部署

这份配置用于单实例、带应用登录的试运行。应用仍仅发布到服务器的 `127.0.0.1:3333`；外部访问使用 Nginx 反代或 SSH 隧道，不开放 3333 公网端口。

## 首次部署

1. 在 GitHub 仓库设置中为服务器添加只读 Deploy Key，并在服务器用该密钥克隆仓库：

   ```bash
   git clone git@github-333:Kai-CKY/333-review-assistant.git /opt/333-review-assistant
   cd /opt/333-review-assistant
   ```

2. 将环境变量模板复制为仅留在服务器上的配置文件，并填写实际密钥。不要提交该文件：

   ```bash
   cp .env.example .env.local
   chmod 600 .env.local
   ```

   按 README 生成密码哈希和独立会话密钥，配置 `WEB_USERS`、`WEB_SESSION_SECRET`。两个 Web 账号共享同一份学习数据。`WEB_USERS` 值使用单引号保留 `$`；不得配置明文密码。尚未配置时业务接口返回 401，登录返回 503，健康检查仍可通过。

3. 安装 Docker Engine 与 Docker Compose plugin 后启动：

   ```bash
   docker compose up -d --build
   docker compose ps
   docker compose logs --tail=100 app
   ```

4. 在自己的电脑上建立 SSH 隧道，然后访问 `http://127.0.0.1:3333`：

   ```powershell
   ssh -N -L 3333:127.0.0.1:3333 admin@你的服务器公网IP
   ```

## 更新

在服务器项目目录执行：

```bash
git pull --ff-only
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 app
```

`runtime-data/` 是运行数据卷，不会被 `git pull` 覆盖。更新前后都应备份 `runtime-data/review-assistant.json`；先在本机运行测试并推送成功，再在服务器拉取更新。

## 公开上线前

应用登录已实现；仍需配置 HTTPS、域名和仅开放必要端口的云防火墙规则。当前 HTTP IP 试运行保持 `COOKIE_SECURE=false`，有 HTTPS 后设为 `true` 并重建容器。应用登录不解决 HTTP 明文传输问题。

## 从 Nginx Basic Auth 迁移

先备份运行数据库、附件、Nginx 配置，并保存服务器 `apps/api/src/feishu/bot.js` 的本地补丁。后续身份需求已扩展本次范围：bot.js 的五处临时开放补丁由可配置准入及角色判断替代，同时更新群聊身份逻辑。拉取前必须检查并归档这些补丁，不能直接覆盖或再次套用旧的“所有人都是羊羊”处理入口。不要覆盖服务器 `.env.local` 或已有运行数据库。

当前服务器路径是 `/www/wwwroot/333-review-assistant`，部署基线据服务器报告为 `c6801a1`。先用 `git diff -- apps/api/src/feishu/bot.js` 核对是否只有已知五处，再保存补丁到仓库外。可对该文件执行 `git stash push -m server-dm-patch -- apps/api/src/feishu/bot.js` 后拉取；**不要自动 stash pop**，新配置已取代这些改动。若还有其他改动，单独审查保留。运行库升级会补建遗忘事件，回滚时须一起考虑升级前的数据备份。

保留服务器已启用的 Ark 模型 `doubao-seed-2-1-pro-260915`，不要用模板覆盖。若遇到 `404 ModelNotOpen`，检查该账号实际开通的模型或推理接入点，不能仅看模型名称是否存在。

配置 `FEISHU_DM_MODE=open` 可保留当前私聊开放体验，但必须补齐 `FEISHU_LEARNER_OPEN_ID` 和 `FEISHU_OWNER_OPEN_ID` 才能识别角色。两位用户分别私聊发送 `/身份` 获取本应用的 open_id，再由服务器管理员绑定；未绑定期间不会放行学习数据。`FEISHU_TESTER_OPEN_ID` 为空不会再导致公开接待模式无法启动。Web 两账号配置 `WEB_ADMIN_USERS=你的管理员账号名`。这些均写入服务器 `.env.local`，不进 Git。

1. 保留 Basic Auth，配置上述应用账号并执行 `docker compose up -d --build`。
2. 通过 SSH 隧道登录应用，验证下列 curl 检查和浏览器登出。`docker compose ps` 应显示 `healthy`；这仅代表进程存活，不代表模型或飞书已健康。
3. 配置反代（保留服务器现有域名、证书及其他设置），确认 Nginx **覆盖**客户端传入的 `X-Real-IP`，随后设 `TRUST_PROXY=true`：

   ```nginx
   location ^~ / {
       proxy_pass http://127.0.0.1:3333;
       proxy_set_header Host $http_host;
       proxy_set_header X-Real-IP $remote_addr;
       proxy_set_header X-Forwarded-Proto $scheme;
   }
   ```

   宝塔现有模板可能有匹配 JS/CSS 的正则 location 遮蔽普通 `/`；当前部署需保留 `^~ /`。沿用现有较长的读取超时，适配 Ark 调用耗时。端口绑定必须仍为 `127.0.0.1:3333:3333`。

   应用默认不信任代理头，避免伪造 IP 绕过限速；未配置代理信任时，经 Nginx 的访问可能共用一个限速桶。不得在允许客户端直连后端的环境中盲目开启 `TRUST_PROXY`。
4. 完成认证验证后再撤除 Nginx 中对应位置的 `auth_basic` / `auth_basic_user_file`，运行 `nginx -t` 后 reload。另开无痕窗口验证看到应用登录页、未登录 API 为 401、登录后为 200。
5. 回滚应用到无鉴权旧版前，必须恢复外层 Basic Auth 或关闭公网反代。所有进程重启都会使原应用会话失效，需要重新登录。

## 本机或隧道 curl 验收（PowerShell）

```powershell
curl.exe -i http://127.0.0.1:3333/api/health
curl.exe -i http://127.0.0.1:3333/api/dashboard
# 分别预期 200、401。凭据在本机交互输入，不写入 shell 命令历史：
$loginUser = Read-Host '账号'
$loginPassword = Read-Host '密码' -AsSecureString
$loginCredential = [System.Net.NetworkCredential]::new('', $loginPassword)
$loginBody = @{ username=$loginUser; password=$loginCredential.Password } | ConvertTo-Json -Compress
$cookieFile = Join-Path $env:TEMP '333-login-cookie.txt'
$loginBody | curl.exe -sS -c $cookieFile -H 'Content-Type: application/json' --data-binary '@-' http://127.0.0.1:3333/api/login
curl.exe -i -b $cookieFile http://127.0.0.1:3333/api/dashboard
curl.exe -i -b $cookieFile -H 'Content-Type: application/json' --data '{}' http://127.0.0.1:3333/api/logout
curl.exe -i -b $cookieFile http://127.0.0.1:3333/api/dashboard
# 登录后 200，登出后重放旧 cookie 为 401。
Remove-Item -LiteralPath $cookieFile
$loginBody=$null; $loginCredential=$null; $loginPassword=$null
```

限速可在独立测试窗口内输入错误密码 5 次，第 6 次应返回 429，并包含 `Retry-After`。不要在羊羊使用过程中对生产共享 IP 运行此测试。
