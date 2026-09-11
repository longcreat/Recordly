import {
	EyeIcon,
	EyeSlashIcon,
	FilmSlateIcon,
	FolderOpenIcon,
	TranslateIcon,
	VideoCameraIcon,
	ArrowClockwiseIcon,
	ArrowSquareOut,
	SunIcon,
	MoonIcon,
	DesktopIcon,
} from "@phosphor-icons/react";
import type { ReactElement } from "react";
import { useI18n } from "@/contexts/I18nContext";
import { useScopedT } from "@/contexts/I18nContext";
import { useTheme } from "@/contexts/ThemeContext";
import type { ScreenRecorderFrameRate } from "@/hooks/useScreenRecorder";
import type { AppLocale } from "@/i18n/config";
import { SUPPORTED_LOCALES } from "@/i18n/config";
import styles from "../LaunchWindow.module.css";
import { useLaunchPopoverCoordinator } from "./LaunchPopoverCoordinator";
import { DropdownItem, HudPopover } from "./PopoverScaffold";

const POPOVER_ID = "more";

const RECORDING_FRAME_RATE_OPTIONS: readonly ScreenRecorderFrameRate[] = [24, 30, 60] as const;

const LOCALE_LABELS: Record<string, string> = {
	en: "English",
	es: "Español",
	fr: "Français",
	it: "Italiano",
	nl: "Nederlands",
	ko: "한국어",
	"pt-BR": "Português",
	"zh-CN": "簡體中文",
	"zh-TW": "繁體中文",
};

export function MorePopover({
	trigger,
	supportsHudCaptureProtection,
	hideHudFromCapture,
	recordingsDirectory,
	frameRate,
	persistFrameRate,
	onToggleHudCaptureProtection,
	onChooseRecordingsDirectory,
	onOpenRecordingsFolder,
	onOpenVideoFile,
	onOpenProjectBrowser,
	showDevUpdatePreview,
	onPreviewUpdateUi,
	appVersion,
}: {
	trigger: ReactElement;
	supportsHudCaptureProtection: boolean;
	hideHudFromCapture: boolean;
	recordingsDirectory?: string | null;
	frameRate: ScreenRecorderFrameRate;
	persistFrameRate: (rate: ScreenRecorderFrameRate) => void;
	onToggleHudCaptureProtection: () => void;
	onChooseRecordingsDirectory: () => void;
	onOpenRecordingsFolder?: () => void;
	onOpenVideoFile: () => void;
	onOpenProjectBrowser: () => void;
	showDevUpdatePreview: boolean;
	onPreviewUpdateUi: () => void;
	appVersion: string | null;
}) {
	const t = useScopedT("launch");
	const { locale, setLocale } = useI18n();
	const { preference, setPreference } = useTheme();
	const { isOpen, requestOpen, requestClose } = useLaunchPopoverCoordinator();
	const open = isOpen(POPOVER_ID);

	return (
		<HudPopover
			open={open}
			onOpenChange={(nextOpen) => {
				if (!nextOpen) {
					requestClose(POPOVER_ID);
					return;
				}
				requestOpen(POPOVER_ID);
			}}
			trigger={trigger}
			align="end"
		>
			{supportsHudCaptureProtection && (
				<DropdownItem
					icon={hideHudFromCapture ? <EyeSlashIcon size={16} /> : <EyeIcon size={16} />}
					selected={hideHudFromCapture}
					onClick={onToggleHudCaptureProtection}
				>
					{hideHudFromCapture
						? t("recording.hideHudFromVideo")
						: t("recording.showHudInVideo")}
				</DropdownItem>
			)}
			<div className={styles.ddLabel} style={{ marginTop: 4 }}>
				{t("recording.storagePath", "存储路径")}
			</div>
			{recordingsDirectory && (
				<div
					style={{
						padding: "2px 10px 6px",
						fontSize: "11px",
						opacity: 0.65,
						maxWidth: "240px",
						overflow: "hidden",
						textOverflow: "ellipsis",
						whiteSpace: "nowrap",
					}}
					title={recordingsDirectory}
				>
					{recordingsDirectory}
				</div>
			)}
			<DropdownItem
				icon={<FolderOpenIcon size={16} />}
				onClick={() => {
					requestClose(POPOVER_ID);
					onChooseRecordingsDirectory();
				}}
			>
				{t("recording.changeRecordingsFolder", "更改视频保存路径...")}
			</DropdownItem>
			{onOpenRecordingsFolder && (
				<DropdownItem
					icon={<ArrowSquareOut size={16} />}
					onClick={() => {
						requestClose(POPOVER_ID);
						onOpenRecordingsFolder();
					}}
				>
					{t("recording.openRecordingsFolder", "打开当前保存文件夹")}
				</DropdownItem>
			)}
			<DropdownItem
				icon={<VideoCameraIcon size={16} />}
				onClick={() => {
					requestClose(POPOVER_ID);
					onOpenVideoFile();
				}}
			>
				{t("recording.openVideoFile")}
			</DropdownItem>
			<DropdownItem
				icon={<FolderOpenIcon size={16} />}
				onClick={() => {
					requestClose(POPOVER_ID);
					onOpenProjectBrowser();
				}}
			>
				{t("recording.openProject")}
			</DropdownItem>
			{showDevUpdatePreview ? (
				<DropdownItem
					icon={<ArrowClockwiseIcon size={16} />}
					onClick={() => {
						requestClose(POPOVER_ID);
						onPreviewUpdateUi();
					}}
				>
					{t("recording.previewUpdateUi", "Preview Update UI")}
				</DropdownItem>
			) : null}
			<div className={styles.ddLabel} style={{ marginTop: 4 }}>
				{t("recording.frameRate")}
			</div>
			{RECORDING_FRAME_RATE_OPTIONS.map((rate) => (
				<DropdownItem
					key={rate}
					icon={<FilmSlateIcon size={16} />}
					selected={frameRate === rate}
					onClick={() => {
						persistFrameRate(rate);
					}}
				>
					{t(`recording.frameRate${rate}`)}
				</DropdownItem>
			))}
			<div className={styles.ddLabel} style={{ marginTop: 4 }}>
				{t("recording.appearance", "Appearance")}
			</div>
			<DropdownItem
				icon={<SunIcon size={16} />}
				selected={preference === "light"}
				onClick={() => {
					setPreference("light");
					requestClose(POPOVER_ID);
				}}
			>
				{t("common.light", "Light")}
			</DropdownItem>
			<DropdownItem
				icon={<MoonIcon size={16} />}
				selected={preference === "dark"}
				onClick={() => {
					setPreference("dark");
					requestClose(POPOVER_ID);
				}}
			>
				{t("common.dark", "Dark")}
			</DropdownItem>
			<DropdownItem
				icon={<DesktopIcon size={16} />}
				selected={preference === "system"}
				onClick={() => {
					setPreference("system");
					requestClose(POPOVER_ID);
				}}
			>
				{t("common.system", "System")}
			</DropdownItem>
			<div className={styles.ddLabel} style={{ marginTop: 4 }}>
				{t("recording.language")}
			</div>
			{SUPPORTED_LOCALES.map((code) => (
				<DropdownItem
					key={code}
					icon={<TranslateIcon size={16} />}
					selected={locale === code}
					onClick={() => {
						setLocale(code as AppLocale);
						requestClose(POPOVER_ID);
					}}
				>
					{LOCALE_LABELS[code] ?? code}
				</DropdownItem>
			))}
			{appVersion && (
				<div
					style={{
						marginTop: 8,
						padding: "4px 12px",
						fontSize: 11,
						color: "var(--launch-text-muted)",
						textAlign: "center",
						userSelect: "text",
					}}
				>
					v{appVersion}
				</div>
			)}
		</HudPopover>
	);
}
