// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import * as keyutil from "./keyutil";

// The terminal word-motion commands are bound to Option+Left / Option+Right
// on macOS. These tests pin the matching rules, so a change to the platform
// mapping (or to the binding syntax) cannot silently break the shortcut.

interface Mods {
    alt?: boolean;
    shift?: boolean;
    meta?: boolean;
    ctrl?: boolean;
}

function keyEvent(key: string, mods: Mods = {}): KeyboardEvent {
    return {
        key: key,
        code: "",
        type: "keydown",
        altKey: mods.alt ?? false,
        shiftKey: mods.shift ?? false,
        metaKey: mods.meta ?? false,
        ctrlKey: mods.ctrl ?? false,
    } as unknown as KeyboardEvent;
}

function macEvent(key: string, mods: Mods = {}) {
    keyutil.setKeyUtilPlatform("darwin");
    return keyutil.adaptFromReactOrNativeKeyEvent(keyEvent(key, mods));
}

describe("keyutil option bindings", () => {
    it("maps the macOS Option key to both option and alt", () => {
        const ev = macEvent("ArrowLeft", { alt: true });
        expect(ev.option).toBe(true);
        expect(ev.alt).toBe(true);
        expect(ev.cmd).toBe(false);
        expect(ev.meta).toBe(false);
    });

    it("matches Option+Left against Option:ArrowLeft", () => {
        const ev = macEvent("ArrowLeft", { alt: true });
        expect(keyutil.checkKeyPressed(ev, "Option:ArrowLeft")).toBe(true);
        expect(keyutil.checkKeyPressed(ev, "Option:ArrowRight")).toBe(false);
    });

    it("matches Option+Right against Option:ArrowRight", () => {
        const ev = macEvent("ArrowRight", { alt: true });
        expect(keyutil.checkKeyPressed(ev, "Option:ArrowRight")).toBe(true);
        expect(keyutil.checkKeyPressed(ev, "Option:ArrowLeft")).toBe(false);
    });

    it("does not match a bare arrow key", () => {
        const ev = macEvent("ArrowLeft");
        expect(keyutil.checkKeyPressed(ev, "Option:ArrowLeft")).toBe(false);
    });

    it("does not match when another modifier is held", () => {
        expect(keyutil.checkKeyPressed(macEvent("ArrowLeft", { alt: true, shift: true }), "Option:ArrowLeft")).toBe(false);
        expect(keyutil.checkKeyPressed(macEvent("ArrowLeft", { alt: true, meta: true }), "Option:ArrowLeft")).toBe(false);
        expect(keyutil.checkKeyPressed(macEvent("ArrowLeft", { alt: true, ctrl: true }), "Option:ArrowLeft")).toBe(false);
    });

    it("keeps Option and Cmd bindings apart", () => {
        const cmdLeft = macEvent("ArrowLeft", { meta: true });
        expect(keyutil.checkKeyPressed(cmdLeft, "Cmd:ArrowLeft")).toBe(true);
        expect(keyutil.checkKeyPressed(cmdLeft, "Option:ArrowLeft")).toBe(false);

        const optionLeft = macEvent("ArrowLeft", { alt: true });
        expect(keyutil.checkKeyPressed(optionLeft, "Cmd:ArrowLeft")).toBe(false);
    });

    it("does not fire the macOS binding on other platforms", () => {
        // on Linux/Windows the Option prefix maps to the Meta key, and the
        // word-motion commands are only bound on macOS anyway
        keyutil.setKeyUtilPlatform("linux");
        const ev = keyutil.adaptFromReactOrNativeKeyEvent(keyEvent("ArrowLeft", { alt: true }));
        expect(keyutil.checkKeyPressed(ev, "Option:ArrowLeft")).toBe(false);
    });
});
