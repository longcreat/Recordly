import { describe, expect, it } from "vitest";
import { qualityToBitratePercent, resolveRecordingQuality } from "./qualityPreference";

describe("recording quality preference", () => {
	it("defaults to high (= current behavior)", () => {
		expect(resolveRecordingQuality(undefined)).toBe("high");
		expect(resolveRecordingQuality("bogus")).toBe("high");
		expect(resolveRecordingQuality(null)).toBe("high");
	});

	it("maps tiers to bitrate percent consistent with export encoding modes", () => {
		expect(qualityToBitratePercent("standard")).toBe(50);
		expect(qualityToBitratePercent("balanced")).toBe(80);
		expect(qualityToBitratePercent("high")).toBe(100);
	});

	it("accepts every declared tier", () => {
		expect(resolveRecordingQuality("standard")).toBe("standard");
		expect(resolveRecordingQuality("balanced")).toBe("balanced");
		expect(resolveRecordingQuality("high")).toBe("high");
	});
});
