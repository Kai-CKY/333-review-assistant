# 在线启用 MinerU PDF 解析

此功能使用独立容器中的 MinerU 3.4.5 `pipeline` CPU 后端，不调用豆包 PDF API。保留原 PDF、解析 JSON、页码和归一化坐标。PaddleOCR 问题页自动回退尚未接入；无法读取的图片/表格区域会提示核对。

目前每文件最多 10 MB、30 页，单实例串行解析，最多排队 3 份；超时 20 分钟。中文 OCR 与表格识别开启，独立公式识别关闭。建议先用 2 页小样本验收，再导入教材分卷。首次下载模型需要时间、网络和磁盘空间。生产配置限制解析容器最多使用 8 GB 内存、2 个 CPU；宿主机还需要为 Web、系统及其他服务留空间。部署前检查 `free -h`、`df -h`、`nproc`，不要在资源不足时直接启用。

## 部署

在服务器已有项目目录操作。确认此次提交的 CI 通过。若 `git status` 有本地改动，先核对保存，不要使用强制覆盖命令。

```bash
cd /www/wwwroot/333-review-assistant
git status --short
git pull --ff-only origin main
free -h
df -h .
nproc
```

编辑已有 `.env.local`，保留原有账号、飞书及模型配置，只添加/更新：

```dotenv
PDF_PARSER_URL=http://pdf-parser:8010
MINERU_MODEL_SOURCE=modelscope
```

主群共享还需要现有 `FEISHU_APP_ID`、`FEISHU_TEST_GROUP_ID`。群聊接收 PDF 需要 `FEISHU_GROUP_CHAT_ENABLED=true` 以及已绑定学习者；沿用现有消息资源下载权限。

Nginx 对代理此应用的 `server` 或 `location` 配置增加：

```nginx
client_max_body_size 15m;
```

上传使用 JSON/Base64，需要大于原文件的请求空间。使用面板的配置检查和重载，或 `nginx -t && nginx -s reload`。解析在后台执行，无需把代理超时延长到 20 分钟。

先构建解析器和应用，验证真实引擎，成功后再备份并切换应用：

```bash
docker compose --profile pdf config --quiet
docker compose --profile pdf build app pdf-parser
docker compose --profile pdf up -d pdf-parser
docker compose exec pdf-parser python smoke.py
```

真实测试会生成两页无个人信息 PDF，验证文字页与扫描页中不同的数字校验码。必须看到 `textPage: true` 和 `scanPage: true`；模型下载/内存/字体失败时先排查，不将健康接口可用视为解析成功。

```bash
set -e
umask 077
backup_dir="/www/backup/333-review-assistant/pdf-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup_dir"
cp -p .env.local "$backup_dir/env.local"
docker compose stop app
tar -czf "$backup_dir/runtime-data.tar.gz" runtime-data
docker compose --profile pdf up -d app
docker compose --profile pdf ps
docker compose --profile pdf logs --tail=50 app pdf-parser
```

若备份失败，先 `docker compose start app` 恢复旧容器，再排查。不要删除数据卷，不要用知识快照恢复覆盖运行数据库。此次代码发布不会把本机 Excel 快照自动合并到线上。

## 使用与验收

- **网页**：以学习者账号登录，页面底部“导入 PDF 资料”上传；状态依次为排队、解析、待核对。展开每页对照原 PDF，点击“已核对，按待核验资料入库”。管理员仍保持只读权限。
- **飞书配置群**：学习者或管理员发送 PDF 附件；收到编号后发送 `查看PDF KP-xxxxxxxx`。全文送达且核对后，由学习者发送 `确认PDF KP-xxxxxxxx`。私聊仍仅支持文字，不接收文件。
- 主群资料确认后出现在网页知识索引与 Agent 检索；独立话题仍受原有范围隔离规则约束。
- 保存保留 `unresolved`，不把 OCR 结果当作核验通过的标准答案。沿用既有入库规则，上传日进入待复习列表。
- 重复上传同一文件到同一范围复用任务；失败任务允许重新上传。进程重启将未完成任务标为失败，不自动重跑。
- 原件、解析内容、确认记录写入现有 `runtime-data`；知识快照会携带已确认资料的原件和解析 JSON。定期备份整个运行目录才能保留未确认任务。
- `/health` 只确认服务可访问，不代表模型已下载或解析质量已达标。模型缓存保存在 `mineru-models` 卷，保留它可避免每次重新下载。

## 回滚功能开关

将 `.env.local` 中 `PDF_PARSER_URL` 清空，执行 `docker compose up -d --force-recreate app`，再 `docker compose --profile pdf stop pdf-parser`。已入库资料继续可读；原件、学习记录和模型缓存均保留。
