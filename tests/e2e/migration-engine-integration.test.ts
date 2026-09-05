import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

vi.mock("electron", () => ({
	app: {
		isPackaged: false,
		getAppPath: () => process.cwd(),
		getPath: (name: string) => {
			if (name === "userData") return path.join(os.tmpdir(), "recordly-test-userData");
			if (name === "temp") return os.tmpdir();
			return process.cwd();
		},
	},
}));

import { createSandbox, createRecordingCluster, createProjectFile } from "./helpers/test-harness";
import { migrateRecordingsDirectory } from "../../electron/ipc/project/migration";
import { PROJECTS_DIRECTORY_NAME } from "../../electron/ipc/constants";

describe("Migration Engine Integration Tests", () => {
	let sandbox: Awaited<ReturnType<typeof createSandbox>>;

	beforeEach(async () => {
		sandbox = await createSandbox("recordly-mig-int-");
	});

	afterEach(async () => {
		await sandbox.cleanup();
	});

	it("atomically moves recordings, companion files, projects, and rewrites paths", async () => {
		const cluster = await createRecordingCluster(sandbox.sourceDir, {
			includeWebcam: true,
			includeSystemAudio: true,
			includeMicAudio: true,
			includeCursorTelemetry: true,
			includeSessionManifest: true,
		});

		const { projectPath } = await createProjectFile(sandbox.projectsDir, {
			videoPath: cluster.videoPath,
			webcamPath: cluster.webcamPath,
			systemAudioPath: cluster.systemAudioPath,
			micAudioPath: cluster.micAudioPath,
		});

		const result = await migrateRecordingsDirectory(sandbox.sourceDir, sandbox.targetDir);

		expect(result.success).toBe(true);
		expect(result.movedFilesCount).toBeGreaterThan(0);
		expect(result.updatedProjectsCount).toBe(1);

		// Verify source files were moved
		await expect(fs.access(cluster.videoPath)).rejects.toThrow();

		// Verify target files exist
		const targetVideo = path.join(sandbox.targetDir, path.basename(cluster.videoPath));
		await expect(fs.access(targetVideo)).resolves.toBeUndefined();

		// Verify target project exists and paths were rewritten
		const targetProject = path.join(
			sandbox.targetDir,
			PROJECTS_DIRECTORY_NAME,
			path.basename(projectPath)
		);
		await expect(fs.access(targetProject)).resolves.toBeUndefined();

		const content = await fs.readFile(targetProject, "utf-8");
		const parsed = JSON.parse(content);
		expect(parsed.videoPath.toLowerCase().startsWith(sandbox.targetDir.toLowerCase())).toBe(true);
		expect(parsed.editor.webcam.sourcePath.toLowerCase().startsWith(sandbox.targetDir.toLowerCase())).toBe(true);
		expect(parsed.editor.audioTracks[0].sourcePath.toLowerCase().startsWith(sandbox.targetDir.toLowerCase())).toBe(true);
		expect(parsed.editor.audioRegions[0].audioPath.toLowerCase().startsWith(sandbox.targetDir.toLowerCase())).toBe(true);
	});
});
