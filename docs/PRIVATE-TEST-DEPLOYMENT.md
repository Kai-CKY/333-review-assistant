# 私有试运行部署

这份配置用于当前单实例、无登录鉴权版本的安全试运行。应用仅发布到服务器的 `127.0.0.1:3333`，不能被公网直接访问；从开发电脑通过 SSH 隧道访问。

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

先实现应用级登录与访问控制，再配置 Nginx/Caddy、HTTPS、域名和仅开放 80/443 的云防火墙规则。不要通过放行 3333 端口绕过这一步。
