import { describe, expect, it } from "vitest";
import { resolveRecordingFrameRate } from "./frameRatePreference";

describe("resolveRecordingFrameRate", () => {
	it("accepts the supported rates", () => {
		expect(([24, 30, 60] as const).map((rate) => resolveRecordingFrameRate(rate))).toEqual([
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
