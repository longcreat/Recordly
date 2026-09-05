import type { Display, Screen } from "electron";
import { getScreen } from "../utils";

/**
 * The slice of Electron's screen module the topology cache depends on. Kept
 * structural so tests can inject a fake without mocking the electron module.
 */
export type DisplayTopologyScreen = Pick<Screen, "getAllDisplays" | "getPrimaryDisplay" | "on">;

// Cursor telemetry samples every CURSOR_SAMPLE_INTERVAL_MS. Each sample used to
// call getAllDisplays()/getPrimaryDisplay(), which enumerate monitors through
// the OS (EnumDisplayMonitors on Windows) dozens of times per second even though
// the topology only changes when a display is plugged in, removed, or rescaled.
let cachedDisplays: Display[] | null = null;
let cachedPrimaryScaleFactor: number | null = null;
let invalidationTarget: DisplayTopologyScreen | null = null;

export function invalidateDisplayTopologyCache(): void {
	cachedDisplays = null;
	cachedPrimaryScaleFactor = null;
}

function attachCacheInvalidation(screen: DisplayTopologyScreen): void {
	if (invalidationTarget === screen) {
		return;
	}

	// Test doubles for Electron's screen module do not always implement the
	// EventEmitter surface. The cache still works, it just cannot self-invalidate.
	if (typeof screen.on !== "function") {
		return;
	}

	invalidationTarget = screen;
	screen.on("display-added", invalidateDisplayTopologyCache);
	screen.on("display-removed", invalidateDisplayTopologyCache);
	screen.on("display-metrics-changed", invalidateDisplayTopologyCache);
}

export function getCachedDisplays(screen: DisplayTopologyScreen = getScreen()): Display[] {
	attachCacheInvalidation(screen);

	if (cachedDisplays === null) {
		cachedDisplays = screen.getAllDisplays();
	}

	return cachedDisplays;
}

export function getCachedPrimaryScaleFactor(screen: DisplayTopologyScreen = getScreen()): number {
	attachCacheInvalidation(screen);

	if (cachedPrimaryScaleFactor === null) {
		cachedPrimaryScaleFactor = screen.getPrimaryDisplay().scaleFactor || 1;
	}

	return cachedPrimaryScaleFactor;
}
