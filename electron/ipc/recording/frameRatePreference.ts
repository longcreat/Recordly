export type RecordingFrameRate = 24 | 30 | 60;

export function resolveRecordingFrameRate(raw: unknown): RecordingFrameRate {
	return raw === 24 || raw === 30 ? raw : 60;
}
