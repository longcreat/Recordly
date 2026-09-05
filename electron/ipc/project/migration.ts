import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import {
	PROJECT_FILE_EXTENSION,
	LEGACY_PROJECT_FILE_EXTENSIONS,
	PROJECTS_DIRECTORY_NAME,
	RECENT_PROJECTS_FILE,
} from "../constants";

export interface MigrationResult {
	success: boolean;
	movedFilesCount: number;
	updatedProjectsCount: number;
	failedFiles: Array<{ source: string; error: string }>;
	warnings: string[];
}

export interface ProgressCallback {
	(progress: { current: number; total: number; currentFile: string }): void;
}

/**
 * Safely copies a file and verifies its byte count before unlinking the source.
 * Handles cross-volume (cross-drive) moves reliably.
 */
async function atomicMoveFile(sourcePath: string, targetPath: string): Promise<void> {
	const sourceStat = await fs.stat(sourcePath);
	const tempTarget = `${targetPath}.migrating-tmp`;

	// Ensure destination directory exists
	await fs.mkdir(path.dirname(targetPath), { recursive: true });

	// Copy to temporary file first
	await fs.copyFile(sourcePath, tempTarget);

	const tempStat = await fs.stat(tempTarget);
	if (tempStat.size !== sourceStat.size) {
		await fs.unlink(tempTarget).catch(() => undefined);
		throw new Error(
			`Size verification failed during copy of ${path.basename(sourcePath)}: expected ${sourceStat.size}, got ${tempStat.size}`,
		);
	}

	// Rename temp file to final destination and unlink source
	await fs.rename(tempTarget, targetPath);
	await fs.unlink(sourcePath);
}

function hasProjectExtension(filename: string): boolean {
	const ext = path.extname(filename).replace(/^\./, "").toLowerCase();
	return [PROJECT_FILE_EXTENSION, ...LEGACY_PROJECT_FILE_EXTENSIONS].includes(ext);
}

/**
 * Deep-remaps paths inside a .recordly project JSON from oldDir to newDir.
 */
function remapProjectContent(
	content: string,
	oldDir: string,
	newDir: string,
	renamedMap: Map<string, string>,
): string {
	try {
		const parsed = JSON.parse(content);
		const normOld = path.resolve(oldDir).toLowerCase();

		const remapPath = (currentPath?: string): string | undefined => {
			if (!currentPath || typeof currentPath !== "string") return currentPath;
			const normCurrent = path.resolve(currentPath);
			const lowerCurrent = normCurrent.toLowerCase();
			if (renamedMap.has(lowerCurrent)) {
				return renamedMap.get(lowerCurrent)!;
			}
			if (lowerCurrent.startsWith(normOld)) {
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
				if (track && typeof track.sourcePath === "string") {
					track.sourcePath = remapPath(track.sourcePath);
				}
			}
		}

		if (Array.isArray(parsed.editor?.audioRegions)) {
			for (const region of parsed.editor.audioRegions) {
				if (region && typeof region.audioPath === "string") {
					region.audioPath = remapPath(region.audioPath);
				}
			}
		}

		return JSON.stringify(parsed, null, 2);
	} catch {
		return content;
	}
}

/**
 * Symmetrically groups files by recording cluster base prefix (e.g. "recording-1741234567")
 */
function getClusterBase(filename: string): string {
	const match = filename.match(/^(recording-\d+)/i);
	if (match) {
		return match[1];
	}
	return filename.split(".")[0];
}

/**
 * Finds next available non-colliding cluster suffix in target directory.
 */
async function findCollisionSuffix(
	targetDir: string,
	clusterBase: string,
	clusterFiles: string[],
): Promise<string> {
	let counter = 0;
	while (true) {
		const suffix = counter === 0 ? "" : ` (${counter})`;
		let collision = false;
		for (const file of clusterFiles) {
			const candidateName = file.replace(clusterBase, `${clusterBase}${suffix}`);
			const candidatePath = path.join(targetDir, candidateName);
			if (existsSync(candidatePath)) {
				collision = true;
				break;
			}
		}
		if (!collision) {
			return suffix;
		}
		counter++;
	}
}

/**
 * Migrates all historical recordings, companion audio stems, cursor telemetry,
 * projects, and thumbnails from oldDir to newDir atomically with collision protection.
 */
export async function migrateRecordingsDirectory(
	oldDir: string,
	newDir: string,
	onProgress?: ProgressCallback,
): Promise<MigrationResult> {
	const resolvedOld = path.resolve(oldDir);
	const resolvedNew = path.resolve(newDir);

	if (resolvedOld.toLowerCase() === resolvedNew.toLowerCase()) {
		return {
			success: true,
			movedFilesCount: 0,
			updatedProjectsCount: 0,
			failedFiles: [],
			warnings: [],
		};
	}

	const result: MigrationResult = {
		success: true,
		movedFilesCount: 0,
		updatedProjectsCount: 0,
		failedFiles: [],
		warnings: [],
	};

	if (!existsSync(resolvedOld)) {
		return result;
	}

	await fs.mkdir(resolvedNew, { recursive: true });

	const renamedMap = new Map<string, string>(); // oldPath.toLowerCase() -> newPath

	// 1. Scan oldDir top-level entries
	let entries: string[] = [];
	try {
		entries = await fs.readdir(resolvedOld);
	} catch (err) {
		result.warnings.push(`Failed to read source directory: ${String(err)}`);
		return result;
	}

	// Filter recording files (video, audio, cursor, manifests, sidecars)
	const isRecordingEntry = (name: string) => {
		const lower = name.toLowerCase();
		return (
			lower.startsWith("recording-") ||
			lower.endsWith(".cursor.json") ||
			lower.endsWith(".recordly-session.json") ||
			lower.endsWith(".recording-diagnostics.json") ||
			lower.endsWith(".system.wav") ||
			lower.endsWith(".mic.wav") ||
			lower.endsWith(".wav.json")
		);
	};

	const recordingFiles = entries.filter((name) => {
		return isRecordingEntry(name);
	});

	// Group into clusters
	const clusters = new Map<string, string[]>();
	for (const file of recordingFiles) {
		const base = getClusterBase(file);
		if (!clusters.has(base)) {
			clusters.set(base, []);
		}
		clusters.get(base)!.push(file);
	}

	// Move recording clusters
	const totalOperations = recordingFiles.length;
	let currentOp = 0;

	for (const [clusterBase, files] of clusters) {
		const suffix = await findCollisionSuffix(resolvedNew, clusterBase, files);

		for (const file of files) {
			currentOp++;
			const sourcePath = path.join(resolvedOld, file);
			const targetName = suffix ? file.replace(clusterBase, `${clusterBase}${suffix}`) : file;
			const targetPath = path.join(resolvedNew, targetName);

			onProgress?.({
				current: currentOp,
				total: totalOperations,
				currentFile: file,
			});

			try {
				await atomicMoveFile(sourcePath, targetPath);
				renamedMap.set(sourcePath.toLowerCase(), targetPath);
				result.movedFilesCount++;
			} catch (err) {
				result.failedFiles.push({ source: sourcePath, error: String(err) });
				result.success = false;
			}
		}
	}

	// 2. Migrate Projects directory
	const oldProjectsDir = path.join(resolvedOld, PROJECTS_DIRECTORY_NAME);
	const newProjectsDir = path.join(resolvedNew, PROJECTS_DIRECTORY_NAME);

	if (existsSync(oldProjectsDir)) {
		await fs.mkdir(newProjectsDir, { recursive: true });
		let projectEntries: string[] = [];
		try {
			projectEntries = await fs.readdir(oldProjectsDir);
		} catch (err) {
			result.warnings.push(`Failed to read Projects directory: ${String(err)}`);
		}

		for (const projFile of projectEntries) {
			const sourceProjPath = path.join(oldProjectsDir, projFile);
			let targetProjName = projFile;
			let counter = 1;
			while (existsSync(path.join(newProjectsDir, targetProjName))) {
				const ext = path.extname(projFile);
				const base = path.basename(projFile, ext);
				targetProjName = `${base} (${counter})${ext}`;
				counter++;
			}
			const targetProjPath = path.join(newProjectsDir, targetProjName);

			try {
				await atomicMoveFile(sourceProjPath, targetProjPath);
				renamedMap.set(sourceProjPath.toLowerCase(), targetProjPath);
				result.movedFilesCount++;

				if (hasProjectExtension(targetProjName)) {
					try {
						const raw = await fs.readFile(targetProjPath, "utf-8");
						const remapped = remapProjectContent(raw, resolvedOld, resolvedNew, renamedMap);
						await fs.writeFile(targetProjPath, remapped, "utf-8");
						result.updatedProjectsCount++;
					} catch (pErr) {
						result.warnings.push(`Failed to rewrite project references in ${targetProjName}: ${String(pErr)}`);
					}
				}
			} catch (err) {
				result.failedFiles.push({ source: sourceProjPath, error: String(err) });
				result.success = false;
			}
		}
	}

	// 3. Remap RECENT_PROJECTS_FILE
	try {
		if (existsSync(RECENT_PROJECTS_FILE)) {
			const raw = await fs.readFile(RECENT_PROJECTS_FILE, "utf-8");
			const list = JSON.parse(raw);
			if (Array.isArray(list)) {
				const normOld = resolvedOld.toLowerCase();
				const updatedList = list.map((item) => {
					if (typeof item !== "string") return item;
					const normItem = path.resolve(item).toLowerCase();
					if (renamedMap.has(normItem)) {
						return renamedMap.get(normItem)!;
					}
					if (normItem.startsWith(normOld)) {
						const rel = path.relative(normOld, path.resolve(item));
						return path.resolve(resolvedNew, rel);
					}
					return item;
				});
				await fs.writeFile(RECENT_PROJECTS_FILE, JSON.stringify(updatedList, null, 2), "utf-8");
			}
		}
	} catch (err) {
		result.warnings.push(`Failed to update recent projects index: ${String(err)}`);
	}

	return result;
}
