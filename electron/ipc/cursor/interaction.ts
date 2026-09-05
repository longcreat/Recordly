import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
	hasLoggedInteractionHookFailure,
	interactionCaptureCleanup,
	isCursorCaptureActive,
	lastLeftClick,
	setHasLoggedInteractionHookFailure,
	setInteractionCaptureCleanup,
	setLastLeftClick,
	setLinuxCursorScreenPoint,
} from "../state";
import type {
	CursorInteractionType,
	HookMouseEvent,
	HookRawEvent,
	UiohookLike,
	UiohookModuleNamespace,
} from "../types";
import {
	getCursorCaptureElapsedMs,
	getHookCursorScreenPoint,
	getNormalizedCursorPoint,
	isCursorCapturePaused,
	pushCursorSample,
} from "./telemetry";

const nodeRequire = createRequire(import.meta.url);

export function normalizeHookMouseButton(rawButton: unknown): 1 | 2 | 3 {
	if (typeof rawButton !== "number" || !Number.isFinite(rawButton)) {
		return 1;
	}

	if (rawButton === 2 || rawButton === 39) {
		return 2;
	}

	if (rawButton === 3 || rawButton === 38) {
		return 3;
	}

	return 1;
}

export function getHookMouseButton(event: HookMouseEvent | null | undefined): 1 | 2 | 3 {
	return normalizeHookMouseButton(
		event?.button ?? event?.mouseButton ?? event?.data?.button ?? event?.data?.mouseButton,
	);
}

/** libuiohook's EVENT_MOUSE_MOVED, mirrored from uiohook-napi's EventType enum. */
const UIOHOOK_EVENT_MOUSE_MOVED = 9;

export function shouldForwardHookEvent(
	eventType: unknown,
	options: { forwardMouseMove: boolean },
): boolean {
	// Forward anything we cannot classify so a future uiohook-napi release can
	// never silently drop the click events cursor telemetry depends on.
	if (typeof eventType !== "number" || !Number.isFinite(eventType)) {
		return true;
	}

	if (eventType === UIOHOOK_EVENT_MOUSE_MOVED) {
		return options.forwardMouseMove;
	}

	return true;
}

const moveFilteredHooks = new WeakSet<object>();

/**
 * Stop high-frequency pointer movement before it reaches the EventEmitter.
 *
 * uiohook-napi's native addon calls `hook.handler(event)` for every event the
 * global hook observes, and `handler` unconditionally emits `input` plus the
 * per-type event. A 500-1000 Hz mouse therefore drives thousands of emit() calls
 * per second on Electron's main thread even though this app only consumes
 * `mousemove` on Linux, which delays the IPC behind HUD stop/pause clicks.
 * Because `start()` binds `this.handler`, installing an own property beforehand
 * swaps in a filtered entry point without patching the native addon.
 *
 * Returns whether the filter was installed by this call.
 */
export function installHookMouseMoveFilter(hook: UiohookLike, forwardMouseMove: boolean): boolean {
	const dispatcher = hook.handler;
	if (typeof dispatcher !== "function" || moveFilteredHooks.has(hook)) {
		return false;
	}

	const boundDispatcher = dispatcher.bind(hook);
	hook.handler = (event: HookRawEvent) => {
		if (!shouldForwardHookEvent(event?.type, { forwardMouseMove })) {
			return;
		}
		boundDispatcher(event);
	};
	moveFilteredHooks.add(hook);

	return true;
}

export function stopInteractionCapture() {
	if (interactionCaptureCleanup) {
		interactionCaptureCleanup();
		setInteractionCaptureCleanup(null);
	}
}

function isUiohookLike(value: unknown): value is UiohookLike {
	const candidate = value as Partial<UiohookLike> | null;
	return typeof candidate?.on === "function" && typeof candidate?.start === "function";
}

function resolveUiohookModule(moduleExports: UiohookModuleNamespace) {
	const defaultExport = moduleExports.default;

	if (moduleExports.uIOhook) {
		return moduleExports.uIOhook;
	}

	if (moduleExports.uiohook) {
		return moduleExports.uiohook;
	}

	if (moduleExports.Uiohook) {
		return moduleExports.Uiohook;
	}

	if (isUiohookLike(defaultExport)) {
		return defaultExport;
	}

	if (defaultExport?.uIOhook) {
		return defaultExport.uIOhook;
	}

	if (defaultExport?.uiohook) {
		return defaultExport.uiohook;
	}

	if (defaultExport?.Uiohook) {
		return defaultExport.Uiohook;
	}

	return null;
}

function shouldRepairBundledUiohookBinary(error: unknown): error is NodeJS.ErrnoException {
	if (process.platform !== "darwin") {
		return false;
	}

	if (process.arch !== "arm64") {
		return false;
	}

	const candidate = error as NodeJS.ErrnoException | null;
	return (
		candidate?.code === "ERR_DLOPEN_FAILED" &&
		typeof candidate.message === "string" &&
		candidate.message.includes("incompatible architecture")
	);
}

export function repairBundledUiohookBinaryForCurrentArch(
	error: unknown,
	options?: {
		packageRoot?: string;
		platform?: NodeJS.Platform;
		arch?: string;
		log?: (message: string) => void;
	},
) {
	const platform = options?.platform ?? process.platform;
	const arch = options?.arch ?? process.arch;

	if (platform !== "darwin" || arch !== "arm64") {
		return false;
	}

	const candidate = error as NodeJS.ErrnoException | null;
	if (
		candidate?.code !== "ERR_DLOPEN_FAILED" ||
		typeof candidate.message !== "string" ||
		!candidate.message.includes("incompatible architecture")
	) {
		return false;
	}

	const packageRoot =
		options?.packageRoot ?? path.dirname(nodeRequire.resolve("uiohook-napi/package.json"));
	const prebuildPath = path.join(packageRoot, "prebuilds", `darwin-${arch}`, "node.napi.node");
	const buildPath = path.join(packageRoot, "build", "Release", "uiohook_napi.node");

	if (!fs.existsSync(prebuildPath)) {
		return false;
	}

	try {
		fs.mkdirSync(path.dirname(buildPath), { recursive: true });
		fs.copyFileSync(prebuildPath, buildPath);
		(options?.log ?? console.warn)(
			"[CursorTelemetry] Repaired stale uiohook-napi binary using bundled darwin-arm64 prebuild.",
		);
		return true;
	} catch {
		return false;
	}
}

function loadUiohookModule() {
	try {
		const moduleExports = nodeRequire("uiohook-napi") as UiohookModuleNamespace;
		return resolveUiohookModule(moduleExports);
	} catch (error) {
		if (!shouldRepairBundledUiohookBinary(error)) {
			throw error;
		}

		if (!repairBundledUiohookBinaryForCurrentArch(error)) {
			throw error;
		}

		delete nodeRequire.cache[nodeRequire.resolve("uiohook-napi")];
		const moduleExports = nodeRequire("uiohook-napi") as UiohookModuleNamespace;
		return resolveUiohookModule(moduleExports);
	}
}

export function shouldStartGlobalInteractionHook(platform: NodeJS.Platform = process.platform) {
	// On macOS, uiohook can block forever while its native event tap starts
	// (notably when Accessibility permission is unavailable or stale). Because
	// start() executes synchronously, that freezes Electron's main thread and
	// makes every window, including the recording HUD, unresponsive. Cursor
	// position and visual-state telemetry still come from the existing native
	// macOS monitor and Electron sampler.
	return platform !== "darwin";
}

export function recordCursorMouseDown(
	button: 1 | 2 | 3,
	hookPoint?: { x: number; y: number } | null,
) {
	if (!isCursorCaptureActive || isCursorCapturePaused()) {
		return;
	}

	const point = getNormalizedCursorPoint(hookPoint);
	if (!point) {
		return;
	}

	const timeMs = getCursorCaptureElapsedMs();
	let interactionType: CursorInteractionType = "click";

	if (button === 2) {
		interactionType = "right-click";
	} else if (button === 3) {
		interactionType = "middle-click";
	} else {
		const thresholdMs = 350;
		const distance = lastLeftClick
			? Math.hypot(point.cx - lastLeftClick.cx, point.cy - lastLeftClick.cy)
			: Number.POSITIVE_INFINITY;

		if (lastLeftClick && timeMs - lastLeftClick.timeMs <= thresholdMs && distance <= 0.04) {
			interactionType = "double-click";
		}

		setLastLeftClick({ timeMs, cx: point.cx, cy: point.cy });
	}

	pushCursorSample(point.cx, point.cy, timeMs, interactionType);
}

export function recordCursorMouseUp(hookPoint?: { x: number; y: number } | null) {
	if (!isCursorCaptureActive || isCursorCapturePaused()) {
		return;
	}

	const point = getNormalizedCursorPoint(hookPoint);
	if (!point) {
		return;
	}

	pushCursorSample(point.cx, point.cy, getCursorCaptureElapsedMs(), "mouseup");
}

export async function startInteractionCapture() {
	if (!isCursorCaptureActive) {
		return;
	}

	if (!["darwin", "win32", "linux"].includes(process.platform)) {
		return;
	}

	if (!shouldStartGlobalInteractionHook()) {
		console.warn("[CursorTelemetry] Skipping the blocking global interaction hook on macOS.");
		return;
	}

	stopInteractionCapture();

	try {
		const hook = loadUiohookModule();
		console.log(
			"[CursorTelemetry] hook loaded:",
			!!hook,
			"has.on:",
			typeof hook?.on,
			"has.start:",
			typeof hook?.start,
		);
		if (!isCursorCaptureActive) {
			return;
		}

		if (!hook || typeof hook.on !== "function" || typeof hook.start !== "function") {
			console.log("[CursorTelemetry] hook unusable — aborting interaction capture");
			return;
		}

		// Only Linux consumes hook mousemove (Electron's cursor position is
		// unreliable there); everywhere else it is pure main-thread overhead.
		installHookMouseMoveFilter(hook, process.platform === "linux");

		const onMouseDown = (event: HookMouseEvent) => {
			recordCursorMouseDown(getHookMouseButton(event), getHookCursorScreenPoint(event));
		};

		const onMouseUp = (event: HookMouseEvent) => {
			recordCursorMouseUp(getHookCursorScreenPoint(event));
		};

		const onMouseMove = (event: HookMouseEvent) => {
			if (process.platform !== "linux" || !isCursorCaptureActive || isCursorCapturePaused()) {
				return;
			}

			const point = getHookCursorScreenPoint(event);
			if (!point) {
				return;
			}

			setLinuxCursorScreenPoint({ x: point.x, y: point.y, updatedAt: Date.now() });
		};

		hook.on("mousedown", onMouseDown);
		hook.on("mouseup", onMouseUp);
		if (process.platform === "linux") {
			hook.on("mousemove", onMouseMove);
		}

		setInteractionCaptureCleanup(() => {
			try {
				if (typeof hook.off === "function") {
					hook.off("mousedown", onMouseDown);
					hook.off("mouseup", onMouseUp);
					if (process.platform === "linux") {
						hook.off("mousemove", onMouseMove);
					}
				} else if (typeof hook.removeListener === "function") {
					hook.removeListener("mousedown", onMouseDown);
					hook.removeListener("mouseup", onMouseUp);
					if (process.platform === "linux") {
						hook.removeListener("mousemove", onMouseMove);
					}
				}
			} catch {
				// ignore listener cleanup errors
			}

			try {
				if (typeof hook.stop === "function") {
					hook.stop();
				}
			} catch {
				// ignore hook shutdown errors
			}
		});

		hook.start();
	} catch (error) {
		if (!hasLoggedInteractionHookFailure) {
			setHasLoggedInteractionHookFailure(true);
			console.warn("[CursorTelemetry] Global interaction capture unavailable:", error);
		}
	}
}
