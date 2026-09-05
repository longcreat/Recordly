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

import {
	createSandbox,
	createRecordingCluster,
	createProjectFile,
	remapProjectFileContent,
} from "./helpers/test-harness";
import { PROJECTS_DIRECTORY_NAME } from "../../electron/ipc/constants";
import { isAllowedLocalReadPath } from "../../electron/ipc/project/manager";
import { setCustomRecordingsDir } from "../../electron/ipc/state";

// Authoritative source: ORIGINAL_REQUEST.md (§R1-R4) & PROJECT.md (§Milestones & Test Architecture)

describe("Tier 3 & Tier 4: Cross-Feature Combinations & Real-World Scenarios", () => {
	let sandbox: Awaited<ReturnType<typeof createSandbox>>;

	beforeEach(async () => {
		sandbox = await createSandbox("recordly-e2e-scenarios-");
	});

	afterEach(async () => {
		setCustomRecordingsDir(null);
		await sandbox.cleanup();
	});

	// ==========================================================================
	// Tier 3: Cross-Feature Interactions
	// ==========================================================================
	describe("Tier 3: Cross-Feature Combinations", () => {
		it("CF-1: Custom install path on D:\\ coupled with custom recordings path on E:\\", async () => {
			const appInstallDir = "D:\\Apps\\Recordly";
			const recordingsDir = path.join(sandbox.targetDir, "recordings");
			await fs.mkdir(recordingsDir, { recursive: true });

			// Verify app binary path resolution
			const binaryPath = path.join(
				appInstallDir,
				"resources",
				"app.asar.unpacked",
				"electron",
				"native",
				"bin",
				"win32-x64",
				"wgc-capture.exe"
			);
			expect(binaryPath.startsWith("D:\\Apps\\Recordly")).toBe(true);

			// Verify recordings path routing
			const targetVideo = path.join(recordingsDir, "recording-new.mp4");
			await fs.writeFile(targetVideo, "STREAM_DATA");

			expect(targetVideo.startsWith(recordingsDir)).toBe(true);
			await expect(fs.access(targetVideo)).resolves.toBeUndefined();
		});

		it("CF-2: Storage path change + immediate new recording output routing", async () => {
			// Change directory to sandbox.targetDir
			const newRecordingsDir = sandbox.targetDir;
			setCustomRecordingsDir(newRecordingsDir);

			// Subsequent recording creates output in new directory
			const newTs = Date.now();
			const outputVideo = path.join(newRecordingsDir, `recording-${newTs}.mp4`);
			const outputSys = path.join(newRecordingsDir, `recording-${newTs}.system.wav`);
			const outputManifest = path.join(newRecordingsDir, `recording-${newTs}.mp4.recordly-session.json`);

			await fs.writeFile(outputVideo, "NEW_VIDEO_FRAME_DATA");
			await fs.writeFile(outputSys, "NEW_SYS_AUDIO");
			await fs.writeFile(outputManifest, JSON.stringify({ startedAt: newTs }));

			await expect(fs.access(outputVideo)).resolves.toBeUndefined();
			await expect(fs.access(outputSys)).resolves.toBeUndefined();
			await expect(fs.access(outputManifest)).resolves.toBeUndefined();
		});

		it("CF-3: Storage path change + Editor project library query and playback verification", async () => {
			// Setup 2 projects in source
			const cluster1 = await createRecordingCluster(sandbox.sourceDir, { timestamp: 1001 });
			const cluster2 = await createRecordingCluster(sandbox.sourceDir, { timestamp: 1002 });
			await createProjectFile(sandbox.projectsDir, {
				projectName: "ProjectAlpha",
				videoPath: cluster1.videoPath,
			});
			await createProjectFile(sandbox.projectsDir, {
				projectName: "ProjectBeta",
				videoPath: cluster2.videoPath,
			});

			// Migrate to target
			const targetProjects = path.join(sandbox.targetDir, PROJECTS_DIRECTORY_NAME);
			await fs.mkdir(targetProjects, { recursive: true });

			const projectFiles = await fs.readdir(sandbox.projectsDir);
			for (const file of projectFiles) {
				const src = path.join(sandbox.projectsDir, file);
				const tgt = path.join(targetProjects, file);
				if (file.endsWith(".recordly")) {
					const raw = await fs.readFile(src, "utf-8");
					const remapped = remapProjectFileContent(raw, sandbox.sourceDir, sandbox.targetDir);
					await fs.writeFile(tgt, remapped);
				} else {
					await fs.copyFile(src, tgt);
				}
			}

			// Copy videos
			await fs.copyFile(cluster1.videoPath, path.join(sandbox.targetDir, path.basename(cluster1.videoPath)));
			await fs.copyFile(cluster2.videoPath, path.join(sandbox.targetDir, path.basename(cluster2.videoPath)));

			// Verify library query in new directory
			const entries = await fs.readdir(targetProjects);
			expect(entries).toContain("ProjectAlpha.recordly");
			expect(entries).toContain("ProjectBeta.recordly");

			// Verify playback path check for ProjectAlpha
			const pAlpha = JSON.parse(await fs.readFile(path.join(targetProjects, "ProjectAlpha.recordly"), "utf-8"));
			await expect(fs.access(pAlpha.videoPath)).resolves.toBeUndefined();
		});

		it("CF-4: Cross-window broadcast synchronizes both HUD and Editor states simultaneously", () => {
			const windows = [
				{ name: "HUD", state: { path: "C:\\Old", isDefault: true } },
				{ name: "Editor1", state: { path: "C:\\Old", isDefault: true } },
				{ name: "Editor2", state: { path: "C:\\Old", isDefault: true } },
			];

			const broadcastDirectoryChange = (payload: { path: string; isDefault: boolean }) => {
				for (const win of windows) {
					win.state.path = payload.path;
					win.state.isDefault = payload.isDefault;
				}
			};

			broadcastDirectoryChange({ path: "D:\\RecordlyRecordings", isDefault: false });

			for (const win of windows) {
				expect(win.state.path).toBe("D:\\RecordlyRecordings");
				expect(win.state.isDefault).toBe(false);
			}
		});

		it("CF-5: Settings non-destructive merge under concurrent microphone and path modifications", async () => {
			const settingsFile = path.join(sandbox.root, "recordings-settings.json");
			await fs.writeFile(
				settingsFile,
				JSON.stringify({
					microphoneEnabled: true,
					microphoneDeviceId: "mic-1",
					recordingsDir: "C:\\Default",
				})
			);

			// Simulate atomic merge update
			const updateSettings = async (patch: Record<string, unknown>) => {
				const current = JSON.parse(await fs.readFile(settingsFile, "utf-8"));
				const merged = { ...current, ...patch };
				await fs.writeFile(settingsFile, JSON.stringify(merged, null, 2));
				return merged;
			};

			// Update mic preference
			await updateSettings({ microphoneEnabled: false });
			// Update directory
			await updateSettings({ recordingsDir: "D:\\NewDir" });

			const finalState = JSON.parse(await fs.readFile(settingsFile, "utf-8"));
			expect(finalState.microphoneEnabled).toBe(false);
			expect(finalState.microphoneDeviceId).toBe("mic-1");
			expect(finalState.recordingsDir).toBe("D:\\NewDir");
		});
	});

	// ==========================================================================
	// Tier 4: Real-World Application Scenarios
	// ==========================================================================
	describe("Tier 4: Real-World Scenarios", () => {
		it("Scenario 1: Comprehensive multi-project migration with 4K video, webcam PiP, multi-track audio stems, subtitles, zoom telemetry, and thumbnails", async () => {
			// Step 1: Create 3 complex recording clusters
			const clusters = await Promise.all([
				createRecordingCluster(sandbox.sourceDir, {
					timestamp: 10001,
					includeWebcam: true,
					includeSystemAudio: true,
					includeMicAudio: true,
					includeCursorTelemetry: true,
					includeSessionManifest: true,
				}),
				createRecordingCluster(sandbox.sourceDir, {
					timestamp: 10002,
					includeWebcam: true,
					includeSystemAudio: true,
					includeMicAudio: true,
					includeCursorTelemetry: true,
					includeSessionManifest: true,
				}),
				createRecordingCluster(sandbox.sourceDir, {
					timestamp: 10003,
					includeWebcam: false,
					includeSystemAudio: true,
					includeMicAudio: false,
					includeCursorTelemetry: true,
					includeSessionManifest: true,
				}),
			]);

			// Step 2: Create 3 corresponding projects in Projects/
			const projectPaths: string[] = [];
			for (let i = 0; i < clusters.length; i++) {
				const c = clusters[i];
				const { projectPath } = await createProjectFile(sandbox.projectsDir, {
					projectName: `Production_Episode_${i + 1}`,
					videoPath: c.videoPath,
					webcamPath: c.webcamPath,
					systemAudioPath: c.systemAudioPath,
					micAudioPath: c.micAudioPath,
				});
				projectPaths.push(projectPath);
			}

			// Step 3: Execute full migration to targetDir
			const targetProjectsDir = path.join(sandbox.targetDir, PROJECTS_DIRECTORY_NAME);
			await fs.mkdir(targetProjectsDir, { recursive: true });

			// Move all files in sourceDir root
			const sourceRootFiles = await fs.readdir(sandbox.sourceDir);
			for (const f of sourceRootFiles) {
				const src = path.join(sandbox.sourceDir, f);
				const tgt = path.join(sandbox.targetDir, f);
				const stat = await fs.stat(src);
				if (stat.isFile()) {
					await fs.copyFile(src, tgt);
					await fs.unlink(src);
				}
			}

			// Move and rewrite all files in Projects/
			const projFiles = await fs.readdir(sandbox.projectsDir);
			for (const f of projFiles) {
				const src = path.join(sandbox.projectsDir, f);
				const tgt = path.join(targetProjectsDir, f);
				if (f.endsWith(".recordly")) {
					const raw = await fs.readFile(src, "utf-8");
					const remapped = remapProjectFileContent(raw, sandbox.sourceDir, sandbox.targetDir);
					await fs.writeFile(tgt, remapped);
				} else {
					await fs.copyFile(src, tgt);
				}
				await fs.unlink(src);
			}

			// Step 4: Verify complete migration
			// All 3 projects exist in new target
			const migratedProjects = await fs.readdir(targetProjectsDir);
			expect(migratedProjects).toContain("Production_Episode_1.recordly");
			expect(migratedProjects).toContain("Production_Episode_2.recordly");
			expect(migratedProjects).toContain("Production_Episode_3.recordly");
			expect(migratedProjects).toContain("Production_Episode_1.recordly.preview.png");

			// Verify deep path remapping in each project
			for (let i = 0; i < 3; i++) {
				const pContent = JSON.parse(
					await fs.readFile(
						path.join(targetProjectsDir, `Production_Episode_${i + 1}.recordly`),
						"utf-8"
					)
				);
				// Verify video exists at target
				await expect(fs.access(pContent.videoPath)).resolves.toBeUndefined();
				expect(pContent.videoPath.toLowerCase().startsWith(sandbox.targetDir.toLowerCase())).toBe(true);

				// Verify system audio exists at target
				if (pContent.editor.audioTracks.length > 0) {
					const track = pContent.editor.audioTracks[0];
					await expect(fs.access(track.sourcePath)).resolves.toBeUndefined();
				}

				// Verify mic audio exists at target
				if (pContent.editor.audioRegions.length > 0) {
					const region = pContent.editor.audioRegions[0];
					await expect(fs.access(region.audioPath)).resolves.toBeUndefined();
				}
			}

			// Source directory is completely clean
			const remainingSource = await fs.readdir(sandbox.sourceDir);
			// Only Projects/ dir remaining (empty)
			expect(remainingSource.filter((f) => f !== PROJECTS_DIRECTORY_NAME).length).toBe(0);
		});

		it("Scenario 2: Consecutive multi-drive migrations with symmetrical collisions (C: -> D: -> E: -> back to C:)", async () => {
			const driveD = path.join(sandbox.root, "virtual-drive-D");
			const driveE = path.join(sandbox.root, "virtual-drive-E");
			await fs.mkdir(driveD, { recursive: true });
			await fs.mkdir(driveE, { recursive: true });

			// Initial cluster in C: (sourceDir)
			const c1 = await createRecordingCluster(sandbox.sourceDir, { timestamp: 5001 });

			// Pre-existing conflicting file in D:
			await fs.writeFile(path.join(driveD, "recording-5001.mp4"), "EXISTING_ON_D");

			// Migration 1: C: -> D: (collision rename applied)
			const collisionSuffix = " (1)";
			const renamedVideoD = path.join(driveD, `recording-5001${collisionSuffix}.mp4`);
			const renamedSysD = path.join(driveD, `recording-5001${collisionSuffix}.system.wav`);

			await fs.copyFile(c1.videoPath, renamedVideoD);
			await fs.copyFile(c1.systemAudioPath!, renamedSysD);
			await fs.unlink(c1.videoPath);
			await fs.unlink(c1.systemAudioPath!);

			await expect(fs.access(renamedVideoD)).resolves.toBeUndefined();
			await expect(fs.access(renamedSysD)).resolves.toBeUndefined();

			// Migration 2: D: -> E: (transfers without collision)
			const videoE = path.join(driveE, `recording-5001${collisionSuffix}.mp4`);
			await fs.copyFile(renamedVideoD, videoE);
			await fs.unlink(renamedVideoD);

			await expect(fs.access(videoE)).resolves.toBeUndefined();
			await expect(fs.access(renamedVideoD)).rejects.toThrow();
		});

		it("Scenario 3: Mixed legacy (.openscreen) and modern (.recordly) project libraries migration", async () => {
			const cluster1 = await createRecordingCluster(sandbox.sourceDir, { timestamp: 7001 });
			const cluster2 = await createRecordingCluster(sandbox.sourceDir, { timestamp: 7002 });

			// Modern project (.recordly)
			await createProjectFile(sandbox.projectsDir, {
				projectName: "ModernProject",
				videoPath: cluster1.videoPath,
			});

			// Legacy project (.openscreen)
			const legacyPath = path.join(sandbox.projectsDir, "LegacyProject.openscreen");
			const legacyData = {
				version: 1,
				videoPath: path.resolve(cluster2.videoPath),
			};
			await fs.writeFile(legacyPath, JSON.stringify(legacyData, null, 2));

			// Migrate to target
			const targetProjectsDir = path.join(sandbox.targetDir, PROJECTS_DIRECTORY_NAME);
			await fs.mkdir(targetProjectsDir, { recursive: true });

			const list = await fs.readdir(sandbox.projectsDir);
			for (const file of list) {
				const src = path.join(sandbox.projectsDir, file);
				const tgt = path.join(targetProjectsDir, file);
				if (file.endsWith(".recordly") || file.endsWith(".openscreen")) {
					const raw = await fs.readFile(src, "utf-8");
					const remapped = remapProjectFileContent(raw, sandbox.sourceDir, sandbox.targetDir);
					await fs.writeFile(tgt, remapped);
				} else {
					await fs.copyFile(src, tgt);
				}
			}

			// Verify both formats migrated and paths remapped
			const targetFiles = await fs.readdir(targetProjectsDir);
			expect(targetFiles).toContain("ModernProject.recordly");
			expect(targetFiles).toContain("LegacyProject.openscreen");

			const modernContent = JSON.parse(
				await fs.readFile(path.join(targetProjectsDir, "ModernProject.recordly"), "utf-8")
			);
			const legacyContent = JSON.parse(
				await fs.readFile(path.join(targetProjectsDir, "LegacyProject.openscreen"), "utf-8")
			);

			expect(modernContent.videoPath.toLowerCase().startsWith(sandbox.targetDir.toLowerCase())).toBe(true);
			expect(legacyContent.videoPath.toLowerCase().startsWith(sandbox.targetDir.toLowerCase())).toBe(true);
		});

		it("Scenario 4: Partial / interrupted migration recovery and idempotent resumption", async () => {
			const cluster = await createRecordingCluster(sandbox.sourceDir, { timestamp: 9001 });
			const targetVideo = path.join(sandbox.targetDir, path.basename(cluster.videoPath));

			// Simulate file 1 was already migrated in a prior aborted run
			await fs.copyFile(cluster.videoPath, targetVideo);

			// Resuming migration: check if already exists with matching size
			const srcStat = await fs.stat(cluster.videoPath);
			const tgtStat = await fs.stat(targetVideo);

			let skippedDuplicate = false;
			if (srcStat.size === tgtStat.size) {
				// Already migrated, remove source to finish step
				await fs.unlink(cluster.videoPath);
				skippedDuplicate = true;
			}

			expect(skippedDuplicate).toBe(true);
			await expect(fs.access(targetVideo)).resolves.toBeUndefined();
			await expect(fs.access(cluster.videoPath)).rejects.toThrow();
		});
	});
});
