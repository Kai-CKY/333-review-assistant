# 更新线上 Agent 与网站的知识数据

## 本次数据与根因

9月18日快照已经包含`photoKnowledge.documents.KP-b8762b08`中的10条生物学整理稿。其`knowledgePoints`投影当时仍是8个演示条目，不能据此断言快照没有入库资料。本次重新导出快照，投影包含10条真实入库知识，8条演示保留但隐藏。原图、OCR、版本和待核验状态均保留。

服务器若已升级为支持`syncSavedKnowledge`的版本，仍只显示演示条目，则还需检查实际`DATA_FILE`、运行库是否含该文档，以及允许的知识范围配置。仅刷新浏览器不会把开发机的数据库传到服务器。

本次不重新恢复或清空线上数据库。使用新增的`merge`工具：默认只预览；只增加缺少的已存知识文档和附件；保留线上现有聊天、学习历史、笔记和当前会话。相同文档不重复导入，线上新版本保留，同版本不同内容或来源范围不允许共享时报告冲突、拒绝写入。知识投影刷新后，由现有Web和Agent共用。

## 给服务器维护 Agent 的操作单

用户已授权更新线上Agent和网站知识数据。项目目录按现有部署记录为`/www/wwwroot/333-review-assistant`，服务为Docker Compose的`app`，持久数据在`runtime-data/`。必须先核对实际配置；不要把示例路径当作无需核对的事实。不得输出`.env.local`中的密钥、密码或完整聊天数据。

1. 记录当前提交、容器镜像和`git status --short`，保留服务器自有代码改动。工作区有改动时先审查和归档，禁止`reset --hard`或直接覆盖。按此前升级操作单处理旧的bot临时补丁，不自动重新套用。
2. 拉取此次Git更新，并构建新镜像；保留服务器的应用身份、登录配置与已开通模型，不复制开发机`.env.local`：

```bash
cd /www/wwwroot/333-review-assistant
git pull --ff-only
docker compose build app
```

如果开发机尚未成功推送GitHub，可由用户把提供的`333agent-knowledge-update.bundle`传到服务器仓库外（例如`/tmp/333agent-knowledge-update.bundle`），在审查并保留本地改动后，用以下命令替代`git pull`，再构建镜像。Bundle包含完整Git提交及知识快照，不包含被忽略的密钥和运行数据库：

```bash
git bundle verify /tmp/333agent-knowledge-update.bundle
git fetch /tmp/333agent-knowledge-update.bundle main
git merge --ff-only FETCH_HEAD
docker compose build app
```

如不能快进，先审查服务器独有提交并处理冲突，禁止强制重置。核对更新后的`git rev-parse HEAD`与用户提供的提交号一致。

3. 在确认`DATA_FILE=/data/review-assistant.json`和`runtime-data:/data`映射后，用新镜像预览合并。下列额外挂载只读提供脚本和快照；不需要把它们烘焙进镜像：

```bash
docker compose run --rm --no-deps \
  -v "$PWD/scripts:/app/scripts:ro" \
  -v "$PWD/.data/knowledge-export:/app/.data/knowledge-export:ro" \
  app node scripts/knowledge-snapshot.mjs merge --database /data/review-assistant.json
```

预览应包含`visibleSavedPoints`至少10，`conflicts`为空；`added`或`unchanged`中有`KP-b8762b08`。若线上已有更新版，则应见`retainedNewer`，以线上版为准，不能强制覆盖。若出现`not_visible_under_server_scope_policy`，核对源scope与服务器配置的应用/主群/羊羊身份；需要显式共享其他已授权范围时配置`KNOWLEDGE_SCOPE_KEYS`，不可简单开放全部群或私聊。不要重绑其他群的草稿来凑数量。

4. 确认没有正在处理的模型或图片任务后，在维护窗口停服务，备份整个`runtime-data`（包括数据库和附件）到仓库外，再应用。不要只备份Git快照。合并工具还会额外保留一份修改前的数据库备份：

```bash
docker compose stop app
# 在此先完成现有备份方案，并核实备份可读。
docker compose run --rm --no-deps \
  -v "$PWD/scripts:/app/scripts:ro" \
  -v "$PWD/.data/knowledge-export:/app/.data/knowledge-export:ro" \
  app node scripts/knowledge-snapshot.mjs merge \
  --database /data/review-assistant.json --apply --server-stopped
docker compose up -d app
docker compose ps
```

应用返回`applied:true`才算成功，记录返回的备份路径。冲突退出码2，不能当成功。工具不会删除原有数据、自动调整配置或推送消息。迁入草稿放在归档会话，不冒充新群消息，也不使旧确认失效问题被绕过。

5. 登录网站验证`/api/knowledge-points`：应看到生物学资料10条（或线上已有更新后的更多条目），不再只见8个演示；`sourceKind=saved_knowledge`，`sourceDocumentId=KP-b8762b08`，待核验标记仍在。检查知识索引、回忆入口及历史复习日期，确认已有学习记录和会话未被清空。健康200仅证明进程存活，不能替代此项。
6. 检查Agent读取同一持久库及配置范围。用户已授权更新其Agent，可在约定测试环境验证知识查询；不要替羊羊提交答案、自评或新的确认记录。记录Agent引用的文档及条目，不把测试作为学习行为保存。
7. 回报实际服务器提交号、合并结果、网站条目数、Agent读取结果、备份位置及任何未完成项。没有登录态或无法取得Agent结果时明确说明，不用健康检查代替成功结论。

## 实测范围

本地67项测试通过，包含合并预览不写入、历史保留、重复导入、冲突和范围阻断，以及登录后的Web API读取入库知识。另用本次真实快照在隔离数据库完成合并：4份附件完整迁入，登录后的Web API返回10条生物学知识，全部保留`unresolved`，原有历史保留，开发机运行库未修改。线上健康检查返回200，但目前没有服务器连接或网站登录态，尚未完成线上数据合并与验收。
