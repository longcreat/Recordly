import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useI18n } from "@/contexts/I18nContext";

// Windows crash recovery runs in the main process at startup and relocates any orphaned recording
// into the library. On editor mount we pull the result once and surface a single confirmation toast,
// so the user knows an interrupted recording was saved rather than lost.
export function useRecoveredRecordingsToast() {
	const { t } = useI18n();
	const hasChecked = useRef(false);

	useEffect(() => {
		if (hasChecked.current) {
			return;
		}
		hasChecked.current = true;

		void (async () => {
			try {
				const result = await window.electronAPI?.getRecoveredRecordings?.();
				const count = result?.success ? (result.recordings?.length ?? 0) : 0;
				if (count <= 0) {
					return;
				}
				toast.success(
					count === 1
						? t("editor.recoveredRecordings.toastSingular")
						: t("editor.recoveredRecordings.toastPlural", undefined, { count }),
				);
			} catch {
				// Recovery is best-effort; never block the editor on a missed toast.
			}
		})();
	}, [t]);
}
