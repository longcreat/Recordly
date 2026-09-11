# 录制帧率设置(Recording Frame Rate Setting)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户在 HUD 设置中选择录制帧率(24/30/60 fps,默认 60 保持现状),Windows 原生、macOS 原生、浏览器回退三条录制路径统一生效。

**Architecture:** 在 `RecordingPreferences`(`%APPDATA%\Recordly\recordings-settings.json`)新增 `frameRate` 字段,主进程在 `start-native-screen-recording` 两条原生路径读取并写入 capture config(原生层 `findInt("fps")` 已支持,无需 C++ 改动);渲染层 `useScreenRecorder` 把硬编码的 `TARGET_FRAME_RATE` 常量改为从偏好读取的 state,浏览器回退约束同步生效。UI 在 HUD 的 MorePopover 加一个分段选择器,沿用 `countdownDelay` 的既有模式。

**Tech Stack:** Electron IPC + React + 既有的 `createRecordingPreferencesStore` 设置存储 + i18n(11 locales)。

**关键事实(已验证):**
- `electron/ipc/register/recording.ts:471`(Windows 路径)和 `:743`(macOS 路径)两处 `fps: 60` 硬编码
- 原生层 `wgc-capture/src/main.cpp` 的 `parseSimpleJson` 已解析 `fps`(`findInt("fps")`,`fps > 0` 才覆盖,默认 60)——**C++ 零改动**
- 偏好存储:`electron/ipc/settings/recordingPreferencesStore.ts`(read + merge patch),IPC 在 `electron/ipc/register/settings.ts:123,154`
- 渲染层偏好加载点:`src/hooks/useScreenRecorder.ts:1527-1543`(effect 一次性 `getRecordingPreferences`)
- 浏览器回退 fps 约束:`src/hooks/useScreenRecorder.ts:12` `TARGET_FRAME_RATE = 60`,使用点 `:601,1966,1982,2093,2114`
- preload 暴露:`electron/preload.ts:979,981`;类型:`electron/electron-env.d.ts:891,903`

---

### Task 1: 设置层 —— RecordingPreferences 增加 frameRate 字段

**Files:**
- Modify: `electron/ipc/settings/recordingPreferencesStore.ts`
- Test: `electron/ipc/settings/recordingPreferencesStore.test.ts`(新建)

- [ ] **Step 1: 写失败测试**

```typescript
// electron/ipc/settings/recordingPreferencesStore.test.ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRecordingPreferencesStore } from "./recordingPreferencesStore";

describe("createRecordingPreferencesStore frameRate", () => {
	let settingsFile: string;
	let tempRoot: string;

	beforeEach(async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-prefs-"));
		settingsFile = path.join(tempRoot, "recordings-settings.json");
	});

	afterEach(async () => {
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	it("round-trips frameRate through read/update", async () => {
		const store = createRecordingPreferencesStore(settingsFile);
		await store.update({ frameRate: 30 });
		const parsed = await store.read();
		expect(parsed.frameRate).toBe(30);
	});

	it("merges frameRate into existing preferences without wiping them", async () => {
		await fs.writeFile(
			settingsFile,
			JSON.stringify({ microphoneEnabled: true, frameRate: 60 }, null, 2),
			"utf-8",
		);
		const store = createRecordingPreferencesStore(settingsFile);
		await store.update({ frameRate: 24 });
		const parsed = await store.read();
		expect(parsed.frameRate).toBe(24);
		expect(parsed.microphoneEnabled).toBe(true);
	});
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest --run electron/ipc/settings/recordingPreferencesStore.test.ts`
Expected: FAIL —— `frameRate` 不在 `RecordingPreferencesPatch` 类型中(TS 编译错误或运行时 merge 不含该字段导致断言失败)

- [ ] **Step 3: 最小实现**

```typescript
// electron/ipc/settings/recordingPreferencesStore.ts —— 仅改类型
export interface RecordingPreferencesPatch {
	microphoneEnabled?: boolean;
	microphoneDeviceId?: string;
	systemAudioEnabled?: boolean;
	webcamEnabled?: boolean;
	webcamDeviceId?: string;
	frameRate?: 24 | 30 | 60;
}
```

(存储是动态 `Record<string, unknown>` merge,无需其他改动。)

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest --run electron/ipc/settings/recordingPreferencesStore.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add electron/ipc/settings/recordingPreferencesStore.ts electron/ipc/settings/recordingPreferencesStore.test.ts
git commit -m "Add frameRate to recording preferences store"
```

---

### Task 2: IPC 层 —— get/set-recording-preferences 返回 frameRate

**Files:**
- Modify: `electron/ipc/register/settings.ts:123-152`(get handler 返回值)
- Modify: `electron/preload.ts:979-988`
- Modify: `electron/electron-env.d.ts:891-910`

- [ ] **Step 1: 扩展 get-recording-preferences 返回值**

在 `electron/ipc/register/settings.ts` 的 `get-recording-preferences` handler 中,两个 return(success 和 catch 分支)各加一行:

```typescript
frameRate: parsed.frameRate === 24 || parsed.frameRate === 30 ? parsed.frameRate : 60,
```

catch 分支(默认值):

```typescript
frameRate: 60,
```

- [ ] **Step 2: 扩展 preload 与类型声明**

`electron/preload.ts:981` 的 `setRecordingPreferences` 参数对象加:

```typescript
frameRate?: 24 | 30 | 60;
```

`electron/electron-env.d.ts:891` 的 `getRecordingPreferences` 返回类型加 `frameRate: 24 | 30 | 60;`,`:903` 的 set 参数类型加 `frameRate?: 24 | 30 | 60;`。

- [ ] **Step 3: 类型检查**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add electron/ipc/register/settings.ts electron/preload.ts electron/electron-env.d.ts
git commit -m "Expose frameRate through recording preferences IPC"
```

---

### Task 3: 主进程录制启动读取 frameRate(两条原生路径)

**Files:**
- Modify: `electron/ipc/register/recording.ts:446-471`(Windows)、`:741-747`(macOS)
- Test: `electron/ipc/register/recordingFrameRate.test.ts`(新建,单元测试辅助函数)

- [ ] **Step 1: 抽一个可测的解析辅助函数并写失败测试**

新建 `electron/ipc/recording/frameRatePreference.ts`:

```typescript
export type RecordingFrameRate = 24 | 30 | 60;

export const RECORDING_FRAME_RATES: readonly RecordingFrameRate[] = [24, 30, 60] as const;

export function resolveRecordingFrameRate(raw: unknown): RecordingFrameRate {
	return raw === 24 || raw === 30 ? raw : 60;
}
```

测试 `electron/ipc/recording/frameRatePreference.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { RECORDING_FRAME_RATES, resolveRecordingFrameRate } from "./frameRatePreference";

describe("resolveRecordingFrameRate", () => {
	it("accepts the supported rates", () => {
		expect(RECORDING_FRAME_RATES.map((rate) => resolveRecordingFrameRate(rate))).toEqual([
			24, 30, 60,
		]);
	});

	it("falls back to 60 for missing or invalid values", () => {
		expect(resolveRecordingFrameRate(undefined)).toBe(60);
		expect(resolveRecordingFrameRate(25)).toBe(60);
		expect(resolveRecordingFrameRate("30")).toBe(60);
		expect(resolveRecordingFrameRate(null)).toBe(60);
	});
});
```

Run: `npx vitest --run electron/ipc/recording/frameRatePreference.test.ts`
Expected: PASS(纯函数直接实现;此任务的失败验证放在 Step 2 集成处)

- [ ] **Step 2: Windows 路径接线**

`electron/ipc/register/recording.ts` 顶部 import 区加:

```typescript
import { createRecordingPreferencesStore } from "../settings/recordingPreferencesStore";
import { resolveRecordingFrameRate } from "../recording/frameRatePreference";
```

模块级(registerRecordingHandlers 函数体外、import 后)加:

```typescript
const recordingPreferencesReader = createRecordingPreferencesStore(RECORDINGS_SETTINGS_FILE);
```

Windows 路径(`:446` 附近,`const timestamp = Date.now();` 之前)加读取,并把 `:471` 的 `fps: 60` 改为变量:

```typescript
const prefs = await recordingPreferencesReader.read();
const frameRate = resolveRecordingFrameRate(prefs.frameRate);
```

```typescript
const config: Record<string, unknown> = {
	outputPath: tempVideoPath,
	fps: frameRate,
};
```

- [ ] **Step 3: macOS 路径接线**

`:743` 附近 macOS config 同样处理:

```typescript
const prefs = await recordingPreferencesReader.read();
const frameRate = resolveRecordingFrameRate(prefs.frameRate);
const config: Record<string, unknown> = {
	fps: frameRate,
	outputPath,
	capturesSystemAudio,
	capturesMicrophone,
};
```

- [ ] **Step 4: 类型检查 + 全量测试**

Run: `npx tsc -p tsconfig.json --noEmit && npx vitest --run`
Expected: 0 errors;全部测试通过(1217+)

- [ ] **Step 5: Commit**

```bash
git add electron/ipc/recording/frameRatePreference.ts electron/ipc/recording/frameRatePreference.test.ts electron/ipc/register/recording.ts
git commit -m "Read frame rate from recording preferences in native capture start"
```

---

### Task 4: 渲染层 —— useScreenRecorder 使用偏好帧率

**Files:**
- Modify: `src/hooks/useScreenRecorder.ts:12,601,1527-1543,1966,1982,2093,2114`

- [ ] **Step 1: state + 加载 + 持久化(照 persistSystemAudioEnabled 模式)**

删除 `:12` 的 `const TARGET_FRAME_RATE = 60;`,改在 hook 内加:

```typescript
type ScreenRecorderFrameRate = 24 | 30 | 60;

const [frameRate, setFrameRate] = useState<ScreenRecorderFrameRate>(60);
const frameRateRef = useRef<ScreenRecorderFrameRate>(60);
```

`recordingPrefsLoaded` effect(`:1527`)的 success 分支加:

```typescript
setFrameRate(resolveFrameRate(result.frameRate));
```

(本地小 helper,文件顶部 hook 外:`const resolveFrameRate = (raw: unknown): ScreenRecorderFrameRate => (raw === 24 || raw === 30 ? raw : 60);`)

持久化回调(挨着 persistWebcamEnabled):

```typescript
const persistFrameRate = useCallback((rate: ScreenRecorderFrameRate) => {
	setFrameRate(rate);
	frameRateRef.current = rate;
	void window.electronAPI.setRecordingPreferences({ frameRate: rate });
}, []);
```

同步 ref 的 effect:

```typescript
useEffect(() => {
	frameRateRef.current = frameRate;
}, [frameRate]);
```

- [ ] **Step 2: 替换所有 TARGET_FRAME_RATE 使用点为 frameRateRef.current**

`:601`(computeBitrate 的高帧率 boost)、`:1966`(maxFrameRate)、`:1982/:2093/:2114`(getDisplayMedia 约束)——共 5 处,把 `TARGET_FRAME_RATE` 全部替换为 `frameRateRef.current`。(约束对象在异步回调里构造,必须用 ref 而非 state,避免闭包旧值。)

注意 `MIN_FRAME_RATE`(`:1967` 附近)保持不变。

- [ ] **Step 3: 暴露给 HUD**

hook 返回对象加 `frameRate` 与 `persistFrameRate`(找到 hook 的 return 语句,挨着 `systemAudioEnabled` / `persistSystemAudioEnabled` 添加)。

- [ ] **Step 4: 类型检查**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: 0 errors

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useScreenRecorder.ts
git commit -m "Apply preferred frame rate to browser fallback capture"
```

---

### Task 5: UI —— MorePopover 帧率选择器 + i18n

**Files:**
- Modify: `src/components/launch/popovers/MorePopover.tsx`(在 countdownDelay 区块后)
- Modify: `src/components/launch/LaunchWindow.tsx` 及 popovers 的 props 传递(跟随 systemAudioEnabled 的既有管道)
- Modify: `src/i18n/locales/*/launch.json`(11 个语言)

- [ ] **Step 1: i18n key(en 先行,格式仿 `recording.countdownDelay`)**

`src/i18n/locales/en/launch.json` 的 `recording` 节加:

```json
"frameRate": "Frame rate",
"frameRate24": "24 fps",
"frameRate30": "30 fps",
"frameRate60": "60 fps"
```

zh-CN 对应:

```json
"frameRate": "录制帧率",
"frameRate24": "24 帧",
"frameRate30": "30 帧",
"frameRate60": "60 帧"
```

其余 9 个语言(zh-TW/de/es/fr/it/ko/nl/pt-BR/ru)按语义翻译同样 4 个 key。

- [ ] **Step 2: MorePopover 增加选择器(照 countdownDelay 的 UI 结构)**

找到 MorePopover 中 countdownDelay 的区块(搜索 `recording.countdownDelay`),在其后按相同结构加:

```tsx
<SettingRow label={t("recording.frameRate")}>
	{/* 与 countdownDelay 一致的分段按钮组,三档 */}
	{([24, 30, 60] as const).map((rate) => (
		<button
			key={rate}
			type="button"
			className={rate === frameRate ? activePillClass : idlePillClass}
			onClick={() => persistFrameRate(rate)}
		>
			{t(`recording.frameRate${rate}`)}
		</button>
	))}
</SettingRow>
```

(`activePillClass`/`idlePillClass` 直接复用 countdownDelay 区块使用的现成样式类——照抄该区块按钮的 className。)

props 增加 `frameRate: 24 | 30 | 60` 与 `persistFrameRate: (rate: 24 | 30 | 60) => void`,由 LaunchWindow 从 useScreenRecorder 返回值透传(与 `systemAudioEnabled` 完全相同的传递路径)。

- [ ] **Step 3: 手动冒烟(dev 模式)**

Run: `npm run dev`
验证:HUD → 更多 → 帧率选择器显示且默认 60;切到 30 后重启应用仍是 30(持久化生效);开始录制,停止后检查文件属性帧率 ≈30。

- [ ] **Step 4: 类型检查 + lint + 全量测试**

Run: `npx tsc -p tsconfig.json --noEmit && npx biome lint src/components/launch/popovers/MorePopover.tsx src/hooks/useScreenRecorder.ts && npx vitest --run`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add src/components/launch src/i18n/locales
git commit -m "Add frame rate selector to HUD settings"
```

---

## 验收标准

1. MorePopover 中出现 24/30/60 三档选择,默认 60,选择后持久化(重启保留)
2. Windows 原生录制:`recordings-settings.json` 设 30 后,录出的 mp4 帧率为 30(用 `ffprobe` 或导入编辑器查看)
3. 浏览器回退路径(禁用原生采集时)约束同样跟随设置
4. 全量测试通过、tsc 0 错误、11 个语言 key 齐全
