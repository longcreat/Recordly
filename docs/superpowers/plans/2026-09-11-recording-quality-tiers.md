# 录制画质档位(Recording Quality Tiers)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户选择录制画质三档(标准 0.5×/均衡 0.8×/高 1.0×,默认"高"完全等于现状),倍率作用于 Windows 原生编码器码率,显著降低"标准/均衡"档的磁盘占用。

**Architecture:** 偏好存储新增 `quality` 字段(复用帧率计划的存储模式),主进程把档位映射为 `bitratePercent`(50/80/100)传入 capture config;C++ 侧 `parseSimpleJson` 新增 `findInt("bitratePercent")`,`MFEncoder::initialize` 增加百分比参数并作用于 `calculateScreenRecordingBitrate` 的结果。倍率数字与导出侧 `exportBitrate.ts` 的 `getEncodingModeBitrateMultiplier`(fast 0.5 / balanced 0.8 / quality 1.0)刻意保持一致,产品语义统一。

**Tech Stack:** C++(Win32 Media Foundation)+ Electron IPC + React。依赖「帧率设置」计划的 Task 1-2(偏好存储与 IPC 模式)已建立。

**关键事实(已验证):**
- 码率唯一决策点:`electron/native/wgc-capture/src/mf_encoder.cpp:16-33` `calculateScreenRecordingBitrate`(1080p→18Mbps、QHD→28Mbps、4K→45Mbps,60fps 再 ×1.35),`:76` `outputType->SetUINT32(MF_MT_AVG_BITRATE, videoBitrate)`
- 编码器构造:`main.cpp:329` `encoder.initialize(outputPathW, captureWidth, captureHeight, config.fps, session.device(), session.context())`
- config 解析:`main.cpp:50-95`(`findInt`,负值/解析失败返回 -1,需范围校验)
- 重建命令:`npm run build:windows-capture`(脚本 `:163` 自动更新 helpers-manifest)
- TS 写 config 处:`electron/ipc/register/recording.ts:469-472`
- **范围限定**:macOS(ScreenCaptureKit swift helper)本期不动,维持现状;浏览器回退路径 MediaRecorder 码率可后续跟进,本期不动(浏览器回退本来就是降级路径)

---

### Task 1: C++ —— CaptureConfig + 解析 bitratePercent

**Files:**
- Modify: `electron/native/wgc-capture/src/main.cpp:34-48`(struct)、`:150-158`(displayX 解析处之后)

- [ ] **Step 1: struct 加字段**

`struct CaptureConfig` 中(`int fps = 60;` 之后)加:

```cpp
int bitratePercent = 100;
```

- [ ] **Step 2: parseSimpleJson 解析(在 displayX/Y/W/H 解析块之前加)**

```cpp
int bitratePercent = findInt("bitratePercent");
if (bitratePercent >= 10 && bitratePercent <= 200) {
    config.bitratePercent = bitratePercent;
}
```

(范围 10-200 防御异常值;缺省保持 100 = 现状。)

- [ ] **Step 3: 编译验证**

Run: `npm run build:windows-capture`
Expected: 构建成功,manifest 自动更新(git status 显示 `helpers-manifest.json` 与 `wgc-capture.exe` 变更)

- [ ] **Step 4: Commit**

```bash
git add electron/native/wgc-capture/src/main.cpp electron/native/bin/win32-x64/
git commit -m "Parse bitratePercent in native capture config"
```

---

### Task 2: C++ —— MFEncoder 应用倍率

**Files:**
- Modify: `electron/native/wgc-capture/src/mf_encoder.h:23`(initialize 声明)
- Modify: `electron/native/wgc-capture/src/mf_encoder.cpp:36-90`(实现与调用点)
- Modify: `electron/native/wgc-capture/src/main.cpp:329-334`(构造调用)

- [ ] **Step 1: initialize 签名加参数(带默认值,不破坏其他调用)**

`mf_encoder.h`:

```cpp
bool initialize(const std::wstring& outputPath, int width, int height, int fps,
                ID3D11Device* device, ID3D11DeviceContext* context,
                int bitratePercent = 100);
```

`mf_encoder.cpp` 实现同步加参数,并在 `:76` 码率计算处应用:

```cpp
const UINT32 videoBitrate = static_cast<UINT32>(
    static_cast<double>(calculateScreenRecordingBitrate(width_, height_, fps_)) *
    (std::max)(10, (std::min)(bitratePercent, 200)) / 100.0 + 0.5);
```

- [ ] **Step 2: main.cpp 调用点传参**

```cpp
if (!encoder.initialize(outputPathW, captureWidth, captureHeight, config.fps,
                       session.device(), session.context(), config.bitratePercent)) {
```

- [ ] **Step 3: 编译 + 冒烟**

Run: `npm run build:windows-capture && npm run smoke --if-present`
Expected: 构建成功;`release/win-unpacked` 若存在旧产物不受影响(原生 helper 是启动时定位的)

- [ ] **Step 4: 手动验证(必须做,这是 C++ 改动的唯一行为验证)**

Run: `npm run dev`
1. 临时在 `electron/ipc/register/recording.ts` 的 config 里硬编码 `bitratePercent: 50`,录 30 秒 1080p,停止
2. 用编辑器打开或 `ffprobe` 查看产物码率:应约为默认档的一半(~9Mbps vs ~18Mbps)
3. 删除硬编码,确认代码回到读取偏好(下一 Task 实现)

- [ ] **Step 5: Commit**

```bash
git add electron/native/wgc-capture/src/ electron/native/bin/win32-x64/
git commit -m "Apply bitrate percent multiplier in Media Foundation encoder"
```

---

### Task 3: TS —— 档位模型 + config 接线

**Files:**
- Create: `electron/ipc/recording/qualityPreference.ts`
- Test: `electron/ipc/recording/qualityPreference.test.ts`
- Modify: `electron/ipc/settings/recordingPreferencesStore.ts`(类型)
- Modify: `electron/ipc/register/settings.ts:123-152`(IPC 返回)
- Modify: `electron/preload.ts:981`、`electron/electron-env.d.ts:891,903`
- Modify: `electron/ipc/register/recording.ts:469-472`(Windows config)

- [ ] **Step 1: 写失败测试**

```typescript
// electron/ipc/recording/qualityPreference.test.ts
import { describe, expect, it } from "vitest";
import { RECORDING_QUALITY_TIERS, resolveRecordingQuality, qualityToBitratePercent } from "./qualityPreference";

describe("recording quality preference", () => {
	it("defaults to high (= current behavior)", () => {
		expect(resolveRecordingQuality(undefined)).toBe("high");
		expect(resolveRecordingQuality("bogus")).toBe("high");
	});

	it("maps tiers to bitrate percent consistent with export encoding modes", () => {
		expect(qualityToBitratePercent("standard")).toBe(50);
		expect(qualityToBitratePercent("balanced")).toBe(80);
		expect(qualityToBitratePercent("high")).toBe(100);
	});

	it("accepts every declared tier", () => {
		for (const tier of RECORDING_QUALITY_TIERS) {
			expect(resolveRecordingQuality(tier)).toBe(tier);
		}
	});
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest --run electron/ipc/recording/qualityPreference.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现**

```typescript
// electron/ipc/recording/qualityPreference.ts
export type RecordingQuality = "standard" | "balanced" | "high";

export const RECORDING_QUALITY_TIERS: readonly RecordingQuality[] = [
	"standard",
	"balanced",
	"high",
] as const;

export function resolveRecordingQuality(raw: unknown): RecordingQuality {
	return RECORDING_QUALITY_TIERS.includes(raw as RecordingQuality)
		? (raw as RecordingQuality)
		: "high";
}

// Multipliers intentionally mirror export's getEncodingModeBitrateMultiplier
// (fast 0.5 / balanced 0.8 / quality 1.0) so both pipelines agree.
export function qualityToBitratePercent(quality: RecordingQuality): number {
	switch (quality) {
		case "standard":
			return 50;
		case "balanced":
			return 80;
		case "high":
		default:
			return 100;
	}
}
```

Run: `npx vitest --run electron/ipc/recording/qualityPreference.test.ts` → PASS

- [ ] **Step 4: 接线(与帧率计划完全同构)**

1. `RecordingPreferencesPatch` 加 `quality?: "standard" | "balanced" | "high";`
2. `get-recording-preferences` 两个返回分支加 `quality: resolveRecordingQuality(parsed.quality)` / `quality: "high"`
3. preload + env.d.ts 类型同步
4. `register/recording.ts` Windows 路径读取处(帧率读取的同一行 `prefs`)加:

```typescript
const quality = resolveRecordingQuality(prefs.quality);
```

config 加(挨着 `fps: frameRate`):

```typescript
bitratePercent: qualityToBitratePercent(quality),
```

- [ ] **Step 5: 全量验证 + Commit**

Run: `npx tsc -p tsconfig.json --noEmit && npx vitest --run`
Expected: 全绿

```bash
git add electron/ipc/recording/qualityPreference.ts electron/ipc/recording/qualityPreference.test.ts electron/ipc/settings/ electron/ipc/register/ electron/preload.ts electron/electron-env.d.ts
git commit -m "Wire recording quality tier to native bitrate percent"
```

---

### Task 4: UI —— MorePopover 画质选择器 + i18n

**Files:**
- Modify: `src/hooks/useScreenRecorder.ts`(state/加载/持久化/暴露,照 frameRate 模式)
- Modify: `src/components/launch/popovers/MorePopover.tsx` + `LaunchWindow.tsx`(props 管道)
- Modify: `src/i18n/locales/*/launch.json`(11 语言)

- [ ] **Step 1: i18n key(en / zh-CN 示例,其余 9 语言同语义)**

`recording` 节加:

```json
"quality": "Recording quality",
"qualityStandard": "Standard",
"qualityBalanced": "Balanced",
"qualityHigh": "High"
```

zh-CN:

```json
"quality": "录制画质",
"qualityStandard": "标准",
"qualityBalanced": "均衡",
"qualityHigh": "高"
```

- [ ] **Step 2: useScreenRecorder + MorePopover**

照帧率计划 Task 4/5 的完整模式:`quality` state + ref、偏好加载、`persistQuality` 回调、hook 返回值暴露、MorePopover 在帧率选择器后加三档按钮组(props: `quality` + `persistQuality`)。

- [ ] **Step 3: 端到端手动验证**

Run: `npm run dev`
1. 默认"高"档录制 30 秒 → 码率 ≈18Mbps(1080p)
2. 切"标准"档,重启应用确认持久化,录 30 秒 → 码率 ≈9Mbps
3. 三档各自录制一次,产物都能正常导入编辑器并播放

- [ ] **Step 4: 类型检查 + lint + 全量测试**

Run: `npx tsc -p tsconfig.json --noEmit && npx biome lint src/hooks/useScreenRecorder.ts src/components/launch && npx vitest --run`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useScreenRecorder.ts src/components/launch src/i18n/locales
git commit -m "Add recording quality selector to HUD settings"
```

---

## 验收标准

1. 三档画质可选、持久化,默认"高"与改动前行为逐字节等价(码率不变)
2. "标准"档 1080p 码率约为默认一半(ffprobe 验证)
3. C++ 重建后 `helpers-manifest.json` 自动更新,打包链路 `npm run build:win` 走通
4. 全量测试、tsc、lint 全绿;11 语言 key 齐全
