# Project: Recordly Custom Installation Path & Video Storage Path

## Architecture
Recordly is an Electron + React + TypeScript desktop screen recording and editing suite.
- **Installer & Packaging Layer**: Uses `electron-builder` targeting Windows NSIS (`Recordly-windows-x64.exe`). Native helper binaries (`wgc-capture.exe`, `cursor-monitor.exe`, `ffmpeg.exe`, etc.) are unpacked into `app.asar.unpacked` and located dynamically via `app.getAppPath()` and `process.resourcesPath`.
- **Main Process Storage & IPC**: Settings are managed in `%APPDATA%\Recordly` (`recordings-settings.json`, `recent-projects.json`). Video storage directory is resolved via `getRecordingsDir()`, dynamically returning `customRecordingsDir ?? RECORDINGS_DIR`. Project loading and local media streaming rely on `isAllowedLocalReadPath` and local HTTP media streaming server.
- **Migration Subsystem**: Dedicated atomic migration engine (`electron/ipc/project/migration.ts`) that orchestrates cross-volume copy-verify-delete, symmetrical cluster collision renaming, `.recordly` JSON absolute path rewriting, and `recent-projects.json` index updates when the storage directory is relocated.
- **Renderer UI Layer**:
  - HUD Toolbar: `LaunchWindow.tsx` and `MorePopover.tsx` presenting quick controls, current recording folder status, and change/open triggers.
  - Editor Settings: `SettingsPanel.tsx` presenting global application preferences, full video storage path management, and drive status.
  - IPC Bridge: `window.electronAPI.getRecordingsDirectory()`, `window.electronAPI.chooseRecordingsDirectory()`, `window.electronAPI.openRecordingsFolder()`, and `recordings-directory-changed` listener.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | NSIS Custom Install Wizard | Configure electron-builder for interactive assisted installer with directory choice wizard page | M1 | ORIGINAL_REQUEST §R1 |
| 2 | NSIS Disk Space Prompt | Display required vs. available partition disk space in installer wizard | M1 | ORIGINAL_REQUEST §R1 |
| 3 | Desktop & Start Menu Shortcuts | Ensure shortcuts are reliably generated pointing to target executable | M1 | ORIGINAL_REQUEST §R1 |
| 4 | Arbitrary Drive Installation | Verify all native helpers and relative asset paths operate correctly when installed to D:\ or E:\ | M1 | ORIGINAL_REQUEST §R1 |
| 5 | Storage Settings Non-Destructive Persistence | Fix `persistRecordingsDirectorySetting` to merge rather than wipe user mic/webcam preferences | M2 | ORIGINAL_REQUEST §R2 |
| 6 | Media Allowlist Custom Path Support | Update `isAllowedLocalReadPath` to include `customRecordingsDir` so custom folder media can stream | M2 | ORIGINAL_REQUEST §R2 |
| 7 | Dynamic Startup Folder Resolution | Ensure startup does not force-create default C: recordings folder when custom folder is configured | M2 | ORIGINAL_REQUEST §R2 |
| 8 | HUD Toolbar Storage UI | Display storage path, default badge, and change/open actions in `MorePopover.tsx` | M2 | ORIGINAL_REQUEST §R2 |
| 9 | Editor Settings Storage UI | Add dedicated Video Storage section in `SettingsPanel.tsx` with path display and change/open buttons | M2 | ORIGINAL_REQUEST §R2 |
| 10 | Cross-Window Directory Sync | Broadcast `recordings-directory-changed` event to synchronize HUD and Editor windows | M2 | ORIGINAL_REQUEST §R2 |
| 11 | Internationalization Parity | Add all new translation keys across all 11 supported locales in `settings.json` | M2 | ORIGINAL_REQUEST §R2 |
| 12 | Atomic Cross-Volume File Move | Copy-verify-delete protocol handling cross-partition moves (C: to D:) with `.tmp` verification | M3 | ORIGINAL_REQUEST §R3 |
| 13 | Symmetrical Cluster Collision Safety | Rename colliding files while preserving synchronized suffixes across video, audio, telemetry, and manifest | M3 | ORIGINAL_REQUEST §R3 |
| 14 | Project File Path Rewriting | Deep-remap absolute paths in `.recordly` files (`videoPath`, webcam, audio tracks/regions) from old to new dir | M3 | ORIGINAL_REQUEST §R3 |
| 15 | Recent Projects Index Remapping | Remap paths in `recent-projects.json` so recent projects list stays unbroken | M3 | ORIGINAL_REQUEST §R3 |
| 16 | Seamless Library Playback Continuity | Verify project loading and playback continue without "Project video file not found" | M3 | ORIGINAL_REQUEST §R3 |
| 17 | TypeCheck & Test Suite Health | Fix existing assertion mismatch in `windowsCaptureSelection.test.ts` and verify 0 TypeScript errors | M4 | ORIGINAL_REQUEST §R4 |
| 18 | Windows Packaging (`npm run build:win`) | Run electron-builder packaging to generate `release/Recordly-windows-x64.exe` | M4 | ORIGINAL_REQUEST §R4 |
| 19 | Full Acceptance & Regression Verification | Verify all acceptance criteria for installer, UI, persistence, migration, and playback | M4 | ORIGINAL_REQUEST §R4 |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | NSIS Installer Configuration (R1) | Configure `electron-builder.json5` for assisted NSIS wizard with custom directory page, disk space display, and desktop/start shortcuts | none | IN_PROGRESS |
| M2 | Video Storage Settings & UI (R2) | Safe config persistence, security allowlist, startup path resolution, HUD & Editor UI components, i18n | none | PLANNED |
| M3 | Historical Video Migration Engine (R3) | Implement atomic migration engine, cluster collision renaming, `.recordly` path remapping, recent projects remapping | M2 | PLANNED |
| M4 | Regression Verification & Windows Packaging (R4) | Fix existing test assertion, full typecheck, unit tests, migration integration tests, and Windows packaging | M1, M2, M3 | PLANNED |

## Interface Contracts

### M2 ↔ Main Process & IPC
```typescript
// IPC Channels
// "get-recordings-directory" -> { success: boolean, path: string, isDefault: boolean }
// "choose-recordings-directory" -> { success: boolean, path: string, isDefault: boolean, migrationResult?: MigrationResult }
// "open-recordings-folder" -> { success: boolean }
// Event: "recordings-directory-changed" -> { path: string, isDefault: boolean }

// electron/ipc/project/manager.ts
export async function persistRecordingsDirectorySetting(nextDir: string): Promise<void>;
export function isAllowedLocalReadPath(candidatePath: string): boolean;
```

### M3 ↔ Migration Engine
```typescript
// electron/ipc/project/migration.ts
export interface MigrationResult {
  success: boolean;
  movedFilesCount: number;
  updatedProjectsCount: number;
  failedFiles: Array<{ source: string; error: string }>;
  warnings: string[];
}

export async function migrateRecordingsDirectory(
  oldDir: string,
  newDir: string,
  onProgress?: (progress: { current: number; total: number; currentFile: string }) => void
): Promise<MigrationResult>;
```

## Code Layout
- `electron-builder.json5`: Windows NSIS installer options (`oneClick`, `allowToChangeInstallationDirectory`, shortcuts)
- `electron/main.ts`: Startup directory initialization (`ensureRecordingsDir`)
- `electron/ipc/constants.ts`: Settings files and project directory constants
- `electron/ipc/utils.ts`: `getRecordingsDir()` and directory loader
- `electron/ipc/project/manager.ts`: Settings persistence and media read security allowlist
- `electron/ipc/project/migration.ts`: Migration engine implementation
- `electron/ipc/project/migration.test.ts`: Vitest suite for migration logic
- `electron/ipc/register/project.ts`: IPC registration for directory choice and migration execution
- `src/components/launch/popovers/MorePopover.tsx`: HUD recordings path UI
- `src/components/launch/LaunchWindow.tsx`: HUD prop wiring
- `src/components/video-editor/SettingsPanel.tsx`: Editor storage settings section
- `src/components/video-editor/layout/useEditorSettingsPanelProps.ts`: Editor props bridge
- `src/locales/*/settings.json`: Translation keys for all 11 locales
