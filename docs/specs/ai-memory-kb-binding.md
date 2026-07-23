# 功能规格:Moraya 客户端 · 点目录记忆对接(消费 Picora 已建能力)

> 类型:功能规格(客户端对接;**服务端与总体架构以 Picora 设计为准,本文档不重复设计、不提服务端需求**)
> 平台:Moraya 客户端 pc/web/mobile(pc 先行)
> **Source of truth(Picora 侧,已评审/已实现)**:
> - `AI-MidasTouch/picora-assets/docs/product/AI记忆点目录架构设计.md`(架构决策,含 §12 两维度 KB 模型)
> - `picora-assets/iterations/v0.70.0-service-ai-memory-hosting.md`(**已实现**:点目录配额单列、sync 限流、目录前缀硬删、单 KB 导出)
> - Picora v0.71.0 commit `456eb74`「OAuth 记忆 KB」(**已实现**:`KbService.ensureMemoryKb` + OAuth 钩子 + owner_id 回填)
> 关联:[[v0.42.0-pc-memory-activation]]、[[v1.5.0-web-memory-cloud-sync]]、[[v0.7.0-core-memory-serialization]]

## 0. 本次重写背景(2026-07-06)

早前本文档独立设计了一套"专属受保护记忆 KB + 服务端需求"。经核对 Picora 侧文档发现:**该体系 Picora 早已完整设计、且服务端大部分已实现**,并且"专属系统记忆 KB(不可删)"这一点 Picora **已明确废止**(改为普通 KB + 下次 OAuth 自动恢复)。故本文档重写为**纯客户端对接规格**:只描述 Moraya 客户端要做什么来消费 Picora 已就绪的能力;服务端需求节整节删除。

## 1. 已就绪的 Picora 能力(客户端只消费,不重复造)

| 能力 | 状态 | 客户端消费点 |
|---|---|---|
| **点目录 = 记忆**:KB 内 `.` 开头目录即工具命名空间(`.moraya/`/`.claude/`/`.cursor/`),`relativePathSchema` 放行隐藏路径,复用 KB Sync v2 | 已就绪 | 记忆文件路径写成 `<命名空间>/…`,走现有 KB sync |
| **点目录配额单列**:`memory_doc_count_limit`(trial 200/pro 2000/pro_plus 10000),`.`-前缀文档不占 `doc_count` | v0.70.0 已实现 | 无需客户端处理;超限 403 QUOTA_EXCEEDED 提示 |
| **目录前缀批量硬删** `DELETE /v1/kbs/:id/tree?prefix=.claude/`(返回 `{deleted,hasMore}`,循环到 false) | v0.70.0 已实现 | "清空某工具云端记忆"直接调 |
| **共享「AI 记忆」KB 自动确保**:`slug='memory'`、名「AI 记忆/AI Memory」、`is_default=0`;`ensureMemoryKb` 三态(created/existing/**restored**),挂 OAuth `exchangeAuthorizationCode`、fail-open;配 `owner_id` 回填 | v0.71.0 已实现 | **客户端不 createKb**;OAuth 后按 `slug='memory'` 从 `GET /v1/kbs` 发现即用。被删也会在下次 OAuth 自动 restored(取代"不可删保护") |

> 结论:**"登录自动建库 + 回填 + 自愈"全在服务端 v0.71.0 做好了**;客户端只做"发现 + 绑定 + 同步"。

## 2. 记忆落点:两维度 KB 模型(对齐 Picora 设计 §12)

- **Tier 1(默认)· 统一共享「AI 记忆」KB**:每用户一个 `slug='memory'` 的共享库,承载所有工具点目录(`.moraya/` `.claude/` `.cursor/`…)。OAuth 后服务端已自动确保存在;客户端发现并把本地全局 `~/.moraya`(及各工具绑定)同步进来。**无需手动选/建库。**
- **Tier 2(进阶)· 专属工具 KB**:用户把某工具记忆拆到独立普通 KB(如「我的Claude」= 顶层手写文档[计 doc_count] + `.claude/` 点目录记忆[计 memory_doc_count])。服务端零新增(就是 `POST /v1/kbs` 建的普通 KB);迁移 = 客户端 sync 到新 KB + 对旧 KB `tree-delete`。
- **路由 = 绑定表 per-group `kbId`**(见 §3):Tier 1 → 指向共享 memory KB;Tier 2 → 指向专属 KB。跨设备一致的服务端路由(`sys_memory_routes`)是 Picora **Phase B**(远期,服务端已 tier-agnostic,不回改)。

## 3. 客户端核心:绑定表 + 工具模板

### 3.1 绑定表(本地配置,不上云,含本机路径)
```jsonc
{
  "kbId": "<目标 KB id;Tier 1=共享 memory KB / Tier 2=专属 KB>",
  "bindings": [
    {
      "tool": "claude",                 // 工具模板 key
      "externalPath": "~/.claude",      // 本机真实目录
      "mountAs": ".claude",             // KB 内命名空间
      "include": ["projects/*/memory/**","CLAUDE.md","agents/**","skills/**"],
      "exclude": ["**/*.jsonl","settings*.json","shell-snapshots/**","todos/**","plans/**"]
    }
  ]
}
```
同步引擎按绑定表扫外部目录 → 路径改写 `mountAs/相对路径` → 走 KB sync。**不用软链接**(Windows symlink 权限 / 云盘实体化 / 监听器不跟随)。

### 3.2 每工具清单模板(安全红线,§4 对齐)
- 模板 = `{默认 root, include globs, exclude globs}`;**exclude 敏感项为硬排除,UI 不可解除**。
- 首发内置:`claude`(include memory/CLAUDE.md/agents/skills;**硬排除** `*.jsonl` 对话转录、`settings*.json` 含 token、`shell-snapshots/todos/plans/statsig`)、`moraya`(内置绑定,全量)。
- 新工具(`cursor` 等)逐个评审加入,每个新模板做一次"敏感内容盘点"。
- `.moraya` **无特例**:Moraya 自身记忆走内置绑定条目,与外部工具同一套机制。

### 3.3 三纪律(不干扰原则)
1. **默认 push-only**:绑定目录只上行备份,云端永不自动写回本地;
2. **恢复必须显式**:新机/点"从云端恢复"才下行,只补本地不存在的文件,同名不同内容一律提示不覆盖;
3. **冲突不落地**:同步冲突服务端保留双版本(KB Sync v2 conflict branch),客户端 UI 呈现差异供人工处理,永不覆写本地。
→ 客户端本质 = "带清单过滤的目录看守 + 单向推送器 + 显式恢复器",无需双向合并引擎。

### 3.4 冲突/合并
- 普通记忆文件(一条一 `.md`)→ per-file LWW + 服务端 conflict branch 兜底。
- **索引类文件**(`MEMORY.md`/`index.json`)→ push 前**行集 union merge**(拉云端→并集去重→推),避免多机追加互相吞行;合并失败退 LWW。

### 3.5 客户端行为
- **挂起策略**:扫 KB 本地根时,`.` 开头且不在绑定表内的目录 → 跳过 + 提示"检测到疑似 AI 记忆目录 `.xxx`,是否绑定?",绝不静默同入。
- **推荐引擎**:按工具约定推荐绑定源(`claude→~/.claude`…),推的是模板不是裸路径。
- **变更监听**:绑定目录用 fsevents/inotify + 防抖批量 push;不可用退化为定时扫描。

## 4. 与 PC v0.42.0 已交付记忆的衔接(改造项)

v0.42.0 已落:PC 本地记忆(plugin-store `memory.json`)+ 设置页 + `/memorize` + 聊天注入 + **手动选账户/KB 的云同步**。本对接需改造:

- **去掉"手动选账户/KB"**:改为 Tier 1 自动发现(`slug='memory'` 共享库),OAuth 后即用。
- **本地记忆落点对齐**:PC 的 `memory.json` 记忆 ↔ 该 KB 的 `.moraya/memories/*.md`(core 序列化已具备);即 Moraya 自身记忆作为绑定表里 `moraya` 内置条目(`mountAs='.moraya'`)。
- **一键清空云端**:从"逐文件 delete"改为 `tree-delete?prefix=.moraya/`(v0.70.0 原语)。

## 5. 分阶段(对齐 Picora 设计 §11「Moraya 迭代 2」+ §12 Phase B)

| 阶段 | 平台 | 内容 | 前置 |
|---|---|---|---|
| P1 | pc | **Tier 1 打通**:OAuth 后按 `slug='memory'` 发现共享「AI 记忆」KB → 把全局 `~/.moraya` 作为 `moraya` 内置绑定同步进去;改造 v0.42.0(去手动选 KB、清空改 tree-delete) | Picora v0.70.0/v0.71.0(已就绪) |
| P2 | pc | **绑定表 + 工具模板(claude 首发)+ 挂起提示 + 推荐引擎 + push-only/显式恢复 + 索引 union merge + fsevents 监听**;绑定 `~/.claude`→`.claude/` | P1 |
| P3 | pc | **Tier 2 专属工具 KB**:把某工具记忆拆到独立 KB(建库 + 绑定 kbId 指向 + 迁移=sync+tree-delete) | P2 |
| P4 | web/mobile | 对齐(web 现同步到"默认 KB",迁到 Tier 1 共享 memory KB + 绑定模型) | P1/P2 |
| —(Picora Phase B) | 服务端 | `sys_memory_routes` 逻辑路由跨设备一致 —— **Picora 侧远期,非本文档范围** | 客户端 Tier 1/2 跑通 |

## 6. 不做 / 边界
- 不做服务端改造、不提服务端需求(已就绪/已决策)。若仍想要"比自动恢复更强的删除保护",那是**改动 Picora 已定方案**,须与 Picora 侧另行讨论,不在本对接内。
- 不做通用记忆中间层(不爬取/不解析私有格式)。
- 跨机项目记忆归并(Claude 项目目录名 = 机器路径 slug,多机并存)= v1 按备份语义,归并留 L3。
- MCP memory server 暴露 / PAM 导入导出 = L3。

## 7. 涉及(实施时)
- 客户端 pc:`src/lib/services/memory/*`(v0.42.0 已建,改造云同步为 Tier 1 发现)、新增绑定表存储 + 工具模板 + 目录看守/推送/恢复引擎 + fsevents 监听;Picora 客户端 `picora-kb-client.ts`(listKbs 按 slug 发现、syncBatch、tree-delete via `DELETE /v1/kbs/:id/tree`)。
- core:`@moraya/core/memory` 序列化已具备;绑定表/工具模板类型可考虑抽 core 供三端共享。
- web/mobile:P4 对齐时各自 `memory/*`。
