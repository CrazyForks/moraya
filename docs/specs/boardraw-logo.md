# 功能规格:Boardraw 品牌 LOGO

> 类型:品牌视觉规格(已定稿、已落地)
> 平台:moraya-boardraw 仓库(教学画板闭源前端)
> 关联:[[teaching-whiteboard]](产品定位)、ADR [[002-moraya-boardraw-proprietary-frontend]]
> 状态:2026-07-11 定稿(概念比选 → C·b² 方案 → 全套资产 → 工程接入完成)

## 1. 品牌要求

- LOGO 只突出 **Boardraw**,不表现 moraya(域名短期借用,Boardraw 是独立品牌)
- 可见 UI 品牌统一为 "Boardraw";仓库名 / 包名 / LICENSE / NOTICE 不变

## 2. 设计定稿:概念 C「b²」

手写小写 **b** + 手写上标 **²**——自由笔迹与结构化公式在同一个符号里相遇,直接编码产品
「公式一等公民」的核心差异化。图形由产品同款 **perfect-freehand 压感算法**生成
(Catmull-Rom 插值中线 + 逐点压力 → `getStroke()` 轮廓),LOGO 的每一笔就是用户在
Boardraw 画布上画出的那种笔迹。

### 比选记录(2026-07-11,4 概念)

| 概念 | 结论 |
|---|---|
| A 一笔 b | 备选。最简耐看,但只讲了 draw 没讲公式 |
| B 板上一笔 | 淘汰。元素多,小尺寸细节挤 |
| **C b²** | **定稿**。唯一把笔迹与公式压进同一符号;16px 主体轮廓可辨 |
| D √b | 淘汰。两元素咬合紧易糊,根号常被读成对勾 |

### 视觉规范

- **品牌色**:`#0091FF`(与产品 UI 主色一致);深色背景用白色版
- **双变体**:
  - **master**(`static/logo.svg`)——完整压感笔锋,用于 ≥48px(标题栏、文档、大图标)
  - **small**(`static/favicon.svg`)——压力拉平、笔画加粗、² 放大,保证 16-32px 字碗留白不糊
- 画布 128×128 viewBox;apple-touch-icon 为品牌蓝底 + 白标(占 72%)

## 3. 资产清单与接入点(moraya-boardraw 仓库)

| 资产 | 用途 |
|---|---|
| `static/logo.svg` | 主标(master) |
| `static/favicon.svg` | 小尺寸标(small);`app.html` SVG favicon;标题栏 `<img>`(20px) |
| `static/favicon.png` | 32px PNG 后备 favicon |
| `static/apple-touch-icon.png` | 180px iOS 主屏图标 |
| `extension/icons/icon-{16,32,48,128}.png` | MV3 插件 `icons` + `action.default_icon`(16/32 用 small,48/128 用 master) |

接入位置:`src/app.html`(favicon links + title "Boardraw")、`extension/manifest.json`
(name/default_title "Boardraw" + icons)、`src/routes/+page.svelte` topbar(`.brand-mark`
+ `t('app.name')`)、`scripts/build-extension.mjs`(复制 `extension/icons/`)。

## 4. 再生成方法

全部资产由单一脚本确定性生成,改笔迹参数后重跑即可:

```bash
cd moraya-boardraw
node scripts/gen-logo.mjs
# SVG 直接写入 static/;PNG 经 playwright 栅格化
# (若本机无 chromium:pnpm exec playwright install chromium-headless-shell;
#  脚本对缓存中已有的 headless shell 有自动回退)
```

字形源数据(`B_GLYPH` / `TWO_GLYPH` 控制点 + 压力)与笔参数均在脚本内,是唯一事实来源;
不要手改生成出的 SVG/PNG。

## 5. 验证(已通过)

- `pnpm check`(0 错误)、`pnpm test`(38 通过)
- `pnpm build` → `build/` 内 favicon/logo 资产就位,index.html 含 icon links
- `pnpm build:extension` → `dist-extension/icons/` 就位,manifest JSON 合法
- 本地 serve `build/` 截图:标题栏 20px 组合标渲染正常;16px 阶梯目检可辨
