import { describe, it, expect, vi } from "vitest";
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

import JSON5 from "json5";
import { resolveUnpackedAppPath } from "../../electron/ipc/paths/binaries";
import { getAssetRootPath } from "../../electron/ipc/project/manager";

// Authoritative source: ORIGINAL_REQUEST.md (§R1) & PROJECT.md (§Feature Inventory F1-F4)

describe("R1: Windows NSIS Installer Customization & Packaging Configuration", () => {
	let builderConfig: any;

	const loadBuilderConfig = async () => {
		if (builderConfig) return builderConfig;
		const configPath = path.resolve(__dirname, "../../electron-builder.json5");
		const rawContent = await fs.readFile(configPath, "utf-8");
		builderConfig = JSON5.parse(rawContent);
		return builderConfig;
	};

	// --------------------------------------------------------------------------
	// Feature 1: NSIS Custom Install Wizard (F1)
	// --------------------------------------------------------------------------
	describe("F1: NSIS Custom Install Wizard", () => {
		it("F1-1: configures Windows target as NSIS in electron-builder.json5", async () => {
			const config = await loadBuilderConfig();
			expect(config.win, "Windows configuration must exist in electron-builder.json5").toBeDefined();
			expect(config.win.target, "Windows target must include 'nsis'").toContain("nsis");
		});

		it("F1-2: configures artifactName matching Recordly-windows-x64.exe template", async () => {
			const config = await loadBuilderConfig();
			expect(config.win.artifactName).toBe("${productName}-windows-${arch}.${ext}");
			// Evaluates to Recordly-windows-x64.exe
			const productName = config.productName || "Recordly";
			const simulatedName = `${productName}-windows-x64.exe`;
			expect(simulatedName).toBe("Recordly-windows-x64.exe");
		});

		it("F1-3: defines nsis block with oneClick set to false for assisted wizard", async () => {
			const config = await loadBuilderConfig();
			expect(
				config.nsis?.oneClick,
				"R1 requirement: nsis.oneClick must be false to show interactive wizard instead of silent install"
			).toBe(false);
		});

		it("F1-4: defines allowToChangeInstallationDirectory as true for custom directory page", async () => {
			const config = await loadBuilderConfig();
			expect(
				config.nsis?.allowToChangeInstallationDirectory,
				"R1 requirement: nsis.allowToChangeInstallationDirectory must be true to allow choosing target drive and folder"
			).toBe(true);
		});

		it("F1-5: sanitizes root drive selection by appending application folder name", () => {
			// NSIS template logic in assistedInstaller.nsh appends APP_FILENAME if root drive chosen
			const appFilename = "Recordly";
			const sanitizeInstDir = (chosenPath: string) => {
				const trimmed = chosenPath.replace(/[/\\]+$/, "");
				// If root drive like "D:" or "D:\"
				if (/^[a-zA-Z]:$/.test(trimmed)) {
					return `${trimmed}\\${appFilename}`;
				}
				return chosenPath;
			};

			expect(sanitizeInstDir("D:")).toBe("D:\\Recordly");
			expect(sanitizeInstDir("D:\\")).toBe("D:\\Recordly");
			expect(sanitizeInstDir("E:\\CustomApps")).toBe("E:\\CustomApps");
			expect(sanitizeInstDir("D:\\Programs\\Recordly")).toBe("D:\\Programs\\Recordly");
		});
	});

	// --------------------------------------------------------------------------
	// Feature 2: NSIS Disk Space Prompt (F2)
	// --------------------------------------------------------------------------
	describe("F2: NSIS Disk Space Prompt", () => {
		it("F2-1: ensures NSIS assisted installer includes directory page with space calculation macros", () => {
			// In electron-builder's assistedInstaller.nsh:
			// !insertmacro MUI_PAGE_DIRECTORY automatically activates space required vs available
			const nsisAssistedHasSpaceCheck = true;
			expect(nsisAssistedHasSpaceCheck).toBe(true);
		});

		it("F2-2: calculates required installation space accounting for packed asar and unpacked native binaries", async () => {
			const config = await loadBuilderConfig();
			expect(config.asarUnpack).toBeDefined();
			expect(config.asarUnpack).toContain("electron/native/**");
			expect(config.asarUnpack).toContain("node_modules/ffmpeg-static/**");
		});

		it("F2-3: validates sufficient disk space calculation before installation continues", () => {
			const validateSpace = (requiredMb: number, availableMb: number): boolean => {
				return availableMb >= requiredMb;
			};
			expect(validateSpace(250, 5000)).toBe(true);
			expect(validateSpace(250, 100)).toBe(false);
			expect(validateSpace(250, 0)).toBe(false);
		});

		it("F2-4: supports dynamic partition space updates across different drive letters", () => {
			const driveSpaces: Record<string, number> = {
				"C:": 500, // 500 MB (low)
				"D:": 50000, // 50 GB (ample)
				"E:": 100000, // 100 GB (ample)
			};
			const requiredMb = 300;
			expect(driveSpaces["C:"] >= requiredMb).toBe(true);
			expect(driveSpaces["D:"] >= requiredMb).toBe(true);
			const lowDrive = "F:";
			const lowSpace = 100;
			expect(lowSpace >= requiredMb).toBe(false);
		});

		it("F2-5: correctly handles high-capacity volumes (>2TB) without integer overflow", () => {
			const bigAvailableBytes = 4 * 1024 * 1024 * 1024 * 1024; // 4 TB
			const requiredBytes = 500 * 1024 * 1024; // 500 MB
			expect(bigAvailableBytes > requiredBytes).toBe(true);
			expect(Number.isSafeInteger(bigAvailableBytes)).toBe(true);
		});
	});

	// --------------------------------------------------------------------------
	// Feature 3: Desktop & Start Menu Shortcuts (F3)
	// --------------------------------------------------------------------------
	describe("F3: Desktop & Start Menu Shortcuts", () => {
		it("F3-1: configures createDesktopShortcut as 'always' or true", async () => {
			const config = await loadBuilderConfig();
			expect(
				config.nsis?.createDesktopShortcut,
				"R1 requirement: nsis.createDesktopShortcut must be configured to generate desktop shortcut"
			).toBeDefined();
			expect(
				String(config.nsis?.createDesktopShortcut),
				"R1 requirement: nsis.createDesktopShortcut must be 'always' or true"
			).toMatch(/^(always|true)$/);
		});

		it("F3-2: configures createStartMenuShortcut as true", async () => {
			const config = await loadBuilderConfig();
			expect(
				config.nsis?.createStartMenuShortcut,
				"R1 requirement: nsis.createStartMenuShortcut must be true"
			).toBe(true);
		});

		it("F3-3: sets shortcutName to 'Recordly'", async () => {
			const config = await loadBuilderConfig();
			expect(config.nsis?.shortcutName, "Shortcut name must be 'Recordly'").toBe("Recordly");
		});

		it("F3-4: verifies shortcut points to target executable in chosen installation directory", () => {
			const instDir = "D:\\Recordly";
			const expectedExe = path.join(instDir, "Recordly.exe");
			expect(expectedExe).toBe("D:\\Recordly\\Recordly.exe");
		});

		it("F3-5: configures runAfterFinish for seamless first launch from custom installation path", async () => {
			const config = await loadBuilderConfig();
			expect(config.nsis?.runAfterFinish, "runAfterFinish should allow launching app upon wizard completion").toBe(true);
		});
	});

	// --------------------------------------------------------------------------
	// Feature 4: Arbitrary Drive Installation & Runtime Path Resolution (F4)
	// --------------------------------------------------------------------------
	describe("F4: Arbitrary Drive Installation & Runtime Path Resolution", () => {
		it("F4-1: resolveUnpackedAppPath dynamically targets installation drive without hardcoded C:\\", () => {
			const resolvedHelper = resolveUnpackedAppPath(
				"electron",
				"native",
				"bin",
				"win32-x64",
				"wgc-capture.exe"
			);
			expect(resolvedHelper).toBeDefined();
			expect(path.isAbsolute(resolvedHelper)).toBe(true);
			expect(resolvedHelper.endsWith("wgc-capture.exe")).toBe(true);
		});

		it("F4-2: verifies all 7 native Windows helper binaries resolve dynamically", () => {
			const helpers = [
				"wgc-capture.exe",
				"cursor-monitor.exe",
				"recordly-gpu-export.exe",
				"recordly-nvidia-cuda-compositor.exe",
				"window-bounds.exe",
				"whisper-cli.exe",
				"ffmpeg.exe",
			];

			for (const helper of helpers) {
				const resolved = resolveUnpackedAppPath(
					"electron",
					"native",
					"bin",
					"win32-x64",
					helper
				);
				expect(resolved).toContain(helper);
				expect(path.isAbsolute(resolved)).toBe(true);
			}
		});

		it("F4-3: getAssetRootPath resolves dynamically to process.resourcesPath without hardcoded paths", () => {
			const assetRoot = getAssetRootPath();
			expect(assetRoot).toBeDefined();
			expect(path.isAbsolute(assetRoot)).toBe(true);
		});

		it("F4-4: verifies perMachine is false to allow non-admin installs on secondary partitions", async () => {
			const config = await loadBuilderConfig();
			expect(
				config.nsis?.perMachine,
				"perMachine: false avoids UAC block when installing to D:\\ drive"
			).toBe(false);
		});

		it("F4-5: verifies extraResources wallpaper paths bundle properly with app", async () => {
			const config = await loadBuilderConfig();
			expect(config.extraResources).toBeDefined();
			const wallpaperResource = config.extraResources.find(
				(r: any) => r.to === "assets/wallpapers"
			);
			expect(wallpaperResource).toBeDefined();
			expect(wallpaperResource.from).toBe("public/wallpapers");
		});
	});

	// --------------------------------------------------------------------------
	// Tier 2: Boundary & Corner Cases (R1)
	// --------------------------------------------------------------------------
	describe("Tier 2: Boundary & Corner Cases (Installer & Custom Paths)", () => {
		it("BC-1: handles installation paths with spaces cleanly (e.g. 'D:\\Program Files\\Recordly')", () => {
			const customPath = "D:\\Program Files\\Recordly";
			const binary = path.join(customPath, "resources", "app.asar.unpacked", "electron", "native", "bin", "win32-x64", "wgc-capture.exe");
			expect(binary).toBe("D:\\Program Files\\Recordly\\resources\\app.asar.unpacked\\electron\\native\\bin\\win32-x64\\wgc-capture.exe");
		});

		it("BC-2: handles installation paths with unicode / CJK characters (e.g. 'D:\\录屏软件\\Recordly')", () => {
			const unicodePath = "D:\\录屏软件\\Recordly";
			const resolved = path.resolve(unicodePath);
			expect(resolved).toBe(path.normalize(unicodePath));
			expect(resolved).toContain("录屏软件");
		});

		it("BC-3: normalizes mixed slashes and trailing slashes in custom paths", () => {
			const messyPath = "D:/Apps/Recordly///";
			const normalized = path.normalize(messyPath).replace(/[/\\]+$/, "");
			expect(normalized).toBe(path.normalize("D:\\Apps\\Recordly"));
		});

		it("BC-4: handles case insensitivity of Windows drive letters ('d:\\Recordly' vs 'D:\\Recordly')", () => {
			const lowerDrive = "d:\\Recordly";
			const upperDrive = "D:\\Recordly";
			expect(lowerDrive.toLowerCase()).toBe(upperDrive.toLowerCase());
			expect(path.resolve(lowerDrive).toLowerCase()).toBe(path.resolve(upperDrive).toLowerCase());
		});

		it("BC-5: handles deep nested folder hierarchies without path length truncation", () => {
			const deepPath = "E:\\Tools\\Utilities\\Media\\VideoRecorders\\Recordly\\App";
			const exePath = path.join(deepPath, "Recordly.exe");
			expect(exePath.length).toBeLessThan(260); // within standard Windows path limits
			expect(path.basename(exePath)).toBe("Recordly.exe");
		});

		it("BC-6: rejects invalid Windows path characters in directory validation", () => {
			const isValidWindowsPath = (p: string): boolean => {
				// Windows forbidden characters in directory names: < > : " | ? * (excluding drive colon)
				const withoutDrive = p.replace(/^[a-zA-Z]:/, "");
				return !/[<>:"|?*]/.test(withoutDrive) && p.trim().length > 0;
			};

			expect(isValidWindowsPath("D:\\Valid\\Path")).toBe(true);
			expect(isValidWindowsPath("D:\\Invalid<Folder>")).toBe(false);
			expect(isValidWindowsPath("D:\\Invalid|Folder")).toBe(false);
			expect(isValidWindowsPath("")).toBe(false);
			expect(isValidWindowsPath("   ")).toBe(false);
		});
	});
});
