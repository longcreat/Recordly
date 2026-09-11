# 自定义区域录制(Custom Region Capture)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户可拖拽框选屏幕任意矩形区域并只录制该区域(Windows 原生路径),与现有的"整个屏幕/窗口"并列第三个录制源类型。

**Architecture:** 三层:① 原生层 —— `wgc-capture` 仍整屏捕获,`MFEncoder` 在已有的 `CopySubresourceRegion` 源框(`mf_encoder.cpp:200-215`,现为左上角 0,0)上应用 crop 偏移,输出尺寸 = 裁剪尺寸;② 主进程 —— `SelectedSource` 增加 `sourceType: "region"` 与 `region` 负载(DIP 逻辑坐标),`resolveWindowsCaptureTarget` 解析出目标显示器 + 物理像素裁剪矩形,config 增加 `cropX/Y/W/H`;③ 渲染层 —— 新建全屏透明置顶的"区域选择"窗口(复用 source-selector 的窗口创建模式),拖拽画框,Esc 取消,确认后走既有 `select-source` IPC 通道。

**Tech Stack:** C++(WGC + Media Foundation)、Electron BrowserWindow、React。建议在「帧率/画质」计划完成后执行(设置管道已就绪)。

**关键事实(已验证):**
- 编码器帧路径中已存在裁剪先例:`mf_encoder.cpp` 的 `writeFrame` 内 `D3D11_BOX sourceBox`(left/top 现固定 0,输出合成纹理 `resizeCompositeTexture_` 尺寸 = 输出宽高)——**裁剪 = 给 sourceBox 加偏移,改动面极小**
- `main.cpp:320-324`:输出尺寸来自 `config.width/height`(0 则取会话尺寸)并强制偶数对齐——crop 尺寸走同一通道
- `main.cpp:308`:显示器匹配用 `findMonitorByBounds(config.displayX/Y/W/H)`(传整块显示器 bounds,与 crop 独立并存)
- 选源类型:`electron/ipc/types.ts:3` `sourceType?: "screen" | "window"`
- 目标解析:`electron/ipc/windowsCaptureSelection.ts:82` `resolveWindowsCaptureTarget`(display/window 两分支)
- 选源完成通道:`electron/ipc/register/sources.ts:309` `select-source` handler(写入 selectedSource、广播、关闭选源窗口)——region 选择完成后直接复用
- 选源窗口创建范式:`electron/windows.ts:1037` `createSourceSelectorWindow`(frame:false + transparent + alwaysOnTop + `?windowType=source-selector`)
- Windows 物理坐标换算先例:`register/recording.ts:487-491`(`Math.round(logical * scale)`)
- **范围限定**:Windows 原生路径;macOS 与浏览器回退本期不支持 region(UI 入口按平台/路径隐藏)

---

### Task 1: C++ —— MFEncoder 裁剪偏移

**Files:**
- Modify: `electron/native/wgc-capture/src/mf_encoder.h:23,44-60`
- Modify: `electron/native/wgc-capture/src/mf_encoder.cpp:36-90`(initialize)、`:195-220`(writeFrame 的 sourceBox)
- Modify: `electron/native/wgc-capture/src/main.cpp:34-48,150-158,320-334`

- [ ] **Step 1: struct + 解析**

`CaptureConfig` 加:

```cpp
int cropX = -1;
int cropY = -1;
int cropW = 0;
int cropH = 0;
bool hasCrop = false;
```

`parseSimpleJson` 加(displayX 块之前):

```cpp
int cw = findInt("cropW");
int ch = findInt("cropH");
int cx = findInt("cropX");
int cy = findInt("cropY");
if (cw > 0 && ch > 0 && cx >= 0 && cy >= 0) {
    config.cropX = cx;
    config.cropY = cy;
    config.cropW = cw;
    config.cropH = ch;
    config.hasCrop = true;
}
```

- [ ] **Step 2: initialize 加 crop 参数(默认 0,不破坏既有调用)**

`mf_encoder.h`:

```cpp
bool initialize(const std::wstring& outputPath, int width, int height, int fps,
                ID3D11Device* device, ID3D11DeviceContext* context,
                int cropLeft = 0, int cropTop = 0);
```

private 成员加 `int cropLeft_ = 0; int cropTop_ = 0;`,实现中赋值。

- [ ] **Step 3: writeFrame 的 sourceBox 应用偏移**

现有代码(mf_encoder.cpp:202-209):

```cpp
D3D11_BOX sourceBox = {};
sourceBox.left = 0;
sourceBox.top = 0;
sourceBox.front = 0;
sourceBox.right = (std::min)(sourceDesc.Width, static_cast<UINT>(width_));
sourceBox.bottom = (std::min)(sourceDesc.Height, static_cast<UINT>(height_));
sourceBox.back = 1;
```

改为:

```cpp
D3D11_BOX sourceBox = {};
sourceBox.left = static_cast<UINT>(cropLeft_);
sourceBox.top = static_cast<UINT>(cropTop_);
sourceBox.front = 0;
sourceBox.right = (std::min)(sourceDesc.Width, static_cast<UINT>(cropLeft_ + width_));
sourceBox.bottom = (std::min)(sourceDesc.Height, static_cast<UINT>(cropTop_ + height_));
sourceBox.back = 1;
if (sourceBox.right <= sourceBox.left || sourceBox.bottom <= sourceBox.top) return false;
```

- [ ] **Step 4: main.cpp 装配**

`:320` 附近,输出尺寸改为优先取 crop:

```cpp
int captureWidth = config.hasCrop
    ? config.cropW
    : (config.width > 0 ? config.width : session.captureWidth());
int captureHeight = config.hasCrop
    ? config.cropH
    : (config.height > 0 ? config.height : session.captureHeight());
```

encoder 构造(`:329`)传 crop:

```cpp
if (!encoder.initialize(outputPathW, captureWidth, captureHeight, config.fps,
                       session.device(), session.context(),
                       config.hasCrop ? config.cropX : 0,
                       config.hasCrop ? config.cropY : 0)) {
```

注意:若画质计划已合入,此处 initialize 还带 `bitratePercent` 参数——保持两个参数并存(cropLeft, cropTop, bitratePercent 顺序以头文件为准)。

- [ ] **Step 5: 编译 + 手动冒烟**

Run: `npm run build:windows-capture`
手动:在 `register/recording.ts` 临时硬编码 `cropX: 100, cropY: 100, cropW: 960, cropH: 540` 录 10 秒 → 产物应为 960×540、内容为屏幕 (100,100) 起 960×540 区域。验证后删除硬编码。

- [ ] **Step 6: Commit**

```bash
git add electron/native/wgc-capture/src/ electron/native/bin/win32-x64/
git commit -m "Crop WGC frames to a sub-rectangle in the encoder"
```

---

### Task 2: 主进程 —— region 源类型解析

**Files:**
- Modify: `electron/ipc/types.ts:3`
- Modify: `electron/ipc/windowsCaptureSelection.ts`
- Test: `electron/ipc/windowsCaptureSelection.test.ts`(既有文件追加)

- [ ] **Step 1: 写失败测试(追加到既有 describe 平级)**

```typescript
describe("region capture target", () => {
	const displays = [
		{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
		{ id: 2, bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, scaleFactor: 2 },
	];

	it("resolves a region on the requested display with DIP-to-physical conversion", () => {
		const target = resolveWindowsCaptureTarget(
			{
				name: "Region",
				display_id: "2",
				sourceType: "region",
				region: { x: 1920 + 100, y: 50, width: 400, height: 300 },
			},
			displays,
			displays[0],
		);
		expect(target.kind).toBe("region");
		if (target.kind !== "region") return;
		expect(target.region).toEqual({ x: 200, y: 100, width: 800, height: 600 });
	});

	it("clamps an oversized region to display bounds", () => {
		const target = resolveWindowsCaptureTarget(
			{
				name: "Region",
				display_id: "1",
				sourceType: "region",
				region: { x: 1800, y: 1000, width: 500, height: 200 },
			},
			displays,
			displays[0],
		);
		expect(target.kind).toBe("region");
		if (target.kind !== "region") return;
		expect(target.region.width).toBe(120);
		expect(target.region.height).toBe(80);
	});

	it("treats a missing/invalid region as a full-display capture", () => {
		const target = resolveWindowsCaptureTarget(
			{ name: "Screen", display_id: "1", sourceType: "region" },
			displays,
			displays[0],
		);
		expect(target.kind).toBe("display");
	});
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest --run electron/ipc/windowsCaptureSelection.test.ts`
Expected: FAIL(`kind: "region"` 分支不存在,返回 "display")

- [ ] **Step 3: 实现**

`types.ts`:

```typescript
export type SelectedSourceRegion = { x: number; y: number; width: number; height: number };

export type SelectedSource = {
	id?: string;
	name: string;
	display_id?: string;
	sourceType?: "screen" | "window" | "region";
	region?: SelectedSourceRegion;
	appName?: string;
	windowTitle?: string;
	[key: string]: unknown;
};
```

`windowsCaptureSelection.ts` —— `ResolvedWindowsCaptureTarget` union 加:

```typescript
| {
		kind: "region";
		displayId: number;
		bounds: { x: number; y: number; width: number; height: number };
		scaleFactor: number;
		region: { x: number; y: number; width: number; height: number };
	}
```

`resolveWindowsCaptureTarget` 在 window 分支之后、display 分支之前加:

```typescript
if (source?.sourceType === "region") {
	const resolvedDisplay = resolveWindowsCaptureDisplay(source, allDisplays, primaryDisplay);
	const raw = source.region;
	if (
		!raw ||
		typeof raw.x !== "number" ||
		typeof raw.y !== "number" ||
		typeof raw.width !== "number" ||
		typeof raw.height !== "number" ||
		raw.width <= 0 ||
		raw.height <= 0
	) {
		return { kind: "display", ...resolvedDisplay };
	}
	const scale = resolvedDisplay.scaleFactor;
	// Region coords are DIP logical screen coords; convert to physical px relative to the display.
	const regionX = Math.max(0, Math.round((raw.x - resolvedDisplay.bounds.x) * scale));
	const regionY = Math.max(0, Math.round((raw.y - resolvedDisplay.bounds.y) * scale));
	const maxWidth = Math.round(resolvedDisplay.bounds.width * scale) - regionX;
	const maxHeight = Math.round(resolvedDisplay.bounds.height * scale) - regionY;
	return {
		kind: "region",
		displayId: resolvedDisplay.displayId,
		bounds: resolvedDisplay.bounds,
		scaleFactor: scale,
		region: {
			x: regionX,
			y: regionY,
			width: Math.min(Math.round(raw.width * scale), maxWidth),
			height: Math.min(Math.round(raw.height * scale), maxHeight),
		},
	};
}
```

Run: `npx vitest --run electron/ipc/windowsCaptureSelection.test.ts` → PASS

- [ ] **Step 4: Commit**

```bash
git add electron/ipc/types.ts electron/ipc/windowsCaptureSelection.ts electron/ipc/windowsCaptureSelection.test.ts
git commit -m "Resolve region capture sources to physical crop rectangles"
```

---

### Task 3: 主进程 —— 录制启动装配 crop config

**Files:**
- Modify: `electron/ipc/register/recording.ts:460-515`(captureTarget 分支处)

- [ ] **Step 1: region 分支(config 装配)**

`resolveWindowsCaptureTarget` 调用之后,`captureTarget.kind === "window"` 分支的 else 部分改为三分支。region 分支与 display 分支共用显示器匹配,再补 crop:

```typescript
let cropRect: { x: number; y: number; width: number; height: number } | null = null;

if (captureTarget.kind === "window") {
	config.windowHandle = captureTarget.windowHandle;
} else {
	// display 与 region 都按显示器捕获;region 额外携带裁剪矩形
	const monitors = getMonitorHandles();
	const scale = captureTarget.scaleFactor ?? 1;
	const physX = Math.round(captureTarget.bounds.x * scale);
	const physY = Math.round(captureTarget.bounds.y * scale);
	const physW = Math.round(captureTarget.bounds.width * scale);
	const physH = Math.round(captureTarget.bounds.height * scale);

	const matchedMonitor = monitors.find(
		(monitor) =>
			(monitor.x === Math.round(captureTarget.bounds.x) &&
				monitor.y === Math.round(captureTarget.bounds.y)) ||
			(monitor.x === physX && monitor.y === physY) ||
			(Math.abs(monitor.x - physX) <= 4 && Math.abs(monitor.y - physY) <= 4),
	);

	if (matchedMonitor) {
		config.displayId = matchedMonitor.handle;
		config.displayX = matchedMonitor.x;
		config.displayY = matchedMonitor.y;
		config.displayW = matchedMonitor.width;
		config.displayH = matchedMonitor.height;
	} else {
		config.displayId = captureTarget.displayId;
		config.displayX = physX;
		config.displayY = physY;
		config.displayW = physW;
		config.displayH = physH;
	}

	if (captureTarget.kind === "region") {
		cropRect = captureTarget.region;
		config.cropX = cropRect.x;
		config.cropY = cropRect.y;
		config.cropW = cropRect.width;
		config.cropH = cropRect.height;
	}
}
```

同时在 stop 流程无需改动(crop 信息只影响启动 config)。

- [ ] **Step 2: 诊断打点补字段(可观测性)**

`recordNativeCaptureDiagnostics` 的 start 调用处(`:552-565`)加 `region: cropRect`(types 中 `NativeCaptureDiagnostics` 有 `[key: string]: unknown` 式扩展或直接加可选字段,以现有类型为准——若无索引签名则在类型中补 `region?: { x: number; y: number; width: number; height: number } | null;`)。

- [ ] **Step 3: 类型检查 + 全量测试**

Run: `npx tsc -p tsconfig.json --noEmit && npx vitest --run`
Expected: 全绿

- [ ] **Step 4: Commit**

```bash
git add electron/ipc/register/recording.ts electron/ipc/types.ts
git commit -m "Pass region crop rectangles to native capture config"
```

---

### Task 4: 区域选择窗口(主进程侧)

**Files:**
- Modify: `electron/windows.ts`(新增 `createRegionPickerWindow`,照 `createSourceSelectorWindow:1037` 范式)
- Modify: `electron/main.ts`(wrapper + 窗口跟踪,照 `createSourceSelectorWindowWrapper:858`)
- Modify: `electron/ipc/register/sources.ts:309`(select-source 兼容 region 关闭选框窗口)
- Modify: `electron/preload.ts` + `electron/electron-env.d.ts`

- [ ] **Step 1: 窗口创建函数**

`electron/windows.ts` 加(紧挨 createSourceSelectorWindow):

```typescript
export function createRegionPickerWindow(): BrowserWindow {
	const cursorPoint = getScreen().getCursorScreenPoint();
	const display = getScreen().getDisplayMatching(
		{ x: cursorPoint.x, y: cursorPoint.y, width: 1, height: 1 },
	);
	const win = new BrowserWindow({
		x: display.bounds.x,
		y: display.bounds.y,
		width: display.bounds.width,
		height: display.bounds.height,
		frame: false,
		resizable: false,
		movable: false,
		alwaysOnTop: true,
		transparent: true,
		fullscreen: true,
		skipTaskbar: true,
		show: false,
		...(process.platform !== "darwin" && { icon: WINDOW_ICON_PATH }),
		backgroundColor: "#00000000",
		webPreferences: {
			preload: path.join(electronWindowsDir, "preload.mjs"),
			nodeIntegration: false,
			contextIsolation: true,
		},
	});

	win.webContents.on("did-finish-load", () => {
		setTimeout(() => {
			if (!win.isDestroyed()) win.show();
		}, 100);
	});

	if (VITE_DEV_SERVER_URL) {
		win.loadURL(`${VITE_DEV_SERVER_URL}?windowType=region-picker&displayId=${display.id}`);
	} else {
		win.loadFile(path.join(RENDERER_DIST, "index.html"), {
			query: { windowType: "region-picker", displayId: String(display.id) },
		});
	}

	return win;
}
```

- [ ] **Step 2: main.ts wrapper + 传递**

照 `:858` 模式:

```typescript
let regionPickerWindow: BrowserWindow | null = null;
function createRegionPickerWindowWrapper() {
	regionPickerWindow = createRegionPickerWindow();
	regionPickerWindow.on("closed", () => {
		regionPickerWindow = null;
	});
	return regionPickerWindow;
}
```

并按 `createSourceSelectorWindowWrapper` 的既有传递方式注入到 sources register(若 sources register 已能通过 `getSourceSelectorWindow` 拿窗口,则给它加同款 `getRegionPickerWindow`)。

- [ ] **Step 3: select-source 关闭选框窗口**

`register/sources.ts:309` 的 `select-source` handler 中,在关闭 sourceSelectorWin 的同处加:

```typescript
const regionPickerWin = getRegionPickerWindow();
if (regionPickerWin) {
	regionPickerWin.close();
}
```

Esc 取消走 `window.close()`(渲染层调用新增的 `closeRegionPicker` IPC 或复用既有 close 通道——若 preload 已有 `closeCurrentWindow` 类方法则直接复用,以 `electron-env.d.ts` 现有声明为准)。

- [ ] **Step 4: preload/类型**

preload 暴露(照 getSources 模式):

```typescript
getRegionPickerDisplay: () => ipcRenderer.invoke("get-region-picker-display"),
cancelRegionPicker: () => ipcRenderer.invoke("cancel-region-picker"),
```

`get-region-picker-display` 返回 `{ id, x, y, width, height, scaleFactor }`(渲染层画框需要逻辑坐标);`cancel-region-picker` 关闭窗口且不改变 selectedSource。env.d.ts 同步类型。

- [ ] **Step 5: 类型检查 + Commit**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: 0 errors

```bash
git add electron/windows.ts electron/main.ts electron/ipc/register/sources.ts electron/preload.ts electron/electron-env.d.ts
git commit -m "Add fullscreen region picker window"
```

---

### Task 5: 区域选择 UI(渲染层)

**Files:**
- Create: `src/components/launch/RegionPickerWindow.tsx`(新窗口入口)
- Modify: 窗口路由(找到按 `windowType=source-selector` 分发组件的位置,照它加 `region-picker` 分支)
- Modify: `src/components/launch/SourceSelector.tsx`(加"区域"入口按钮)
- Modify: `src/i18n/locales/*/launch.json`(11 语言,`sourceSelector` 节)

- [ ] **Step 1: i18n key**

`sourceSelector` 节加(en / zh-CN 示例):

```json
"region": "Region",
"regionHint": "Drag to select an area, Enter to confirm, Esc to cancel",
"regionConfirm": "Confirm",
"regionCancel": "Cancel",
"regionTooSmall": "Selected area is too small"
```

zh-CN:

```json
"region": "区域",
"regionHint": "拖拽框选区域,回车确认,Esc 取消",
"regionConfirm": "确认",
"regionCancel": "取消",
"regionTooSmall": "所选区域太小"
```

- [ ] **Step 2: RegionPickerWindow 组件(核心逻辑全量)**

```tsx
import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/contexts/I18nContext";

type DragState = { startX: number; startY: number; x: number; y: number; width: number; height: number } | null;
type DisplayInfo = { id: number; x: number; y: number; width: number; height: number; scaleFactor: number };

const MIN_REGION_SIZE = 32;

export default function RegionPickerWindow() {
	const { t } = useI18n();
	const [drag, setDrag] = useState<DragState>(null);
	const [display, setDisplay] = useState<DisplayInfo | null>(null);

	useEffect(() => {
		void window.electronAPI?.getRegionPickerDisplay?.().then((result) => {
			if (result?.success) setDisplay(result.display);
		});
	}, []);

	const cancel = useCallback(() => {
		void window.electronAPI?.cancelRegionPicker?.();
	}, []);

	const confirm = useCallback(() => {
		if (!drag || !display) return;
		const x = Math.min(drag.startX, drag.x);
		const y = Math.min(drag.startY, drag.y);
		const width = Math.abs(drag.width);
		const height = Math.abs(drag.height);
		if (width < MIN_REGION_SIZE || height < MIN_REGION_SIZE) return;
		// Client coords are relative to this fullscreen window which covers the
		// display; convert to global logical coords expected by the capture resolver.
		void window.electronAPI.selectSource({
			id: `region:${display.id}`,
			name: t("sourceSelector.region"),
			display_id: String(display.id),
			sourceType: "region",
			region: {
				x: display.x + x,
				y: display.y + y,
				width,
				height,
			},
		});
	}, [drag, display, t]);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") cancel();
			if (event.key === "Enter") confirm();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [cancel, confirm]);

	const normalized = drag
		? {
				x: Math.min(drag.startX, drag.x),
				y: Math.min(drag.startY, drag.y),
				width: Math.abs(drag.width),
				height: Math.abs(drag.height),
			}
		: null;

	return (
		<div
			className="fixed inset-0 cursor-crosshair"
			style={{ background: "rgba(0,0,0,0.3)" }}
			onMouseDown={(event) => setDrag({ startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, width: 0, height: 0 })}
			onMouseMove={(event) =>
				setDrag((current) =>
					current
						? { ...current, x: event.clientX, y: event.clientY, width: event.clientX - current.startX, height: event.clientY - current.startY }
						: null,
				)
			}
			onMouseUp={confirm}
		>
			{normalized && normalized.width >= MIN_REGION_SIZE && normalized.height >= MIN_REGION_SIZE && (
				<div
					className="fixed border-2 border-white shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]"
					style={{ left: normalized.x, top: normalized.y, width: normalized.width, height: normalized.height }}
				>
					<div className="absolute -top-8 left-0 rounded bg-black/70 px-2 py-1 text-xs text-white">
						{Math.round(normalized.width)} × {Math.round(normalized.height)}
					</div>
				</div>
			)}
			<div className="fixed bottom-6 left-1/2 -translate-x-1/2 rounded bg-black/70 px-3 py-2 text-xs text-white">
				{t("sourceSelector.regionHint")}
			</div>
		</div>
	);
}
```(窗口内 clientX/Y 是显示器内坐标;confirm 时加 `display.x/y` 偏移转成全屏逻辑坐标,与 `resolveWindowsCaptureTarget` 的 `raw.x - display.bounds.x` 换算严格互逆。Task 4 的 `get-region-picker-display` IPC 返回 `{ success: true, display }`。)

- [ ] **Step 3: 窗口路由 + SourceSelector 入口**

1. 找到 `windowType=source-selector` 的组件分发处(grep `source-selector`),加 `region-picker → <RegionPickerWindow />` 分支
2. `SourceSelector.tsx` 在 screen/window 列表区域加"区域"按钮(仅 Windows 原生可用时显示,判定复用现有的原生采集可用性状态),点击调用新 IPC `open-region-picker`(在 `register/sources.ts` 加 handler 调 `createRegionPickerWindowWrapper`,照 `open-source-selector:528` 模式)

- [ ] **Step 4: 端到端手动验证(核心路径,必做)**

Run: `npm run dev`
1. 选源器出现"区域"入口 → 点击 → 全屏变暗 + 十字光标
2. 拖出 800×600 框 → 松开或回车 → HUD 显示源名为"区域"
3. 录制 10 秒停止 → 产物尺寸 800×600、内容即所选区域(多显示器上在副屏选区验证一次,确认偏移正确)
4. Esc 取消 → 回到选源器,selectedSource 不变
5. 框 <32px → 不确认(提示太小)

- [ ] **Step 5: 类型检查 + lint + 全量测试 + Commit**

Run: `npx tsc -p tsconfig.json --noEmit && npx biome lint src/components/launch && npx vitest --run`
Expected: 全绿

```bash
git add src/components/launch electron/ipc/register/sources.ts src/i18n/locales electron/preload.ts electron/electron-env.d.ts
git commit -m "Add drag-to-select region picker for Windows capture"
```

---

### Task 6: 录制链路回归 + 打包验证

**Files:** 无新增,验证性任务

- [ ] **Step 1: 全链路回归(手动清单)**

1. 整屏录制(默认路径)→ 正常
2. 窗口录制 → 正常
3. 区域录制 + 暂停/恢复/停止 → 正常
4. 区域录制中崩溃恢复流程:录制中强杀进程 → 重启 → 恢复 toast 出现且文件可播(验证 recover.ts 与 crop 路径兼容——恢复只按文件名工作,应无影响,需实证)
5. 区域 + 系统音频 + 麦克风 sidecar → 三个文件都生成
6. 帧率/画质设置(前两个计划)与区域叠加 → config 全字段正确(可临时打印 config 验证)

- [ ] **Step 2: 打包**

Run: `npm run build:win`
Expected: 成功;安装后重复 Step 1 的 1/3/4 项

- [ ] **Step 3: Commit(如有修正)**

```bash
git add -A
git commit -m "Polish region capture after end-to-end regression"
```

---

## 验收标准

1. 选源器三源:屏幕/窗口/区域;区域入口仅 Windows 原生路径可用时显示
2. 拖框录制产物尺寸=框选尺寸、内容=框选区域,多显示器 DIP/物理换算正确(有单测)
3. Esc 取消、Enter/松开确认、最小尺寸防护
4. 崩溃恢复、音频 sidecar、帧率/画质设置与 region 正交可用
5. 全量测试、tsc、lint 全绿;`build:win` 产物人工验证通过
