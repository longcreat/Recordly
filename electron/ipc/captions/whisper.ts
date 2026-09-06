import { createWriteStream, constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import type Electron from "electron";
import { net } from "electron";
import {
	WHISPER_MODEL_DIR,
	WHISPER_MODEL_DOWNLOAD_URL,
	WHISPER_SMALL_MODEL_PATH,
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

export async function getWhisperSmallModelStatus() {
	try {
		await fs.access(WHISPER_SMALL_MODEL_PATH, fsConstants.R_OK);
		return {
			success: true,
			exists: true,
			path: WHISPER_SMALL_MODEL_PATH,
		};
	} catch {
		return {
			success: true,
			exists: false,
			path: null,
		};
	}
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
	await fs.mkdir(WHISPER_MODEL_DIR, { recursive: true });
	const tempPath = `${WHISPER_SMALL_MODEL_PATH}.download`;

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
		await fs.rename(tempPath, WHISPER_SMALL_MODEL_PATH);
		sendWhisperModelDownloadProgress(webContents, {
			status: "downloaded",
			progress: 100,
			path: WHISPER_SMALL_MODEL_PATH,
		});
		return WHISPER_SMALL_MODEL_PATH;
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
	await fs.rm(WHISPER_SMALL_MODEL_PATH, { force: true });
}
