# ADR 001:moraya-board 采用 GPL-3.0-only(与 @moraya/core 同 license)

> 状态:已决策,已落实(moraya-board 首个 commit 即 GPL-3.0-only)
> 日期:2026-07-11
> 关联:[[teaching-whiteboard]] 规格 §8、moraya-board 仓库 LICENSE / package.json

## 背景

教学画板产品线 `moraya-board`(核心包 `@moraya/board`,见 [teaching-whiteboard 规格](../specs/teaching-whiteboard.md))最初定位为闭源独立价值体系。但其核心依赖 `@moraya/core` 为 **GPL-3.0-only**:闭源产品分发时链接/打包 GPL 代码会触发传染义务(web 产品向浏览器分发 JS bundle 同样构成分发),需要版权人双授权 + CLA 前置项才能合规,构成动工阻塞。

评估中重新权衡后,用户决策:board 与 core 保持相同的 GPL-3.0-only。

## 决策

`moraya-board` 仓库与 `@moraya/board` 包采用 **GPL-3.0-only**,与 `@moraya/core` 完全一致。

理由:

1. **合规摩擦归零**:同 license 直接依赖 core,无传染冲突;原「core 双授权声明 + CLA」前置项不再阻塞动工。
2. **知识产权保护并未削弱,形式更强**:copyleft 传染性使竞品无法将画板引擎闭源套壳——这正是 core 仓库既有的反克隆取向;闭源只防「看」,GPL 防「占」。
3. **版权人后手完整保留**:唯一版权人可在未来任何时候对商业版/闭源衍生另行双授权;商业价值放服务层(Picora 云托管、单文件分享链接,open-core 模式)。
4. **赛道现实**:开源是白板赛道的入场券(Excalidraw 护城河 = MIT + 90k stars 社区;tldraw 转 source-available 后口碑受损),闭源新画板难获初始信任,且产品短期本不收费。

## 前提与落实项

- **CLA 前置于外部贡献**:双授权后手成立要求版权归属单一。moraya-board 接受首个外部 PR 前,须在 CONTRIBUTING.md 落实 CLA(贡献即授予版权人再授权权利)——与 core 仓库同规则,当前无外部贡献者,不阻塞。
- 已落实:仓库 LICENSE(GPL-3.0 全文)、package.json `"license": "GPL-3.0-only"`、全部源文件 SPDX 头(`GPL-3.0-only`,与 core 一致)。
- 预发布期 `"private": true` 仅防误发 npm(pnpm pack vendor tarball 不受影响),首个公开发布时移除。

## 备选方案(已否决)

- **闭源 + core 双授权**(本 ADR 初稿方案):合规可行(版权人不受自己 GPL 约束),但引入 CLA/声明前置项与长期双 license 维护成本,且闭源在赛道内失分——被本决策取代。
- **改 MIT/Apache**:放弃 copyleft 对第三方闭源套壳的抑制,削弱反克隆价值——否决。
- **board 不依赖 core、公式栈重写**:重复造 KaTeX+mhchem 渲染与 in-place editing,违背资产复用初衷——否决。

## 影响

- `@moraya/board` 可正常声明 `@moraya/core` 为 peerDependency(同 GPL,零合规注意事项)。
- 消费 board 的宿主(独立 Web、Chrome 插件、Moraya PC 插件形态)分发时同样受 GPL 约束——Moraya PC 本体不受影响(插件形态边界与 PC 本体 license 的关系在插件形态立项时单独评估;最坏情况 board 画板以独立窗口/独立 web 形态与 PC 协作,不进 PC 分发物)。
- 第三方克隆 board 需保持 GPL 开源——反克隆威慑与生态开放兼得。
