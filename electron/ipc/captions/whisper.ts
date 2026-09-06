import { createWriteStream, constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type Electron from "electron";
import { net } from "electron";
import {
	getWhisperModelDir,
	getWhisperSmallModelPath,
	LEGACY_WHISPER_MODEL_DIR,
	LEGACY_WHISPER_SMALL_MODEL_PATH,
	WHISPER_MODEL_DOWNLOAD_URL,
	WHISPER_MODEL_FILE_NAME,
} from "../constants";

export function sendWhisperModelDownloadProgress(
	webContents: Electron.WebContents,
	payload: {
		status: "idle" | "downloading" | "downloaded" | "error";
		progress: number;
		path?: string | null;
		error?: string;
	},
) {
	webContents.send("whisper-small-model-download-progress", payload);
}

async function fileReadable(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath, fsConstants.R_OK);
		return true;
	} catch {
		return false;
	}
}

// The model may live in the install dir (new portable default) or the legacy
// userData dir (older installs). Prefer whichever already exists.
async function resolveExistingModelPath(): Promise<string | null> {
	for (const candidate of [getWhisperSmallModelPath(), LEGACY_WHISPER_SMALL_MODEL_PATH]) {
		if (await fileReadable(candidate)) return candidate;
	}
	return null;
}

// Pick a writable target dir: prefer the install dir, fall back to userData when the
// install dir isn't writable (e.g. a per-machine install without admin rights).
async function resolveWritableModelDir(): Promise<string> {
	for (const dir of [getWhisperModelDir(), LEGACY_WHISPER_MODEL_DIR]) {
		try {
			await fs.mkdir(dir, { recursive: true });
			await fs.access(dir, fsConstants.W_OK);
			return dir;
		} catch {
			// Try the next candidate.
		}
	}
	return LEGACY_WHISPER_MODEL_DIR;
}

function getManagedWhisperModelPaths(): string[] {
	return [...new Set([getWhisperSmallModelPath(), LEGACY_WHISPER_SMALL_MODEL_PATH])];
}

export async function getWhisperSmallModelStatus() {
	const existingPath = await resolveExistingModelPath();
	return {
		success: true,
		exists: existingPath !== null,
		path: existingPath,
		// Lets the renderer recognise (and clear) persisted paths that point at a
		// managed small-model location which no longer exists on disk.
		managedPaths: getManagedWhisperModelPaths(),
	};
}

export function downloadFileWithProgress(
	url: string,
	destinationPath: string,
	onProgress: (progress: number) => void,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const controller = new AbortController();
		// Inactivity timeout (same spirit as the old socket timeout): abort if no chunk
		// arrives within 30s. Re-armed on every chunk so slow-but-steady transfers survive.
		let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
		const armInactivityTimer = () => {
			if (inactivityTimer) clearTimeout(inactivityTimer);
			inactivityTimer = setTimeout(
				() => controller.abort(new Error("Whisper model download timed out.")),
				30_000,
			);
		};
		const clearInactivityTimer = () => {
			if (inactivityTimer) clearTimeout(inactivityTimer);
			inactivityTimer = null;
		};

		let settled = false;
		const fileStream = createWriteStream(destinationPath);
		const fail = (error: unknown) => {
			if (settled) return;
			settled = true;
			clearInactivityTimer();
			fileStream.destroy();
			reject(error instanceof Error ? error : new Error(String(error)));
		};
		fileStream.on("error", fail);

		armInactivityTimer();
		// net.fetch uses Chromium's network stack, so it honours the OS system proxy
		// (node:https does not) and follows redirects by default.
		net.fetch(url, { signal: controller.signal })
			.then(async (response) => {
				if (!response.ok) {
					fail(
						new Error(`Whisper model download failed with status ${response.status}.`),
					);
					return;
				}
				const body = response.body;
				if (!body) {
					fail(new Error("Whisper model download returned an empty body."));
					return;
				}
				const totalBytes = Number.parseInt(
					response.headers.get("content-length") ?? "0",
					10,
				);
				const reader = body.getReader();
				let downloadedBytes = 0;
				try {
					for (;;) {
						const { done, value } = await reader.read();
						if (done) break;
						armInactivityTimer();
						downloadedBytes += value?.byteLength ?? 0;
						if (Number.isFinite(totalBytes) && totalBytes > 0) {
							onProgress(
								Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)),
							);
						}
						// Backpressure: wait for the file stream to drain before reading more.
						if (!fileStream.write(Buffer.from(value))) {
							await new Promise<void>((drain) => fileStream.once("drain", drain));
						}
					}
				} catch (error) {
					fail(error);
					return;
				}
				fileStream.end(() => {
					if (settled) return;
					settled = true;
					clearInactivityTimer();
					onProgress(100);
					resolve();
				});
			})
			.catch(fail);
	});
}

export async function downloadWhisperSmallModel(
	webContents: Electron.WebContents,
): Promise<string> {
	const targetDir = await resolveWritableModelDir();
	const targetPath = path.join(targetDir, WHISPER_MODEL_FILE_NAME);
	const tempPath = `${targetPath}.download`;

	sendWhisperModelDownloadProgress(webContents, {
		status: "downloading",
		progress: 0,
		path: null,
	});

	try {
		await fs.rm(tempPath, { force: true });
		await downloadFileWithProgress(WHISPER_MODEL_DOWNLOAD_URL, tempPath, (progress) => {
			sendWhisperModelDownloadProgress(webContents, {
				status: "downloading",
				progress,
				path: null,
			});
		});
		await fs.rename(tempPath, targetPath);
		sendWhisperModelDownloadProgress(webContents, {
			status: "downloaded",
			progress: 100,
			path: targetPath,
		});
		return targetPath;
	} catch (error) {
		await fs.rm(tempPath, { force: true }).catch(() => undefined);
		sendWhisperModelDownloadProgress(webContents, {
			status: "error",
			progress: 0,
			path: null,
			error: String(error),
		});
		throw error;
	}
}

export async function deleteWhisperSmallModel(): Promise<void> {
	await fs.rm(getWhisperSmallModelPath(), { force: true }).catch(() => undefined);
	await fs.rm(LEGACY_WHISPER_SMALL_MODEL_PATH, { force: true }).catch(() => undefined);
}
