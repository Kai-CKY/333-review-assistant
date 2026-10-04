# 本地页面样板与数据候选

2026-10-04。此 demo 单独位于 `prototypes/review-console/`，不改动现有应用页面或业务 API，也不部署线上。

## 打开样板

在项目目录运行：

```powershell
node scripts/preview-review-demo.mjs
```

打开 <http://127.0.0.1:3340/>。监听仅限本机，直接读取本机私有数据候选，不连接飞书或模型。退出运行进程即停止访问。

- 学习与复习：3/7/14 天切换，单独列出逾期项，点开知识点查看上传内容、来源、安排原因及时间线。
- Agent 记忆：当前会话、归档历史、长期备注、学习档案、知识资料及回复加载依据；支持关键词和群聊／私聊范围筛选。原始上传图片按北京时间横向排列，最新在左，每次上传显示原记录时间（精确到秒）；打开记录可对照原图编辑转写。只采用明确上传字段，缺失时显示未记录，不用备份或处理时间替代。
- 人员与身份：固定羊羊和管理者，查看账号绑定、称呼及来源；未采集的历史识别信息明确标注。
- 迁移数据核对：10 个手动上传知识点、40 张独立表、已移除的 8 个旧示例、校验结果及本次核对记录导出。

默认展示真实数据副本。“示例体验”是单独的合成数据，不属于迁移数据。当前候选已删除 8 个旧演示知识点。模拟群内上传和自评只改变页面示例；真实上传记录的文字校正则保存到本机候选，并保留版本，刷新后仍在。提醒开关仅为交互样板，不发送提醒。

上传时间线已改为横向，并出现在学习与复习页和知识资料页。打开上传记录可对照原图编辑知识点标题和转写正文；使用“查看这次上传的复习日历”筛选关联内容并预览日期。默认展示 14 天，预测用虚线标识，允许切换新学／遗忘、日期及假设自评，不生成真实完成日志。

## 本机文件

- 原始快照：`.data/local-backups/20261004-review-demo/production-snapshot.tar.gz`
- 原始数据和附件：`.data/local-backups/20261004-review-demo/original/`
- 下载时间、运行版本及哈希清单：`.data/local-backups/20261004-review-demo/manifest.json`
- 当前新版 SQLite 候选：`.data/local-review/20261004-manual-uploads/review-candidate.sqlite`
- 每张表的可读 JSON：`.data/local-review/20261004-manual-uploads/tables/`
- 迁移报告：`.data/local-review/20261004-manual-uploads/migration-report.json`
- SQL 表结构：`.data/local-review/20261004-manual-uploads/schema.sql`

每条导入实体保留不可变的原始内容快照；会话消息、备注、知识点、状态、处理任务和版本分别成行。快照是迁移证据，未来业务查询应使用独立字段及仓储接口。未实现的历史事件表为空。候选还没有接入生产应用，不能仅修改 `DATA_FILE` 就部署。

## 重新生成

每次使用新的输出目录，脚本不会覆盖既有备份或候选。

```powershell
python scripts/pull-review-snapshot.py --output .data/local-backups/NEW-SNAPSHOT
python scripts/prepare-review-data.py --backup .data/local-backups/NEW-SNAPSHOT --output .data/local-review/NEW-CANDIDATE
python scripts/edit-review-transcription.py seed --candidate .data/local-review/NEW-CANDIDATE
$env:REVIEW_DEMO_DATA = '.data/local-review/NEW-CANDIDATE'
node scripts/preview-review-demo.mjs
```

下载脚本只读 SSH，逐文件捕获并检查读取期间没有变化，同时记录当前生产绑定。只导出运行数据和必要绑定，不读取 `.env`、密码或 API Key。原始备份包含完整聊天和学习内容，保存在已被 Git 忽略的 `.data/` 内。线上切换前需要按最终停写快照重做转换，保全此次下载之后的新消息和记录。

## 当前待查看的事实

原库 18 个知识点中，8 个已由管理者确认是演示并从当前候选移除，保留 10 个手动上传的知识点及遗忘待复习状态。4 次图片上传共保留 50 条转写（10 条已入库，另一次有 40 条草稿，另两次无完整转写）；校正草稿不自动新增学习任务。67 条会话事件、3 个会话及 7 份附件／原文文件仍保留。

页面样板及候选经管理者确认后，再实现服务端仓储、实际提醒和上线迁移。产品及权限决定见 [PROJECT-RULES-2026-10-04.md](PROJECT-RULES-2026-10-04.md)。

## 本轮验证

- 移除示例后的 142 个迁移实体内容往返核验通过，添加 2 张转写及修订表后共 40 张表，外键与 SQLite 完整性检查通过；7 份附件／原文文件哈希匹配。
- 本轮浏览器 20 项检查通过，包含三种宽度的四页布局、转写弹窗、真实数据原样保存、上传与日历关联、算法日期预测、示例校正及数据隔离，并检查了页面截图。
- 独立候选副本验证文字校正持久化、重开及重新导出后的保留、最初版本保留、旧版本冲突拒绝、空转写手动补充，以及知识点文字同步、复习状态和日志不变。
- 浏览器演示之后再次校验，原始快照的 10 个文件哈希不变；实际待核对候选仍是 10 个知识点、4 次上传、50 条转写，未写入验收校正。真实线上应用、飞书连接和数据未改动。
