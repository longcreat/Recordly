import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils", () => ({
	getScreen: vi.fn(() => {
		throw new Error("getScreen() must not be reached when a screen is injected");
	}),
}));

import type { DisplayTopologyScreen } from "./displayTopology";
import {
	getCachedDisplays,
	getCachedPrimaryScaleFactor,
	invalidateDisplayTopologyCache,
} from "./displayTopology";

type FakeScreen = DisplayTopologyScreen & {
	emit: (event: string) => void;
};

function createFakeScreen({
	displays,
	primaryScaleFactor,
}: {
	displays: unknown[];
	primaryScaleFactor: number;
}) {
	const listeners = new Map<string, Array<() => void>>();

	const screen = {
		getAllDisplays: vi.fn(() => displays),
		getPrimaryDisplay: vi.fn(() => ({ scaleFactor: primaryScaleFactor })),
		on: vi.fn((event: string, listener: () => void) => {
			const bucket = listeners.get(event) ?? [];
			bucket.push(listener);
			listeners.set(event, bucket);
			return screen;
		}),
		emit(event: string) {
			for (const listener of listeners.get(event) ?? []) {
				listener();
			}
		},
	} as unknown as FakeScreen;

	return screen;
}

describe("display topology cache", () => {
	beforeEach(() => {
		invalidateDisplayTopologyCache();
	});

	it("enumerates displays once across repeated cursor samples", () => {
		const display = { id: 1 };
		const screen = createFakeScreen({ displays: [display], primaryScaleFactor: 2 });

		expect(getCachedDisplays(screen)).toEqual([display]);
		expect(getCachedDisplays(screen)).toEqual([display]);
		expect(getCachedDisplays(screen)).toEqual([display]);

		expect(screen.getAllDisplays).toHaveBeenCalledTimes(1);
	});

	it("reads the primary scale factor once across repeated cursor samples", () => {
		const screen = createFakeScreen({ displays: [], primaryScaleFactor: 1.5 });

		expect(getCachedPrimaryScaleFactor(screen)).toBe(1.5);
		expect(getCachedPrimaryScaleFactor(screen)).toBe(1.5);

		expect(screen.getPrimaryDisplay).toHaveBeenCalledTimes(1);
	});

	it("falls back to a scale factor of 1 when the display reports none", () => {
		const screen = createFakeScreen({ displays: [], primaryScaleFactor: 0 });

		expect(getCachedPrimaryScaleFactor(screen)).toBe(1);
	});

	it.each([
		"display-added",
		"display-removed",
		"display-metrics-changed",
	])("re-enumerates after %s", (event) => {
		const screen = createFakeScreen({ displays: [{ id: 1 }], primaryScaleFactor: 1 });

		getCachedDisplays(screen);
		getCachedPrimaryScaleFactor(screen);

		screen.emit(event);

		getCachedDisplays(screen);
		getCachedPrimaryScaleFactor(screen);

		expect(screen.getAllDisplays).toHaveBeenCalledTimes(2);
		expect(screen.getPrimaryDisplay).toHaveBeenCalledTimes(2);
	});

	it("subscribes to display topology events only once per screen", () => {
		const screen = createFakeScreen({ displays: [], primaryScaleFactor: 1 });

		getCachedDisplays(screen);
		getCachedDisplays(screen);
		getCachedPrimaryScaleFactor(screen);

		expect(screen.on).toHaveBeenCalledTimes(3);
	});
});
