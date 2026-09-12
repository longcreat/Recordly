export type WindowsCaptureSourceLike = {
	id?: string;
	name?: string;
	display_id?: string;
	sourceType?: string;
	region?: { x: number; y: number; width: number; height: number };
};

export type WindowsCaptureDisplayBounds = {
	x: number;
	y: number;
	width: number;
	height: number;
};

export type WindowsCaptureDisplayLike = {
	id: number;
	bounds: WindowsCaptureDisplayBounds;
	scaleFactor?: number;
};

export type ResolvedWindowsCaptureDisplay = {
	displayId: number;
	bounds: WindowsCaptureDisplayBounds;
	scaleFactor?: number;
};

export type ResolvedWindowsCaptureTarget =
	| {
			kind: "window";
			windowHandle: number;
	  }
	| {
			kind: "display";
			displayId: number;
			bounds: WindowsCaptureDisplayBounds;
			scaleFactor?: number;
	  }
	| {
			kind: "region";
			displayId: number;
			bounds: WindowsCaptureDisplayBounds;
			scaleFactor: number;
			region: { x: number; y: number; width: number; height: number };
	  }
	| {
			kind: "invalid-window";
	  };

function parseDesktopCapturerWindowHandle(sourceId?: string) {
	if (!sourceId) {
		return null;
	}

	const match = sourceId.match(/^window:(\d+)/);
	if (!match) {
		return null;
	}

	const handle = Number.parseInt(match[1], 10);
	return Number.isFinite(handle) && handle > 0 ? handle : null;
}

function isWindowCaptureSource(source: WindowsCaptureSourceLike | null | undefined) {
	return source?.sourceType === "window" || source?.id?.startsWith("window:") === true;
}

export function resolveWindowsCaptureDisplay(
	source: WindowsCaptureSourceLike | null | undefined,
	allDisplays: WindowsCaptureDisplayLike[],
	primaryDisplay: WindowsCaptureDisplayLike,
): ResolvedWindowsCaptureDisplay {
	const requestedDisplayId = Number(source?.display_id);
	const primaryDisplayId = Number(primaryDisplay.id);
	const requestedOrPrimaryDisplayId =
		Number.isFinite(requestedDisplayId) && requestedDisplayId > 0
			? requestedDisplayId
			: primaryDisplayId;

	const matchedDisplay =
		allDisplays.find((display) => String(display.id) === String(requestedOrPrimaryDisplayId)) ??
		primaryDisplay;

	return {
		displayId: requestedOrPrimaryDisplayId,
		bounds: matchedDisplay.bounds,
		scaleFactor: matchedDisplay.scaleFactor ?? 1,
	};
}

export function resolveWindowsCaptureTarget(
	source: WindowsCaptureSourceLike | null | undefined,
	allDisplays: WindowsCaptureDisplayLike[],
	primaryDisplay: WindowsCaptureDisplayLike,
): ResolvedWindowsCaptureTarget {
	if (isWindowCaptureSource(source)) {
		const windowHandle = parseDesktopCapturerWindowHandle(source?.id);
		if (windowHandle !== null) {
			return {
				kind: "window",
				windowHandle,
			};
		}

		return {
			kind: "invalid-window",
		};
	}

	if (source?.sourceType === "region") {
		const resolvedDisplay = resolveWindowsCaptureDisplay(source, allDisplays, primaryDisplay);
		const raw = source.region;
		if (
			!raw ||
			typeof raw.x !== "number" ||
			typeof raw.y !== "number" ||
			typeof raw.width !== "number" ||
			typeof raw.height !== "number" ||
			raw.width <= 0 ||
			raw.height <= 0
		) {
			return { kind: "display", ...resolvedDisplay };
		}
		const scale = resolvedDisplay.scaleFactor ?? 1;
		// Region coords are global DIP screen coords; convert to physical px
		// relative to the matched display's origin.
		const regionX = Math.max(0, Math.round((raw.x - resolvedDisplay.bounds.x) * scale));
		const regionY = Math.max(0, Math.round((raw.y - resolvedDisplay.bounds.y) * scale));
		const maxWidth = Math.round(resolvedDisplay.bounds.width * scale) - regionX;
		const maxHeight = Math.round(resolvedDisplay.bounds.height * scale) - regionY;
		const region = {
			x: regionX,
			y: regionY,
			width: Math.min(Math.round(raw.width * scale), maxWidth),
			height: Math.min(Math.round(raw.height * scale), maxHeight),
		};
		// A clamped crop below the encoder's minimum even dimensions cannot
		// produce a valid H.264 stream; record the full display instead.
		if (region.width < 2 || region.height < 2) {
			return { kind: "display", ...resolvedDisplay };
		}
		return {
			kind: "region",
			displayId: resolvedDisplay.displayId,
			bounds: resolvedDisplay.bounds,
			scaleFactor: scale,
			region,
		};
	}

	const resolvedDisplay = resolveWindowsCaptureDisplay(source, allDisplays, primaryDisplay);
	return {
		kind: "display",
		...resolvedDisplay,
	};
}
