import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

export interface RecordingClusterOptions {
	timestamp?: number;
	includeWebcam?: boolean;
	includeSystemAudio?: boolean;
	includeMicAudio?: boolean;
	includeCursorTelemetry?: boolean;
	includeSessionManifest?: boolean;
	videoContent?: string;
}

export interface RecordingClusterPaths {
	timestamp: number;
	videoPath: string;
	webcamPath?: string;
	systemAudioPath?: string;
	micAudioPath?: string;
	cursorTelemetryPath?: string;
	sessionManifestPath?: string;
}

export interface ProjectManifestOptions {
	projectId?: string;
	projectName?: string;
	videoPath: string;
	webcamPath?: string;
	systemAudioPath?: string;
	micAudioPath?: string;
}

/**
 * Creates an isolated sandboxed directory tree for E2E tests.
 */
export async function createSandbox(prefix = "recordly-e2e-"): Promise<{
	root: string;
	sourceDir: string;
	targetDir: string;
	projectsDir: string;
	cleanup: () => Promise<void>;
}> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	const sourceDir = path.join(root, "source-recordings");
	const targetDir = path.join(root, "target-recordings");
	const projectsDir = path.join(sourceDir, "Projects");

	await fs.mkdir(sourceDir, { recursive: true });
	await fs.mkdir(targetDir, { recursive: true });
	await fs.mkdir(projectsDir, { recursive: true });

	const cleanup = async () => {
		try {
			await fs.rm(root, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors in test sandbox
		}
	};

	return {
		root,
		sourceDir,
		targetDir,
		projectsDir,
		cleanup,
	};
}

/**
 * Generates a complete synchronized recording file cluster in a directory.
 */
export async function createRecordingCluster(
	dir: string,
	options: RecordingClusterOptions = {}
): Promise<RecordingClusterPaths> {
	const ts = options.timestamp ?? Date.now() + Math.floor(Math.random() * 1000);
	const baseName = `recording-${ts}`;
	const videoPath = path.join(dir, `${baseName}.mp4`);
	await fs.writeFile(videoPath, options.videoContent ?? `VIDEO_CONTENT_${ts}`);

	let webcamPath: string | undefined;
	if (options.includeWebcam ?? true) {
		webcamPath = path.join(dir, `${baseName}-webcam.mp4`);
		await fs.writeFile(webcamPath, `WEBCAM_CONTENT_${ts}`);
	}

	let systemAudioPath: string | undefined;
	if (options.includeSystemAudio ?? true) {
		systemAudioPath = path.join(dir, `${baseName}.system.wav`);
		await fs.writeFile(systemAudioPath, `SYSTEM_AUDIO_${ts}`);
	}

	let micAudioPath: string | undefined;
	if (options.includeMicAudio ?? true) {
		micAudioPath = path.join(dir, `${baseName}.mic.wav`);
		await fs.writeFile(micAudioPath, `MIC_AUDIO_${ts}`);
		await fs.writeFile(
			path.join(dir, `${baseName}.mic.wav.json`),
			JSON.stringify({ durationMs: 5000, sampleRate: 48000 })
		);
	}

	let cursorTelemetryPath: string | undefined;
	if (options.includeCursorTelemetry ?? true) {
		cursorTelemetryPath = path.join(dir, `${baseName}.mp4.cursor.json`);
		await fs.writeFile(
			cursorTelemetryPath,
			JSON.stringify([
				{ time: 0, x: 100, y: 100 },
				{ time: 1000, x: 200, y: 200 },
			])
		);
	}

	let sessionManifestPath: string | undefined;
	if (options.includeSessionManifest ?? true) {
		sessionManifestPath = path.join(dir, `${baseName}.mp4.recordly-session.json`);
		await fs.writeFile(
			sessionManifestPath,
			JSON.stringify({
				sessionId: randomUUID(),
				videoFileName: `${baseName}.mp4`,
				webcamFileName: webcamPath ? `${baseName}-webcam.mp4` : undefined,
				startedAt: ts,
			})
		);
	}

	return {
		timestamp: ts,
		videoPath,
		webcamPath,
		systemAudioPath,
		micAudioPath,
		cursorTelemetryPath,
		sessionManifestPath,
	};
}

/**
 * Creates a valid .recordly project file referencing files in the cluster.
 */
export async function createProjectFile(
	projectsDir: string,
	options: ProjectManifestOptions
): Promise<{ projectPath: string; projectData: any }> {
	const projectId = options.projectId ?? randomUUID();
	const projectName = options.projectName ?? `Project_${projectId.slice(0, 8)}`;
	const projectPath = path.join(projectsDir, `${projectName}.recordly`);

	const projectData = {
		version: 1,
		projectId,
		projectName,
		videoPath: path.resolve(options.videoPath),
		editor: {
			webcam: options.webcamPath
				? { sourcePath: path.resolve(options.webcamPath) }
				: undefined,
			audioTracks: options.systemAudioPath
				? [
						{
							id: "track-system-1",
							sourcePath: path.resolve(options.systemAudioPath),
							volume: 1.0,
						},
				  ]
				: [],
			audioRegions: options.micAudioPath
				? [
						{
							id: "region-mic-1",
							audioPath: path.resolve(options.micAudioPath),
							startMs: 0,
							endMs: 5000,
						},
				  ]
				: [],
			timeline: {
				durationMs: 5000,
			},
		},
	};

	await fs.writeFile(projectPath, JSON.stringify(projectData, null, 2), "utf-8");

	// Also write thumbnail preview
	const thumbnailPath = path.join(projectsDir, `${projectName}.recordly.preview.png`);
	await fs.writeFile(thumbnailPath, `PREVIEW_PNG_${projectId}`);

	return {
		projectPath,
		projectData,
	};
}

/**
 * Safe reference remapping algorithm matching Project Specification for testing.
 */
export function remapProjectFileContent(
	content: string,
	oldDir: string,
	newDir: string,
	renamedMap: Map<string, string> = new Map()
): string {
	const parsed = JSON.parse(content);
	const normOld = path.resolve(oldDir).toLowerCase();

	const remapPath = (currentPath?: string): string | undefined => {
		if (!currentPath) return currentPath;
		const normCurrent = path.resolve(currentPath);
		if (renamedMap.has(normCurrent.toLowerCase())) {
			return renamedMap.get(normCurrent.toLowerCase());
		}
		if (normCurrent.toLowerCase().startsWith(normOld)) {
			const rel = path.relative(normOld, normCurrent);
			return path.resolve(newDir, rel);
		}
		return currentPath;
	};

	if (parsed.videoPath) {
		parsed.videoPath = remapPath(parsed.videoPath);
	}

	if (parsed.editor?.webcam?.sourcePath) {
		parsed.editor.webcam.sourcePath = remapPath(parsed.editor.webcam.sourcePath);
	}

	if (Array.isArray(parsed.editor?.audioTracks)) {
		for (const track of parsed.editor.audioTracks) {
			if (track.sourcePath) {
				track.sourcePath = remapPath(track.sourcePath);
			}
		}
	}

	if (Array.isArray(parsed.editor?.audioRegions)) {
		for (const region of parsed.editor.audioRegions) {
			if (region.audioPath) {
				region.audioPath = remapPath(region.audioPath);
			}
		}
	}

	return JSON.stringify(parsed, null, 2);
}
