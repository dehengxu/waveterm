// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import type { WaveConfigViewModel } from "@/app/view/waveconfig/waveconfig-model";
import type { WaveConfigEnv } from "@/app/view/waveconfig/waveconfigenv";
import { useWaveEnv } from "@/app/waveenv/waveenv";
import { cn, stringToBase64 } from "@/util/util";
import { useAtomValue } from "jotai";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

type KeybindingsData = {
    global?: Record<string, string>;
    functions?: Record<string, string>;
};

type GlobalHotkeyDef = {
    id: string;
    label: string;
    hint: string;
};

const GlobalHotkeyDefs: GlobalHotkeyDef[] = [
    { id: "window.toggle", label: "唤起 / 隐藏 Wave 窗口", hint: "显示或隐藏最近使用的 Wave 窗口" },
    { id: "window.new", label: "新建 Wave 窗口", hint: "打开一个全新的 Wave 窗口并聚焦" },
    { id: "window.focus", label: "聚焦最近窗口", hint: "只聚焦不隐藏，等同于「回到 Wave」" },
    { id: "ai.focus", label: "聚焦 AI 输入框", hint: "唤起窗口并把光标放进 Wave AI 输入框" },
    { id: "ai.toggle", label: "切换 AI 面板", hint: "唤起窗口并显示 / 隐藏 AI 面板" },
    { id: "term.focus", label: "聚焦终端块", hint: "唤起窗口并聚焦到终端输入" },
];

// keys that macOS already owns -- they cannot be registered as global hotkeys
const SystemTakenKeys: Record<string, string> = {
    "Cmd:Space": "Spotlight",
    "Cmd:Tab": "应用程序切换",
    "Cmd:Q": "退出应用",
    "Cmd:M": "最小化窗口",
    "Cmd:H": "隐藏应用",
    "Ctrl:Cmd:Q": "锁屏",
};

const ModifierKeys = ["Control", "Alt", "Shift", "Meta", "OS"];

function parseKeybindings(content: string): KeybindingsData {
    if (!content || content.trim() === "") {
        return {};
    }
    try {
        const parsed = JSON.parse(content);
        if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) {
            return {};
        }
        return parsed as KeybindingsData;
    } catch (e) {
        return {};
    }
}

// Builds a Wave key description (e.g. "Cmd:Shift:Space"). Modifier keys are
// accumulated separately, because the keydown event for a modifier carries
// e.key == "Control"/"Alt"/... instead of the actual combination.
function buildKeyDesc(e: React.KeyboardEvent, held: Set<string>): string | null {
    if (ModifierKeys.includes(e.key)) {
        return null;
    }
    const parts: string[] = [];
    const hasMeta = held.has("Meta") || e.metaKey;
    const hasCtrl = held.has("Control") || e.ctrlKey;
    const hasAlt = held.has("Alt") || e.altKey;
    const hasShift = held.has("Shift") || e.shiftKey;
    if (hasMeta) {
        parts.push("Cmd");
    }
    if (hasAlt) {
        parts.push("Option");
    }
    if (hasCtrl) {
        parts.push("Ctrl");
    }
    if (hasShift) {
        parts.push("Shift");
    }
    let key = e.key;
    if (key === " ") {
        key = "Space";
    } else if (key.length === 1) {
        key = key.toUpperCase();
    }
    if (!key) {
        return null;
    }
    parts.push(key);
    return parts.join(":");
}

interface KeyCaptureInputProps {
    value: string;
    onChange: (value: string) => void;
    hasError?: boolean;
}

const KeyCaptureInput = memo(({ value, onChange, hasError }: KeyCaptureInputProps) => {
    const [recording, setRecording] = useState(false);
    const heldRef = useRef<Set<string>>(new Set());

    useEffect(() => {
        if (!recording) {
            return;
        }
        const onKeyUp = (e: KeyboardEvent) => {
            heldRef.current.delete(e.key);
        };
        window.addEventListener("keyup", onKeyUp);
        return () => {
            window.removeEventListener("keyup", onKeyUp);
        };
    }, [recording]);

    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.key === "Escape") {
                heldRef.current.clear();
                setRecording(false);
                return;
            }
            if (ModifierKeys.includes(e.key)) {
                heldRef.current.add(e.key);
                return;
            }
            const desc = buildKeyDesc(e, heldRef.current);
            heldRef.current.clear();
            setRecording(false);
            if (desc) {
                onChange(desc);
            }
        },
        [onChange]
    );

    return (
        <button
            type="button"
            className={cn(
                "px-3 py-1.5 rounded font-mono text-[12px] border transition-colors cursor-pointer min-w-[110px] text-center",
                recording
                    ? "border-accent-500 bg-accent-500/10 text-accent-500"
                    : hasError
                      ? "border-red-500 text-red-400"
                      : "border-zinc-600 bg-zinc-800 hover:border-accent-500"
            )}
            onClick={() => {
                heldRef.current.clear();
                setRecording(true);
            }}
            onKeyDown={handleKeyDown}
            title={recording ? "按下新的组合键，Esc 取消" : "点击后按下新的组合键"}
        >
            {recording ? "按键…" : value || "未设置"}
        </button>
    );
});
KeyCaptureInput.displayName = "KeyCaptureInput";

interface KeybindingsVisualProps {
    model: WaveConfigViewModel;
}

export const KeybindingsVisualContent = memo(({ model }: KeybindingsVisualProps) => {
    const env = useWaveEnv<WaveConfigEnv>();
    const fileContent = useAtomValue(model.fileContentAtom);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [status, setStatus] = useState<{ registered: Record<string, string>; failed: Record<string, string> }>({
        registered: {},
        failed: {},
    });

    const data = useMemo(() => parseKeybindings(fileContent), [fileContent]);
    const globalMap = useMemo(() => data.global ?? {}, [data]);

    // the main process reports which hotkeys actually registered (a key that is
    // already claimed by the OS fails silently on the Electron side)
    useEffect(() => {
        let cancelled = false;
        getApi()
            .getGlobalHotkeyStatus()
            .then((st) => {
                if (!cancelled) {
                    setStatus(st);
                }
            })
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, [fileContent]);

    const save = useCallback(
        async (next: KeybindingsData) => {
            setSaving(true);
            setError(null);
            try {
                const formatted = JSON.stringify(next, null, 2);
                const fullPath = `${model.configDir}/keybindings.json`;
                await env.rpc.FileWriteCommand(TabRpcClient, {
                    info: { path: fullPath },
                    data64: stringToBase64(formatted),
                });
                globalStore.set(model.fileContentAtom, formatted);
                globalStore.set(model.originalContentAtom, formatted);
                globalStore.set(model.hasEditedAtom, false);
            } catch (err) {
                setError(`保存失败: ${err.message || String(err)}`);
            } finally {
                setSaving(false);
            }
        },
        [env, model]
    );

    const setGlobalHotkey = useCallback(
        (actionId: string, key: string) => {
            const nextGlobal = { ...globalMap };
            if (key) {
                nextGlobal[actionId] = key;
            } else {
                delete nextGlobal[actionId];
            }
            save({ ...data, global: nextGlobal });
        },
        [data, globalMap, save]
    );

    const findConflict = useCallback(
        (actionId: string, key: string): string | null => {
            if (!key) {
                return null;
            }
            const systemOwner = SystemTakenKeys[key];
            if (systemOwner) {
                return `与 macOS 系统快捷键（${systemOwner}）冲突`;
            }
            for (const def of GlobalHotkeyDefs) {
                if (def.id !== actionId && globalMap[def.id] === key) {
                    return `与「${def.label}」重复`;
                }
            }
            return null;
        },
        [globalMap]
    );

    return (
        <div className="flex flex-col gap-5 p-4">
            <div className="flex flex-col gap-1">
                <div className="text-sm font-semibold">全局唤起快捷键</div>
                <div className="text-xs text-muted">
                    这些快捷键在系统范围内生效，即使 Wave 不是当前窗口也能触发。点击键位框后按下新的组合键。
                </div>
            </div>

            {error && (
                <div className="flex items-center gap-2 p-3 rounded border border-red-500/30 bg-red-500/10 text-red-400 text-sm">
                    <i className="fa-sharp fa-solid fa-circle-exclamation" />
                    <span>{error}</span>
                </div>
            )}

            <div className="flex flex-col divide-y divide-zinc-700 border border-zinc-700 rounded-lg overflow-hidden">
                {GlobalHotkeyDefs.map((def) => {
                    const key = globalMap[def.id] ?? "";
                    const conflict = findConflict(def.id, key);
                    const failed = status.failed?.[def.id] != null;
                    const isRegistered = status.registered?.[def.id] != null;
                    return (
                        <div key={def.id} className="flex items-center gap-4 px-4 py-3">
                            <div className="flex flex-col flex-1 min-w-0">
                                <div className="text-sm">{def.label}</div>
                                <div className="text-xs text-muted">
                                    <code className="font-mono">{def.id}</code> · {def.hint}
                                </div>
                            </div>
                            <KeyCaptureInput
                                value={key}
                                hasError={!!conflict || failed}
                                onChange={(v) => setGlobalHotkey(def.id, v)}
                            />
                            {key && (
                                <button
                                    type="button"
                                    className="px-2 py-1 text-xs rounded border border-zinc-700 hover:border-zinc-500 text-muted hover:text-primary transition-colors cursor-pointer"
                                    onClick={() => setGlobalHotkey(def.id, "")}
                                >
                                    清除
                                </button>
                            )}
                            <div className="w-[120px] text-right text-xs">
                                {conflict ? (
                                    <span className="text-red-400 flex items-center gap-1 justify-end">
                                        <i className="fa-sharp fa-solid fa-triangle-exclamation" />
                                        {conflict}
                                    </span>
                                ) : failed ? (
                                    <span className="text-red-400 flex items-center gap-1 justify-end">
                                        <i className="fa-sharp fa-solid fa-circle-exclamation" />
                                        注册失败（被系统占用）
                                    </span>
                                ) : isRegistered ? (
                                    <span className="text-accent-500 flex items-center gap-1 justify-end">
                                        <i className="fa-sharp fa-solid fa-check" />
                                        已注册
                                    </span>
                                ) : key ? (
                                    <span className="text-muted">等待注册</span>
                                ) : (
                                    <span className="text-muted">未启用</span>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>

            {saving && (
                <div className="flex items-center gap-2 text-xs text-muted">
                    <i className="fa-sharp fa-solid fa-spinner fa-spin" />
                    保存中...
                </div>
            )}

            <div className="flex flex-col gap-2 p-4 rounded-lg border border-zinc-700 bg-zinc-800/40">
                <div className="text-sm font-semibold">功能快捷键</div>
                <div className="text-xs text-muted">
                    Wave 的功能快捷键（新建标签页、分割块、切换面板等）目前仍由代码内置，暂不支持在此自定义。
                    后续版本会开放，届时可在 <code className="font-mono">keybindings.json</code> 的{" "}
                    <code className="font-mono">functions</code> 段落中按命令 ID 覆盖。
                </div>
            </div>
        </div>
    );
});
KeybindingsVisualContent.displayName = "KeybindingsVisualContent";
