import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRecordingPreferencesStore } from "./recordingPreferencesStore";

vi.mock("electron", () => ({
	app: {
		getPath: () => "",
	},
}));

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) =>
			fs.rm(directory, {
				recursive: true,
				force: true,
			}),
		),
	);
});

describe("recording preferences store", () => {
	it("preserves concurrent microphone and webcam preference updates", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-preferences-"));
		temporaryDirectories.push(directory);
		const store = createRecordingPreferencesStore(path.join(directory, "recording.json"));

		await Promise.all([
			store.update({ microphoneEnabled: true }),
			store.update({ microphoneDeviceId: "preferred-mic" }),
			store.update({ webcamEnabled: true }),
			store.update({ webcamDeviceId: "preferred-camera" }),
		]);

		await expect(store.read()).resolves.toEqual({
			microphoneEnabled: true,
			microphoneDeviceId: "preferred-mic",
			webcamEnabled: true,
			webcamDeviceId: "preferred-camera",
		});
	});
});

describe("createRecordingPreferencesStore frameRate", () => {
	let tempRoot: string;
	let settingsFile: string;

	beforeEach(async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-prefs-"));
		settingsFile = path.join(tempRoot, "recordings-settings.json");
	});

	afterEach(async () => {
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	it("round-trips frameRate through read/update", async () => {
		const store = createRecordingPreferencesStore(settingsFile);
		await store.update({ frameRate: 30 });
		const parsed = await store.read();
		expect(parsed.frameRate).toBe(30);
	});

	it("merges frameRate into existing preferences without wiping them", async () => {
		await fs.writeFile(
			settingsFile,
			JSON.stringify({ microphoneEnabled: true, frameRate: 60 }, null, 2),
			"utf-8",
		);
		const store = createRecordingPreferencesStore(settingsFile);
		await store.update({ frameRate: 24 });
		const parsed = await store.read();
		expect(parsed.frameRate).toBe(24);
		expect(parsed.microphoneEnabled).toBe(true);
	});
});

describe("createRecordingPreferencesStore quality", () => {
	let tempRoot: string;
	let settingsFile: string;

	beforeEach(async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-prefs-"));
		settingsFile = path.join(tempRoot, "recordings-settings.json");
	});

	afterEach(async () => {
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	it("round-trips quality through read/update", async () => {
		const store = createRecordingPreferencesStore(settingsFile);
		await store.update({ quality: "balanced" });
		const parsed = await store.read();
		expect(parsed.quality).toBe("balanced");
	});

	it("merges quality into existing preferences without wiping them", async () => {
		await fs.writeFile(
			settingsFile,
			JSON.stringify({ microphoneEnabled: true, quality: "high" }, null, 2),
			"utf-8",
		);
		const store = createRecordingPreferencesStore(settingsFile);
		await store.update({ quality: "standard" });
		const parsed = await store.read();
		expect(parsed.quality).toBe("standard");
		expect(parsed.microphoneEnabled).toBe(true);
	});
});
