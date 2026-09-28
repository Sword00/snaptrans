# SnapTrans · 截图翻译

一个 Windows 桌面截图工具，对标**微信截图翻译**：框选屏幕任意区域 → 随手标注 → 一键把图上的文字**就地替换成译文**（保留原来的位置、字号、颜色和背景），最后复制 / 保存 / 贴图。

```
翻译前                     翻译后
┌──────────────────┐      ┌──────────────────┐
│ WorkBuddy, 我帮你 │  →   │ 工作伙伴，我来帮您 │
└──────────────────┘      └──────────────────┘
```

---

## 1. 快速开始

```bash
npm install          # 安装依赖（会自动生成图标）
npm run lang         # 下载中英文 OCR 语言包（约 30MB，只需一次）
npm start            # 启动，托盘出现绿色图标
```

启动后按 **`Alt + Shift + A`** 即可开始截图（也可以在托盘图标上单击 / 双击）。

> 不想跑源码？`npm run dist` 会打出 `dist/SnapTrans Setup 1.0.0.exe`（安装版）和免安装的 portable 版。

---

## 2. 怎么用

### 2.1 框选

按下快捷键 → 屏幕变暗、鼠标变十字 → 拖动框选任意区域。
松开后选区周围出现 8 个绿色手柄，可以继续拖拽调整大小；**在选区外任意位置按下鼠标可以重新框选**。

选区左上角会实时显示尺寸（图片实际像素，不是屏幕逻辑像素）。

### 2.2 标注工具栏

工具栏从左到右分三组，和微信截图一致：

| 组 | 按钮 | 说明 | 快捷键 |
|---|---|---|---|
| 编辑 | ▢ 矩形 | 拖拽画矩形框 | `R` |
| | ◯ 椭圆 | 拖拽画椭圆 | `E` |
| | ☺ 表情 | 点画布选位置 → 选表情 | `M` |
| | ↗ 箭头 | 拖拽画箭头 | `A` |
| | ✏ 画笔 | 自由手绘 | `P` |
| | ▨ 马赛克 | 拖拽涂抹打码 | `B` |
| | T 文字 | 点击输入文字，`Enter` 提交、`Esc` 取消、`Shift+Enter` 换行 | `T` |
| 智能 | 文A **翻译** | **OCR + 翻译 + 就地替换**（核心功能） | `Ctrl+T` |
| | A 提取文字 | 识别文字并复制到剪贴板 | `Ctrl+O` |
| | ▯ 长截图 | 自动滚动并拼接成一整张长图 | — |
| 输出 | ↺ 撤销 | 多步撤销 / 重做 | `Ctrl+Z` / `Ctrl+Shift+Z` |
| | ⤓ 保存 | 另存为 PNG / JPG 文件 | `Ctrl+S` |
| | 📌 贴图 | 把结果钉在桌面上（可拖动、滚轮缩放、双击关闭） | — |
| | ↗ 复制 | 复制到剪贴板 | `Ctrl+C` |
| | ✕ 取消 | 放弃并关闭 | `Esc` |
| | ✓ 完成 | 复制到剪贴板并关闭 | `Enter` |

画布上的元素都是**对象**：没有选中工具时，点击即可选中，拖动移动，拖手柄缩放，`Delete` 删除。
选中后还能在样式条上改颜色 / 粗细。

### 2.3 翻译替换（核心）

点工具栏里的 **文A** 图标：

1. 对选区做 OCR，得到每一段文字的外框（bbox）；
2. 把文字送翻译引擎；
3. 逐段：**采样原文的背景色**盖住原文 → **采样原文的文字色和字号** → 把译文按框大小自动缩放/换行画回去。

所以结果是「原图被改写」，而不是在旁边加个气泡。翻译出来的每一段都是一个可撤销、可拖动、可改色的对象。

工具栏右侧的小按钮（如 `简中`）可以随时切换目标语言。

### 2.4 设置面板

托盘图标右键 → **设置…**。

**快捷键**

点击输入框会变成「请按下组合键…」，直接按你想要的组合即可，程序自动规范化成 `Ctrl+Alt+Q` 这种写法。

- 至少要带一个修饰键（`Ctrl` / `Alt` / `Shift`），或者用 `F1`~`F24`。
  **裸的字母 / 数字会被拒绝** —— Electron 会把它注册成全局按键，等于把全系统的打字都吞掉。
- 录好后**立即生效**，不用点保存。
- 如果该组合已被别的程序占用，会明确提示，并且**自动把原来的快捷键装回去**。
  （这里特意避开了「先注销旧的再注册新的」这种写法：新键失败时旧键已经没了，用户会从
  「快捷键冲突」直接变成「彻底没有快捷键」——改一次设置就把功能弄丢。）
- 点右侧 `×` 可关闭全局快捷键。按 `Esc` 取消录制。

**数据目录**

`settings.json`、运行日志、OCR 语言包缓存默认放在 `%APPDATA%\SnapTrans`。
点「更改…」可以整体挪到别的盘（比如省 C 盘空间）：

- 切换时把现有配置和缓存**复制**过去：不删原目录，也不覆盖目标目录里已有的同名文件；
- **需要重启才生效**（Electron 的 userData 路径只能在启动前设置），界面会给出「立即重启」按钮；
- 重启后日志里会有一行 `数据目录： <路径> (自定义)`，可以据此确认；
- 如果自定义目录不可用（盘符没了 / 目录被删 / 没权限），程序会**自动退回默认目录**并在日志里
  说明原因 —— 不会因为改错目录就打不开。引导文件也会保留，修好路径后重启即可恢复。

> 实现上有个先有鸡还是先有蛋的问题：数据目录这个设置本身要存在数据目录里。
> 所以用了一个**固定位置**的引导文件 `%APPDATA%\SnapTrans\datadir.txt`（一行纯文本）记录自定义目录，
> 启动时先读它再 `app.setPath('userData', ...)`。详见 `src/datadir.js`。

---

## 3. 翻译引擎

设置里可以在两种引擎间切换（托盘右键 → 设置…）：

### 免费接口（默认，零配置）

依次尝试 **有道 → MyMemory → 必应/Edge → Google**，无需任何 Key。
适合「英文界面截图 → 中文」这类场景；如果原文本来就是目标语言，会基本原样保留。

> 需要联网。实测国内网络下**有道最快最稳**（单段 30~90ms），偶发 `errorCode 411`（频率限制）时会自动退避重试并进入 10 分钟冷却，期间直接走 MyMemory。
> 必应接口当前返回 404、Google 直连超时，所以排在后面兜底。四个都失败时界面会给出具体原因。

### AI 大模型（效果最接近微信）

填一个 **OpenAI 兼容**的接口即可，任何厂商都行：

| 厂商 | 接口地址 | 模型示例 |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| 智谱 | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` |
| Moonshot | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| 本地 Ollama | `http://localhost:11434/v1` | `qwen2.5:7b` |

大模型会按界面文案习惯**意译**，所以能做到免费接口做不到的效果：

```
WorkBuddy, 我帮你   →   工作伙伴，我来帮您
```

设置面板里的 **测试连通性** 按钮会真发一条 `Hello, world!` 出去，返回译文和耗时。

---

## 4. OCR

用本地 **PaddleOCR PP-OCRv4 + ONNX Runtime**（`@gutenye/ocr-node`），完全离线、免费、无需 Key。
模型在 `node_modules/@gutenye/ocr-models/assets/`，打包时经 `extraResources` 放到 `resources/models/`。

### 4.1 为什么从 Tesseract 换掉（实测对比，不是推测）

**中文识别质量差距是量级上的。**同一张中文 UI 截图：

| 实际文字 | Tesseract（`chi_sim+eng`） | PP-OCRv4 |
|---|---|---|
| 截图翻译设置 新 | `戟国翁诉设置` conf 0.59 | **截图翻译设置 新** conf 0.996 |
| 翻译引擎：有道智云（免费通道） | `(REESE)` conf 0.60 | **全对** conf 0.949 |
| 识别到的文字会就地替换，保留字号与颜色 | `SBR RE` conf 0.55 | **全对** conf 0.978 |
| 快捷键 Alt+Shift+A 开始截图… | `ai,` conf 0.42 | **全对** conf 0.967 |
| 立即翻译（蓝底白字） | `E` conf 0.45 | **立即翻译** conf 0.944 |
| 上次更新时间 2026-09-27 23:40 | `REET …` conf 0.66 | **全对** conf 0.985 |

而且**更快**：稳态 347ms vs 612ms。1200×800 大图 + 13px 小字 **14/14 全中**（稳态 722ms）。

换引擎后，之前为 Tesseract 写的一堆补丁全部删掉了 —— 放大阶梯重试、彩底区块二次识别、
反色补识别、页面分割模式调参，都不再需要（PP-OCR 的检测模型自己处理小字和彩底白字）。

### 4.2 接入踩过的坑（都是实测结论，不是推测）

**① 输入必须是 RGBA 四通道原始像素，而且 Windows 上要换通道。**
Electron 的 `nativeImage.toBitmap()` 在 Windows 返回的是 **BGRA**，macOS 才是 RGBA。
不换通道会得到一张红蓝互换的图 —— 中文还能认出来，但置信度会掉，彩底白字直接崩。
见 `src/ocr.js` 的 `toRGBA()`。

**② `detect()` 返回的 box 不在原图坐标系里。**
它在「把图向上补齐到 32 的倍数」之后的空间里（420px 宽的图，`resizedImageWidth` 报 448）。
必须按 `原图宽 / resizedImageWidth` 还原，否则整体偏移。
实测：CSS 绝对定位在 `left=50 top=100` 的文字，box 报 `(53,109)`；还原后偏移仅 `(−0.3, +2.2)px`。

**③ 检测模型不做下采样，大图是按原尺寸推理的。**
`multipleOfBaseSize(image)` 调用时没传 `maxSize`，上游那段「缩到 960」的代码是死代码。
所以耗时随像素线性上涨；`src/ocr.js` 里 `MAX_SIDE = 2400` 只是延迟保护，正常框选区域远达不到。

**④ 相邻 UI 元素会被并成一行。**
检测框是连通域 + `unclip_ratio = 1.5` 外扩（`@gutenye/ocr-common/src/backend/splitIntoLineImages.ts:108`
硬编码，Node 路径没有出口）。测试卡片里蓝底按钮 `Get Started` 和红底徽标 `NEW`
被识别成一行 `Get Started NEW` —— 就地替换时一段只能取一个背景色，
画出来就是蓝底上盖着红块，而且取到的文字色是徽章的红。

> 解法：`src/ocr.js` 的 `splitByColumnGap()` 做后处理 —— 算**列剖面**，
> 出现「宽度 > 0.9 倍框高」的连续空白列就切开。普通空格约 0.3em、三个连续空格约 0.9em，
> 都够不到这个阈值，所以正常文本不会被误切；切开后按比例把识别文本也切回去
> （`splitTextAtGaps()`，优先在附近的空格处落刀）。
> 效果：`Get Started`→`开始`（蓝底白字）、`NEW`→`新`（红底白字），两个元素的背景色和文字色都对了。

**⑤ 检测框的高度不能用来推字号。**
框高相对墨迹的外扩量**不稳定**：同一张卡片上 38px 标题框高 37（比墨迹 39 还小），
19px 正文框高 23（比墨迹 20 大 3px）。拿框高乘系数推字号，实测误差 38→36、19→22、24→25（最差 +16%）。
详见 5.1。

**⑥ PP-OCR 也会在汉字之间插空格**（`待 付款`），`normalizeCJK()` 负责还原。

**⑦ 打包必须解包，而且模型路径要显式传。**
`onnxruntime` 是原生模块、用系统文件读取，**读不到 asar 里的虚拟路径** ——
所以 `onnxruntime-node` / `sharp` / `@img` / `@gutenye` / `@techstark` 都进了 `asarUnpack`。
另外 `@gutenye/ocr-models` 内部用 `__dirname` 解析模型路径，打进 asar 后失效，
所以 `src/ocr.js` 必须显式把 `models` 路径传进 `Ocr.create()`。

**⑧ 包是 ESM，CommonJS 下只能动态 import。**
`@gutenye/ocr-node` 的 `package.json` 是 `"type": "module"`，`require()` 会报错，
`src/ocr.js` 里用的是 `await import('@gutenye/ocr-node')`。

### 4.3 复现与排查

```bash
npm run uitest        # 端到端：造卡片 → 真实 OCR+翻译 → 就地替换 → 出图（含小字回归）
npm run test:hotkey   # 单测：快捷键安全校验 + 改键失败回滚（纯 Node，不需要 Electron）
npm run test:datadir  # 测试：数据目录校验 / 迁移 / 不覆盖已有数据 / reset
npm run test:settings # UI 测试：起真窗口模拟按键录制、数据目录交互，断言无 console 报错
npm run test:fontsize # 验收：12 行已知字号的合成卡片 → 真 OCR → 比对 estimateFontSize
npm run calib:inkratio # 标定：重算 INK_RATIO（复用生产 measureInk），并与现值对比
npm run diag:ocr      # 逐行打印置信度 / 框高 / 墨迹高 / 框坐标，并画框线图
                      # 默认取最近粘贴到对话里的截图，也可指定：npm run diag:ocr -- 截图.png
node scripts/selftest.js 某张截图.png [--ocr-only]   # 只跑 OCR/翻译链路
```

> `test:datadir` 会往真实默认目录写引导文件，所以脚本自带三重保护：开跑前发现已有引导文件就直接
> 中止（绝不覆盖你的真实设置）、全程 `try/finally` 保证清理、结束打印引导文件是否已删除。
> 另外它是用 `node scripts/start.js <脚本>` 启动的，Electron 找不到 package.json，
> `app.name` 会退化成 `Electron`，所以它操作的「默认目录」是 `%APPDATA%\Electron` 而不是
> `%APPDATA%\SnapTrans` —— 反而更安全，碰不到你的真实配置。

`npm run uitest` 会产出 `demo/demo-before.png`（原图）、`demo/demo-after.png`（替换后）、
`demo/uitest-report.json`（每段的原文/译文/取到的背景色/文字色/字号/对齐/字重）。

**小字回归用例**保留在 `uitest.js` 里：90×39 的裁片里那行字只有约 11px 高。
这是当年 Tesseract 最致命的短板（整图识别全部返回空，用户看到「没有识别到文字」），
换 PP-OCR 后天然就能认，这条用例用来钉住这个能力，防止以后调参把它弄丢。

> 排查小技巧：`npm run diag:ocr` 的输出里同时给了**框高**和**墨迹高**两列。
> 两者对不上是正常的（见 4.2 ⑤）；**要判断字号看墨迹高，不要看框高**。

---

## 5. 译文保真：位置、字号、颜色、字重

就地替换的观感取决于四个量是否还原得准，`src/pipeline.js` + `renderer/objects.js` 分别处理：

| 量 | 做法 |
|---|---|
| **位置 / 尺寸** | 直接用 OCR 的 bbox 外扩一点作为绘制框，译文在其中自适应换行缩放 |
| **背景色** | 取 bbox 外扩一圈的**众数颜色**（避开文字本身），盖住原文 |
| **文字色** | 取 bbox 内「与背景色距离最大的 6% 像素」的平均色 |
| **字号** | 见下 |
| **对齐** | 多行看各行中心是否对齐；单行默认左对齐（保留原始 x0 最稳） |
| **字重** | 按原文字形的**笔画粗细**判定，见下 |

### 5.1 字号：从像素量墨迹，不要信 OCR 的框

**不能用段落 bbox 高度**：多行段落的 bbox 把**行距**也算进去了 → 2 行正文算出 34px，实际 19px。

**也不能用 OCR 的行框高度**（这是换 PP-OCR 后新踩的坑）：
框高相对墨迹的外扩量**不稳定**，同一张卡片上：

| 文本 | 实际字号 | OCR 框高 | 真实墨迹高 |
|---|---:|---:|---:|
| 标题（38px bold） | 38 | 37 | 39 |
| 正文第 1 行（19px） | 19 | 23 | 20 |
| `Regular weight sample`（24px） | 24 | 26 | 25 |

框高乘系数推字号，实测误差 38→36、19→22、24→25（最差 **+16%**）。

**现在的做法：从像素量墨迹高度，再按字形类别折算。**

`src/ocr.js` 的 `measureInk()`：在框上下各放开 0.9 倍框高的窗口里算**行剖面**
（每行有多少像素明显偏离该行中位亮度），按剖面切成「墨迹带」，取与 OCR 框竖直重叠最大的那条。
相邻行之间是空白行，会自然切成两条带，所以放开窗口不会串行。

两个参数是扫出来的（`THRESH = 80`、`MIN_PIX = 2`）：40 会把抗锯齿的浅色毛边也算成墨迹
（38px 标题多算 2px），120 以上又会把细笔画的升部（`button.` 的 b/t 竖干）整段丢掉。
在这组参数下，同类样本的「墨迹/字号」离散度只有 **0.5%**。

再按字形类别折算成 em（在 Microsoft YaHei 上实测标定，每类 6 个样本、12~38px）：

| 类别 | 判据 | 标定值（墨迹/字号） | 代码里取的系数（字号 = 墨迹 ÷ 系数） |
|---|---|---|---|
| `cjk` | 汉字占比 > 40% | 0.9386 | **0.95** |
| `desc` | 有降部 `g j p q y` | 1.0599 | **1.05** |
| `asc` | 只有升部 / 大写 | 0.7524 | **0.75** |
| `xh` | 只有 x 高度 | 0.5361 | **0.55** |

标定脚本是 `scripts/calib-inkratio.js`（`npm run calib:inkratio`），它**直接复用生产代码的
`measureInk()`**，所以标定值与实现不会各自漂移；跑完还会把标定值和 `INK_RATIO` 现值逐类对比，
最大偏差 > 0.03 就提示更新。换 OCR 模型（比如升到 PP-OCRv5）时重跑这个脚本即可。

段落内取**最高那一行**的墨迹（最高行最能反映 em 尺寸，其他行可能只有 x 高度）。

**三条踩过的坑**（前两条在 `classifyInk()` 的注释里，第三条在标定脚本的自检里）：

1. 升部字母是 `bdfhklt`，**不含 c/e**（它们跟 x 一样高）。曾经写成 `[A-Zb-df-hklt0-9]`，
   把 c 也算进来了，于是纯 x 高度的 `we assume success` 被判成 `asc`，20px 估成 15px。
2. **词首的大写不可信** —— PP-OCR 会把行首小写字母「纠正」成大写：
   实际渲染的是小写 `we assume success`，OCR 给出 `We assume success`。
   所以只在「整行没有小写字母」（真·全大写，如 `SAVE CHANGES`）时才拿大写字母当墨迹顶部。
3. **标定样本自己会标错类别** —— `xh` 组里曾放着 `no errors occurred`，它含升部字母 `d`，
   墨迹被升部撑高（24px 量到 19px，比值 0.792），把 `xh` 的均值从 0.54 抬到 0.58、
   标准差从 0.020 拉到 0.098。所以标定脚本现在**先跑一遍自检**：每个样本都要满足
   `classifyInk(样本) === 声明的类别`，不符就直接退出，不产出结果。

**验收结果**（`scripts/test-fontsize.js` 的合成卡片，12 行覆盖 4 类字形 × 多字号、中英文各一组，`npm run test:fontsize` 可复现）：

```
真实 | 估计 | 误差  | 类别      | 墨迹 | 文本
  38 |   38 |    +0 | desc/desc | 40.0 | Translate any text on your screen
  19 |   19 |    +0 | desc/desc | 20.0 | Press Alt+Shift+A, then drag to select
  24 |   24 |    +0 | desc/desc | 25.0 | Regular weight sample text here
  38 |   39 |    +1 | cjk/cjk   | 37.0 | 截图翻译可以直接替换原文
  19 |   20 |    +1 | cjk/cjk   | 19.0 | 识别到的文字会就地替换，保留字号与颜色
  15 |   14 |    -1 | cjk/cjk   | 13.0 | 框选之后点击翻译按钮即可
  20 |   20 |    +0 | asc/asc   | 15.0 | SAVE CHANGES
  20 |   21 |    +1 | asc/asc   | 16.0 | Submit
  20 |   20 |    +0 | xh/xh     | 11.0 | we assume success
  15 |   15 |    +0 | desc/desc | 16.0 | joggy puppy jumping
  13 |   13 |    +0 | cjk/cjk   | 12.0 | 本地识别不需要联网也能用
  13 |   13 |    +0 | asc/asc   | 10.0 | Cancel

共 12 行可比对，0 行未识别；最大误差 6.7%
```

换引擎前同一张卡片是 38→36、19→22、24→25。

### 5.2 字重怎么判

量 bbox 内**水平墨迹游程的中位数 ÷ bbox 高度**（笔画越粗比值越大）。两个关键点：

1. 墨迹阈值必须按**实测的前景/背景对比度**归一化。用绝对阈值时，低对比度的灰色文字被少算、
   高对比度的黑色文字被多算 —— 同为常规体，19px 灰字量出 0.05、24px 黑字量出 0.12，差一倍。
2. 阈值必须**随字高变化**。小字号时栅格化把笔画下限压到 1px，比值被系统性抬高
   （15px 粗体 0.364，而 38px 粗体只有 0.154）。

实测标定（同色同底）：24px 常规 `0.080` / 24px 粗体 `0.160`；19px 常规 `0.050`；
20px 粗体 `0.235`；38px 粗体 `0.154`；15px 粗体 `0.364`。
最终取 capH ≥ 20 时阈值 0.12，之后每 px 线性抬到 capH=11 时的 0.25 —— 6/6 全对。

> 这套判定是在合成样本上标定的启发式，真实截图里字体千差万别。如果发现误判，
> 设置里关掉「译文自动判断粗体」即可。

---

## 6. 目录结构

```
snaptrans/
├─ main.js                  主进程：托盘、全局快捷键、多屏遮罩、贴图窗口、IPC
├─ preload.js               contextBridge 暴露的渲染层 API
├─ src/
│  ├─ settings.js           配置读写（userData/settings.json）
│  ├─ datadir.js            数据目录重定向（引导文件 + 迁移 + 失败退回默认）
│  ├─ hotkey.js             全局快捷键：安全校验 + 注册策略（失败回滚旧键）
│  ├─ gpu.js                渲染后端配置（默认软件渲染，规避 GPU 进程崩溃）
│  ├─ ocr.js                PaddleOCR 封装：像素级墨迹测量 + 列空白切分 + 行/段落聚合
│  ├─ translate.js          免费接口（有道/MyMemory/必应/Google）+ OpenAI 兼容大模型
│  ├─ pipeline.js           OCR → 翻译 串联；按墨迹高推算字号 / 推断对齐
│  └─ native.js             PowerShell 调 user32.dll，长截图滚动用
├─ renderer/
│  ├─ overlay.html/css/js   框选遮罩 + 工具栏 + 画布编辑 + 翻译渲染
│  ├─ objects.js            绘图对象模型：绘制/命中测试/缩放/译文排版/取色/字重判定
│  ├─ icons.js              工具栏 SVG 图标
│  ├─ pin.html/js           贴图窗口
│  └─ settings.html/js      设置面板
├─ scripts/
│  ├─ start.js              启动器（清理环境变量后拉起 Electron）
│  ├─ make-icons.js         纯 Node 生成 PNG/ICO 图标（无第三方依赖）
│  ├─ selftest.js           命令行 OCR + 翻译自检
│  ├─ uitest.js             端到端验证：造卡片 → 真实 OCR+翻译 → 出图 + 报告
│  ├─ hotkey-test.js        单测：快捷键安全校验 + 失败回滚（纯 Node）
│  ├─ datadir-test.js       测试：数据目录校验 / 迁移 / 不覆盖 / reset
│  ├─ settings-uitest.js    UI 测试：设置面板（按键录制 / 数据目录）真窗口交互
│  ├─ test-fontsize.js      验收：已知字号卡片 → 真 OCR → 比对 estimateFontSize
│  ├─ calib-inkratio.js     标定：重算 INK_RATIO（复用生产 measureInk）
│  └─ diag-ocr.js           诊断：逐行置信度/框高/墨迹高 + 画框线图
├─ demo/                    uitest / test:fontsize / calib 产出的图与报告
└─ assets/                  托盘/应用图标
```

> `main.js` 支持 `--check-ocr [图片]`：加载引擎（可选再识别一张图）后退出，
> 退出码 0/1 表示通过与否。打包版是 GUI 程序、stdout 拿不到，所以它同时把结果写进
> `snaptrans.log`，用来做「打包后 ONNX 原生模块还能不能加载」的冒烟。

---

## 7. 已知限制

- **主力平台是 Windows**。macOS 已做适配（见 [README-macOS.md](README-macOS.md)），
  但只覆盖 **Apple Silicon**：上游 `onnxruntime-node` 在 macOS 上只提供 arm64 二进制，
  Intel Mac 用不了本地 OCR。Linux 未验证。
- **长截图仅 Windows**：依赖 PowerShell 调 `user32.dll` 模拟滚轮，macOS / Linux 上按钮会直接隐藏。
- **长截图**是「模拟滚轮 + 按重叠区拼接」，对固定表头 / 视差滚动 / 无限加载的页面效果有限，最多抓 12 帧。
- 翻译替换依赖 OCR 的外框，**竖排文字、艺术字、复杂背景上的文字**替换后可能不够自然。
- OCR 对**清晰的界面文字**效果好（标题、正文、按钮、徽章、彩底白字），实测 11px 级别的英文小字也能认；
  但**花体、艺术字、复杂照片背景上的文字**仍会掉准确率 —— 这类场景建议改用大模型引擎。
- **竖排文字**不在覆盖范围内（PP-OCRv4 用的是横排检测模型，没启用角度分类器）。
- 字号与字重都是**从像素反推的估算**（见第 5 节），真实截图里字体千差万别，偶有偏差。可在设置里关掉「自动判断粗体」。
- **一行里塞了多个不同背景的元素**（按钮 + 徽标）会被检测框并成一行，靠 `splitByColumnGap()`
  按列空白再切开兜住（见 4.2 ④）。如果两个元素挨得极近（间隔小于 0.9 倍字高）就切不开，
  那一行会取到单一背景色，观感会差一些。
- 检测模型**不做下采样**，耗时随选区像素线性上涨。正常框选区域（几百像素见方）在 1 秒内；
  整屏 4K 全选会明显变慢，`src/ocr.js` 里 `MAX_SIDE = 2400` 会先缩一次再识别。
- 免费翻译接口是公开服务，偶发限流或不可用属正常，界面会给出失败原因，可切到大模型引擎。

---

## 8. 常见问题

**快捷键按了没反应？**
可能被微信 / QQ 等占用。托盘右键 → 设置 → 点一下快捷键输入框，直接按一个新的组合（例如 `Ctrl`+`Alt`+`Q`）。
如果新组合也被占用，界面会提示，并且原来的快捷键会自动保留下来。

**改快捷键时提示「注册失败」，我的旧快捷键还在吗？**
在。程序是先注册新键、成功才摘掉旧键；新键失败会把旧键原样装回去，
不会出现「改一次设置就彻底没有快捷键」的情况。

**想关闭全局快捷键？**
设置里点快捷键输入框右侧的 `×`。托盘菜单和双击托盘图标仍然可以截图。

**改了数据目录，为什么数据还在原来的地方？**
需要**重启**才生效 —— Electron 的 userData 路径只能在程序启动前设置。
点界面上的「立即重启」即可。重启后日志里会有一行 `数据目录： <路径> (自定义)` 可以确认。

**换了数据目录之后程序打不开 / 配置丢了？**
不会打不开。如果自定义目录不可用（盘符没了、目录被删、没权限），程序会自动退回默认目录，
并在日志里写明原因。把盘接回来或重建目录，再重启就恢复了。
要主动改回默认，设置里点「恢复默认」再重启；也可以直接删掉引导文件
`%APPDATA%\SnapTrans\datadir.txt`。

**数据目录里都有什么？**
`settings.json`（配置）和 `snaptrans.log`（日志）。OCR 模型是随程序带的，
在安装目录的 `resources/models/` 下（约 16MB），不占数据目录。
托盘菜单的「打开数据目录」可以直接跳过去。

**第一次翻译很慢？**
首次要加载 ONNX 会话（实测约 500ms，冷启动更久）。程序启动 4 秒后会自动预热，之后每次翻译通常在 1 秒内。

**翻译出来是空的 / 报「没有识别到文字」？**
框选区域里确实没有可识别文字。PP-OCRv4 对常规界面文字（含 11px 级小字、彩底白字）识别率很高，
如果仍失败，通常是字太小、对比度太低、或者是花体/艺术字，把框拉大一点、或切到大模型引擎再试。

**想换成自己的私有化 OCR？**
`src/ocr.js` 的对外契约是 `recognize(dataUrl) -> { lines, paragraphs, size }`，
其中 `lines[i] = { text, bbox, inkHeight, confidence, poly }`。
换掉 `recognize` 的实现即可，`src/pipeline.js` 和渲染逻辑都不用动 ——
只要记得**填 `inkHeight`**（从像素量出来的真实墨迹高度），字号还原全靠它。

**程序没反应 / 托盘图标不见了？**
主进程会把启动过程写进日志，位置：

```
%APPDATA%\SnapTrans\snaptrans.log
```

里面有版本、是否打包、**数据目录（是默认还是自定义、有没有退回）**、快捷键是否注册成功
（注册的是哪个键、失败原因）、OCR 预热结果，以及任何未捕获异常。反馈问题时附上这个文件即可。

> 注意：改了数据目录之后，日志也跟着搬到新目录里去了。

---

## 9. 打包说明

```bash
npm run pack    # 只出免安装目录 dist/win-unpacked/
npm run dist    # 出安装包 dist/SnapTrans Setup 1.0.0.exe + portable 版
```

macOS 的打包配置（`npm run dist:mac`）与验证步骤见 [README-macOS.md](README-macOS.md)。

打包输出目录**每次换一个新的**（`--config.directories.output=dist-xxx`）。
同一个目录重复打包会撞上 `EBUSY: resource busy or locked, unlink ...app.asar` ——
上一轮遗留的 `app.asar` 被锁住，`tasklist` 里查不到任何相关进程，属环境级问题，换目录最省事。

`package.json` 里配了 `"electronDist": "node_modules/electron/dist"`，让 electron-builder 直接复用本地已装好的 Electron 二进制，**避免每次打包都去 GitHub 重新下载**（网络受限时这一步会直接失败）。

打包产物里 `resources/models/` 带上了 PP-OCRv4 的检测 + 识别模型和字典（约 16MB），所以装完即可离线使用，不需要联网下载任何东西。

### 9.1 打包后必须做的冒烟

`main.js` 里有一个 `--check-ocr` / `SNAPTRANS_CHECK_OCR` 入口：加载 OCR 引擎（可选再识别一张图）后退出，
退出码 0/1 表示通过与否，同时把结果写进 `snaptrans.log`。

```bash
# 免安装目录
env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS SNAPTRANS_CHECK_OCR="<绝对路径>/demo/demo-before.png" \
  ./dist/win-unpacked/SnapTrans.exe

# 便携版（自解压到 %TEMP%，工作目录会变，所以图片路径必须是绝对路径）
env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS SNAPTRANS_CHECK_OCR="<绝对路径>/demo/demo-before.png" \
  "./dist/SnapTrans 1.0.0.exe"
```

> 图片路径**一律写绝对路径**。便携版会把自身解压到 `%TEMP%` 再启动，工作目录不是仓库根目录；
> 开发态虽然能认相对路径，但统一用绝对路径可以避免两种模式行为不一致。
> 指定了图片却找不到时，冒烟会**明确失败**（记 `找不到图片，无法识别` 并退出码 1），不会静默放行。

通过时的输出（实测）：

```
[main] 启动：版本 1.0.0，打包=true，资源目录=...\dist\win-unpacked\resources
[main] check-ocr：模型目录= ...\dist\win-unpacked\resources\models
[ocr] 引擎就绪（PaddleOCR PP-OCRv4 / ONNX Runtime），耗时 582 ms
[main] check-ocr：识别 7 行 / 6 段（图 760x460）
[main] check-ocr： 通过
```

> ⚠️ **三个坑，都会让人误以为「打包版坏了」**：
>
> 0. **判定那一行必须同步写日志**。`log()` 走的是 `fs.createWriteStream`（异步、有缓冲），
>    而冒烟结尾紧接着 `app.exit()` —— `exit` 不等流刷盘，于是 `check-ocr： 通过/未通过`
>    这一行**永远写不进日志**（实测反复复现），只能靠退出码反推，排查时很误导。
>    所以退出前落地的日志用 `logSync()`（`fs.appendFileSync`）。
> 1. **必须清掉 `ELECTRON_RUN_AS_NODE`**。本机（IDE 内置终端）默认设了 `ELECTRON_RUN_AS_NODE=1`，
>    它会让 `SnapTrans.exe` **退化成普通 Node**：`--version` 输出 `v20.18.3`、
>    带任何 `--xxx` 参数都报 `bad option`、不带参数就变成 Node REPL 卡死（无任何输出）。
>    开发态之所以没事，是因为 `scripts/start.js` 会先删掉这个变量再拉起 Electron。
>    正式用户双击图标不会遇到这个问题（桌面环境没这个变量）。
> 2. **打包版对不认识的 `--xxx` 会直接 `bad option` 退出**（因为上一条：它其实是 Node）。
>    所以冒烟走环境变量 `SNAPTRANS_CHECK_OCR`，不要用命令行开关。
>
> 另外，**重复打包到同一个输出目录**时，如果上一次的 `app.asar` 还被某个进程（杀软 / 索引器）持有，
> electron-builder 会以 `EBUSY: resource busy or locked, unlink ...app.asar` 失败。
> 换一个 `-c.directories.output=<新目录>` 即可。
>
> 代价是**旧输出目录会留下删不掉的残渣**：`rd /s /q` 报「另一个程序正在使用此文件」、
> `ren` 报「拒绝访问」，但 `tasklist` 里又查不到任何 SnapTrans/electron 进程 ——
> 是环境级的文件锁，跟项目无关。此时目录里只剩一个 780KB 上下的 `app.asar`，
> 其余文件用 `[System.IO.File]::Delete()` 逐个删（绕开回收站）都能清掉。
> 结论：打包输出目录**每次换新的**，别复用；清理时忽略那几个残渣即可。

### 9.2 体积构成与优化（实测数据）

从 Tesseract 换到 PP-OCRv4 之后重新测的（同一台机器、同一份 `package.json` 配置）：

| 项目 | Tesseract 版 | PaddleOCR 版 |
|---|---:|---:|
| 便携版 `SnapTrans 1.0.0.exe` | 104.3 MB | **99.9 MB** |
| 安装包 `SnapTrans Setup 1.0.0.exe` | 104.5 MB | **100.2 MB** |
| `dist/win-unpacked/` 展开后 | 273 MB | 303 MB |
| `resources/app.asar` | 14.0 MB | **0.8 MB** |
| `resources/app.asar.unpacked/` | — | 58.1 MB |
| `resources/models/` | （原 `lang-data/`）29.6 MB | 15.4 MB |
| `locales/` | 2 个 | 2 个 |

**压缩后净省 4.4 MB**，尽管展开体积大了 30MB —— 因为 ONNX 原生库（`onnxruntime.dll` 28.7MB）
压缩率远好于 Tesseract 的语言包（本身就是压缩数据，压不动）。
`app.asar` 从 14MB 掉到 0.8MB，是因为原生模块和模型全部挪出了 asar。

体积是怎么压下来的，按收益排序：

1. **`"compression": "maximum"`** —— electron-builder 默认用 deflate；改成 LZMA/7z 后，Electron 运行时本身（`SnapTrans.exe` 展开 180MB）被压到约 55MB。**这是单项收益最大的一步**。
2. **`"electronLanguages": ["zh-CN", "en-US"]`** —— Electron 自带 55 份 `locales/*.pak`，中文用户只需要这两份，省下约 40MB。
3. **`files` 裁掉 onnxruntime 的非本平台二进制** —— `onnxruntime-node` 原始 287MB，只留 `win32/x64`：
   - `bin/napi-v6/darwin/**`（86MB）、`linux/**`（69MB）、`win32/arm64/**`（70MB）—— 本项目只出 Windows x64 包；
   - `win32/x64/DirectML.dll`（18.5MB）+ `dxcompiler.dll`（18MB）+ `dxil.dll`（1.5MB）—— DirectML 是给 GPU 推理用的，
     实测移走后纯 CPU 结果**完全一致**（稳态 408ms）；
   - `script/**`（安装脚本）、`**/*.map`。
   裁完只剩 `onnxruntime.dll` 28.7MB + `onnxruntime_binding.node` 0.3MB。
4. **模型不进 asar，走 `extraResources`** —— 模型是二进制、压不动，而且 `@gutenye/ocr-models`
   内部用 `__dirname` 解析路径，打进 asar 后失效。直接放到 `resources/models/`。

### 9.3 还能更小吗

| 方向 | 能到 | 代价 |
|---|---:|---|
| `@gutenye/ocr-models` 里那个用不上的角度分类模型 `ch_ppocr_mobile_v2.0_cls_infer.onnx` | 约 −0.5 MB | 目前没启用角度分类（`Ocr.create` 只建检测 + 识别两个会话）。想支持竖排文字时还要把它拿回来 |
| 换 `PP-OCRv4_mobile` 的轻量识别模型 | 约 −6 MB | 中文识别精度下降，和换引擎的初衷相反，**不建议** |
| 识别模型改首次运行联网下载 | 约 −10 MB | 首次使用必须联网（离线用户直接不可用），和「离线免费」的产品定位冲突 |

**结论：99.9 MB 里，约 55MB 是压缩后的 Electron 运行时、29MB 是 ONNX 原生库、16MB 是模型，
剩下不到 1MB 是应用代码。** 应用代码本身已经没有可优化的空间了 —— 再往下只能动 Electron 或模型，
都是产品形态的选择，不是纯优化。
