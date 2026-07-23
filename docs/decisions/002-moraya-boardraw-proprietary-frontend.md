# ADR 002:moraya-boardraw 前端闭源,行使版权人对自有 GPL 包的商业授权

> 状态:已决策,已落实(moraya-boardraw 首个 commit 即 UNLICENSED + NOTICE)
> 日期:2026-07-11
> 关联:[[001-moraya-board-gpl-licensing]]、[[teaching-whiteboard]] 规格 §6.1/§8、moraya-boardraw 仓库 LICENSE / NOTICE

## 背景

教学画板产品线采用分层架构:核心包 `@moraya/board`(GPL-3.0-only,ADR 001)+ 前端 `moraya-boardraw`。用户决策:**boardraw 前端代码完全闭源**,核心依赖直接引用 `@moraya/board`。

闭源前端打包分发 GPL 依赖(`@moraya/board` 及其传递依赖 `@moraya/core`)会触发 GPL 传染义务——这正是 ADR 001 明确保留的「版权人双授权后手」所覆盖的场景,本 ADR 记录该后手的首次行使。

## 决策

1. `moraya-boardraw` 仓库为**专有闭源**:`"license": "UNLICENSED"`、`"private": true`、LICENSE 为全权保留声明。
2. 其对 `@moraya/board`、`@moraya/core` 的使用**依据版权人自有商业授权**,不适用 GPL 条款(版权人不受自己所发 GPL 约束;两包目前均无外部贡献者)。
3. 授权依据在 boardraw 仓库 `NOTICE` 中书面声明,同时明确:第三方不得以 boardraw 的分发为由主张对这两个包超出其公开 GPL-3.0-only 条款的任何权利。
4. 产品分层由此定型为 **open-core**:引擎开源(GPL,社区与反克隆)+ 前端闭源(产品体验与商业价值)——与 Excalidraw(MIT 引擎 + excalidraw.com 增值服务)结构同型但 copyleft 更强。

## 前提与约束

- **CLA 硬约束升级**:后手已被行使,`moraya-board` 与 `moraya-core` 接受任何外部代码贡献前,CLA(贡献者授予版权人再授权权利)从「建议项」升级为**强制前置项**——否则外部贡献代码不得进入 boardraw 依赖链。
- boardraw 中的第三方依赖保持宽松 license(katex/fflate/perfect-freehand/Svelte 工具链均 MIT),不引入其他 GPL/专有依赖。
- vendor tarball 桥(`vendor/moraya-board-0.1.0.tgz`,git 跟踪保证可复现)仅是分发机制,不改变授权依据;board 公开发布 npm 后切换为版本区间,授权依据不变。

## 影响

- 引擎侧改进(渲染、格式、md 转换)天然开源回馈;前端交互、产品化、云集成保持专有。
- Chrome MV3 / Moraya 插件形态作为 boardraw 的再包装,继承同一授权依据。
- 若未来出售/转让 board/core 版权或引入共有版权,本授权链需重新评估(记录在案)。
