#include "monitor_utils.h"
#include <ShellScalingApi.h>
#include <iostream>

static BOOL CALLBACK enumMonitorCallback(HMONITOR hMonitor, HDC, LPRECT, LPARAM lParam) {
    auto* monitors = reinterpret_cast<std::vector<MonitorInfo>*>(lParam);

    MONITORINFOEXW mi = {};
    mi.cbSize = sizeof(mi);
    if (GetMonitorInfoW(hMonitor, &mi)) {
        MonitorInfo info;
        info.handle = hMonitor;
        info.x = mi.rcMonitor.left;
        info.y = mi.rcMonitor.top;
        info.width = mi.rcMonitor.right - mi.rcMonitor.left;
        info.height = mi.rcMonitor.bottom - mi.rcMonitor.top;
        info.deviceName = mi.szDevice;
        monitors->push_back(info);
    }

    return TRUE;
}

std::vector<MonitorInfo> enumerateMonitors() {
    std::vector<MonitorInfo> monitors;
    EnumDisplayMonitors(nullptr, nullptr, enumMonitorCallback, reinterpret_cast<LPARAM>(&monitors));
    return monitors;
}

// Electron uses the HMONITOR handle value cast to a number as the display ID.
HMONITOR findMonitorByDisplayId(int64_t displayId) {
    auto monitors = enumerateMonitors();

    for (const auto& m : monitors) {
        if (static_cast<int64_t>(reinterpret_cast<intptr_t>(m.handle)) == displayId) {
            return m.handle;
        }
    }

    return nullptr;
}

HMONITOR findMonitorByBounds(int x, int y, int width, int height) {
    auto monitors = enumerateMonitors();

    // 1. Exact match
    for (const auto& m : monitors) {
        if (m.x == x && m.y == y && m.width == width && m.height == height) {
            std::cerr << "Found monitor by exact bounds: " << x << "," << y << " " << width << "x" << height << std::endl;
            return m.handle;
        }
    }

    // 2. Tolerance bounds match (within 6px for rounding differences)
    for (const auto& m : monitors) {
        if (std::abs(m.x - x) <= 6 && std::abs(m.y - y) <= 6 &&
            std::abs(m.width - width) <= 6 && std::abs(m.height - height) <= 6) {
            std::cerr << "Found monitor by tolerance bounds match: " << m.x << "," << m.y << " " << m.width << "x" << m.height << std::endl;
            return m.handle;
        }
    }

    // 3. Top-left point match (within 6px)
    for (const auto& m : monitors) {
        if (std::abs(m.x - x) <= 6 && std::abs(m.y - y) <= 6) {
            std::cerr << "Found monitor by top-left point match: " << x << "," << y << std::endl;
            return m.handle;
        }
    }

    // 4. OS MonitorFromRect fallback
    RECT rect = { x, y, x + width, y + height };
    HMONITOR monitor = MonitorFromRect(&rect, MONITOR_DEFAULTTONULL);
    if (monitor) {
        std::cerr << "Found monitor via Windows OS MonitorFromRect fallback" << std::endl;
        return monitor;
    }

    // 5. Fallback to primary / single monitor if only one monitor exists
    if (monitors.size() == 1) {
        std::cerr << "Falling back to sole available monitor" << std::endl;
        return monitors[0].handle;
    }

    return nullptr;
}

MonitorInfo getMonitorInfo(HMONITOR monitor) {
    MonitorInfo info;
    info.handle = monitor;

    MONITORINFOEXW mi = {};
    mi.cbSize = sizeof(mi);
    if (GetMonitorInfoW(monitor, &mi)) {
        info.x = mi.rcMonitor.left;
        info.y = mi.rcMonitor.top;
        info.width = mi.rcMonitor.right - mi.rcMonitor.left;
        info.height = mi.rcMonitor.bottom - mi.rcMonitor.top;
        info.deviceName = mi.szDevice;
    }

    return info;
}
