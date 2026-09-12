import { describe, expect, it } from "vitest";

import {
	resolveWindowsCaptureDisplay,
	resolveWindowsCaptureTarget,
} from "./windowsCaptureSelection";

describe("resolveWindowsCaptureDisplay", () => {
	const primaryDisplay = {
		id: 101,
		bounds: {
			x: 0,
			y: 0,
			width: 1920,
			height: 1080,
		},
	};

	const secondaryDisplay = {
		id: 202,
		bounds: {
			x: 1920,
			y: -40,
			width: 2560,
			height: 1440,
		},
		scaleFactor: 1.5,
	};

	it("uses the requested secondary display bounds for WGC fallback metadata", () => {
		const resolved = resolveWindowsCaptureDisplay(
			{ display_id: String(secondaryDisplay.id) },
			[primaryDisplay, secondaryDisplay],
			primaryDisplay,
		);

		expect(resolved).toEqual({
			displayId: secondaryDisplay.id,
			bounds: secondaryDisplay.bounds,
			scaleFactor: 1.5,
		});
	});

	it("falls back to the primary display when the source has no display id", () => {
		const resolved = resolveWindowsCaptureDisplay(
			undefined,
			[primaryDisplay, secondaryDisplay],
			primaryDisplay,
		);

		expect(resolved).toEqual({
			displayId: primaryDisplay.id,
			bounds: primaryDisplay.bounds,
			scaleFactor: 1,
		});
	});

	it("keeps the requested display id even if Electron cannot rematch it, while using primary bounds", () => {
		const resolved = resolveWindowsCaptureDisplay(
			{ display_id: "303" },
			[primaryDisplay, secondaryDisplay],
			primaryDisplay,
		);

		expect(resolved).toEqual({
			displayId: 303,
			bounds: primaryDisplay.bounds,
			scaleFactor: 1,
		});
	});
});

describe("resolveWindowsCaptureTarget", () => {
	const primaryDisplay = {
		id: 101,
		bounds: {
			x: 0,
			y: 0,
			width: 1920,
			height: 1080,
		},
	};

	const secondaryDisplay = {
		id: 202,
		bounds: {
			x: 1920,
			y: -40,
			width: 2560,
			height: 1440,
		},
		scaleFactor: 1.5,
	};

	it("uses a window handle when a Windows window source is selected", () => {
		const resolved = resolveWindowsCaptureTarget(
			{ id: "window:123456:0", sourceType: "window" },
			[primaryDisplay, secondaryDisplay],
			primaryDisplay,
		);

		expect(resolved).toEqual({
			kind: "window",
			windowHandle: 123456,
		});
	});

	it("does not silently turn an invalid window source into display capture", () => {
		const resolved = resolveWindowsCaptureTarget(
			{ id: "window:0:0", sourceType: "window", display_id: String(secondaryDisplay.id) },
			[primaryDisplay, secondaryDisplay],
			primaryDisplay,
		);

		expect(resolved).toEqual({
			kind: "invalid-window",
		});
	});

	it("keeps display capture behavior for selected screens", () => {
		const resolved = resolveWindowsCaptureTarget(
			{ id: "screen:202:0", sourceType: "screen", display_id: String(secondaryDisplay.id) },
			[primaryDisplay, secondaryDisplay],
			primaryDisplay,
		);

		expect(resolved).toEqual({
			kind: "display",
			displayId: secondaryDisplay.id,
			bounds: secondaryDisplay.bounds,
			scaleFactor: 1.5,
		});
	});
});

describe("region capture target", () => {
	const displays = [
		{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
		{ id: 2, bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, scaleFactor: 2 },
		{ id: 3, bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
	];

	it("resolves a region on the requested display with DIP-to-physical conversion", () => {
		const target = resolveWindowsCaptureTarget(
			{
				name: "Region",
				display_id: "2",
				sourceType: "region",
				region: { x: 2020, y: 50, width: 400, height: 300 },
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

	it("resolves a region on a negative-origin display relative to that display", () => {
		const target = resolveWindowsCaptureTarget(
			{
				name: "Region",
				display_id: "3",
				sourceType: "region",
				region: { x: -1800, y: 100, width: 200, height: 150 },
			},
			displays,
			displays[0],
		);
		expect(target.kind).toBe("region");
		if (target.kind !== "region") return;
		expect(target.region).toEqual({ x: 120, y: 100, width: 200, height: 150 });
	});

	it("treats a missing/invalid region as a full-display capture", () => {
		const target = resolveWindowsCaptureTarget(
			{ name: "Screen", display_id: "1", sourceType: "region" },
			displays,
			displays[0],
		);
		expect(target.kind).toBe("display");
	});

	it("falls back to a full-display capture for a degenerate 1x1 region", () => {
		const target = resolveWindowsCaptureTarget(
			{
				name: "Region",
				display_id: "1",
				sourceType: "region",
				region: { x: 500, y: 500, width: 1, height: 1 },
			},
			displays,
			displays[0],
		);
		expect(target.kind).toBe("display");
		if (target.kind !== "display") return;
		expect(target.displayId).toBe(1);
		expect(target.bounds).toEqual(displays[0].bounds);
	});
});
