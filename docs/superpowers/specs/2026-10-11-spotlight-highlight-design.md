# 聚光灯(Spotlight)高光圈选效果 — 设计规格

日期:2026-10-11
状态:待实现
前置调研:Screen Studio(mask & highlight)、Camtasia(Spotlight & Blur / Spotlight 光标效果)、Snagit(Spotlight & Magnify)、ScreenFlow(Callout)、FocuSee(跟随光标)——业界标配两种形态:手动圈选区域、跟随光标;主流视觉是"圈外压暗 + 可选模糊/描边"。

## 1. 目标 / 非目标

**目标(v1)**

- 时间区间效果:圆圈外半透明压暗,圆圈描边高亮,起止各 300ms 渐入渐出
- 两种位置模式:`manual` 手动拖拽圆圈、`cursor` 自动跟随录制光标轨迹
- 预览与导出(MP4 / GIF)视觉一致
- 与 zoom 联动:聚光灯定义在视频坐标系,随 zoom 相机一起变换

**非目标(v1 明确不做)**

- 矩形/椭圆形状、多圆叠加
- 圈外模糊(Screen Studio Mask 式)
- 圆心弹簧平滑(v1 直接线性插值;圆远大于光标,微抖不可见)
- 渐入渐出时长可配置

## 2. 数据模型

`src/components/video-editor/types.ts`:

```ts
export type SpotlightMode = "manual" | "cursor";

export interface SpotlightRegion {
	id: string;
	startMs: number;
	endMs: number;
	mode: SpotlightMode;
	focus: { cx: number; cy: number }; // 0-1 视频坐标系;cursor 模式不使用
	radius: number; // 相对视频宽度 0-1
	dimOpacity: number; // 0-1
	feather: number; // 相对视频宽度,0-1
	ringColor: string; // hex
	ringWidth: number; // 相对视频宽度,0 = 无描边
}
```

常量与默认值(同文件):

```ts
export const DEFAULT_SPOTLIGHT_RADIUS = 0.15;
export const DEFAULT_SPOTLIGHT_DIM_OPACITY = 0.45;
export const DEFAULT_SPOTLIGHT_FEATHER = 0.08;
export const DEFAULT_SPOTLIGHT_RING_COLOR = "#ffffff";
export const DEFAULT_SPOTLIGHT_RING_WIDTH = 0.004; // 1920 宽 ≈ 8px
export const SPOTLIGHT_FADE_MS = 300;
```

取值边界(仅在边界处执行,见 §7):radius ∈ [0.02, 0.6];dimOpacity ∈ [0, 0.95];feather ∈ [0, min(0.3, radius × 0.9)];ringWidth ∈ [0, 0.02];startMs/endMs 合法化同 zoom 模板。`EditorEffectSection` 增加 `"spotlight"`(与 `CursorClickEffectStyle` 中的 `"spotlight"` 值分属不同联合类型,无冲突)。

新建 region(时间轴添加):`mode: "manual"`,focus 画面中心,radius/dimOpacity/feather/ring 取默认值,时长 `Math.min(1000, totalMs)`,落点与重叠校验逻辑复用 `useTimelineZoomActions` 的 `defaultRegionDurationMs` 同款语义。

## 3. 渲染架构

共享几何模块 `src/components/video-editor/videoPlayback/spotlightGeometry.ts`(纯函数,无 DOM/Pixi/canvas 依赖):

```ts
export interface SpotlightFrameState {
	region: SpotlightRegion;
	center: { cx: number; cy: number }; // 视频坐标系 0-1
	opacity: number; // dimOpacity × 渐入渐出系数
}

// 求当前帧活跃聚光灯;无活跃区域或 cursor 模式无光标采样点 → null
export function resolveSpotlightAtTime(
	regions: SpotlightRegion[],
	timeMs: number,
	cursorSamples: CursorTelemetryPoint[] | null,
): SpotlightFrameState | null;

// 视频坐标 → 舞台像素(应用 zoom 相机 scale/x/y)
export function spotlightToStageGeometry(params: {
	stageSize: { width: number; height: number };
	baseMask: { x: number; y: number; width: number; height: number };
	cameraTransform: { scale: number; x: number; y: number };
	center: { cx: number; cy: number };
	radius: number; // 视频宽比例
	feather: number;
	ringWidth: number;
}): { cx: number; cy: number; r: number; featherPx: number; ringPx: number };
```

- `resolveSpotlightAtTime`:活跃窗口为 `[startMs, endMs]`,窗外返回 null;窗口内,`[startMs, startMs + SPOTLIGHT_FADE_MS]` 为渐入(opacity 系数 0→1)、`[endMs − SPOTLIGHT_FADE_MS, endMs]` 为渐出(1→0),均用 `mathUtils.ts` 的 `easeInOutCubic`,其余区段系数为 1;若数据异常重叠,取 startMs 最早者(时间轴已保证不重叠,此为确定性定义);cursor 模式圆心用 `cursorRenderer.ts` 的 `interpolateCursorPosition(samples, timeMs)`,返回 null 即该帧不渲染(明确语义,无回退值)。
- `spotlightToStageGeometry`:圆心舞台坐标 = `cameraTransform` 作用于 `(baseMask.x + cx×baseMask.width, baseMask.y + cy×baseMask.height)`;半径按 `cameraTransform.scale` 放大 → zoom 时圆跟随内容。

### 3.1 预览(VideoPlayback.tsx + 新 SpotlightOverlay)

- Pixi canvas 之上加**全屏遮罩 div**(最顶层,pointer-events: none):背景 `rgba(0,0,0,α)`,`mask-image: radial-gradient(circle at cx cy, transparent (r−featherPx), black r)` 挖羽化洞 —— 与导出端径向渐变**同一数学**,一致性天然成立
- 圆环为独立圆 div(`border: ringPx solid ringColor;border-radius: 50%`)
- ticker 每帧:`resolveSpotlightAtTime` → `spotlightToStageGeometry`(cameraTransform 取 `applyZoomTransform` 返回值)→ 写两个 div 的样式;无活跃区域时隐藏
- 编辑态(选中且暂停):圆环 div 启用 pointer 事件 —— 拖环体移动圆心、拖边缘手柄改 radius,坐标映射复用 `updateFocusFromClientPoint` 的 client→baseMask→0-1 模式(VideoPlayback.tsx:1188-1257);选中态另画虚线辅助圈

### 3.2 导出

`src/lib/exporter/spotlightCanvasRenderer.ts`:

```ts
export function drawSpotlight(
	ctx: CanvasRenderingContext2D,
	width: number,
	height: number,
	frame: SpotlightFrameState,
	geometryPx: { cx: number; cy: number; r: number; featherPx: number; ringPx: number },
): void;
```

实现:全屏 `fillStyle = rgba(0,0,0,opacity)` → `globalCompositeOperation = "destination-out"` 画径向渐变圆(内 (r−feather) 全透明 → r 全不透明)挖洞 → 恢复 source-over 画圆环描边。纯无状态,每帧独立。

- **MP4**(modernFrameRenderer.ts):`FrameRenderConfig` 增加 `spotlightRegions`;`renderFrame` 中若 `resolveSpotlightAtTime` 非 null,走既有 2D 合成画布路径(与 blur 标注同一条,`composeBlurAnnotationFrame`/`ensureExportCompositeCanvas` 已铺好):`drawImage(app.canvas)` → `drawSpotlight` → 后续标注/字幕照旧
- **GIF**(frameRenderer.ts):场景渲染后同点调用 `drawSpotlight`
- **层级语义**:遮罩压暗一切场景内容(视频、背景、光标、标注、字幕、webcam),圆内不受影响;跟随光标模式圆心即光标,光标恒在圈内保持明亮。预览 DOM 顶层与导出"画在最终帧之上"完全同构,零特例

### 3.3 导出配置链路

`useTimelineState.spotlightRegions` → `buildExportRenderOptions.ts` → `VideoExporterConfig`(modernVideoExporter.ts)→ `FrameRenderConfig`;GIF 分支(useExportRunner.ts)同;`cursorTelemetry` 已在配置中,无需新增。

## 4. 时间轴

- `timeline/core/constants.ts` 新增 `SPOTLIGHT_ROW_ID`;`timelineTypes.ts` variant 增加 `"spotlight"`(字段:id/startMs/endMs/mode)
- 单行轨道,region 互不重叠:仿 `canPlaceZoomAtMs` 实现 `canPlaceSpotlightAtMs`,添加/拖拽时校验拒绝
- 行内 ghost 点击添加、拖拽调区间、右键删除,交互同 zoom 行(TimelineCanvas.tsx)
- 工具栏(TimelineToolbar.tsx)"添加缩放"旁加"添加聚光灯"按钮 → `EditorPreviewPanel.tsx` 调 `timelineRef.current?.addSpotlight()` → `useTimelineEditorRuntime` → 新 `hooks/actions/useTimelineSpotlightActions.ts`(仿 useTimelineZoomActions)
- 选中 region → `setActiveEffectSection("spotlight")`

## 5. 设置面板与命令 hook

- 新 `hooks/useSpotlightRegionCommands.ts`(仿 useZoomRegionCommands):选中/删除/属性变更(handleSpotlightFocusChange、handleSpotlightRadiusChange 等,setter 内 clamp 边界值)
- SettingsPanel.tsx:props 增加 selectedSpotlight 相关项(`useEditorSettingsPanelProps.ts` 组装);新 `spotlightSectionContent`:
  - 模式分段按钮:手动 / 跟随光标
  - 大小 slider(2%–60% 视频宽)、压暗强度(0–95%)、羽化(0–30%)、描边粗细(0–2%)
  - 描边颜色:复用 `@uiw/react-color-block`(同 cursorClickEffectColor 的用法)
  - 删除按钮;manual 模式下提示"在预览中拖动圆圈调整位置"

## 6. 持久化 / 撤销 / i18n

- `projectPersistence.ts`:`ProjectEditorState.spotlightRegions: SpotlightRegion[]`;`normalizeProjectEditor` 照 zoom 模板(446-486 行)加归一化:白名单 mode、数值 clamp(§2 边界表)、非法项丢弃、缺省 `[]`。旧项目无此字段 → 默认 `[]`,PROJECT_VERSION 保持 1。旧版本 App 打开新项目会忽略该字段(可接受)
- `project/useProjectSnapshotModel.ts` 快照加入 `spotlightRegions`;加载回填走 useEditorProjectController 既有流程
- `editorHistory.ts`:`EditorHistorySnapshot` 加 `spotlightRegions` + `selectedSpotlightId`;`useEditorHistory.ts` 的 buildSnapshot/applySnapshot 加字段 + 新增 `nextSpotlightIdRef`
- i18n:`src/i18n` 各语言文件新增 key(工具栏按钮、面板标签、提示语),通过 `npm run i18n:check`

## 7. 边界处理原则(硬性约定)

**校验集中在边界,核心路径信任输入;不做兜底、不撒防御补丁。**

- 所有 clamp / 白名单 / 默认值只存在于两处:`normalizeProjectEditor`(加载边界)与 `useSpotlightRegionCommands` 各 setter(编辑边界)。几何/渲染纯函数直接使用字段值,不重复校验
- cursor 模式该时刻无光标采样点 → `resolveSpotlightAtTime` 返回 null → 该帧不渲染聚光灯。不静默改用 focus 或其他魔法回退
- 全链路不新增 try-catch;null 是唯一"缺失"信号,语义为"不渲染"
- 区间重叠在添加/拖拽入口拒绝(canPlace 校验);normalize 对已存数据只排序不拆重

## 8. 测试策略与验收

单元测试(vitest,与实现同目录):

- `videoPlayback/spotlightGeometry.test.ts`:区间求值与 300ms 渐变曲线、cursor 模式插值与无采样 null、camera 变换几何(scale/x/y 作用于圆心与半径)、feather < radius 不变式
- `lib/exporter/spotlightCanvasRenderer.test.ts`:mock ctx 断言调用序列(fill → destination-out 渐变 → restore → 描边)与 rgba 值
- `timeline/model/timelineModel.test.ts`:spotlight variant 构建与 span
- `projectPersistence.test.ts`:normalize 默认值/白名单/clamp/非法项丢弃
- `editorHistory.test.ts`:快照含 spotlightRegions 的往返一致

人工验收清单:

1. 手动模式:添加→拖动圆心→拖边缘改大小→调各参数,预览即时生效
2. 跟随光标模式:圆沿光标轨迹走,与光标本体无可见错位
3. zoom 与聚光灯叠加:zoom 进出时圆随内容缩放、无跳动
4. 渐入渐出各 300ms,无跳变
5. MP4 导出与预览逐段对比一致;GIF 导出一致
6. 撤销/重做覆盖添加、删除、属性修改、区间拖拽
7. 旧项目文件打开正常(无聚光灯字段)

## 9. 触碰文件清单(附录)

**类型/状态**:types.ts、state/useTimelineState.ts、editorHistory.ts、hooks/useEditorHistory.ts
**持久化**:projectPersistence.ts、project/useProjectSnapshotModel.ts
**渲染(新模块)**:videoPlayback/spotlightGeometry.ts(+test)、lib/exporter/spotlightCanvasRenderer.ts(+test)
**预览**:VideoPlayback.tsx(props、ticker、拖拽交互、overlay)、layout/EditorVideoPreview.tsx、layout/EditorPreviewPanel.tsx
**导出**:lib/exporter/modernFrameRenderer.ts、lib/exporter/frameRenderer.ts、lib/exporter/modernVideoExporter.ts、export/buildExportRenderOptions.ts、export/useExportRunner.ts
**时间轴**:timeline/core/constants.ts、timeline/core/timelineTypes.ts、timeline/model/timelineModel.ts(+test)、timeline/TimelineEditor.tsx、timeline/hooks/useTimelineDndBindings.ts、timeline/hooks/useTimelineEditorRuntime.ts、timeline/hooks/actions/useTimelineSpotlightActions.ts(新)、timeline/components/viewport/TimelineCanvas.tsx、timeline/components/toolbar/TimelineToolbar.tsx
**面板/接线**:SettingsPanel.tsx、hooks/useSpotlightRegionCommands.ts(新)、layout/useEditorSettingsPanelProps.ts、EditorShell.tsx / VideoEditor.tsx 接线
**i18n**:src/i18n 各语言文件
