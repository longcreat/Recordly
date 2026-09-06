import type { PointerEvent as ReactPointerEvent } from "react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export type SliderScale = "linear" | "logarithmic";

interface SliderControlProps {
	label: string;
	value: number;
	defaultValue: number;
	min: number;
	max: number;
	step: number;
	onChange: (value: number) => void;
	formatValue: (value: number) => string;
	parseInput: (text: string) => number | null;
	accentColor?: "purple" | "blue";
	// "logarithmic" spaces values by ratio so 0.5x->1x feels as wide as 1x->2x.
	// Used for playback speed; requires min > 0, otherwise it degrades to linear.
	scale?: SliderScale;
	// When true, onChange fires only on pointer release while the drag updates the
	// visual locally. Use for expensive or rejectable commits (e.g. clip speed).
	commitOnRelease?: boolean;
}

function clamp(value: number, min: number, max: number) {
	return Math.min(max, Math.max(min, value));
}

export function quantizeToStep(value: number, min: number, step: number) {
	if (!(step > 0)) {
		return value;
	}

	return min + Math.round((value - min) / step) * step;
}

// Maps a normalized track position (0..1) to a value. Logarithmic mapping keeps
// perceptual spacing even across a multiplicative range; it falls back to linear
// when the bounds are not strictly positive and ordered.
export function sliderPositionToValue(
	position: number,
	min: number,
	max: number,
	scale: SliderScale,
): number {
	if (scale === "logarithmic" && min > 0 && max > min) {
		return min * (max / min) ** position;
	}

	return min + position * (max - min);
}

// Inverse of sliderPositionToValue: maps a value back to its 0..1 track position.
export function sliderValueToPosition(
	value: number,
	min: number,
	max: number,
	scale: SliderScale,
): number {
	if (scale === "logarithmic" && min > 0 && max > min && value > 0) {
		return Math.log(value / min) / Math.log(max / min);
	}

	return (value - min) / (max - min || 1);
}

export const SliderControl = memo(function SliderControl({
	label,
	value,
	defaultValue: _defaultValue,
	min,
	max,
	step,
	onChange,
	formatValue,
	parseInput: _parseInput,
	accentColor = "blue",
	scale = "linear",
	commitOnRelease = false,
}: SliderControlProps) {
	const rootRef = useRef<HTMLDivElement | null>(null);
	const valueTextRef = useRef<HTMLSpanElement | null>(null);
	const boundsRef = useRef<DOMRect | null>(null);
	const requestRef = useRef<number | null>(null);
	// In commit-on-release mode the pending value lives here so the track and label
	// follow the pointer even though the parent's `value` prop has not updated yet.
	const [dragValue, setDragValue] = useState<number | null>(null);
	const displayValue = dragValue ?? value;

	const pct = Math.min(
		100,
		Math.max(0, sliderValueToPosition(displayValue, min, max, scale) * 100),
	);

	const dividerClass =
		accentColor === "purple"
			? "bg-foreground/95 shadow-[0_0_10px_rgba(139,92,246,0.28)]"
			: "bg-foreground/95 shadow-[0_0_10px_rgba(37,99,235,0.28)]";

	// Sync initial and prop-driven changes to CSS variable
	useEffect(() => {
		if (rootRef.current) {
			rootRef.current.style.setProperty("--slider-pct", String(pct / 100));
		}
	}, [pct]);

	const computeValueAt = useCallback(
		(clientX: number): number | null => {
			const bounds = boundsRef.current;
			if (!bounds || bounds.width <= 6) {
				return null;
			}

			const normalized = clamp((clientX - (bounds.left + 3)) / (bounds.width - 6), 0, 1);
			const rawValue = sliderPositionToValue(normalized, min, max, scale);
			const nextValue = clamp(quantizeToStep(rawValue, min, step), min, max);
			return Number(nextValue.toFixed(6));
		},
		[max, min, scale, step],
	);

	const paintValue = useCallback(
		(finalValue: number) => {
			const finalPct = (sliderValueToPosition(finalValue, min, max, scale) * 100).toFixed(4);

			// Direct DOM update for instant feedback
			if (rootRef.current) {
				rootRef.current.style.setProperty("--slider-pct", String(Number(finalPct) / 100));
				rootRef.current.setAttribute("aria-valuenow", String(finalValue));
				rootRef.current.setAttribute("aria-valuetext", formatValue(finalValue));
			}
			if (valueTextRef.current) {
				valueTextRef.current.textContent = formatValue(finalValue);
			}
		},
		[formatValue, max, min, scale],
	);

	const updateValue = useCallback(
		(clientX: number) => {
			const finalValue = computeValueAt(clientX);
			if (finalValue == null) {
				return;
			}

			paintValue(finalValue);

			if (commitOnRelease) {
				// Hold the pending value locally; notify the parent on release only.
				setDragValue(finalValue);
			} else {
				onChange(finalValue);
			}
		},
		[commitOnRelease, computeValueAt, onChange, paintValue],
	);

	const handlePointerDown = useCallback(
		(event: ReactPointerEvent<HTMLDivElement>) => {
			event.preventDefault();
			const pointerId = event.pointerId;
			const target = event.currentTarget;

			// Cache bounds to avoid layout thrashing during move
			boundsRef.current = target.getBoundingClientRect();

			target.setPointerCapture(pointerId);
			updateValue(event.clientX);

			const handlePointerMove = (moveEvent: PointerEvent) => {
				if (moveEvent.pointerId !== pointerId) {
					return;
				}

				if (requestRef.current) {
					cancelAnimationFrame(requestRef.current);
				}

				requestRef.current = requestAnimationFrame(() => {
					updateValue(moveEvent.clientX);
				});
			};

			const finishPointer = (finishEvent: PointerEvent) => {
				if (finishEvent.pointerId !== pointerId) {
					return;
				}

				if (requestRef.current) {
					cancelAnimationFrame(requestRef.current);
					requestRef.current = null;
				}

				if (finishEvent.type === "pointerup") {
					if (commitOnRelease) {
						const finalValue = computeValueAt(finishEvent.clientX);
						setDragValue(null);
						if (finalValue != null) {
							onChange(finalValue);
						}
					} else {
						updateValue(finishEvent.clientX);
					}
				}

				target.releasePointerCapture(pointerId);
				target.removeEventListener("pointermove", handlePointerMove);
				target.removeEventListener("pointerup", finishPointer);
				target.removeEventListener("pointercancel", finishPointer);
				boundsRef.current = null;
			};

			target.addEventListener("pointermove", handlePointerMove);
			target.addEventListener("pointerup", finishPointer);
			target.addEventListener("pointercancel", finishPointer);
		},
		[commitOnRelease, computeValueAt, onChange, updateValue],
	);

	return (
		<div
			ref={rootRef}
			role="slider"
			tabIndex={0}
			aria-label={label}
			aria-valuemin={min}
			aria-valuemax={max}
			aria-valuenow={displayValue}
			aria-valuetext={formatValue(displayValue)}
			onPointerDown={handlePointerDown}
			onKeyDown={(event) => {
				if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
					event.preventDefault();
					onChange(clamp(quantizeToStep(value - step, min, step), min, max));
				}

				if (event.key === "ArrowRight" || event.key === "ArrowUp") {
					event.preventDefault();
					onChange(clamp(quantizeToStep(value + step, min, step), min, max));
				}
			}}
			className="relative flex h-10 w-full select-none items-center overflow-hidden rounded-xl bg-editor-bg/80 px-1.5 outline-none focus-visible:ring-1 focus-visible:ring-[#2563EB]/40"
			style={
				{
					"--slider-pct": String(pct / 100),
				} as React.CSSProperties
			}
		>
			<div
				className="pointer-events-none absolute inset-y-[3px] left-[3px] right-auto rounded-[10px] bg-foreground/[0.08] shadow-[0_4px_10px_0_rgba(0,0,0,0.18)] transition-none"
				style={{
					width: "calc(var(--slider-pct) * (100% - 6px))",
				}}
			/>
			<div
				className={cn(
					"pointer-events-none absolute bottom-[18%] top-[18%] z-10 w-[2px] rounded-full transition-none",
					dividerClass,
				)}
				style={{
					left: "calc(var(--slider-pct) * (100% - 6px) - 6px)",
				}}
			/>
			<span className="pointer-events-none relative z-10 flex-1 pl-3 text-[12px] font-medium text-muted-foreground">
				{label}
			</span>
			<span
				ref={valueTextRef}
				className="pointer-events-none relative z-10 pr-3 text-[12px] font-medium tabular-nums text-foreground"
			>
				{formatValue(displayValue)}
			</span>
		</div>
	);
});
