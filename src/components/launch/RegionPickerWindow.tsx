import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/contexts/I18nContext";

type DragState = {
	startX: number;
	startY: number;
	x: number;
	y: number;
	width: number;
	height: number;
} | null;

type PickerDisplay = {
	id: number;
	x: number;
	y: number;
	width: number;
	height: number;
	scaleFactor: number;
};

const MIN_REGION_SIZE = 32;

export default function RegionPickerWindow() {
	const { t } = useI18n();
	const [drag, setDrag] = useState<DragState>(null);
	const [display, setDisplay] = useState<PickerDisplay | null>(null);
	const [tooSmall, setTooSmall] = useState(false);

	useEffect(() => {
		void window.electronAPI?.getRegionPickerDisplay?.().then((result) => {
			if (result?.success && result.display) {
				setDisplay(result.display);
			}
		});
	}, []);

	const cancel = useCallback(() => {
		void window.electronAPI?.cancelRegionPicker?.();
	}, []);

	const confirm = useCallback(() => {
		if (!drag || !display) return;
		const x = Math.min(drag.startX, drag.x);
		const y = Math.min(drag.startY, drag.y);
		const width = Math.abs(drag.width);
		const height = Math.abs(drag.height);
		if (width < MIN_REGION_SIZE || height < MIN_REGION_SIZE) {
			// Drop the too-small rect (keep the hint) so the next drag starts clean.
			setDrag(null);
			setTooSmall(true);
			return;
		}
		// Client coords are relative to this fullscreen window covering the
		// display; convert to the global logical coords the capture resolver expects.
		void window.electronAPI.selectSource({
			id: `region:${display.id}`,
			name: t("launch.sourceSelector.region"),
			display_id: String(display.id),
			thumbnail: null,
			appIcon: null,
			sourceType: "region",
			region: { x: display.x + x, y: display.y + y, width, height },
		});
	}, [drag, display, t]);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") cancel();
			if (event.key === "Enter") confirm();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [cancel, confirm]);

	const normalized = drag
		? {
				x: Math.min(drag.startX, drag.x),
				y: Math.min(drag.startY, drag.y),
				width: Math.abs(drag.width),
				height: Math.abs(drag.height),
			}
		: null;

	return (
		<div
			className="fixed inset-0 cursor-crosshair"
			style={{ background: "rgba(0,0,0,0.3)" }}
			onPointerDown={(event) => {
				setTooSmall(false);
				// Capture the pointer so the pointerup is delivered to this element
				// even when the cursor ends up on another monitor.
				event.currentTarget.setPointerCapture(event.pointerId);
				setDrag({
					startX: event.clientX,
					startY: event.clientY,
					x: event.clientX,
					y: event.clientY,
					width: 0,
					height: 0,
				});
			}}
			onPointerMove={(event) => {
				if (event.buttons === 0) {
					// No button pressed: a stale rect must never follow the cursor.
					setDrag(null);
					return;
				}
				setDrag((current) =>
					current
						? {
								...current,
								x: event.clientX,
								y: event.clientY,
								width: event.clientX - current.startX,
								height: event.clientY - current.startY,
							}
						: null,
				);
			}}
			onPointerUp={confirm}
		>
			{normalized && normalized.width >= MIN_REGION_SIZE && normalized.height >= MIN_REGION_SIZE && (
				<div
					className="fixed border-2 border-white shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]"
					style={{
						left: normalized.x,
						top: normalized.y,
						width: normalized.width,
						height: normalized.height,
					}}
				>
					<div className="absolute -top-8 left-0 rounded bg-black/70 px-2 py-1 text-xs text-white">
						{Math.round(normalized.width)} × {Math.round(normalized.height)}
					</div>
				</div>
			)}
			<div className="fixed bottom-6 left-1/2 -translate-x-1/2 rounded bg-black/70 px-3 py-2 text-xs text-white">
				{tooSmall ? t("launch.sourceSelector.regionTooSmall") : t("launch.sourceSelector.regionHint")}
			</div>
		</div>
	);
}
