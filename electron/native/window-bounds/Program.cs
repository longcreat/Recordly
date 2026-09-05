using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace RecordlyNativeWindowBounds
{
    internal static class Program
    {
        [StructLayout(LayoutKind.Sequential)]
        public struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        private const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool IsWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

        [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

        private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("dwmapi.dll")]
        private static extern int DwmGetWindowAttribute(
            IntPtr hwnd,
            int dwAttribute,
            out RECT pvAttribute,
            int cbAttribute);

        public static int Main(string[] args)
        {
            if (args.Length == 0)
            {
                return 1;
            }

            string rawId = args[0];
            string targetTitle = args.Length > 1 ? args[1] : null;

            IntPtr hWnd = IntPtr.Zero;

            // 1. Try parsing numeric window handle
            if (!string.IsNullOrEmpty(rawId))
            {
                // Source ID might be formatted as "12345" or "12345:0"
                string cleanId = rawId;
                int colonIdx = cleanId.IndexOf(':');
                if (colonIdx >= 0)
                {
                    cleanId = cleanId.Substring(0, colonIdx);
                }

                long parsedId;
                if (long.TryParse(cleanId, out parsedId) && parsedId > 0)
                {
                    IntPtr candidate = new IntPtr(parsedId);
                    if (IsWindow(candidate))
                    {
                        hWnd = candidate;
                    }
                }
            }

            // 2. If handle not resolved or not a window, try matching by window title
            if (hWnd == IntPtr.Zero && !string.IsNullOrEmpty(targetTitle))
            {
                IntPtr foundWnd = IntPtr.Zero;
                string searchTitle = targetTitle.Trim();

                EnumWindows(delegate (IntPtr wnd, IntPtr param)
                {
                    if (!IsWindowVisible(wnd)) return true;

                    StringBuilder sb = new StringBuilder(512);
                    if (GetWindowText(wnd, sb, sb.Capacity) > 0)
                    {
                        string title = sb.ToString();
                        if (title.Equals(searchTitle, StringComparison.OrdinalIgnoreCase) ||
                            title.IndexOf(searchTitle, StringComparison.OrdinalIgnoreCase) >= 0)
                        {
                            foundWnd = wnd;
                            return false; // Stop enumeration
                        }
                    }
                    return true;
                }, IntPtr.Zero);

                hWnd = foundWnd;
            }

            if (hWnd == IntPtr.Zero || !IsWindow(hWnd))
            {
                return 1;
            }

            RECT rect;
            // Prefer DWM extended frame bounds (excludes invisible window drop shadows)
            int hr = DwmGetWindowAttribute(hWnd, DWMWA_EXTENDED_FRAME_BOUNDS, out rect, Marshal.SizeOf(typeof(RECT)));
            if (hr != 0)
            {
                if (!GetWindowRect(hWnd, out rect))
                {
                    return 1;
                }
            }

            int width = rect.Right - rect.Left;
            int height = rect.Bottom - rect.Top;

            if (width <= 0 || height <= 0)
            {
                return 1;
            }

            Console.WriteLine("{{\"x\":{0},\"y\":{1},\"width\":{2},\"height\":{3}}}",
                rect.Left, rect.Top, width, height);

            return 0;
        }
    }
}
