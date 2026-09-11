import fs from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import { AUTO_RECORDING_MAX_AGE_MS, AUTO_RECORDING_PREFIX } from "../constants";
import { getRecordingsDir, moveFileWithOverwrite } from "../utils";
import { validateRecordedVideo } from "./diagnostics";

// Native Windows capture writes to `<temp>/recordly-native-<timestamp>.mp4` while recording and
// moves it into the recordings library on a clean stop. When the main process is killed mid-recording,
// the capture helper still finalizes the mp4 (stdin EOF -> stopCapture + finalize), so a complete,
// playable file is left orphaned in temp. These orphans are the only reliable signal of an
// interrupted Windows session, so recovery is a startup scan of temp rather than an in-flight journal.
const ORPHAN_VIDEO_PATTERN = /^recordly-native-(\d+)\.mp4$/i;

// A helper that is *still* finalizing produces a briefly-unplayable file. Skip anything modified this
// recently and let the next launch claim it, rather than risking discarding a valid in-progress write.
const RECOVERY_SETTLE_MS = 5_000;

export type RecoveredWindowsRecording = {
	path: string;
	timestamp: number;
	hasSystemAudio: boolean;
	hasMicAudio: boolean;
};

let pendingRecoveredRecordings: RecoveredWindowsRecording[] = [];

// Pull-based handoff to the renderer: consumed once so the "recovered" toast shows a single time.
export function consumeRecoveredWindowsRecordings(): RecoveredWindowsRecording[] {
	const result = pendingRecoveredRecordings;
	pendingRecoveredRecordings = [];
	return result;
}

async function pathExists(target: string): Promise<boolean> {
	try {
		await fs.access(target);
		return true;
	} catch {
		return false;
	}
}

// Move an audio sidecar (and its `.json` metadata, when present) next to the recovered video.
// Empty or missing sidecars are dropped so they cannot be mistaken for real audio later.
async function relocateAudioSidecar(
	tempAudioPath: string,
	finalAudioPath: string,
): Promise<boolean> {
	if (!(await pathExists(tempAudioPath))) {
		return false;
	}

	const stat = await fs.stat(tempAudioPath).catch(() => null);
	if (!stat || stat.size <= 0) {
		await fs.rm(tempAudioPath, { force: true }).catch(() => undefined);
		return false;
	}

	await moveFileWithOverwrite(tempAudioPath, finalAudioPath);

	const tempJsonPath = `${tempAudioPath}.json`;
	if (await pathExists(tempJsonPath)) {
		await moveFileWithOverwrite(tempJsonPath, `${finalAudioPath}.json`).catch(() => undefined);
	}

	return true;
}

export async function recoverInterruptedWindowsRecordings(): Promise<RecoveredWindowsRecording[]> {
	if (process.platform !== "win32") {
		return [];
	}

	let tempDir: string;
	try {
		tempDir = app.getPath("temp");
	} catch {
		return [];
	}

	let recordingsDir: string;
	try {
		recordingsDir = await getRecordingsDir();
	} catch (error) {
		console.warn("[recover] Failed to resolve recordings directory:", error);
		return [];
	}

	let entries: string[];
	try {
		entries = await fs.readdir(tempDir);
	} catch (error) {
		console.warn("[recover] Failed to scan temp directory:", error);
		return [];
	}

	const recovered: RecoveredWindowsRecording[] = [];
	const now = Date.now();

	for (const entry of entries) {
		const match = ORPHAN_VIDEO_PATTERN.exec(entry);
		if (!match) {
			continue;
		}

		const timestamp = Number(match[1]);
		if (!Number.isFinite(timestamp)) {
			continue;
		}

		const tempVideoPath = path.join(tempDir, entry);
		const stat = await fs.stat(tempVideoPath).catch(() => null);
		if (!stat) {
			continue;
		}

		const finalVideoPath = path.join(recordingsDir, `${AUTO_RECORDING_PREFIX}${timestamp}.mp4`);

		// Already relocated by a previous launch: drop the leftover temp orphan and stay idempotent.
		if (await pathExists(finalVideoPath)) {
			await fs.rm(tempVideoPath, { force: true }).catch(() => undefined);
			continue;
		}

		// Ancient orphans are not worth resurrecting; let the temp copy go.
		if (now - stat.mtimeMs > AUTO_RECORDING_MAX_AGE_MS) {
			await fs.rm(tempVideoPath, { force: true }).catch(() => undefined);
			continue;
		}

		// May still be finalizing; retry on the next launch instead of touching it now.
		if (now - stat.mtimeMs < RECOVERY_SETTLE_MS) {
			continue;
		}

		// Preserve anything we cannot prove playable rather than deleting user data on a hiccup.
		try {
			await validateRecordedVideo(tempVideoPath);
		} catch (error) {
			console.warn(
				"[recover] Skipping unplayable interrupted recording (left in temp):",
				tempVideoPath,
				error,
			);
			continue;
		}

		try {
			await moveFileWithOverwrite(tempVideoPath, finalVideoPath);
		} catch (error) {
			console.error(
				"[recover] Failed to relocate interrupted recording:",
				tempVideoPath,
				error,
			);
			continue;
		}

		const finalBasePath = finalVideoPath.replace(/\.mp4$/i, "");
		const hasSystemAudio = await relocateAudioSidecar(
			path.join(tempDir, `recordly-native-${timestamp}.system.wav`),
			`${finalBasePath}.system.wav`,
		).catch((error) => {
			console.warn("[recover] Failed to relocate system audio sidecar:", error);
			return false;
		});
		const hasMicAudio = await relocateAudioSidecar(
			path.join(tempDir, `recordly-native-${timestamp}.mic.wav`),
			`${finalBasePath}.mic.wav`,
		).catch((error) => {
			console.warn("[recover] Failed to relocate microphone audio sidecar:", error);
			return false;
		});

		recovered.push({ path: finalVideoPath, timestamp, hasSystemAudio, hasMicAudio });
	}

	if (recovered.length > 0) {
		pendingRecoveredRecordings = [...pendingRecoveredRecordings, ...recovered];
		console.log(`[recover] Recovered ${recovered.length} interrupted Windows recording(s).`);
	}

	return recovered;
}
