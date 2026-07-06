# 功能规格:提示词资产(Prompt as Asset)

> 类型:功能规格(设计阶段,待确认后拆分各平台迭代实施)
> 平台:cross-product(Moraya 客户端 pc 先行 → web/mobile 对齐;Picora 侧零改动,复用现有 KB 同步)
> 关联:[[ai-memory-kb-binding]](跨工具记忆中枢)、v0.42.0-pc-memory-activation、v1.6.0 KB sync Git-style merge
> 状态:2026-07-06 设计确认(用户选择"先落设计文档,再实施";P1 捕获机制、存储形态、品牌叙事已逐项确认)

## 1. 背景与痛点

AI 时代,编写自然语言提示词已成为知识工作者的日常工作,但提示词目前是"写完即弃"的一次性输入:

1. **compact 即丢失**:用户在外部 AI 软件(Claude Code、Claude 客户端等)中发送的提示词,对话上下文压缩(compact)后无法找回。
2. **散落无索引**:一个项目开多个 AI 会话时,用户忘记某段需求提示词发到了哪个会话;需求未完整实现、跨会话修 bug 时,不得不在新会话中重写大量环境/背景提示词——既浪费编写时间,又浪费 token。
3. **无存量资产**:用户此前从未系统沉淀过原始提示词,联想、复用、整理都无从谈起。

产品链路已具备(Picora 云端存储 + Moraya 编辑 + 知识库自动同步),缺的是把"提示词"升格为一等公民资产的产品层设计。

## 2. 愿景与品牌叙事

### 2.1 定位:Moraya = 你的个人 AI 资产中枢

与 [[ai-memory-kb-binding]] 的「跨工具记忆中枢」合并为统一大叙事,形成**双资产模型**:

| 资产 | 来源 | 形态 | 规格 |
|---|---|---|---|
| **记忆**(AI 学到的) | Moraya AI / 外部工具记忆目录 | `.`-前缀隐藏命名空间(`.moraya/` `.claude/` …) | [[ai-memory-kb-binding]] |
| **提示词**(你写下的) | 你发给各 AI 工具的原始提示词 | KB 可见目录 `prompts/*.md` | 本规格 |

两类资产都是:**本地可见、Markdown 可编辑、可版本化、可跨设备同步、可迁移**。这与现有产品定位「你的创作、你的密钥、你的 AI,只在你的设备上」一脉相承——提示词资产是"你的创作"在 AI 时代的自然延伸。

### 2.2 差异化价值点(vs 行业现状)

行业调研(2025-2026)显示的空白:Cursor / Claude Code 的 memories 是黑盒且面向代码项目;PromptLayer / LangSmith 是脱离日常编辑器的企业 LLM hub;Obsidian / Notion 有 RAG 但没把提示词当一等公民。**没有产品把"个人发给各 AI 工具的原始提示词"当作可见、可版本化、本地优先的 Markdown 资产来管理。**

Moraya 的四个差异化论点:

1. **会话转录自动回收**:用户发给 Claude Code 的每条提示词本就存在 `~/.claude/projects/*.jsonl` 转录中,自带项目/会话/时间元数据。Moraya 把它们变成可搜索的 Markdown 资产——同时解决痛点 1(compact 找不回:转录里永远有原文)和痛点 2(忘了发到哪个会话:元数据即索引)。
2. **可见的本地 Markdown 文件** vs 竞品黑盒:提示词资产就是文件树里的普通 md 文档,可打开、可编辑、可 git、可导出——"可见性"本身是品牌承诺。
3. **提示词 + 环境上下文绑定**(需求卡片,P2):行业所有工具都是 prompt 与 context 分离,由用户手动组装;Moraya 让需求提示词"记住"它的环境背景,新会话一键展开完整上下文,省重写省 token。
4. **个人 → 云端 → 跨工具的资产流转**:经 Picora KB 同步跨设备,经记忆中枢愿景跨工具。

### 2.3 品牌落点(实施时)

- 设置页:「AI 资产」作为一级概念组织记忆 + 提示词两个入口(替代分散的"长期记忆"单页心智)。
- 侧边栏/文件树:`prompts/` 目录带专属图标与计数徽标,让资产"看得见、在变多"。
- 官网 / README:以「个人 AI 资产中枢」叙事介绍双资产模型。

## 3. 核心模型:提示词 = KB 可见目录下的 Markdown 文档

**设计原则:不引入新对象模型。** 原始提示词直接保存为知识库根目录 `prompts/` 下的普通 Markdown 文档,frontmatter 承载元数据,正文即提示词原文(**不做任何改写**,保持用户原始表达)。

### 3.1 文件形态

路径:`{kbRoot}/prompts/{YYYY-MM-DD}-{slug}.md`(slug 取提示词首行/首句的 kebab 化摘要,冲突时追加序号)

```markdown
---
source: claude-code          # 来源工具标识(claude-code | moraya | manual | …)
project: moraya              # 来源项目(转录目录名反解)
sessionId: a3f2c8…           # 来源会话 ID(转录文件名)
sentAt: 2026-07-05T14:32:00Z # 发送时间(转录消息时间戳)
tags: []                     # 用户/AI 补充的标签(P3)
---

修复 KB 同步冲突时行级合并丢失末行换行的问题,
要求保持 conflictPolicy 语义不变……(提示词原文,逐字保留)
```

### 3.2 与现有体系的关系

- **可见文档,非记忆**:`prompts/` 是 KB 普通内容目录,走文档配额与常规 KB sync;不占 [[ai-memory-kb-binding]] 的 `.`-前缀记忆命名空间与记忆配额(`isMemoryPath` 不命中)。二者互补:记忆是 AI 消费的浓缩事实,提示词是用户创作的原文资产。
- **同步零新协议**:`prompts/*.md` 随现有 KB sync(manifest 比对、sourceHash+updatedAt、三向 merge、conflictPolicy)自动上云 Picora,Picora 侧无需任何改动。
- **frontmatter 解析**:复用 `src/lib/utils/frontmatter.ts`。
- **`~/.claude` 绑定**:与 [[ai-memory-kb-binding]] §2.2 是**同一 opt-in 绑定框架的两种用途**——记忆备份(同步点目录)与提示词提取(解析会话转录)。实施时共享绑定 UI 与授权状态。

## 4. 三支柱交互设计

### 4.1 支柱 A:捕获(Capture)— P1,自动导入外部会话转录

数据飞轮起点:先有存量资产,联想/整理才有素材。

**绑定与授权**
- KB 设置(与 KB sync 绑定入口并列)新增「导入 AI 工具会话提示词」:选择本地工具目录(P1 仅 Claude Code:`~/.claude`)→ 显式 opt-in 确认(读取另一应用的数据,必须用户主动授权,同 [[ai-memory-kb-binding]] §6)。

**转录解析(纯本地)**
- 解析 `~/.claude/projects/{project}/*.jsonl` 会话转录,提取 `role=user` 的消息原文及元数据(project、sessionId、时间戳)。
- **去噪启发式**(阈值见 §7 待定):过滤短确认类消息("好的"/"继续"/"yes")、斜杠命令、工具结果回显;按长度/结构识别"需求级提示词"(多行、含需求动词、≥N 字符)。
- **去重**:同一 sessionId + 消息序号幂等;重复导入不产生重复文件。

**历史回填 + 增量**
- **首次绑定执行历史回溯回填**:解析既有全部转录(用户此前无任何沉淀,存量即价值),非仅监听新会话。
- 之后增量:按转录文件 mtime 检测新增/变化,应用启动或手动"立即导入"时执行。

**导入面板(确认式,非静默)**
- 回填/增量结果先进入预览面板:按项目 → 会话分组列出候选提示词,默认全选,用户可勾选/排除(整个项目可排除)→ 确认后写入 `prompts/*.md`。
- 遵循 AI 文件写入规则:写入的是新文件,不覆盖任何既有文档。

**用户体验目标**:绑定一次,历史提示词全部回收;此后在 Claude Code 里照常工作,提示词自动沉淀——**零习惯改变**。

### 4.2 支柱 B:调用(Recall)— P2,高效输入辅助

- **`@` 联想**:Moraya 编辑器与 AI 聊天输入中,`@` 触发历史提示词联想(复用 `src/lib/services/memory/inject.ts` 的 weight + lastUsedAt 衰减 + 子串匹配排序引擎,作用于 prompts/ 索引);选中即插入原文。
- **Prompt Palette**:命令面板式检索(按 project / tags / 全文),一键复制或插入。
- **需求卡片(Prompt Card)**:一份 md 文档聚合「需求提示词 + 绑定的环境上下文」——frontmatter 声明 context 来源(规则段引用、相关文件列表、项目背景段落,参考 rules-engine 的 glob 注入模型);卡片提供「复制全文」动作,新开外部 AI 会话时一键粘贴完整背景,直接消灭痛点 2 的重写与 token 浪费。
- 使用即计数:插入/复制动作回写 frontmatter 使用元数据(usage-count、last-used),为热力排序供数。

### 4.3 支柱 C:整理(Refine)— P3,AI 辅助资产化

- **AI 整理**:对 prompts/ 存量做去重合并建议(相似提示词聚类)、补充参数化占位符(`{{param}}`,复用 `src/lib/services/ai/templates/engine.ts` 插值引擎)、生成 tags;所有改写需用户确认,原文件保留。
- **升格为模板**:成熟的提示词资产可一键升格为 AITemplate(KB 级 `{kbPath}/templates/*.json`),进入模板画廊参数化复用。
- **使用热力**:常用提示词在 Palette / 联想中上浮,长期未用的自动归档(移入 `prompts/archive/`,可配置)。

## 5. 分阶段实施(设计确认后拆各平台迭代)

| 阶段 | 平台 | 内容 | 依赖 |
|---|---|---|---|
| P1 | pc | Claude Code 转录绑定 + 历史回填 + 增量导入 + 导入预览面板 + `prompts/*.md` 写入与 KB sync 上云 | Rust 侧读 `~/.claude` 路径能力(对齐 [[ai-memory-kb-binding]] P2 的目录绑定实施,`$HOME/.claude/**` 只读 scope) |
| P2 | pc | `@` 联想 + Prompt Palette + 需求卡片 + 使用计数 | P1(有存量资产) |
| P3 | pc | AI 整理(去重/参数化/tags)+ 升格模板 + 热力归档 | P2 |
| P4 | web/mobile | 对齐(web/mobile 无本地 `~/.claude`,仅消费云端 prompts/:检索、联想、卡片) | P1-P2 |

品牌落点(§2.3 设置页/官网/README)随 P1 一并落地。

## 6. 安全与隐私

- **显式 opt-in**:读取 `~/.claude` = 读取另一应用的数据,必须用户主动绑定授权;未绑定不读取、不上传任何外部工具数据(同 [[ai-memory-kb-binding]] §6)。
- **纯本地解析**:转录解析全部在本机完成,候选提示词仅经用户确认后才写入 KB;上云走既有 KB sync 通道,遵循其明文/E2E 决策。
- **敏感内容防线**:导入预览可排除项目/单条;提示词可能含密钥、内部信息——预览面板对疑似凭据模式(`sk-…`、token 形态)给出高亮警示(不自动改写)。
- **路径安全**:Rust 侧读取遵循 `validate_path()` 模式,scope 限定 `$HOME/.claude/**` 只读;不跟随符号链接。
- **注入上限**(P2 联想/卡片注入 AI 上下文时):单次注入设上限(参考行业 25KB / 1000 行模式),防 attention 稀释与 token 失控。

## 7. 待定 / 后续决策

- 支持的外部工具枚举:Claude Code 先行;Cursor / Windsurf / 其他工具的会话数据格式各异,是否纳入 P2+ 及解析适配器如何抽象。
- 去噪阈值:需求级提示词的长度/结构启发式参数,P1 实施时以真实转录样本调优;是否提供"宽松/严格"档位。
- `prompts/` 目录名是否允许用户配置(vs 固定约定优先)。
- 与模板系统的升格关系细节:升格后资产文件与模板 JSON 的关联/回链方式。
- 是否提供 MCP 接口,让外部 AI 工具(Claude Code 等)反查 Moraya 提示词库(资产流转的"最后一公里",可与记忆中枢的 MCP 规划合并考虑)。
- 检索质量:pc 无本地 embedding(现状 weight+子串);提示词资产是否接 KB 在线 embedding(与 [[ai-memory-kb-binding]] §7 同一决策)。

## 8. 涉及(实施时)

- **捕获**:新增 `src/lib/services/prompt-asset/`(转录解析器、去噪/去重、导入编排);Rust 侧 `~/.claude` 只读命令(对齐 [[ai-memory-kb-binding]] 的目录绑定实施);导入预览面板组件。
- **存储/同步**:`src/lib/utils/frontmatter.ts`(元数据读写)、`src/lib/services/kb-sync/`(零改动,prompts/ 随普通文档同步)。
- **调用**:`src/lib/services/memory/inject.ts` 排序引擎复用;AIChatPanel `/` 命令框架扩展;Prompt Palette 组件。
- **整理**:`src/lib/services/ai/templates/`(engine 插值、registry 升格入口)。
- **Picora**:零改动(prompts/ 走普通文档配额与既有同步协议)。
- **i18n**:全部新增 UI 文案覆盖 12 个 locale 文件。
