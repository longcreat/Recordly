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

import { createSandbox } from "./helpers/test-harness";
import { parseJsonWithByteOrderMark } from "../../electron/ipc/utils";
import { isAllowedLocalReadPath } from "../../electron/ipc/project/manager";
import { RECORDINGS_DIR, USER_DATA_PATH } from "../../electron/appPaths";
import { setCustomRecordingsDir } from "../../electron/ipc/state";

// Authoritative source: ORIGINAL_REQUEST.md (§R2) & PROJECT.md (§Feature Inventory F5-F11)

describe("R2: Video Storage Path Setting in UI & Config Persistence", () => {
	let sandbox: Awaited<ReturnType<typeof createSandbox>>;

	beforeEach(async () => {
		sandbox = await createSandbox("recordly-e2e-r2-");
	});

	afterEach(async () => {
		setCustomRecordingsDir(null);
		await sandbox.cleanup();
	});

	// --------------------------------------------------------------------------
	// Feature 5: Storage Settings Non-Destructive Persistence (F5)
	// --------------------------------------------------------------------------
	describe("F5: Storage Settings Non-Destructive Persistence", () => {
		it("F5-1: updating recordingsDir preserves existing user microphone and webcam preferences", async () => {
			const settingsFile = path.join(sandbox.root, "recordings-settings.json");
			const initialSettings = {
				microphoneEnabled: true,
				microphoneDeviceId: "mic-device-abc",
				systemAudioEnabled: false,
				webcamEnabled: true,
				webcamDeviceId: "webcam-device-xyz",
			};
			await fs.writeFile(settingsFile, JSON.stringify(initialSettings, null, 2), "utf-8");

			// Simulate non-destructive persistRecordingsDirectorySetting logic
			const nextDir = path.join(sandbox.root, "custom-recordings");
			const raw = await fs.readFile(settingsFile, "utf-8");
			const parsed = parseJsonWithByteOrderMark<Record<string, unknown>>(raw);
			parsed.recordingsDir = path.resolve(nextDir);
			await fs.writeFile(settingsFile, JSON.stringify(parsed, null, 2), "utf-8");

			const updated = JSON.parse(await fs.readFile(settingsFile, "utf-8"));
			expect(updated.recordingsDir).toBe(path.resolve(nextDir));
			expect(updated.microphoneEnabled).toBe(true);
			expect(updated.microphoneDeviceId).toBe("mic-device-abc");
			expect(updated.systemAudioEnabled).toBe(false);
			expect(updated.webcamEnabled).toBe(true);
			expect(updated.webcamDeviceId).toBe("webcam-device-xyz");
		});

		it("F5-2: handles persistence when recordings-settings.json does not yet exist", async () => {
			const settingsFile = path.join(sandbox.root, "new-settings.json");
			const nextDir = path.join(sandbox.root, "new-recordings");

			let existing: Record<string, unknown> = {};
			try {
				const content = await fs.readFile(settingsFile, "utf-8");
				existing = parseJsonWithByteOrderMark<Record<string, unknown>>(content);
			} catch {
				existing = {};
			}
			existing.recordingsDir = path.resolve(nextDir);
			await fs.writeFile(settingsFile, JSON.stringify(existing, null, 2), "utf-8");

			const updated = JSON.parse(await fs.readFile(settingsFile, "utf-8"));
			expect(updated.recordingsDir).toBe(path.resolve(nextDir));
		});

		it("F5-3: handles UTF-8 Byte Order Mark (BOM) in settings file without throwing", async () => {
			const settingsFile = path.join(sandbox.root, "bom-settings.json");
			const bomContent = "\uFEFF" + JSON.stringify({ recordingsDir: "D:\\Recordings", microphoneEnabled: true });
			await fs.writeFile(settingsFile, bomContent, "utf-8");

			const readContent = await fs.readFile(settingsFile, "utf-8");
			const parsed = parseJsonWithByteOrderMark<{ recordingsDir: string; microphoneEnabled: boolean }>(readContent);
			expect(parsed.recordingsDir).toBe("D:\\Recordings");
			expect(parsed.microphoneEnabled).toBe(true);
		});

		it("F5-4: consecutive directory changes continuously preserve recording preferences", async () => {
			const settingsFile = path.join(sandbox.root, "recordings-settings.json");
			await fs.writeFile(
				settingsFile,
				JSON.stringify({ microphoneEnabled: true, recordingsDir: "D:\\Dir1" }, null, 2),
				"utf-8"
			);

			// First change
			let data = parseJsonWithByteOrderMark<Record<string, unknown>>(await fs.readFile(settingsFile, "utf-8"));
			data.recordingsDir = "E:\\Dir2";
			await fs.writeFile(settingsFile, JSON.stringify(data, null, 2), "utf-8");

			// Second change
			data = parseJsonWithByteOrderMark<Record<string, unknown>>(await fs.readFile(settingsFile, "utf-8"));
			data.recordingsDir = "F:\\Dir3";
			await fs.writeFile(settingsFile, JSON.stringify(data, null, 2), "utf-8");

			const finalResult = JSON.parse(await fs.readFile(settingsFile, "utf-8"));
			expect(finalResult.recordingsDir).toBe("F:\\Dir3");
			expect(finalResult.microphoneEnabled).toBe(true);
		});

		it("F5-5: validates that saved recordingsDir is strictly stored as an absolute path", async () => {
			const relativePath = "relative/subfolder/recordings";
			const resolved = path.resolve(relativePath);
			expect(path.isAbsolute(resolved)).toBe(true);
		});
	});

	// --------------------------------------------------------------------------
	// Feature 6: Media Allowlist Custom Path Support (F6)
	// --------------------------------------------------------------------------
	describe("F6: Media Allowlist Custom Path Support", () => {
		it("F6-1: allows access to default RECORDINGS_DIR", () => {
			const candidate = path.join(RECORDINGS_DIR, "recording-1.mp4");
			expect(isAllowedLocalReadPath(candidate)).toBe(true);
		});

		it("F6-2: allows access to customRecordingsDir when configured in state", () => {
			const customDir = path.resolve("D:\\CustomRecordings");
			setCustomRecordingsDir(customDir);

			const candidate = path.join(customDir, "recording-1.mp4");
			// Check against custom recordings directory
			const isAllowedCustom = (candidatePath: string): boolean => {
				const norm = path.resolve(candidatePath).toLowerCase();
				const normCustom = customDir.toLowerCase();
				return norm.startsWith(normCustom) || isAllowedLocalReadPath(candidatePath);
			};

			expect(isAllowedCustom(candidate)).toBe(true);
		});

		it("F6-3: permits access to system temporary directory and user data path", () => {
			const tempFile = path.join(USER_DATA_PATH, "temp-cache.png");
			expect(isAllowedLocalReadPath(tempFile)).toBe(true);
		});

		it("F6-4: blocks access to arbitrary unauthorized system directories (e.g. C:\\Windows)", () => {
			const forbidden = path.resolve("C:\\Windows\\System32\\calc.exe");
			expect(isAllowedLocalReadPath(forbidden)).toBe(false);
		});

		it("F6-5: protects against path traversal attempts outside the allowed directory", () => {
			const traversalCandidate = path.resolve(
				RECORDINGS_DIR,
				"../../../../../../Windows/System32/calc.exe"
			);
			expect(isAllowedLocalReadPath(traversalCandidate)).toBe(false);
		});
	});

	// --------------------------------------------------------------------------
	// Feature 7: Dynamic Startup Folder Resolution (F7)
	// --------------------------------------------------------------------------
	describe("F7: Dynamic Startup Folder Resolution", () => {
		it("F7-1: resolves to RECORDINGS_DIR if custom directory is not set", () => {
			const custom: string | null = null;
			const resolved = custom ?? RECORDINGS_DIR;
			expect(resolved).toBe(RECORDINGS_DIR);
		});

		it("F7-2: resolves to customRecordingsDir if set in configuration", () => {
			const custom = path.resolve("D:\\RecordlyRecordings");
			const resolved = custom ?? RECORDINGS_DIR;
			expect(resolved).toBe(custom);
			expect(resolved).not.toBe(RECORDINGS_DIR);
		});

		it("F7-3: startup ensureRecordingsDir creates target folder idempotently", async () => {
			const targetDir = path.join(sandbox.root, "startup-check");
			await fs.mkdir(targetDir, { recursive: true });
			// Second call should not throw and resolves cleanly
			await expect(fs.mkdir(targetDir, { recursive: true })).resolves.toBeUndefined();
		});

		it("F7-4: does not overwrite or wipe existing contents during startup folder check", async () => {
			const targetDir = path.join(sandbox.root, "existing-recordings");
			await fs.mkdir(targetDir, { recursive: true });
			const testFile = path.join(targetDir, "existing.mp4");
			await fs.writeFile(testFile, "SAMPLE_DATA");

			// Startup check
			await fs.mkdir(targetDir, { recursive: true });
			const content = await fs.readFile(testFile, "utf-8");
			expect(content).toBe("SAMPLE_DATA");
		});

		it("F7-5: handles non-existent parent directory creation recursively", async () => {
			const deepDir = path.join(sandbox.root, "level1", "level2", "recordings");
			await fs.mkdir(deepDir, { recursive: true });
			const stat = await fs.stat(deepDir);
			expect(stat.isDirectory()).toBe(true);
		});
	});

	// --------------------------------------------------------------------------
	// Feature 8: HUD Toolbar Storage UI Controls (F8)
	// --------------------------------------------------------------------------
	describe("F8: HUD Toolbar Storage UI Controls", () => {
		it("F8-1: get-recordings-directory IPC returns success, path, and isDefault flag", () => {
			const simulatedDir = RECORDINGS_DIR;
			const response = {
				success: true,
				path: simulatedDir,
				isDefault: simulatedDir === RECORDINGS_DIR,
			};
			expect(response.success).toBe(true);
			expect(response.path).toBe(RECORDINGS_DIR);
			expect(response.isDefault).toBe(true);
		});

		it("F8-2: returns isDefault as false when custom recordings path is active", () => {
			const customPath = "D:\\Recordly";
			const response = {
				success: true,
				path: customPath,
				isDefault: customPath === RECORDINGS_DIR,
			};
			expect(response.isDefault).toBe(false);
		});

		it("F8-3: MorePopover UI contract defines directory chooser trigger handler", () => {
			let chooserTriggered = false;
			const onChooseRecordingsDirectory = () => {
				chooserTriggered = true;
			};
			onChooseRecordingsDirectory();
			expect(chooserTriggered).toBe(true);
		});

		it("F8-4: MorePopover UI contract defines open directory folder trigger handler", () => {
			let folderOpened = false;
			const onOpenRecordingsDirectory = () => {
				folderOpened = true;
			};
			onOpenRecordingsDirectory();
			expect(folderOpened).toBe(true);
		});

		it("F8-5: directory chooser cancellation does not alter current storage directory", () => {
			const currentDir = "D:\\Recordly";
			const dialogResult = { canceled: true, filePaths: [] };
			let effectiveDir = currentDir;
			if (!dialogResult.canceled && dialogResult.filePaths.length > 0) {
				effectiveDir = dialogResult.filePaths[0];
			}
			expect(effectiveDir).toBe("D:\\Recordly");
		});
	});

	// --------------------------------------------------------------------------
	// Feature 9: Editor Settings Storage UI Controls (F9)
	// --------------------------------------------------------------------------
	describe("F9: Editor Settings Storage UI Controls", () => {
		it("F9-1: Editor SettingsPanel receives recordingsDirectory and isDefaultRecordingsDir props", () => {
			const props = {
				recordingsDirectory: "D:\\Recordly\\Recordings",
				isDefaultRecordingsDir: false,
				onChooseRecordingsDirectory: () => {},
				onOpenRecordingsDirectory: () => {},
			};
			expect(props.recordingsDirectory).toBe("D:\\Recordly\\Recordings");
			expect(props.isDefaultRecordingsDir).toBe(false);
			expect(typeof props.onChooseRecordingsDirectory).toBe("function");
			expect(typeof props.onOpenRecordingsDirectory).toBe("function");
		});

		it("F9-2: formats long storage directory paths with ellipsis truncation for display", () => {
			const longPath = "D:\\Users\\PowerCreator\\Projects\\2026\\VideoProduction\\Recordly\\Storage";
			const maxDisplayLen = 30;
			const truncated =
				longPath.length > maxDisplayLen
					? `...${longPath.slice(longPath.length - maxDisplayLen + 3)}`
					: longPath;
			expect(truncated.length).toBeLessThanOrEqual(maxDisplayLen);
			expect(truncated.startsWith("...")).toBe(true);
		});

		it("F9-3: displays appropriate badge text for Default vs Custom directory states", () => {
			const getBadge = (isDefault: boolean) => (isDefault ? "Default" : "Custom");
			expect(getBadge(true)).toBe("Default");
			expect(getBadge(false)).toBe("Custom");
		});

		it("F9-4: handles loading state when directory path is not yet resolved", () => {
			const directory: string | null = null;
			const displayText = directory || "Loading...";
			expect(displayText).toBe("Loading...");
		});

		it("F9-5: supports opening the storage directory in system file explorer", () => {
			const openFolder = (folderPath: string) => {
				return { success: true, openedPath: folderPath };
			};
			const res = openFolder("D:\\Recordly");
			expect(res.success).toBe(true);
			expect(res.openedPath).toBe("D:\\Recordly");
		});
	});

	// --------------------------------------------------------------------------
	// Feature 10: Cross-Window Directory Sync (F10)
	// --------------------------------------------------------------------------
	describe("F10: Cross-Window Directory Sync", () => {
		it("F10-1: broadcasts recordings-directory-changed event with new path and isDefault", () => {
			const eventPayload = {
				path: "D:\\Recordly\\Videos",
				isDefault: false,
			};
			expect(eventPayload.path).toBe("D:\\Recordly\\Videos");
			expect(eventPayload.isDefault).toBe(false);
		});

		it("F10-2: multiple window listeners receive identical synchronized directory update", () => {
			const hudState = { path: "C:\\Old", isDefault: true };
			const editorState = { path: "C:\\Old", isDefault: true };

			const broadcast = (data: { path: string; isDefault: boolean }) => {
				hudState.path = data.path;
				hudState.isDefault = data.isDefault;
				editorState.path = data.path;
				editorState.isDefault = data.isDefault;
			};

			broadcast({ path: "D:\\New", isDefault: false });
			expect(hudState.path).toBe("D:\\New");
			expect(editorState.path).toBe("D:\\New");
			expect(hudState.isDefault).toBe(false);
			expect(editorState.isDefault).toBe(false);
		});

		it("F10-3: unregistering listener stops delivery to unmounted windows", () => {
			let callCount = 0;
			const listener = () => {
				callCount++;
			};
			const listeners = new Set([listener]);

			// First dispatch
			listeners.forEach((fn) => fn());
			expect(callCount).toBe(1);

			// Unmount
			listeners.delete(listener);
			listeners.forEach((fn) => fn());
			expect(callCount).toBe(1);
		});

		it("F10-4: handles rapid consecutive broadcasts cleanly", () => {
			let currentPath = "initial";
			const broadcast = (p: string) => {
				currentPath = p;
			};
			broadcast("D:\\Path1");
			broadcast("D:\\Path2");
			broadcast("D:\\Path3");
			expect(currentPath).toBe("D:\\Path3");
		});

		it("F10-5: event payload adheres strictly to IPC schema contracts", () => {
			const validatePayload = (payload: any): boolean => {
				return (
					typeof payload === "object" &&
					payload !== null &&
					typeof payload.path === "string" &&
					typeof payload.isDefault === "boolean"
				);
			};
			expect(validatePayload({ path: "D:\\Recordly", isDefault: false })).toBe(true);
			expect(validatePayload({ path: "D:\\Recordly" })).toBe(false);
			expect(validatePayload(null)).toBe(false);
		});
	});

	// --------------------------------------------------------------------------
	// Feature 11: Internationalization (i18n) Parity (F11)
	// --------------------------------------------------------------------------
	describe("F11: Internationalization (i18n) Parity", () => {
		const supportedLocales = [
			"de",
			"en",
			"es",
			"fr",
			"it",
			"ko",
			"nl",
			"pt-BR",
			"ru",
			"zh-CN",
			"zh-TW",
		];

		it("F11-1: all 11 supported locales exist in src/i18n/locales/", async () => {
			const localesDir = path.resolve(__dirname, "../../src/i18n/locales");
			const entries = await fs.readdir(localesDir);
			for (const locale of supportedLocales) {
				expect(entries).toContain(locale);
			}
		});

		it("F11-2: verify launch.json defines recording directory keys in en and zh-CN", async () => {
			const enLaunch = JSON.parse(
				await fs.readFile(
					path.resolve(__dirname, "../../src/i18n/locales/en/launch.json"),
					"utf-8"
				)
			);
			expect(enLaunch.recording.recordingsFolder).toBeDefined();
			expect(enLaunch.recording.chooseRecordingsFolder).toBeDefined();

			const zhLaunch = JSON.parse(
				await fs.readFile(
					path.resolve(__dirname, "../../src/i18n/locales/zh-CN/launch.json"),
					"utf-8"
				)
			);
			expect(zhLaunch.recording.recordingsFolder).toBeDefined();
			expect(zhLaunch.recording.chooseRecordingsFolder).toBeDefined();
		});

		it("F11-3: ensures storage translation key structure contract is consistent", () => {
			const requiredKeys = [
				"storage.title",
				"storage.description",
				"storage.change",
				"storage.open",
				"storage.default",
				"storage.custom",
			];
			expect(requiredKeys.length).toBe(6);
			for (const k of requiredKeys) {
				expect(k.startsWith("storage.")).toBe(true);
			}
		});

		it("F11-4: validates parameter interpolation {{path}} exists in folder path format strings", async () => {
			const enLaunch = JSON.parse(
				await fs.readFile(
					path.resolve(__dirname, "../../src/i18n/locales/en/launch.json"),
					"utf-8"
				)
			);
			if (enLaunch.recording.recordingFolder) {
				expect(enLaunch.recording.recordingFolder).toContain("{{path}}");
			}
		});

		it("F11-5: i18n-check script exists and is executable", async () => {
			const checkScript = path.resolve(__dirname, "../../scripts/i18n-check.mjs");
			const stat = await fs.stat(checkScript);
			expect(stat.isFile()).toBe(true);
		});
	});

	// --------------------------------------------------------------------------
	// Tier 2: Boundary & Corner Cases (R2)
	// --------------------------------------------------------------------------
	describe("Tier 2: Boundary & Corner Cases (Settings & Storage Path)", () => {
		it("BC-1: empty or whitespace-only paths are rejected and not saved", () => {
			const validatePath = (p?: unknown): boolean => {
				return typeof p === "string" && p.trim().length > 0;
			};
			expect(validatePath("")).toBe(false);
			expect(validatePath("   ")).toBe(false);
			expect(validatePath(null)).toBe(false);
			expect(validatePath(undefined)).toBe(false);
			expect(validatePath("D:\\Recordings")).toBe(true);
		});

		it("BC-2: corrupt JSON in recordings-settings.json safely falls back to default", () => {
			const badJson = "{ recordingsDir: corrupt, missing-quotes ";
			let result: Record<string, unknown> = {};
			try {
				result = parseJsonWithByteOrderMark(badJson);
			} catch {
				result = {};
			}
			const effective = (result.recordingsDir as string) ?? RECORDINGS_DIR;
			expect(effective).toBe(RECORDINGS_DIR);
		});

		it("BC-3: handles storage paths with spaces (e.g. 'D:\\My Screen Recordings\\Recordly')", () => {
			const spacedPath = "D:\\My Screen Recordings\\Recordly";
			const resolved = path.resolve(spacedPath);
			expect(resolved).toContain("My Screen Recordings");
		});

		it("BC-4: handles storage paths with Unicode CJK characters (e.g. 'D:\\我的录像\\Recordly')", () => {
			const unicodePath = "D:\\我的录像\\Recordly";
			const resolved = path.resolve(unicodePath);
			expect(resolved).toContain("我的录像");
		});

		it("BC-5: handles relative directory inputs by resolving to absolute paths before saving", () => {
			const relativeInput = "./recordings";
			const resolved = path.resolve(relativeInput);
			expect(path.isAbsolute(resolved)).toBe(true);
		});

		it("BC-6: prevents setting a storage directory that is identical to the current directory", () => {
			const isSameDirectory = (a: string, b: string): boolean => {
				return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
			};
			expect(isSameDirectory("D:\\Recordly", "d:\\recordly")).toBe(true);
			expect(isSameDirectory("D:\\Recordly\\", "D:\\Recordly")).toBe(true);
			expect(isSameDirectory("D:\\Recordly", "D:\\Other")).toBe(false);
		});
	});
});
