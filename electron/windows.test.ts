import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	app: {
		getPath: () => "C:\\RecordlyTest",
		setPath: vi.fn(),
		isReady: () => true,
	},
	BrowserWindow: class {
		static getAllWindows() {
			return [];
		}
	},
	ipcMain: {
		on: vi.fn(),
		handle: vi.fn(),
		removeHandler: vi.fn(),
	},
	screen: {
		getAllDisplays: () => [],
		getPrimaryDisplay: () => ({
			scaleFactor: 1,
			workArea: { x: 0, y: 0, width: 0, height: 0 },
		}),
		getDisplayNearestPoint: () => ({
			scaleFactor: 1,
			workArea: { x: 0, y: 0, width: 0, height: 0 },
		}),
		getCursorScreenPoint: () => ({ x: 0, y: 0 }),
		on: vi.fn(),
	},
}));

import { isHudOverlayMousePassthroughSupported } from "./windows";

const REAL_PLATFORM = process.platform;

function withPlatform(platform: NodeJS.Platform, run: () => void) {
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
	try {
		run();
	} finally {
		Object.defineProperty(process, "platform", {
			value: REAL_PLATFORM,
			configurable: true,
		});
	}
}

describe("isHudOverlayMousePassthroughSupported", () => {
	// Regression guard for the Windows "invisible wall": the HUD overlay covers a
	// large transparent rectangle, so it may only become interactive-on-hover when
	// the OS honours setIgnoreMouseEvents(true, { forward: true }). Narrowing this
	// predicate to macOS makes every click inside the transparent margins of the
	// Windows HUD vanish, disables the floating webcam preview, and turns
	// showHudOverlayFromTray() into a focus-stealing show().
	it("keeps passthrough enabled on Windows", () => {
		withPlatform("win32", () => {
			expect(isHudOverlayMousePassthroughSupported()).toBe(true);
		});
	});

	it("keeps passthrough enabled on macOS", () => {
		withPlatform("darwin", () => {
			expect(isHudOverlayMousePassthroughSupported()).toBe(true);
		});
	});

	it("falls back to the constrained overlay on Linux, where forwarding is dropped", () => {
		withPlatform("linux", () => {
			expect(isHudOverlayMousePassthroughSupported()).toBe(false);
		});
	});
});
