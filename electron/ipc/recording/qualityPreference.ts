export type RecordingQuality = "standard" | "balanced" | "high";

export function resolveRecordingQuality(raw: unknown): RecordingQuality {
	return raw === "standard" || raw === "balanced" ? raw : "high";
}

// Multipliers intentionally mirror export's getEncodingModeBitrateMultiplier
// (fast 0.5 / balanced 0.8 / quality 1.0) so both pipelines agree.
export function qualityToBitratePercent(quality: RecordingQuality): number {
	switch (quality) {
		case "standard":
			return 50;
		case "balanced":
			return 80;
		case "high":
		default:
			return 100;
	}
}
