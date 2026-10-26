// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import fs from "fs";
import path from "path";
import { getWaveConfigDir } from "./emain-platform";

/**
 * Get settings directly from the Wave Home directory on launch.
 * Only use this when the app is first starting up. Otherwise, prefer the settings.GetFullConfig function.
 * @returns The initial launch settings for the application.
 */
export function getLaunchSettings(): SettingsType {
    const settingsPath = path.join(getWaveConfigDir(), "settings.json");
    try {
        const settingsContents = fs.readFileSync(settingsPath, "utf8");
        return JSON.parse(settingsContents);
    } catch (_) {
        // fail silently
    }
}

/**
 * Get keybindings directly from the Wave Home directory on launch.
 * Only use this when the app is first starting up, so that global hotkeys are
 * registered before the first config event arrives.
 * @returns The initial key bindings for the application.
 */
export function getLaunchKeybindings(): { global?: Record<string, string>; functions?: Record<string, string> } {
    const keybindingsPath = path.join(getWaveConfigDir(), "keybindings.json");
    try {
        const keybindingsContents = fs.readFileSync(keybindingsPath, "utf8");
        return JSON.parse(keybindingsContents);
    } catch (_) {
        // fail silently
    }
}
