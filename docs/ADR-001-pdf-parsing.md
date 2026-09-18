# ADR-001：权威 PDF 的本地解析方案

**状态**：已采纳  
**日期**：2026-08-26

## 决策

使用 **MinerU 3.x 本地 `pipeline` 后端**作为首选解析器；通过 `DocumentParser` 接口封装，并以 **PaddleOCR 的 PP-StructureV3 / PaddleOCR-VL** 作为问题页回退方案。

## 背景

本系统的题目、标准答案和主观题批改必须基于用户提供的 333 PDF。系统在本机部署，要求支持中文、扫描件、教材目录/页眉页脚、多栏版式、表格与原文页码引用。

## 选择理由

MinerU 支持本地 PDF 输入、Markdown/JSON 输出、中文 OCR、阅读顺序、页眉页脚清除、扫描件和复杂版式，且 `pipeline` 可在 CPU 上运行。它最适合先将个人的中文教材和笔记转换为可检索、可引用的知识来源。

PaddleOCR 是中文 OCR 的稳健回退：其 PP-StructureV3 提供细粒度结构与坐标，PaddleOCR-VL 适合版面复杂或 OCR 置信度低的页面。

Docling 和 Marker 不作为首选：它们都是优秀且宽格式的通用解析器，但对本项目“中文考研资料、本机、可回退 OCR”的组合没有明显优势。它们保留为后续对照评测对象。

## 统一输出契约

无论具体引擎，解析后都转换为以下内部格式：

```text
ParsedDocument
  documentId, sourceSha256, parserName, parserVersion
  pages[]
    pageNumber, blocks[]
      blockId, type, markdown, plainText, bbox, confidence
```

其中 `blockId + pageNumber + bbox` 是题目、答案与反馈的引用锚点。原始 PDF 永不被覆盖。

## 导入与审核流程

1. 上传/选择本地 PDF，计算 SHA-256，去重后保存原件。
2. Worker 使用 MinerU 解析并生成 Markdown、JSON、页面预览和块级引用。
3. 系统抽取标题和候选知识点，但初始状态均为 `draft`。
4. 用户审核关键页、知识点、关键词和参考答案，确认后标记 `approved`。
5. 仅已审核内容进入 RAG 检索和 AI 批改。
6. 对低置信度或人工标记错误的页面，用 PaddleOCR 回退重解析；保留两个版本供比较。

## 首批质量门槛

选择至少 5 份样本 PDF（数字文本教材、扫描笔记、多栏内容、表格/图片页、真题）。对每类抽查页面：

- 标题层级与阅读顺序可人工读通。
- 关键段落无明显漏字、乱码或页眉页脚重复。
- 每个知识点都可回跳原始 PDF 页码。
- 表格、图示无法可靠还原时，必须标记为需人工处理，不得静默成为评分依据。

若首选引擎未通过某一页面的检查，只回退该页，不影响其他已经审核的资料。

## 许可证与部署说明

MinerU 的仓库许可证是在 Apache 2.0 基础上附加条件；个人、本机、非分发使用符合当前项目边界，但未来对外发布前必须复核。PaddleOCR 采用 Apache-2.0；Docling 采用 MIT。
