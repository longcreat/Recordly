import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { screenState, cursorQueries, nearestPointQueries } = vi.hoisted(() => ({
	screenState: {
		primaryScaleFactor: 2,
		displays: [] as Array<{ id: number; scaleFactor: number }>,
		cursor: { x: 10, y: 20 },
	},
	cursorQueries: { count: 0 },
	nearestPointQueries: [] as Array<{ x: number; y: number }>,
}));

vi.mock("electron", () => ({
	app: {
		getPath: vi.fn(() => "/tmp"),
		setPath: vi.fn(),
		isReady: vi.fn(() => true),
	},
}));

vi.mock("../utils", () => ({
	getTelemetryPathForVideo: vi.fn(() => "/tmp/recording.cursor.json"),
	getScreen: vi.fn(() => ({
		getCursorScreenPoint: () => {
			cursorQueries.count += 1;
			return screenState.cursor;
		},
		getPrimaryDisplay: () => ({ scaleFactor: screenState.primaryScaleFactor }),
		getDisplayNearestPoint: (point: { x: number; y: number }) => {
			nearestPointQueries.push(point);
			return {
				scaleFactor: screenState.primaryScaleFactor,
				bounds: { x: 0, y: 0, width: 1920, height: 1080 },
			};
		},
		getAllDisplays: () => screenState.displays,
	})),
}));

import { setSelectedSource } from "../state";
import { invalidateDisplayTopologyCache } from "./displayTopology";
import { getNormalizedCursorPoint } from "./telemetry";

const REAL_PLATFORM = process.platform;

function useWin32() {
	Object.defineProperty(process, "platform", { value: "win32", configurable: true });
}

afterEach(() => {
	Object.defineProperty(process, "platform", { value: REAL_PLATFORM, configurable: true });
});

describe("getNormalizedCursorPoint hook coordinates", () => {
	beforeEach(() => {
		useWin32();
		invalidateDisplayTopologyCache();
		setSelectedSource(null);
		cursorQueries.count = 0;
		nearestPointQueries.length = 0;
		screenState.primaryScaleFactor = 2;
		screenState.cursor = { x: 10, y: 20 };
		screenState.displays = [];
	});

	it("prefers the hook position captured at the instant of the click", () => {
		// 3840x2160 physical at 200% scaling is 1920x1080 DIP.
		screenState.displays = [
			{ id: 1, scaleFactor: 2 },
			{ id: 2, scaleFactor: 2 },
		];

		expect(getNormalizedCursorPoint({ x: 1920, y: 1080 })).toEqual({ cx: 0.5, cy: 0.5 });
		expect(cursorQueries.count).toBe(0);
		// The display lookup must receive DIP, not the raw physical hook position.
		expect(nearestPointQueries).toEqual([{ x: 960, y: 540 }]);
	});

	it("falls back to the Electron cursor query when displays disagree on scaling", () => {
		// Dividing a physical hook position by the primary factor would place the
		// ripple on the wrong monitor here, so the always-correct query wins.
		screenState.displays = [
			{ id: 1, scaleFactor: 2 },
			{ id: 2, scaleFactor: 1 },
		];
		screenState.cursor = { x: 960, y: 540 };

		expect(getNormalizedCursorPoint({ x: 1920, y: 1080 })).toEqual({ cx: 0.5, cy: 0.5 });
		expect(cursorQueries.count).toBe(1);
	});

	it("still samples the cursor when no hook position is available", () => {
		screenState.displays = [{ id: 1, scaleFactor: 2 }];
		screenState.cursor = { x: 480, y: 270 };

		expect(getNormalizedCursorPoint()).toEqual({ cx: 0.25, cy: 0.25 });
		expect(cursorQueries.count).toBe(1);
	});
});
