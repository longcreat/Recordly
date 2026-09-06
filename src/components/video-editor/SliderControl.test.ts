import { describe, expect, it } from "vitest";
import { quantizeToStep, sliderPositionToValue, sliderValueToPosition } from "./SliderControl";

const SPEED_MIN = 0.5;
const SPEED_MAX = 30;
const SPEED_STEP = 0.5;

describe("slider scale mapping (logarithmic)", () => {
	it("maps the track ends to the min and max values", () => {
		expect(sliderPositionToValue(0, SPEED_MIN, SPEED_MAX, "logarithmic")).toBeCloseTo(0.5, 6);
		expect(sliderPositionToValue(1, SPEED_MIN, SPEED_MAX, "logarithmic")).toBeCloseTo(30, 6);
	});

	it("round-trips value -> position -> value across the speed range", () => {
		for (const speed of [0.5, 1, 2, 4, 8, 16, 30]) {
			const position = sliderValueToPosition(speed, SPEED_MIN, SPEED_MAX, "logarithmic");
			expect(
				sliderPositionToValue(position, SPEED_MIN, SPEED_MAX, "logarithmic"),
			).toBeCloseTo(speed, 6);
		}
	});

	it("gives the slow range far more track than a linear scale would", () => {
		// 1x sits at log(2)/log(60) ~ 0.169 of the track, so the most-used 0.5x..4x
		// band occupies roughly half the slider instead of ~12% on a linear scale.
		const positionOfOne = sliderValueToPosition(1, SPEED_MIN, SPEED_MAX, "logarithmic");
		const positionOfFour = sliderValueToPosition(4, SPEED_MIN, SPEED_MAX, "logarithmic");
		expect(positionOfOne).toBeCloseTo(Math.log(2) / Math.log(60), 6);
		expect(positionOfOne).toBeLessThan(0.2);
		expect(positionOfFour).toBeGreaterThan(0.45);
		expect(positionOfFour).toBeLessThan(0.55);
	});

	it("falls back to linear mapping when min is not strictly positive", () => {
		expect(sliderPositionToValue(0.5, 0, 10, "logarithmic")).toBeCloseTo(5, 6);
		expect(sliderValueToPosition(5, 0, 10, "logarithmic")).toBeCloseTo(0.5, 6);
	});
});

describe("slider scale mapping (linear)", () => {
	it("maps proportionally by default", () => {
		expect(sliderPositionToValue(0.5, 0, 10, "linear")).toBeCloseTo(5, 6);
		expect(sliderValueToPosition(2.5, 0, 10, "linear")).toBeCloseTo(0.25, 6);
	});
});

describe("quantizeToStep (speed snapping)", () => {
	it("snaps arbitrary drag values to clean 0.5 multiples", () => {
		expect(quantizeToStep(3.87, SPEED_MIN, SPEED_STEP)).toBe(4);
		expect(quantizeToStep(0.74, SPEED_MIN, SPEED_STEP)).toBe(0.5);
		expect(quantizeToStep(0.76, SPEED_MIN, SPEED_STEP)).toBe(1);
		expect(quantizeToStep(29.9, SPEED_MIN, SPEED_STEP)).toBe(30);
	});

	it("returns the value unchanged when step is not positive", () => {
		expect(quantizeToStep(3.3, SPEED_MIN, 0)).toBe(3.3);
	});
});

describe("log scale + snap composition", () => {
	it("commits clean in-range 0.5-step speeds for positions across the track", () => {
		for (let i = 0; i <= 20; i += 1) {
			const position = i / 20;
			const raw = sliderPositionToValue(position, SPEED_MIN, SPEED_MAX, "logarithmic");
			const snapped = quantizeToStep(raw, SPEED_MIN, SPEED_STEP);

			expect(snapped).toBeGreaterThanOrEqual(SPEED_MIN);
			expect(snapped).toBeLessThanOrEqual(SPEED_MAX);
			// The committed value is always an exact multiple of the 0.5 step.
			expect(Math.abs(snapped / SPEED_STEP - Math.round(snapped / SPEED_STEP))).toBeLessThan(
				1e-9,
			);
		}
	});
});
