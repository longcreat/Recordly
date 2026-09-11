import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PLAYABLE_MARKER = "PLAYABLE";

async function setMtime(targetPath: string, ageMs: number) {
	const when = new Date(Date.now() - ageMs);
	await fs.utimes(targetPath, when, when);
}

describe("recoverInterruptedWindowsRecordings", () => {
	let tempRoot: string;
	let appDataPath: string;
	let userDataPath: string;
	let tempPath: string;
	let appPath: string;
	let originalPlatform: PropertyDescriptor | undefined;

	beforeEach(async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-recover-"));
		appDataPath = path.join(tempRoot, "AppData");
		userDataPath = path.join(tempRoot, "UserData");
		tempPath = path.join(tempRoot, "Temp");
		appPath = path.join(tempRoot, "App");

		await Promise.all(
			[appDataPath, userDataPath, tempPath, appPath].map((dirPath) =>
				fs.mkdir(dirPath, { recursive: true }),
			),
		);

		originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });

		vi.resetModules();
		vi.doMock("electron", () => ({
			app: {
				isPackaged: false,
				getAppPath: () => appPath,
				getPath: (name: string) => {
					if (name === "appData") return appDataPath;
					if (name === "userData") return userDataPath;
					if (name === "temp") return tempPath;
					return tempRoot;
				},
				setPath: () => undefined,
			},
		}));
		// Recovery validation normally shells out to ffmpeg; drive it from the file's marker instead.
		vi.doMock("./diagnostics", () => ({
			validateRecordedVideo: vi.fn(async (videoPath: string) => {
				const content = await fs.readFile(videoPath, "utf-8").catch(() => "");
				if (!content.includes(PLAYABLE_MARKER)) {
					throw new Error(`unplayable: ${videoPath}`);
				}
				return { fileSizeBytes: content.length, durationSeconds: 1.5 };
			}),
		}));
	});

	afterEach(async () => {
		vi.resetModules();
		vi.doUnmock("electron");
		vi.doUnmock("./diagnostics");
		if (originalPlatform) {
			Object.defineProperty(process, "platform", originalPlatform);
		}
		if (tempRoot) {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	it("relocates a playable orphan plus companion audio into the library", async () => {
		const { getRecordingsDir } = await import("../utils");
		const { recoverInterruptedWindowsRecordings, consumeRecoveredWindowsRecordings } =
			await import("./recover");

		const recordingsDir = await getRecordingsDir();
		const timestamp = 1_700_000_000_000;
		const tempVideo = path.join(tempPath, `recordly-native-${timestamp}.mp4`);
		const tempSystem = path.join(tempPath, `recordly-native-${timestamp}.system.wav`);
		const tempMic = path.join(tempPath, `recordly-native-${timestamp}.mic.wav`);

		await fs.writeFile(tempVideo, PLAYABLE_MARKER);
		await fs.writeFile(tempSystem, "system-audio");
		await fs.writeFile(tempMic, "mic-audio");
		await setMtime(tempVideo, 60_000);

		const recovered = await recoverInterruptedWindowsRecordings();

		expect(recovered).toHaveLength(1);
		expect(recovered[0]).toMatchObject({
			path: path.join(recordingsDir, `recording-${timestamp}.mp4`),
			timestamp,
			hasSystemAudio: true,
			hasMicAudio: true,
		});

		await expect(
			fs.access(path.join(recordingsDir, `recording-${timestamp}.mp4`)),
		).resolves.toBeUndefined();
		await expect(
			fs.access(path.join(recordingsDir, `recording-${timestamp}.system.wav`)),
		).resolves.toBeUndefined();
		await expect(
			fs.access(path.join(recordingsDir, `recording-${timestamp}.mic.wav`)),
		).resolves.toBeUndefined();
		await expect(fs.access(tempVideo)).rejects.toThrow();

		expect(consumeRecoveredWindowsRecordings()).toHaveLength(1);
		expect(consumeRecoveredWindowsRecordings()).toHaveLength(0);
	});

	it("skips an orphan that may still be finalizing (modified moments ago)", async () => {
		const { getRecordingsDir } = await import("../utils");
		const { recoverInterruptedWindowsRecordings } = await import("./recover");

		const recordingsDir = await getRecordingsDir();
		const timestamp = 1_700_000_000_001;
		const tempVideo = path.join(tempPath, `recordly-native-${timestamp}.mp4`);
		await fs.writeFile(tempVideo, PLAYABLE_MARKER);
		await setMtime(tempVideo, 0);

		const recovered = await recoverInterruptedWindowsRecordings();

		expect(recovered).toHaveLength(0);
		await expect(fs.access(tempVideo)).resolves.toBeUndefined();
		await expect(
			fs.access(path.join(recordingsDir, `recording-${timestamp}.mp4`)),
		).rejects.toThrow();
	});

	it("leaves an unplayable orphan in temp instead of deleting user data", async () => {
		const { getRecordingsDir } = await import("../utils");
		const { recoverInterruptedWindowsRecordings } = await import("./recover");

		const recordingsDir = await getRecordingsDir();
		const timestamp = 1_700_000_000_002;
		const tempVideo = path.join(tempPath, `recordly-native-${timestamp}.mp4`);
		await fs.writeFile(tempVideo, "CORRUPT");
		await setMtime(tempVideo, 60_000);

		const recovered = await recoverInterruptedWindowsRecordings();

		expect(recovered).toHaveLength(0);
		await expect(fs.access(tempVideo)).resolves.toBeUndefined();
		await expect(
			fs.access(path.join(recordingsDir, `recording-${timestamp}.mp4`)),
		).rejects.toThrow();
	});

	it("is idempotent: a leftover temp orphan is dropped when the final already exists", async () => {
		const { getRecordingsDir } = await import("../utils");
		const { recoverInterruptedWindowsRecordings } = await import("./recover");

		const recordingsDir = await getRecordingsDir();
		const timestamp = 1_700_000_000_003;
		const finalVideo = path.join(recordingsDir, `recording-${timestamp}.mp4`);
		await fs.writeFile(finalVideo, "already-recovered");

		const tempVideo = path.join(tempPath, `recordly-native-${timestamp}.mp4`);
		await fs.writeFile(tempVideo, PLAYABLE_MARKER);
		await setMtime(tempVideo, 60_000);

		const recovered = await recoverInterruptedWindowsRecordings();

		expect(recovered).toHaveLength(0);
		await expect(fs.access(tempVideo)).rejects.toThrow();
		const finalContent = await fs.readFile(finalVideo, "utf-8");
		expect(finalContent).toBe("already-recovered");
	});

	it("discards an ancient orphan beyond the retention window", async () => {
		const { getRecordingsDir } = await import("../utils");
		const { recoverInterruptedWindowsRecordings } = await import("./recover");
		const { AUTO_RECORDING_MAX_AGE_MS } = await import("../constants");

		const recordingsDir = await getRecordingsDir();
		const timestamp = 1_700_000_000_004;
		const tempVideo = path.join(tempPath, `recordly-native-${timestamp}.mp4`);
		await fs.writeFile(tempVideo, PLAYABLE_MARKER);
		await setMtime(tempVideo, AUTO_RECORDING_MAX_AGE_MS + 60_000);

		const recovered = await recoverInterruptedWindowsRecordings();

		expect(recovered).toHaveLength(0);
		await expect(fs.access(tempVideo)).rejects.toThrow();
		await expect(
			fs.access(path.join(recordingsDir, `recording-${timestamp}.mp4`)),
		).rejects.toThrow();
	});

	it("ignores non-matching temp files", async () => {
		const { recoverInterruptedWindowsRecordings } = await import("./recover");

		await fs.writeFile(path.join(tempPath, "recordly-native-abc.mp4"), PLAYABLE_MARKER);
		await fs.writeFile(path.join(tempPath, "some-other-file.mp4"), PLAYABLE_MARKER);
		await fs.writeFile(
			path.join(tempPath, "recordly-native-1700000000005.system.wav"),
			"audio",
		);

		const recovered = await recoverInterruptedWindowsRecordings();
		expect(recovered).toHaveLength(0);
	});

	it("is a no-op off Windows", async () => {
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
		const { recoverInterruptedWindowsRecordings } = await import("./recover");

		const timestamp = 1_700_000_000_006;
		const tempVideo = path.join(tempPath, `recordly-native-${timestamp}.mp4`);
		await fs.writeFile(tempVideo, PLAYABLE_MARKER);
		await setMtime(tempVideo, 60_000);

		const recovered = await recoverInterruptedWindowsRecordings();
		expect(recovered).toHaveLength(0);
		await expect(fs.access(tempVideo)).resolves.toBeUndefined();
	});
});
