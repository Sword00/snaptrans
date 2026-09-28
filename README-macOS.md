# SnapTrans 在 macOS 上运行

> 这份文档是给「在 Mac 上验证」用的。Windows 的说明见 [README.md](README.md)。

---

## 0. 先说清楚：什么能跑、什么不能

| 能力 | macOS 状态 | 说明 |
| --- | --- | --- |
| 托盘常驻 / 菜单栏图标 | ✅ 已适配 | 纯黑 template image，亮色暗色菜单栏都自动反色 |
| 全局快捷键 | ✅ 已适配 | 默认 `Command+Shift+A`（Windows 是 `Alt+Shift+A`） |
| 框选截图（含 Retina） | ✅ 已适配 | 遮罩层按截图实际像素反推 dpr，2x 屏不糊 |
| 屏幕录制授权检测 | ✅ 新增 | 未授权时**明确弹框引导**，不再是「遮罩一片黑」 |
| 本地 OCR（PaddleOCR） | ⚠️ 仅 Apple Silicon | 见 [第 4 节](#4-intel-mac-用不了本地-ocr) |
| 就地翻译替换 / 标注 / 贴图 | ✅ 已适配 | 与 Windows 同一套渲染逻辑 |
| 长截图（滚动拼接） | ❌ 不支持 | 依赖 Windows 的 `user32.dll` 模拟滚轮，按钮会直接隐藏 |
| 打包成 .dmg | ⚠️ 未签名 | 能打出来，但 Gatekeeper 会拦，需要手动放行 |

**我在 Windows 上做的适配，没法产出「双击就能装」的 macOS 包**（dmg 需要 macOS 工具链、签名需要 Apple 开发者账号）。所以这份文档给的是**从源码跑起来**的路径 —— 这是验证成本最低、也最能暴露问题的方式。

---

## 1. 快速开始

```bash
git clone https://github.com/Sword00/snaptrans.git
cd snaptrans
git checkout feat/macos          # macOS 适配在这个分支上
npm install                      # 会下载 darwin 版的 sharp / onnxruntime
npm start
```

`npm install` 会自动跑 `postinstall` 生成图标（含 `icon.icns` 与菜单栏 template 图标），不需要额外步骤。

启动后应该看到：

- 菜单栏出现一个 **取景框 + 字母 A** 的黑色小图标（不是彩色方块 —— 彩色说明 template 图标没生效）
- **Dock 里没有 SnapTrans**（托盘应用，故意藏的）
- 按 `Command+Shift+A` 或点菜单栏图标 → 弹出菜单 → 「截图翻译」

首次截图会触发下面的授权流程。

---

## 2. 首次运行：屏幕录制授权（最容易卡住的一步）

macOS 从 10.15 起，抓屏必须经过「屏幕录制」TCC 授权。这一步有三个坑，代码里都做了处理：

### 坑 1：未授权时不报错，返回的是**全黑图**

`desktopCapturer.getSources()` 在未授权时**既不抛异常、也不返回空数组**，而是返回尺寸正常、内容全黑的缩略图。

如果只判断 `sources.length`（改造前的代码就是这样），会一路走到「遮罩全黑」，用户根本猜不到是权限问题。

现在 `src/platform.js` 会采样缩略图像素，判定「全黑」后直接弹框说明。

### 坑 2：授权后**必须重启应用**才生效

TCC 权限是在**进程启动时**读取的。用户刚在系统设置里打开开关，正在跑的进程拿到的仍然是黑帧。

所以弹框里的按钮是：**打开系统设置 / 重启应用 / 仍然继续 / 取消** —— 「重启应用」不是敷衍的兜底，而是这一步真正的解法。

### 坑 3：状态显示「已授权」但图还是黑的

这正是坑 2 的场景。代码同时看**权限状态**和**像素内容**：

```
status=denied / restricted        → 拦，引导去系统设置
status=granted 但缩略图全黑       → 拦，引导重启应用
status=granted 且图有内容         → 放行
```

判定表在 `src/platform.js` 的 `decideCapture()`，是个纯函数，`npm run test:platform` 里有 11 条用例覆盖（在 Windows 上就能跑）。

### 授权步骤

1. 首次按快捷键 → 弹框说「截取到的画面是全黑的」
2. 点「打开系统设置」→ 直接跳到 **隐私与安全性 → 屏幕录制**
3. 勾选 **SnapTrans**
4. 回到弹框点「重启应用」

> 如果你的桌面本来就是纯黑的，弹框里点「仍然继续」即可绕过（同一个截图会话里只会拦一次）。

---

## 3. 应用菜单与 Dock

### 为什么要装应用菜单

macOS 上 Electron **不装应用菜单，`Cmd+C` / `Cmd+V` / `Cmd+A` / `Cmd+Q` 会全部失效** —— Chromium 把这些编辑快捷键交给菜单的 Edit 角色处理，没有菜单就没有它们。

`src/platform.js` 的 `installMenu()` 装了 `SnapTrans / 编辑 / 窗口` 三个菜单，所以设置窗口里的输入框可以正常复制粘贴。

### 为什么 Dock 里看不到图标

`app.dock.hide()` 把应用变成「附件型应用」（对标 Windows 的 `skipTaskbar`）。副作用是**窗口 `show()` 不会自动抢焦点**，所以：

- 每次截图前调 `app.focus({ steal: true })` —— 不然遮罩层的 `ESC` 收不到
- 权限弹框会**临时把 Dock 图标放出来**，用户才找得到这个框、也能 `Cmd+Tab` 过来

### 托盘图标为什么单击不截图

macOS 上 `tray.setContextMenu()` 之后，**单击托盘图标既会弹菜单、又会再发一个 `click` 事件**。如果 `click` 绑了 `startCapture`，用户每次想看菜单都会顺手截一次屏。

所以 macOS 上只保留菜单交互（菜单第一项就是「截图翻译」）。

---

## 4. Intel Mac 用不了本地 OCR

`onnxruntime-node@1.30.0` 的 `bin/napi-v6/darwin/` 下**只有 `arm64`，没有 `x64`**：

```
$ ls node_modules/onnxruntime-node/bin/napi-v6/darwin/
arm64
```

这不是配置问题，是上游没为 Intel Mac 出预编译二进制。包里的 `package.json` 只声明了 `os: ["win32","darwin","linux"]`，**不含 arch**，所以 npm 不会帮你拦住。

代码的处理方式是「提前说人话」，而不是等原生模块加载失败：

- 启动时 `platform.localOcrSupport()` 检查 `<platform>/<arch>` 目录在不在，日志里写明原因
- `src/ocr.js` 的 `getEngine()` 先探架构再加载，抛出的错误是
  「onnxruntime-node 没有 darwin/x64 的预编译二进制……Intel Mac 无法使用本地 OCR」
- 设置面板「系统权限」卡片会显示红色「不可用」徽章 + 具体原因

**结论：请用 Apple Silicon（M 系列）的 Mac 验证。** 判断方法：

```bash
uname -m     # arm64 = Apple Silicon；x86_64 = Intel
```

---

## 5. 打包成 .dmg（可选）

```bash
npm run dist:mac     # 产出 dmg + zip，只针对 arm64
```

配置在 `package.json` 的 `build.mac`：

- `target`: `dmg` + `zip`，`arch: ["arm64"]`
- `icon`: `assets/icon.icns`（含 16 → 1024 全部尺寸，留了 9.5% 透明外边距符合 macOS 图标栅格）
- `category`: `public.app-category.productivity`
- `notarize: false` / `gatekeeperAssess: false` —— 没有 Apple 开发者账号时不做签名与公证

打出来的包**未签名**，双击会被 Gatekeeper 拦。放行方式：

```bash
xattr -dr com.apple.quarantine "/Applications/SnapTrans.app"
```

或者右键 → 打开 → 在弹框里再点一次「打开」。

要出可分发、免提示的包，需要 Apple Developer 账号（$99/年）做 Developer ID 签名 + 公证 —— 这一步留给你。

### 打包时会自动裁剪

`scripts/afterpack-trim.js` 是 electron-builder 的 `afterPack` 钩子，会把 `app.asar.unpacked` 里非目标平台的 ONNX Runtime 二进制删掉。

`onnxruntime-node` 一个包带了三个平台的二进制（实测 darwin 86MB、linux 69MB、win32 134MB，合计约 290MB），不裁的话每个平台都要白扛另外两个平台 155MB。

---

## 6. 验证清单

跑起来之后，建议按这个顺序确认：

**基础**

- [ ] `npm install` 无报错，`assets/` 下生成了 `trayTemplate.png` / `trayTemplate@2x.png` / `icon.icns`
- [ ] `npm start` 启动后菜单栏出现**黑色**小图标（彩色 = template 没生效）
- [ ] Dock 里没有 SnapTrans
- [ ] 点菜单栏图标 → 弹出菜单（**不应该同时触发截图**）

**权限**

- [ ] 首次按 `Command+Shift+A` → 出现「截取到的画面是全黑的」弹框
- [ ] 点「打开系统设置」→ 直接跳到「隐私与安全性 → 屏幕录制」
- [ ] 勾选 SnapTrans → 点「重启应用」→ 重启后能正常截图

**功能**

- [ ] 框选 → 工具栏出现 → 长截图按钮**不在**（macOS 不支持）
- [ ] 工具栏按钮的提示文字显示 `⌘T` / `⌘Z`（不是 `Ctrl+T`）
- [ ] 点「翻译并就地替换」→ 文字被译文覆盖，字号/颜色/位置对得上
- [ ] Retina 屏上遮罩背景是清晰的（不是糊的）
- [ ] 设置窗口里 `Cmd+C` / `Cmd+V` 能用
- [ ] 设置窗口「系统权限」卡片显示屏幕录制状态与平台信息

**回归**

```bash
npm run test:platform    # 平台适配层 41 项
npm run test:hotkey      # 快捷键注册 35 项
npm run test:settings    # 设置面板 32 项
npm run test:datadir     # 数据目录 27 项
npm run test:fontsize    # 字号估计 12 项
```

---

## 7. 出问题怎么查

日志在数据目录下：

```
~/Library/Application Support/SnapTrans/snaptrans.log
```

启动时会打这几行，先看它们：

```
[main] 平台：macOS arm64（electron 33.x / node 20.x）
[main] 屏幕录制权限状态：granted | denied | not-determined | ...
[main] 已启动，快捷键 Command+Shift+A 注册成功
```

截图被权限守卫拦下时会打：

```
[main] 截图被拦下：blank 权限状态= granted
[main] 用户对权限提示选择了： relaunch
```

数据目录可以用设置面板改（「数据目录」卡片 → 更改…），改完要重启。

---

## 8. 源码里 macOS 相关的改动清单

给需要 review 的人：

| 文件 | 改动 |
| --- | --- |
| `src/platform.js` | **新增**。平台判定、Dock、应用菜单、TCC 权限检测与引导、原生模块架构探测 |
| `main.js` | 接入 platform 层：`hideDock` / `installMenu` / 截图前权限守卫 / 托盘 template 图标 / 新增 `platform:*` IPC |
| `scripts/make-icons.js` | 新增 `drawTrayGlyph()`（纯黑 template）、`buildICNS()`；`drawIcon()` 支持 macOS 图标外边距 |
| `scripts/preview-icons.js` | **新增**。把图标放大贴到模拟菜单栏背景上，本地就能看效果 |
| `scripts/afterpack-trim.js` | **新增**。打包后按目标平台裁剪 ONNX Runtime 二进制 |
| `scripts/platform-test.js` | **新增**。平台层单测（41 项，Windows 上也能跑） |
| `src/settings.js` | 默认快捷键按平台区分（macOS `Command+Shift+A`） |
| `src/ocr.js` | 加载引擎前先探架构，把「原生模块加载失败」翻译成人话 |
| `renderer/overlay.js` | 按平台隐藏长截图按钮、提示文字 `Ctrl` → `⌘` |
| `renderer/settings.js` + `.html` | 新增「系统权限」卡片；字体栈加 macOS 字体 |
| `package.json` | 新增 `mac` target、`afterPack` 钩子、`test:platform` / `icons:preview` / `dist:mac` 脚本 |
