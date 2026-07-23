# 详细设计:教学画板 — Part A `@moraya/board` 核心包 / Part B `moraya-boardraw` 前端

> 类型:详细设计(承接 [[teaching-whiteboard]] 需求规格;实施依据)
> 日期:2026-07-11
> 关联:ADR [[001-moraya-board-gpl-licensing]]、ADR [[002-moraya-boardraw-proprietary-frontend]]
> 现状基线:board 0.1.0(commit a8e0d4b,types/scene/formula/payload 已落地,15 tests);boardraw 0.1.0(commit 9707007,SvelteKit SPA 骨架 + vendor 桥 + 依赖冒烟,check/test/build 全过)

---

# Part A:`@moraya/board` 核心包详细设计

## A1. 设计原则

1. **Framework-free**:纯 TS + SVG 字符串/DOM 无关逻辑,零 Svelte/React 依赖;宿主(boardraw、Moraya 插件、Chrome MV3)自行包装 UI 与响应式。
2. **编辑态与导出态同构**:两者都产出 SVG 元素结构,同一份 `render` 代码,导出即所见。
3. **源码即真相**:formula 存 LaTeX、text 存纯文本;一切视觉产物可从场景 JSON 重建。
4. **不可变更新**:场景变更产生新元素对象(结构共享),这是 undo/redo 与宿主细粒度重渲染的基础。

## A2. 模块图(0.1.0 已有 ✅ / 计划 ⬜)

```
types.ts ✅      场景模型 v1(5 元素类型 + BoardScene/AppState + measured 字段)
scene.ts ✅      createEmptyScene / isBoardScene / extractMarkdown
formula.ts ✅    katex+mhchem 渲染(katexStrict 对齐 core)
payload.ts ✅    .mboard.svg 编解码(fflate deflate+base64,metadata 标记)
geometry.ts ✅   0.2.0:Point/Rect、elementBBox、hitTest(旋转反变换/笔迹分段/描边带)、rectHits、unionBBox
render.ts ✅     0.2.0:renderElement(每类型)+ renderSceneToSvg(分层 g + 箭头 marker + formula foreignObject/switch 回退)
store.ts ✅      0.3.0:BoardStore(不可变快照 + 订阅 changedIds + mergeKey 合并 + transact + reset)
history.ts ✅    0.3.0:op-based(add/remove/update/appState)applyOp/inverseOp,上限 100
markdown.ts ✅   0.4.0:md→formula/text 元素(elementsFromMarkdown/formulasFromMarkdown,extractMarkdown 逆向;**自包含实现,未依赖 @moraya/core parse**——block 文法很小,dependency-free 更利于任意宿主复用,core peer 保持 optional 备将来)
```

**实现进度**(2026-07-11):board **0.2.0**(commit 2434b94,geometry+render)/ **0.3.0**(store+history)/ **0.4.0**(markdown,48 tests)已发 vendor tarball;boardraw **M1**(383ac49)画笔/形状/选择移动/删除/撤销重做/pan-zoom/导出;**M2**(7595970)formula/text 元素 + FormulaEditor(实时 KaTeX 预览 + 数学/化学模板)+ TextEditor + 离屏测量层(measure.ts 实现 board MeasureFn,measured 回写元素并入 .mboard.svg)+ 工具字母快捷键;**M3**(4bf49f7)file-service.ts 文件打开/保存(File System Access API + `<input>`/download 兜底)+ localStorage 自动草稿(debounce 500ms + 恢复 banner)+ 无场景 .mboard.svg 新标签只读降级 + Cmd+O/S/Shift+S;**M4a**(a0c0c75)Import Markdown(elementsFromMarkdown → 测量 → transact 单步 add),与 Export .md 合成 **md↔board 双向闭环**。board 48 tests、boardraw 9 tests,两侧 check(0 warn)/build 全过。

**M5a Chrome MV3 打包**(commit 74baadd):`pnpm build:extension` 把同一 SPA build 包成 unpacked MV3 扩展(dist-extension/)。关键处理:MV3 extension_pages CSP 禁内联脚本,而 SvelteKit SPA fallback 有一段内联 bootstrap → `scripts/build-extension.mjs` 后构建把它外置为自托管 `sveltekit-bootstrap.js`(`document.currentScript.parentElement` 在外置 classic script 下仍成立)再加 manifest + service-worker;工具栏图标开全屏 tab,side panel 可用。两个 worker/bootstrap 已过 `node -c` 语法校验。

**M5b 圈选笔迹 → 公式识别**(commit 3312cab):管线 = lasso 工具圈选 ink → `rasterize.ts` 把区域画成 PNG(buildRegionSvg 纯函数 + canvas 栅格化)→ 可插拔 `FormulaRecognizer`(`resolveRecognizer`:window 注入 hook 优先,否则读用户配置的 OpenAI 兼容 vision 端点)→ 返回 LaTeX 填入 FormulaEditor 让用户确认 → transact 单步「删 ink + 加 formula」。AISettings 弹窗配置 endpoint/key/model(localStorage,key 用 password 输入)。AI 网络调用在接口后,管线本身自主可测:11 新单测(recognizer 请求体/清洗/配置往返、rasterize SVG 构建)+ **E2E 用注入 mock recognizer 覆盖完整流程**。boardraw 是独立产品(不受 Moraya Rust-proxy 安全模型约束),浏览器侧用用户自有 key 直连自配端点是可接受模式。

**E2E 测试基建**(commit 7177f36):Playwright 用系统 Chrome(`channel:'chrome'`,免下载),`e2e/` 目录(与 vitest src/** 隔离)。**6 个 E2E 在真实 Chrome 通过**:画笔绘制、undo/redo、公式插入 + KaTeX 渲染、Markdown 导入、圈选识别全流程(mock recognizer)、自动草稿 reload 恢复——补上 M1 起一直标注的浏览器交互层验证缺口。踩坑:`\ce{-> }` 反应箭头在 KaTeX 里渲染成 SVG `<path>`,断言 ink 笔迹要用 `svg > g > path`(直接孙节点)而非后代选择器,以免命中公式内部的 katex 箭头 path。

boardraw 累计:20 unit tests + 6 E2E,check 0 warn / build / MV3 打包全过。

**M4b Picora OAuth + KB 云托管**(commit 282d197):如实移植 moraya-web 的 Picora 客户端(该客户端不在 @moraya/core,仅 moraya-web 有)——`src/lib/cloud/` 下:PKCE OAuth(picora-auth)、session + 轮转 refresh(session)、401 自动刷新的 apiFetch、KB/board 操作(listKbs / uploadBoard 走 `POST /v1/kbs/:id/sync` upsert 带 `Picora-Sync-Version:2` header + sourceHash=SHA-256 hex / listBoards 走 manifest 过滤 `boards/*.mboard.svg` / downloadBoard 走 `/v1/docs/:id/raw`)。`.mboard.svg` 即 KB 普通文本文档,零协议改动(与规格 §6.2 一致)。CloudDialog:登录→选 KB→保存/打开画板;`/login/callback` 路由。env 配置(`$env/dynamic/public`,缺省 fallback 不 throw)。
- **纯 seam 已单测**:PKCE challenge 对 RFC 7636 测试向量、SHA-256 已知向量、envelope 解析、upsert body、manifest→board 过滤、slug —— 12 单测;E2E 覆盖「未配置」状态路径。
- ⚠️ **Picora 前置条件(未满足)**:boardraw 需在 Picora 注册**自己的** OAuth client(moraya-web 的 `mw_picora` / `editor.moraya-web` scope 是 app 专属),设 `PUBLIC_PICORA_OAUTH_CLIENT_ID` + 回调 URI。未注册 client + 真实后端时**无法 E2E 真实登录/上传流程**;代码按契约如实实现但仅纯逻辑可验证。

**boardraw 累计:32 unit tests + 7 E2E(真实 Chrome),check 0 warn / build / MV3 打包全过。**

**仍未做 / 延后**:
- ⚠️ MV3 扩展真机(chrome://extensions 加载、CSP 下 SPA 启动、side panel)仅 build + JS 语法校验,未真机加载。
- ⚠️ Picora 真实登录/云存取需注册 client + 后端(见上)。
- 第三形态 **Moraya PC 插件**:需 Moraya 插件系统对接(未开始)。
- **浏览器自动化测试**:CanvasHost pointer/DOM、measure、编辑器、file-service 的 File System Access 交互当前仅 build+typecheck+纯逻辑单测覆盖(draft 持久化已单测);真机流程需 `pnpm dev`(5174)手动过一遍(绘制/公式/存盘/导入)。环境无 chrome-devtools MCP / playwright。

依赖方向:`types ← {scene, geometry} ← render ← store ← history`;`formula`/`payload` 仅依赖 `types`。禁止反向依赖。

## A3. geometry.ts(0.2.0)

```ts
type Point = { x: number; y: number }
type Rect = { x: number; y: number; width: number; height: number }

elementBBox(el: BoardElement): Rect          // stroke: points 外包;text/formula: 需宿主注入测量结果(见 A5)
hitTest(el, p: Point, tolerance): boolean    // stroke: 点到折线段距离 ≤ size/2+tol;shape: 描边带命中(fill 时含内部);
                                             // text/formula/image: bbox 命中
rectHits(el, r: Rect): boolean               // 框选:bbox 相交
applyRotation(p, center, rad): Point         // 命中测试前把指针点反旋转到元素局部系(rotation 支持)
```

- 命中测试是纯几何,不碰 DOM——满足性能规范「指针回调中零布局读」。
- stroke 简化:先 bbox 粗筛,再逐段精确距离;点数 >512 时按步长 2 抽样粗测。

## A4. render.ts(0.2.0)——渲染管线核心

```ts
renderElement(el: BoardElement, ctx: RenderCtx): string   // 单元素 → SVG 片段字符串
renderSceneToSvg(scene, opts?: { embedScene?: boolean }): string  // 完整 .mboard.svg 文本
```

各元素类型的 SVG 形态:

| 元素 | SVG 输出 |
|---|---|
| stroke | `perfect-freehand` `getStroke(points, {size, thinning:0.5, smoothing:0.5, streamline:0.5})` → 闭合多边形 `<path d="..." fill={color}>`(perfect-freehand 输出轮廓,用 fill 不用 stroke) |
| shape | line/arrow → `<line>`+`<marker>`(箭头);rect → `<rect rx=2>`;ellipse → `<ellipse>` |
| text | `<text>` + `<tspan>` 按行(`\n` 分行);font-family 走 CSS 变量,导出时落系统字体栈 |
| formula | `<g class="mboard-formula"><foreignObject>KaTeX HTML</foreignObject></g>`,foreignObject 尺寸 = 宿主注入的测量值 |
| image | `<image href={src}>`(导出时 data URI 保持内嵌;相对路径保持相对) |

**结构分层**(对齐规格 §4.2):`<g class="mboard-strokes|shapes|text|formulas|images">` 按类型分组,组内按 z/数组序。

**⚠️ formula 静态视图的已知限制与决策**:导出 SVG 内嵌 KaTeX HTML(foreignObject)+ 内联一份精简 KaTeX CSS(`<style>` 于 SVG 根,约 20KB)。SVG 以 `<img>` 方式展示时禁止加载外部资源 → **不嵌 KaTeX woff2 字体,公式回退系统 serif 字体**——可读但非印刷级。改进路径(0.5.x 择一):(a)导出时字体子集化为 data URI(体积换保真);(b)公式预渲染为纯 path(引入 MathJax SVG 输出,双引擎,倾向否)。GitHub `<img>` 渲染的 sanitize 行为以实测为准,降级底线 = 公式区域显示 LaTeX 源文本(`<switch>` fallback)。

## A5. 宿主测量注入(text/formula 的 bbox 问题)

核心包无 DOM,无法测量 KaTeX HTML / 文本的自然尺寸。约定:

```ts
interface MeasureFn { (el: TextElement | FormulaElement): { width: number; height: number } }
```

- 宿主(boardraw)用隐藏测量层(off-screen div,一次性 `getBoundingClientRect`,结果缓存 per (latex|text, fontSize))实现 `MeasureFn`,注册给 `BoardStore`。
- 测量结果写回元素的 `measured: {width,height}` 字段(**加入 types v1,序列化保存**)——导出与再打开时无需重测,保证无宿主环境(纯 Node 工具链)也能 `renderSceneToSvg`。
- 元素 latex/text/fontSize 变更时使 measured 失效并重测。

## A6. store.ts + history.ts(0.3.0)

```ts
type BoardOp =
  | { kind: 'add'; elements: BoardElement[] }
  | { kind: 'remove'; ids: string[] }
  | { kind: 'update'; before: BoardElement[]; after: BoardElement[] }   // 自带逆操作素材
  | { kind: 'appState'; before: Partial<BoardAppState>; after: Partial<BoardAppState> }

class BoardStore {
  getScene(): BoardScene                       // 始终返回不可变快照
  subscribe(fn: (scene, changedIds) => void): () => void
  apply(op: BoardOp, opts?: { mergeKey?: string }): void   // 应用 + 推入历史
  transact(fn): void                           // 批量 op 合成单个历史项(如批量删除)
  undo() / redo() / canUndo() / canRedo()
}
```

- **mergeKey 合并**:同 mergeKey 的连续 update 合并为一个历史项(拖动过程 60fps 的位置更新只留一步 undo)。笔迹绘制中不产生 op,`pointerup` 才 `add`——落笔一次 = 一步 undo。
- 历史上限 100 项,超出丢弃最旧。
- `changedIds` 让宿主做细粒度重渲染(只重画变更元素),不强制全场景 diff。
- 订阅模型 = 普通回调集合,**不依赖任何框架**;boardraw 侧用 `$state` 包一层(见 B3)。遵守 moraya 反模式规则:宿主订阅在组件顶层 + onDestroy 清理,不进 `$effect`。

## A7. markdown.ts(0.4.0,optional peer 激活)

- `formulasFromMarkdown(md: string): FormulaElement[]`:用 `@moraya/core` 的 parse 提取 `$$..$$`/`$..$`/`\ce{}`,生成待放置元素(x/y 由宿主放置交互决定)。
- `extractMarkdown`(已有)保持在 scene.ts,此模块只做反向。
- `@moraya/core` 保持 optional peerDependency:未安装时该子路径 import 抛错,主入口不受影响(tsup 独立 entry,不进 index)。

## A8. API 稳定性与版本

- 公开 API = index.ts 导出(现状 + A3-A7 新增);破坏性变更定义沿用 0.1.0 注释:删除/重命名导出符号,或 `.mboard.svg` payload 不兼容变更。
- 场景 `version` 升级策略:字段**新增**不升 version(解析端忽略未知字段);字段语义变更/删除才升,且解析端拒绝更高 version(已实现于 `isBoardScene`)。
- 里程碑:0.2.0 geometry+render → 0.3.0 store+history → 0.4.0 markdown → 0.5.x 导出保真优化。

## A9. 测试计划(每模块随实现落地,vitest)

- geometry:命中测试边界(旋转元素、粗笔迹边缘、框选相交)
- render:每元素类型快照式断言(包含关键属性,不做全量 snapshot);`renderSceneToSvg → extractSceneFromSvg` roundtrip
- store/history:op 应用/撤销/重做/mergeKey 合并/transact 原子性
- markdown:`extractMarkdown(formulasFromMarkdown(md))` 语义 roundtrip

---

# Part B:`moraya-boardraw` 前端详细设计

## B1. 技术形态(已定,0.1.0 落地)

SvelteKit SPA(adapter-static,`ssr=false`,dev 5174)+ Svelte 5 runes;闭源(ADR 002);`@moraya/board` 经 vendor tarball 桥。单页应用,v1 无路由拆分(`/` 即画板)。

## B2. 组件树

```
+page.svelte(画板宿主页)
├── Toolbar.svelte        # 左侧工具条:select | pen | shape(line/arrow/rect/ellipse) | text | formula | eraser | image
├── CanvasHost.svelte     # 核心画布:SVG 视口 + 指针事件管线 + 元素渲染
│   ├── ElementLayer      # {#each} 渲染 scene 元素(内联 SVG,复用 @moraya/board renderElement 的属性逻辑)
│   ├── SelectionOverlay  # 选中框、8 向缩放手柄、旋转手柄
│   └── InkPreview        # 正在绘制的笔迹(pointerup 前的临时层,不进 store)
├── FormulaEditor.svelte  # 公式浮层编辑器:LaTeX textarea + 实时 KaTeX 预览 + 模板面板(常用数学/化学方程式)
├── ContextBar.svelte     # 选中元素属性条:颜色、笔宽/线宽、字号、display/inline 切换(formula)
├── FilePanel.svelte      # 打开/保存/导出/「导出讲义(md)」
└── MeasureLayer.svelte   # 隐藏测量层(实现 A5 MeasureFn:off-screen 渲染 KaTeX/text 后一次性测量,缓存)
```

## B3. 状态管理

- `src/lib/board-store.svelte.ts`:包装 `@moraya/board` 的 `BoardStore` —— 顶层 `store.subscribe` 把不可变快照写入 `$state` 浅引用(`sceneSnapshot = scene`),组件用 `$derived` 切片;**不在 `$effect` 内 subscribe**(项目反模式规则),onDestroy 清理。
- 工具状态机(`$state`):`idle → drawing(pen) | dragging(select) | resizing | rotating | editing-formula | placing(formula/text/image)`;当前工具、当前样式(颜色/笔宽/字号)为独立 `$state`。
- 视口状态:`{ panX, panY, zoom }` → SVG `viewBox` 派生;**不用 CSS transform**(保持 SVG 坐标系与场景坐标一一对应,简化命中)。

## B4. 指针事件管线(性能规范约束)

- 单一 `onpointerdown/move/up` 挂在 SVG 根;`setPointerCapture` 保证拖出画布不丢事件。
- **回调内零布局读**:screen→scene 坐标换算用缓存的 `viewportRect`(仅 resize/scroll 时经 RAF 更新)+ 视口状态纯数值计算;禁止在 move 回调调用 `getBoundingClientRect`/`coordsAtPos` 类 API(moraya 性能规则 §2)。
- 笔迹采样:pointermove 原始点(含 `pressure`,无压感设备置 0.5)推入本地数组,`InkPreview` 经 RAF 节流重绘(RAF id 命名存储 + cancel 配对 + onDestroy 清理,性能规则 §4);`pointerup` 时一次性 `store.apply({kind:'add'})`。
- 拖动/缩放经 `mergeKey` 合并历史(A6)。
- 触控:pointer events 统一处理;双指 pinch 缩放视口(touch-action: none)。

## B5. 公式交互(产品差异化核心)

1. **创建**:工具条选 formula → 点画布定位 → FormulaEditor 浮层打开(空 LaTeX);模板面板给常用骨架(分式/积分/矩阵/`\ce{}` 反应式/箭头条件)。
2. **编辑**:双击 formula 元素 → 同一浮层带入现有 LaTeX;实时预览用 `renderFormulaHtml`(throwOnError:false,错误显示红色源码——board formula.ts 已定);确认写回 `update` op,触发重测量。
3. **渲染缓存**:`Map<latex+display, html>` 模块级缓存(对齐 moraya hljs 缓存模式),场景内重复公式零重复编译。
4. **导出讲义**:FilePanel「导出 Markdown」调 `extractMarkdown(scene)` 下载 .md;反向(md→画板)待 board 0.4.0。
5. **v1.x 预留**:选区套索「AI 识别为公式」按钮位(走宿主各自的 AI 通道,boardraw 独立 Web 版接 Picora 侧 AI 或用户自配 key——实施时单独设计,本文档不展开)。

## B6. 文件与持久化

| 动作 | 机制 |
|---|---|
| 打开 | File System Access API(`showOpenFilePicker`,Chrome/Edge)→ 降级 `<input type=file>`;读文本 → `extractSceneFromSvg` → null 时提示「场景数据丢失,只读查看」(规格 §4.2 降级) |
| 保存 | 持有 FileHandle 时原地写回;否则「另存为」/下载 `*.mboard.svg`(`renderSceneToSvg({embedScene:true})`) |
| 自动草稿 | `localStorage['boardraw:draft']` 存 payload(encodeScenePayload,已压缩);500ms debounce;启动时提示恢复 |
| Picora(v1 后期) | OAuth(复用 moraya-web 的 Picora 流程)+ KB 文件 API 上传/拉取 `.mboard.svg`(规格 §6.2,Picora 零改动) |
| 快捷键 | V/P/T/F 工具切换、Cmd+Z / Cmd+Shift+Z、Delete、Cmd+S 保存、Cmd+O 打开、空格+拖 = 平移 |

## B7. i18n 与主题

- v1 语言:`en` + `zh-CN` 起步(新产品,不受 moraya 12-locale 规则约束;结构预留 locale json 目录,后续扩展)。
- 主题:CSS 变量 + `prefers-color-scheme`(亮/暗),变量命名对齐 moraya `variables.css` 风格;画布背景色属于场景数据(`appState.background`),与 UI 主题解耦。

## B8. 测试与验证

- 单元(vitest):board-store 包装(订阅→$state 同步、undo 链)、坐标换算(screen↔scene 含 zoom/pan)、公式渲染缓存、草稿存取;现有依赖桥冒烟保留。
- 组件(后续引入 @testing-library/svelte,可选):FormulaEditor 确认/取消写回。
- 端到端手工清单(每里程碑):画笔连笔 60fps 无掉帧(Performance 面板抽查)、pinch 缩放、双击改公式、保存→重开 roundtrip、GitHub 上传 `.mboard.svg` 显示效果实测(A4 限制项验证)。

## B9. 里程碑(boardraw,依赖 board 版本)

| 里程碑 | 内容 | 依赖 |
|---|---|---|
| M1 | 视口(pan/zoom)+ 画笔 + 形状 + 选择/移动/删除 + undo/redo | board 0.2.0(geometry/render)、0.3.0(store/history) |
| M2 | formula/text 元素 + FormulaEditor + 测量层 + 渲染缓存 | board 0.3.0 |
| M3 | 文件打开/保存/自动草稿 + 导出讲义 md + 只读降级 | — |
| M4 | Picora OAuth + KB 托管;md→画板(反向) | board 0.4.0 |
| M5 | Chrome MV3 包装;「AI 识别公式」入口 | — |

---

## 附:两仓协同工作流

1. board 侧改动 → `pnpm test && pnpm build && pnpm pack` → 替换 boardraw `vendor/*.tgz` + 更新 `file:` 版本号 → boardraw `pnpm install && pnpm test`(依赖桥冒烟即回归)。
2. 版本联动:boardraw 的 M1/M2 开工前,board 需先发对应 0.2.0/0.3.0 tarball;board 公开发布 npm 后,vendor 桥切 `^x.y.z` 区间(README 已写明)。
3. 文档:board 每版本 API 变更追加到本文件 A 部分;boardraw 交互变更走 moraya 主仓迭代文档流程(平台标签建议新增 `board`,首个迭代文档时定)。
