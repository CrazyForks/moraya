# ADR 003：Boardraw 借力 Excalidraw —— 吸收 MIT 内核能力进 @moraya/board（路线甲）

> 状态：已采纳（2026-07-13）
> 关联：[[001-moraya-board-gpl-licensing]]、[[002-moraya-boardraw-proprietary-frontend]]、[[teaching-whiteboard]]

## 背景

用户提出基于 Excalidraw（MIT，90k+ stars）二次开发 boardraw 以获得成熟画板基础能力。经对本地源码（`excalidraw` monorepo v0.18.0，~150k LOC TS）与 boardraw 现有架构（@moraya/board SVG 同构引擎 ~2.1k LOC + boardraw Svelte 前端 ~5k LOC，138 测试）的全面探查，评估了三条路线。

## 决策

采用**路线甲：吸收内核，保 SVG 架构**——把 Excalidraw **纯 TS 无 React 内核**（`@excalidraw/element`(62.6k)/`math`(4.1k)/`common`(7k)/`utils`(1.5k)，经 grep 验证零 React import）中教学画板所需的成熟逻辑，**按需改编移植**进 `@moraya/board`；渲染保持自研 SVG（编辑=导出同构、公式 foreignObject、AI 识别栅格化管线不变）。

**否决**：
- **全量 fork React 应用（路线丙）**：Moraya 全家 Svelte，双 UI 框架长期成本高；77k LOC React 编辑器壳魔改 + 追 upstream 负担重（与 spec §6.1 原始否决理由一致）。
- **以 Excalidraw 纯 TS 内核置换 @moraya/board 模型层（路线乙）**：需替换全部渲染与 CanvasHost 交互层、公式 foreignObject 机制在 Canvas 上不存在、`.boardraw` 格式需 schema 迁移——推翻既有投入且交互壳仍需 Svelte 重写（React 壳本就不可复用），性价比不成立。当前教学场景（单人、≤10 元素类型）SVG 性能足够。

**关键技术依据**：rough.js（Excalidraw 手绘质感引擎，MIT）原生支持 SVG 模式（Excalidraw 自身 SVG 导出即用 RoughSVG）——手绘美学可进 SVG 渲染器，全量功能对齐在保 SVG 架构下成立。

## License 归属规范（强制）

- Excalidraw 为 MIT（Copyright (c) 2020 Excalidraw），与 @moraya/board 的 GPL-3.0-only 兼容（MIT 代码可并入 GPL 项目）。
- 每个含改编代码的 board 源文件头部**必须**注明：`Portions derived from Excalidraw (https://github.com/excalidraw/excalidraw), MIT License, Copyright (c) 2020 Excalidraw`。
- moraya-board 仓库根维护 `THIRD_PARTY_NOTICES.md`：MIT 许可全文 + 被改编模块滚动清单。
- 移植原则：**改编（adapt）为主**——适配 BoardElement 类型与 update-op 历史模型，按教学场景裁剪；非逐行拷贝。

## 阶段路线图快照（详情见迭代文档）

P1 v0.8.0 绑定箭头/群组/对齐分布/菱形 → P2 v0.9.0 样式系统（roughjs 手绘/填充样式/线型/箭头头型）→ P3 v0.10.0 线性进阶（多点折线/elbow/容器文字）→ P4 v0.11.0 画布体验(网格吸附/缩放控件/右键/剪贴板/锁定/翻转) → P5 v0.12.0 教学增强(激光笔/Frame/PNG 导出/图片裁剪) → P6 远期(AI 识别增强、协作)。

**明确不对齐**：embeddable/iframe/magicframe、mermaid/图表粘贴（Moraya 文档侧已有）、素材库市场、多人协作（spec v3+）。
