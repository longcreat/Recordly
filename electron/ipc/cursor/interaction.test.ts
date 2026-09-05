import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	app: {
		getPath: vi.fn(() => "/tmp"),
		setPath: vi.fn(),
		isReady: vi.fn(() => true),
	},
}));

import type { UiohookLike } from "../types";
import {
	installHookMouseMoveFilter,
	repairBundledUiohookBinaryForCurrentArch,
	shouldForwardHookEvent,
	shouldStartGlobalInteractionHook,
} from "./interaction";

describe("shouldStartGlobalInteractionHook", () => {
	it("does not start the synchronous uiohook event tap on macOS", () => {
		expect(shouldStartGlobalInteractionHook("darwin")).toBe(false);
	});

	it("keeps global interaction capture enabled on Windows and Linux", () => {
		expect(shouldStartGlobalInteractionHook("win32")).toBe(true);
		expect(shouldStartGlobalInteractionHook("linux")).toBe(true);
	});
});

// libuiohook event_type values, matching uiohook-napi's exported EventType enum.
const EVENT_MOUSE_PRESSED = 7;
const EVENT_MOUSE_RELEASED = 8;
const EVENT_MOUSE_MOVED = 9;
const EVENT_MOUSE_WHEEL = 11;

describe("shouldForwardHookEvent", () => {
	it("drops pointer movement only when the platform does not consume it", () => {
		expect(shouldForwardHookEvent(EVENT_MOUSE_MOVED, { forwardMouseMove: false })).toBe(false);
		expect(shouldForwardHookEvent(EVENT_MOUSE_MOVED, { forwardMouseMove: true })).toBe(true);
	});

	it("always forwards the click events cursor telemetry is built on", () => {
		for (const eventType of [EVENT_MOUSE_PRESSED, EVENT_MOUSE_RELEASED, EVENT_MOUSE_WHEEL]) {
			expect(shouldForwardHookEvent(eventType, { forwardMouseMove: false })).toBe(true);
		}
	});

	it("forwards unrecognised event types instead of silently dropping them", () => {
		expect(shouldForwardHookEvent(undefined, { forwardMouseMove: false })).toBe(true);
		expect(shouldForwardHookEvent("mousedown", { forwardMouseMove: false })).toBe(true);
		expect(shouldForwardHookEvent(Number.NaN, { forwardMouseMove: false })).toBe(true);
	});
});

describe("installHookMouseMoveFilter", () => {
	/**
	 * Mirrors uiohook-napi's UiohookNapi: `handler` is a prototype method and
	 * `start()` binds whatever `this.handler` resolves to, so an own property
	 * installed beforehand becomes the native dispatch entry point.
	 */
	class FakeHook {
		dispatched: Array<{ type: number }> = [];
		boundHandler: ((event: { type: number }) => void) | null = null;

		on = vi.fn();

		handler(event: { type: number }) {
			this.dispatched.push(event);
		}

		start() {
			this.boundHandler = this.handler.bind(this);
		}
	}

	function startAndDeliver(hook: FakeHook, eventTypes: number[]) {
		hook.start();
		expect(hook.boundHandler).not.toBeNull();
		for (const type of eventTypes) {
			hook.boundHandler?.({ type });
		}
		return hook.dispatched.map((event) => event.type);
	}

	it("stops mousemove before it reaches listeners while keeping click events", () => {
		const hook = new FakeHook();
		expect(installHookMouseMoveFilter(hook as unknown as UiohookLike, false)).toBe(true);

		expect(
			startAndDeliver(hook, [
				EVENT_MOUSE_MOVED,
				EVENT_MOUSE_PRESSED,
				EVENT_MOUSE_MOVED,
				EVENT_MOUSE_RELEASED,
				EVENT_MOUSE_MOVED,
			]),
		).toEqual([EVENT_MOUSE_PRESSED, EVENT_MOUSE_RELEASED]);
	});

	it("keeps mousemove on the platform that reads cursor position from the hook", () => {
		const hook = new FakeHook();
		expect(installHookMouseMoveFilter(hook as unknown as UiohookLike, true)).toBe(true);

		expect(startAndDeliver(hook, [EVENT_MOUSE_MOVED, EVENT_MOUSE_PRESSED])).toEqual([
			EVENT_MOUSE_MOVED,
			EVENT_MOUSE_PRESSED,
		]);
	});

	it("does not wrap the dispatcher twice when capture restarts", () => {
		const hook = new FakeHook();
		const hookLike = hook as unknown as UiohookLike;

		expect(installHookMouseMoveFilter(hookLike, false)).toBe(true);
		const wrapped = hook.handler;
		expect(installHookMouseMoveFilter(hookLike, false)).toBe(false);
		expect(hook.handler).toBe(wrapped);

		expect(startAndDeliver(hook, [EVENT_MOUSE_MOVED, EVENT_MOUSE_RELEASED])).toEqual([
			EVENT_MOUSE_RELEASED,
		]);
	});

	it("leaves hooks without a native dispatch entry point untouched", () => {
		const hook = { on: vi.fn(), start: vi.fn() } as unknown as UiohookLike;

		expect(installHookMouseMoveFilter(hook, false)).toBe(false);
		expect(hook.handler).toBeUndefined();
	});
});

describe("repairBundledUiohookBinaryForCurrentArch", () => {
	const tempRoots: string[] = [];

	afterEach(async () => {
		await Promise.all(
			tempRoots
				.splice(0)
				.map((tempRoot) => fs.rm(tempRoot, { recursive: true, force: true })),
		);
	});

	it("promotes the bundled darwin-arm64 prebuild over a stale incompatible build", async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-uiohook-"));
		tempRoots.push(tempRoot);

		const packageRoot = path.join(tempRoot, "uiohook-napi");
		const prebuildPath = path.join(packageRoot, "prebuilds", "darwin-arm64", "node.napi.node");
		const buildPath = path.join(packageRoot, "build", "Release", "uiohook_napi.node");
		await fs.mkdir(path.dirname(prebuildPath), { recursive: true });
		await fs.mkdir(path.dirname(buildPath), { recursive: true });
		await fs.writeFile(prebuildPath, "arm64-prebuild");
		await fs.writeFile(buildPath, "x64-build");

		const log = vi.fn();
		const repaired = repairBundledUiohookBinaryForCurrentArch(
			Object.assign(
				new Error(
					"mach-o file, but is an incompatible architecture (have 'x86_64', need 'arm64')",
				),
				{
					code: "ERR_DLOPEN_FAILED",
				},
			),
			{ packageRoot, platform: "darwin", arch: "arm64", log },
		);

		expect(repaired).toBe(true);
		expect(await fs.readFile(buildPath, "utf8")).toBe("arm64-prebuild");
		expect(log).toHaveBeenCalledWith(
			"[CursorTelemetry] Repaired stale uiohook-napi binary using bundled darwin-arm64 prebuild.",
		);
	});

	it("does not rewrite binaries for unrelated load failures", async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-uiohook-"));
		tempRoots.push(tempRoot);

		const packageRoot = path.join(tempRoot, "uiohook-napi");
		const buildPath = path.join(packageRoot, "build", "Release", "uiohook_napi.node");
		await fs.mkdir(path.dirname(buildPath), { recursive: true });
		await fs.writeFile(buildPath, "existing-build");

		const repaired = repairBundledUiohookBinaryForCurrentArch(
			Object.assign(new Error("some other dlopen failure"), {
				code: "ERR_DLOPEN_FAILED",
			}),
			{ packageRoot, platform: "darwin", arch: "arm64" },
		);

		expect(repaired).toBe(false);
		expect(await fs.readFile(buildPath, "utf8")).toBe("existing-build");
	});
});
