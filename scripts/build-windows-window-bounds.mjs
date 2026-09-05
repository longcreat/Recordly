import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import { updateNativeHelperManifest } from "./native-helper-manifest.mjs";

const projectRoot = process.cwd();
const sourceDir = path.join(projectRoot, "electron", "native", "window-bounds");
const sourcePath = path.join(sourceDir, "Program.cs");
const outputDir = path.join(
	projectRoot,
	"electron",
	"native",
	"bin",
	process.arch === "arm64" ? "win32-arm64" : "win32-x64",
);
const outputPath = path.join(outputDir, "window-bounds.exe");
const helperId = "window-bounds";

if (process.platform !== "win32") {
	console.log("[build-windows-window-bounds] Skipping: host platform is not Windows.");
	process.exit(0);
}

if (!existsSync(sourcePath)) {
	console.error("[build-windows-window-bounds] Source not found at", sourcePath);
	process.exit(1);
}

mkdirSync(outputDir, { recursive: true });

const cscPaths = [
	"C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe",
	"C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe",
];

let cscPath = cscPaths.find((p) => existsSync(p));

if (!cscPath) {
	const whereCheck = spawnSync("where", ["csc.exe"], { encoding: "utf8" });
	if (whereCheck.status === 0 && whereCheck.stdout.trim()) {
		cscPath = whereCheck.stdout.split("\n")[0].trim();
	}
}

if (!cscPath) {
	if (existsSync(outputPath)) {
		console.log(
			"[build-windows-window-bounds] csc.exe not found, but prebuilt binary exists. Skipping.",
		);
		process.exit(0);
	}
	console.warn("[build-windows-window-bounds] csc.exe compiler not found on this system.");
	process.exit(0);
}

console.log(`[build-windows-window-bounds] Compiling ${sourcePath} -> ${outputPath}...`);
const result = spawnSync(
	cscPath,
	["/nologo", "/optimize+", "/target:exe", `/out:${outputPath}`, sourcePath],
	{
		encoding: "utf8",
		timeout: 30000,
	},
);

if (result.status !== 0) {
	console.error(
		"[build-windows-window-bounds] Compilation failed:",
		result.stderr || result.stdout,
	);
	process.exit(1);
}

console.log(`[build-windows-window-bounds] Successfully built ${outputPath}`);

// Register provenance like every other Windows helper so the bundled binary can
// be traced back to the source tree it was compiled from.
const manifestPath = updateNativeHelperManifest({
	projectRoot,
	helperId,
	sourceDir,
	binaryPath: outputPath,
	binaryName: "window-bounds.exe",
});
console.log(`[build-windows-window-bounds] Updated helper manifest: ${manifestPath}`);
