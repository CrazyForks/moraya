# 功能规格:教学画板(Teaching Whiteboard / Moraya Board)

> 类型:功能规格(设计阶段,需求评估已确认;待拆分独立仓库迭代实施)
> 平台:新产品线(独立仓库 `moraya-board` = 核心包 `@moraya/board`,GPL-3.0-only;三形态分发:独立 Web / Moraya 插件 / Chrome 插件)
> 关联:[[prompt-asset]](个人 AI 资产中枢叙事)、@moraya/core(公式渲染内核)、Picora(OAuth + 云托管)、ADR [[001-moraya-board-gpl-licensing]]
> 状态:2026-07-11 需求评估确认(竞品分析、嵌入方式、手写识别策略、license 决策已逐项评估)

## 1. 背景与定位

### 1.1 需求起点

Excalidraw 类白板产品是通用协作画布,但**没有一款把结构化公式(数学 + 化学)当一等公民**:Excalidraw 的文本是纯文本,Miro / FigJam 无 LaTeX 能力,GeoGebra / Desmos 是学科工具而非自由画板。理科教学场景(备课、板书、讲义)存在真实空白:教师需要在自由画布上混合书写笔迹、几何图形与**可编辑、可复用的标准公式**,并能把成果流转回 Markdown 讲义。

### 1.2 产品定位

**教学向公式画板**:以 KaTeX(数学)+ mhchem(化学方程式)为一等公民元素的自由画布,画板内容与 Markdown 文档双向流动,本地优先、GPL-3.0 开源独立产品线(与 @moraya/core 同 license;决策见 ADR [[001-moraya-board-gpl-licensing]])。

差异化三论点:

1. **结构化公式为一等公民**:公式元素保存 LaTeX 源码,渲染只是视图——可点击编辑、可无损导出为 md 的 `$$...$$`,而非竞品的"贴一张公式截图"。
2. **画板 ↔ Markdown 自由转换**:画板文件即标准 md 图片资源(见 §4),嵌入任何 Markdown 文档零语法冲突;画板中的公式/文本可提取为讲义,md 中的公式可发送到画板。
3. **Moraya 资产生态复用**:@moraya/core 公式渲染、Picora OAuth 与云托管、Moraya ai_proxy 多模态识别通道——画板文件成为 KB 内新资产类型,强化「个人 AI 资产中枢」叙事。

商业形态:**GPL-3.0 开源 + open-core**,短期不收费;copyleft 即知识产权保护(竞品无法闭源套壳),商业价值放在 Picora 云托管/分享等服务层;版权人保留未来对商业版双授权的全部后手。详见 §8 与 ADR [[001-moraya-board-gpl-licensing]]。

## 2. 竞品格局(2026-07 调研)

### 2.1 商业竞品

| 产品 | 定位 | 与本项目关系 |
|---|---|---|
| Miro | 企业协作白板,模板/工作坊最全,$8-20/user/月 | 重协作轻内容,无公式能力 |
| FigJam | Figma 生态头脑风暴,$3-5/editor/月 | 设计师向,无教学/公式场景 |
| Mural | 引导式工作坊(计时/投票) | 同上 |
| Mathpix Snip | 图片/手写 → LaTeX/SMILES OCR(商业 API) | 潜在能力供应商,非竞品 |
| MyScript iink SDK | 商业手写识别 SDK(数学实时转换);Nebo 是其自有教学笔记产品 | 同上 |

### 2.2 开源同类(重点:license)

| 项目 | License | 说明 |
|---|---|---|
| Excalidraw | **MIT**(90k+ stars) | 手绘风无限画布;场景 JSON 嵌入导出 PNG(tEXt chunk)/ SVG(metadata),文件既是图片又是可编辑源——本项目 §4 文件格式的直接先例 |
| tldraw | 自定义 source-available,**商用需付费** | SDK 最强,但不能作为闭源商用基座 |
| draw.io / diagrams.net | Apache 2.0 | 技术图表向(UML/ERD) |
| AFFiNE | MIT | 文档 + 白板一体,与 Moraya 定位部分重叠 |
| Penpot | MPL | 设计平台带白板 |

**结论**:通用白板是红海;「结构化公式一等公民 + md 双向流动的教学画板」无直接对标,差异化成立。

## 3. 数据模型:分层场景图

画板 = 场景图(scene),元素(element)按类型分层:

```
v1 元素类型:
  stroke   — 自由笔迹(perfect-freehand 压感多边形;点序列 + 笔参数)
  shape    — 几何图形(线/箭头/矩形/椭圆)
  text     — 文本(纯文本源)
  formula  — 公式(LaTeX 源,含 \ce{} 化学方程式;KaTeX+mhchem 渲染)
  image    — 位图/矢量图引用(内嵌 data URI 或相对路径)
v2 候选:
  chem-structure — 化学结构式(SMILES 源,Ketcher/渲染库;见 §9 风险)
```

核心原则:**结构化元素永远保存源码**(formula 存 LaTeX、text 存纯文本),渲染是派生视图。这是「画板 ↔ md 双向转换」的语义基础:

- **画板 → md(导出讲义)**:遍历场景中 formula/text 元素(按空间顺序),生成 `$$...$$` 与段落;stroke/shape 不进 md——它们本来就无 md 表达,**留在画板文件内不是缺陷而是设计边界**(md 只引用画板文件,见 §4)。
- **md → 画板**:文档中的公式块 / 选中文本一键「发送到画板」,成为 formula/text 元素。

## 4. 文件格式:`*.mboard.svg`(自包含 SVG,场景 JSON 嵌入 metadata)

### 4.1 决策:图片路径嵌套,不用代码块嵌套

两种候选路径的评估结论:

| | 代码块嵌套(md 内嵌场景源码) | **图片路径嵌套(采纳)** |
|---|---|---|
| md 语法 | 需自定义 fence 语言,非标准 | 标准 `![](x.mboard.svg)`,零冲突 |
| Moraya 外的渲染器 | 显示一坨 JSON | SVG 直接显示图形 |
| 嵌套渲染风险 | **必须在 ProseMirror NodeView 内嵌整个画板运行时**(md 用 @moraya/core 渲染,代码块内再起一个渲染内核,生命周期/性能/焦点冲突) | **无嵌套**:阅读态就是一张 SVG 图片;双击才在独立 overlay/新 tab 加载画板引擎 |
| md 源码可读性 | 几十 KB JSON 污染源码,git diff 不可读 | 源码只有一行图片引用 |

### 4.2 格式定义(草案)

复刻 Excalidraw embed-scene 机制:导出的 SVG 同时是**渲染结果**(任何浏览器/md 渲染器可见)和**可编辑源**(画板引擎读 metadata 还原场景):

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900">
  <metadata id="mboard">
    <!-- payload-type:application/vnd.moraya-board+json;version:1;encoding:base64+deflate -->
    <!-- payload-start:eJx9kU1PwzAMhv/...:payload-end -->
  </metadata>
  <g class="mboard-strokes">…perfect-freehand 多边形…</g>
  <g class="mboard-shapes">…</g>
  <g class="mboard-formulas">…KaTeX 渲染的 SVG 子树(内联,阅读态无需 KaTeX 运行时)…</g>
  <g class="mboard-text">…</g>
</svg>
```

- 场景 JSON schema:`{ type: "moraya-board", version: 1, elements: Element[], appState: {...} }`,带 version 字段向前兼容。
- payload 编码:JSON → deflate → base64(与 Excalidraw 同思路),打开时校验;若 SVG 被压缩/清洗工具剥离 metadata,提示「场景数据丢失,仅可作为图片查看」。
- 公式导出:formula 元素用 KaTeX SSR 渲染为 SVG/HTML 子树内联(阅读态自包含);编辑态从 LaTeX 源重渲染。
- Markdown 中的写法:`![alt](./assets/lesson-3.mboard.svg)`——就是普通图片。
- v2 兼容项:读取 Excalidraw 式 `.png` tEXt chunk(单向导入)。

### 4.3 Moraya 编辑器侧集成(最小改动)

- 图片 NodeView 识别 `.mboard.svg` 后缀 → ImageToolbar 增加「编辑画板」入口(复用现有 image toolbar 模式,[src/lib/editor/ImageToolbar.svelte](../../src/lib/editor/ImageToolbar.svelte))。
- 打开方式:独立窗口 / 新 tab 加载画板(插件形态,见 §6),保存后 md 侧图片自动刷新。
- 不新增 ProseMirror node 类型,不改 schema / markdown 序列化——严格遵守项目「格式保持」规则。

## 5. 手写识别策略:结构化优先 + AI 显式辅助

这是最大技术风险点(用户提出的两个风险问题),评估结论:

### 5.1 风险一:如何识别画笔绘制的是公式?

- **实时笔迹 → LaTeX**(MyScript iink 级)自研不现实;商业 SDK 收费且化学支持弱。开源侧(Pix2Text/TrOCR/Math2LaTeX)是图片 OCR 而非在线笔迹识别,且准确率不足以做产品承诺。
- **化学**更严峻:手写化学识别只有 DECIMER(研究级,结构式→SMILES)与 Mathpix(商业)。
- **分阶段策略**:
  - **v1:不做手写识别,不承诺。** 公式通过结构化输入创建:LaTeX 源输入 + 常用公式模板面板 + 复用 @moraya/core 0.6.0 的 in-place math editing(点击公式直接编辑 LaTeX、token 高亮)。
  - **v1.x:「圈选笔迹 → AI 识别」显式动作。** 用户圈选一片笔迹 → 区域栅格化为图片 → 走 Moraya 现有 **ai_proxy 多模态通道**(Claude / GPT-4o 对手写公式转 LaTeX 已相当可靠)→ 返回 LaTeX 预览,**用户确认后**替换为 formula 元素。识别是显式、可确认、可撤销的,体验可控且零新增基建(复用用户已配置的 AI provider 与 keychain 密钥体系)。
  - **v2+**:评估 Pix2Text/TrOCR 本地模型(隐私叙事加分)或 MyScript 商业授权。

### 5.2 风险二:纯笔画(画线、画圈)无法用 md 语法表达?

在 §4 的「画板 = 图片资源文件」模型下**此问题消解**:stroke/shape 持久化在 `.mboard.svg` 内(SVG 本身就是它们的标准表达),md 文档只引用文件,不需要也不应该表达笔画。只有代码块嵌套方案才存在此矛盾——已排除。

## 6. 架构与三形态分发

### 6.1 仓库与包结构

仓库分工对齐 moraya-core 模式(**moraya-board 仓库 = 画板核心包项目**,app 壳是消费方,不在此仓库):

```
moraya-board/(独立仓库,GPL-3.0-only)= @moraya/board 核心包
  # 场景图模型、渲染器、命中测试、undo/redo、mboard.svg 序列化、md 提取——
  # 纯 TS + SVG,零应用框架绑定(UI 层由各宿主自行包装)
  # 消费方式:预发布期 vendor tarball(package.json 暂 private:true 防误发);
  # 后续公开发布 npm(GPL,同 @moraya/core 模式)

消费方(各自独立仓库/宿主):
  moraya-boardraw  # 独立 Web 版前端(已建仓):SvelteKit SPA + adapter-static(镜像 moraya-web 骨架,
                   # dev 端口 5174);**完全闭源**(UNLICENSED,授权依据 ADR 002 + 仓库 NOTICE);
                   # 经 vendor tarball 桥消费 @moraya/board(git 跟踪 vendor/*.tgz 保证可复现,
                   # 禁 link:/sibling 相对路径,npm-only 边界同 moraya↔core);
                   # Picora OAuth + 云托管;保留未来独立 app 的壳(短期不做)
  Chrome MV3 插件  # boardraw 同一 web build 的包装(new tab / side panel 入口,本地文件 + web 版协同)
  Moraya 插件形态  # Moraya PC 经插件系统 / 内置集成加载 @moraya/board + 画板 UI(见 §4.3)
```

分层定型为 **open-core**:引擎开源(GPL-3.0,社区 + copyleft 反克隆)+ 前端闭源(产品体验与商业价值)——与 Excalidraw(MIT 引擎 + excalidraw.com 服务)结构同型。

- **引擎选型:自研轻量 SVG 场景图引擎**(Svelte 5 + perfect-freehand(MIT)+ KaTeX)。不 fork Excalidraw(React 栈不合、跟 upstream 是长期负担);不用 tldraw(license)。教学画板 v1 只需 5 种元素,无需无限协作/库市场,粗估 6-10k LOC,渲染态与导出态同构(都是 SVG),导出即所见。
- **@moraya/core 复用面**:KaTeX+mhchem 渲染路径、in-place math editing、markdown parse/serialize(画板↔md 转换)、i18n。**依赖基线版本:0.8.1**(2026-07-11 当前版本;board 侧从 npm 公开包按语义化范围锁定,遵循与 moraya 主仓一致的「npm-only 边界」——不得经 sibling 路径 / symlink 导入)。license 处理见 §8。

### 6.2 云托管(Picora)

- v1:`.mboard.svg` 作为 KB 内普通文件,走现有 KB 文件 API 与同步(manifest 比对、sourceHash),**Picora 侧零改动**——即用户要求的「单个文件托管」。
- v2:独立于 KB 的单文件分享链接(只读 web 渲染页)才需要 Picora 新增 board 资产端点。

## 7. 能力边界声明(v1 范围)

- **化学 = 方程式/反应式**(KaTeX mhchem `\ce{2H2 + O2 -> 2H2O}`),**不含结构式**(苯环、键线式)。结构式需要 SMILES + 结构编辑器(Ketcher,Apache-2.0),列为 v2 评估项。
- 无多人实时协作(教学备课是单人场景;协作是 v3+ 命题)。
- 无手写实时识别承诺(§5.1)。

## 8. 知识产权与 License

- `moraya-board` 仓库与 `@moraya/board` 包:**GPL-3.0-only**,与 `@moraya/core` 同 license(决策过程见 ADR [[001-moraya-board-gpl-licensing]])。
  - **合规摩擦归零**:同 license 直接依赖 core,无传染冲突,无双授权前置项。
  - **copyleft 即反克隆保护**:竞品可读源码但无法闭源套壳——与 core 仓库既有取向一致。
  - **后手保留**:版权人唯一,未来可随时对商业版/闭源衍生做双授权;商业价值放服务层(Picora 托管/分享,open-core)。
  - 开源亦是白板赛道入场券(Excalidraw 的护城河即其 90k stars 社区)。
- 前端 `moraya-boardraw` 为**专有闭源**(UNLICENSED):对自有 GPL 包的使用依据版权人商业授权(双授权后手的首次行使),见 ADR [[002-moraya-boardraw-proprietary-frontend]] 与 boardraw 仓库 NOTICE。
- 接受外部贡献前须先落实 CLA(保留再授权权利),与 core 仓库同规则——后手已行使,此项升级为**强制前置**(ADR 002)。
- 第三方依赖均取宽松 license:perfect-freehand(MIT)、KaTeX(MIT)、fflate(MIT)、Ketcher(Apache-2.0,v2)。禁止引入 tldraw(商用付费 source-available)。

## 9. 风险清单

| 风险 | 等级 | 缓解 |
|---|---|---|
| ~~GPL-3.0 core 与闭源产品冲突~~ | 已消解 | board 采用同款 GPL-3.0-only(ADR 001),无冲突;接受外部贡献前落实 CLA |
| 手写识别期望管理 | 高(产品) | v1 不承诺;v1.x AI 圈选识别为显式辅助(§5.1) |
| 化学结构式超出 KaTeX 能力 | 中 | v1 范围限定方程式;v2 评估 Ketcher 元素(§7) |
| 自研画板引擎工作量 | 中 | v1 元素收敛 5 种;perfect-freehand/KaTeX/core 复用(§6.1) |
| SVG 嵌 JSON 被压缩/清洗后丢场景 | 低 | 打开时校验 + 降级提示(§4.2;Excalidraw 同款问题) |
| 通用白板红海 | 低 | 不做通用白板,锚定教学 + 公式差异化(§2) |

## 10. 路线图

| 阶段 | 内容 |
|---|---|
| v1 | @moraya/board 引擎(5 元素类型)+ 独立 Web 版 + `.mboard.svg` 格式 + Picora OAuth/KB 托管 + 画板→md 讲义导出 + md 公式→画板 |
| v1.x | Moraya PC 集成(图片 NodeView「编辑画板」入口)+ AI 圈选识别(ai_proxy 多模态)+ Chrome MV3 包装 |
| v2 | 化学结构式元素(Ketcher/SMILES)+ Excalidraw PNG 导入 + Picora 单文件分享链接 |
| v3+ | 实时协作、本地识别模型(Pix2Text/TrOCR)评估 |

## 11. 验证方案(v1 实施时)

- `.mboard.svg` 样例文件:浏览器 / GitHub 直接显示图形;画板引擎解析 metadata 还原场景;`serialize(parse(file))` 场景 JSON 等价。
- 画板→md 导出:含 `$$...$$` 与 `\ce{}` 的讲义在 Moraya 中正确渲染(mhchem 已注册)。
- md 引用 `.mboard.svg` 的文档在 Moraya 视觉/源码/分屏三模式下均按普通图片渲染,roundtrip 不改写图片语法。
- 单元测试:@moraya/board 场景模型、序列化、md 提取逻辑(vitest,按项目测试规范)。已落地:仓库首个 commit 含 15 个用例(scene/payload/formula),typecheck + build 通过。
