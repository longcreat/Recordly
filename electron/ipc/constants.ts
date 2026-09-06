import path from "node:path";
import { app } from "electron";
import { USER_DATA_PATH } from "../appPaths";

export const PROJECT_FILE_EXTENSION = "recordly";
export const LEGACY_PROJECT_FILE_EXTENSIONS = ["openscreen"];
export const PROJECTS_DIRECTORY_NAME = "Projects";
export const PROJECT_THUMBNAIL_SUFFIX = ".preview.png";
export const RECENT_PROJECTS_FILE = path.join(USER_DATA_PATH, "recent-projects.json");
export const MAX_RECENT_PROJECTS = 16;
export const SHORTCUTS_FILE = path.join(USER_DATA_PATH, "shortcuts.json");
export const RECORDINGS_SETTINGS_FILE = path.join(USER_DATA_PATH, "recordings-settings.json");
export const COUNTDOWN_SETTINGS_FILE = path.join(USER_DATA_PATH, "countdown-settings.json");
export const APP_SETTINGS_FILE = path.join(USER_DATA_PATH, "app-settings.json");
export const AUTO_RECORDING_PREFIX = "recording-";
export const AUTO_RECORDING_RETENTION_COUNT = 20;
export const AUTO_RECORDING_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const ALLOW_RECORDLY_WINDOW_CAPTURE = Boolean(process.env["VITE_DEV_SERVER_URL"]);
export const RECORDING_SESSION_MANIFEST_SUFFIX = ".recordly-session.json";
export const WHISPER_MODEL_DOWNLOAD_URL =
	"https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin";
export const WHISPER_MODEL_FILE_NAME = "ggml-small.bin";
// Legacy C-drive location (userData). Kept so an already-downloaded model still
// works after upgrading, and used as the fallback target.
export const LEGACY_WHISPER_MODEL_DIR = path.join(USER_DATA_PATH, "whisper");
export const LEGACY_WHISPER_SMALL_MODEL_PATH = path.join(
	LEGACY_WHISPER_MODEL_DIR,
	WHISPER_MODEL_FILE_NAME,
);

// Portable model location: resolved at runtime so the model lands beside the app
// on whatever drive the user installed to. Packaged apps derive the install root
// from the running executable; dev builds (no install dir) fall back to userData.
export function getWhisperModelDir(): string {
	if (app.isPackaged) {
		try {
			return path.join(path.dirname(app.getPath("exe")), "whisper");
		} catch {
			// Fall through to the userData location below.
		}
	}
	return LEGACY_WHISPER_MODEL_DIR;
}

export function getWhisperSmallModelPath(): string {
	return path.join(getWhisperModelDir(), WHISPER_MODEL_FILE_NAME);
}
export const COMPANION_AUDIO_LAYOUTS = [
	{ platform: "mac" as const, systemSuffix: ".system.m4a", micSuffix: ".mic.m4a" },
	{ platform: "win" as const, systemSuffix: ".system.wav", micSuffix: ".mic.wav" },
	{ platform: "mac" as const, systemSuffix: ".system.webm", micSuffix: ".mic.webm" },
];

export const CURSOR_TELEMETRY_VERSION = 2;
export const CURSOR_SAMPLE_INTERVAL_MS = 33;
export const MAX_CURSOR_SAMPLES = 60 * 60 * 30; // 1 hour @ 30Hz
