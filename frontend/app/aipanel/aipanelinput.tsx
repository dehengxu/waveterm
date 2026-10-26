// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { formatFileSizeError, isAcceptableFile, validateFileSize } from "@/app/aipanel/ai-utils";
import { waveAIHasFocusWithin } from "@/app/aipanel/waveai-focus-utils";
import { type WaveAIModel } from "@/app/aipanel/waveai-model";
import { getSettingsKeyAtom } from "@/app/store/global";
import { Tooltip } from "@/element/tooltip";
import { cn } from "@/util/util";
import { useAtom, useAtomValue } from "jotai";
import { memo, useCallback, useEffect, useRef } from "react";

interface AIPanelInputProps {
    onSubmit: (e: React.FormEvent) => void;
    status: string;
    model: WaveAIModel;
}

export interface AIPanelInputRef {
    focus: () => void;
    resize: () => void;
    scrollToBottom: () => void;
    // Removes the whole line the caret is on. Returns false when the input
    // does not hold the DOM focus, so the caller can fall through to
    // another target (e.g. a terminal block).
    deleteLine: () => boolean;
}

export const AIPanelInput = memo(({ onSubmit, status, model }: AIPanelInputProps) => {
    const [input, setInput] = useAtom(model.inputAtom);
    const isFocused = useAtomValue(model.isWaveAIFocusedAtom);
    const isChatEmpty = useAtomValue(model.isChatEmptyAtom);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const isPanelOpen = useAtomValue(model.getPanelVisibleAtom());
    const pendingApproval = useAtomValue(model.pendingApprovalAtom);
    const sessionAutoTools = useAtomValue(model.sessionAutoToolsAtom);
    const foreverAutoTools = useAtomValue(getSettingsKeyAtom("waveai:autotools")) ?? [];

    // The tools that are waiting for the user right now. The two permission
    // buttons on the left of the input apply to these.
    const pendingToolnames = pendingApproval == null ? [] : Object.keys(pendingApproval.byTool);
    const hasPendingApproval = pendingToolnames.length > 0;
    const sessionActive = hasPendingApproval && pendingToolnames.some((name) => sessionAutoTools.includes(name));
    const foreverActive = hasPendingApproval && pendingToolnames.some((name) => foreverAutoTools.includes(name));
    const pendingLabel = pendingToolnames.join(", ");
    const everyTimeTooltip = hasPendingApproval
        ? `Approve Every Time — allow ${pendingLabel} without asking for the rest of this chat`
        : "Approve Every Time — no tool is waiting for approval";
    const foreverTooltip = hasPendingApproval
        ? `Approved Forever — always allow ${pendingLabel} without asking`
        : "Approved Forever — no tool is waiting for approval";

    let placeholder: string;
    if (!isChatEmpty) {
        placeholder = "Continue...";
    } else if (model.inBuilder) {
        placeholder = "What would you like to build...";
    } else {
        placeholder = "Ask Wave AI anything...";
    }

    const resizeTextarea = useCallback(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;

        textarea.style.height = "auto";
        const scrollHeight = textarea.scrollHeight;
        const maxHeight = 7 * 24;
        textarea.style.height = `${Math.min(scrollHeight, maxHeight)}px`;
    }, []);

    // React re-renders the controlled textarea and the browser puts the
    // caret at the end of the new text, so the position we want has to be
    // restored once the value has been committed.
    const pendingCaretRef = useRef<number | null>(null);

    const deleteLine = useCallback((): boolean => {
        const textarea = textareaRef.current;
        if (!textarea) {
            return false;
        }
        if (document.activeElement !== textarea) {
            // the input does not have the focus -- let someone else handle it
            return false;
        }
        const value = textarea.value;
        const caret = textarea.selectionStart ?? 0;
        // start of the line the caret is on
        const lineStart = value.lastIndexOf("\n", caret - 1) + 1;
        const nextBreak = value.indexOf("\n", caret);
        const contentEnd = nextBreak == -1 ? value.length : nextBreak;
        let removeStart: number;
        let removeEnd: number;
        if (contentEnd < value.length) {
            // the line has a terminator, take it along with the line
            removeStart = lineStart;
            removeEnd = contentEnd + 1;
        } else if (lineStart > 0) {
            // last line without a terminator, take the preceding newline
            removeStart = lineStart - 1;
            removeEnd = value.length;
        } else {
            removeStart = 0;
            removeEnd = value.length;
        }
        const newValue = value.slice(0, removeStart) + value.slice(removeEnd);
        if (newValue !== value) {
            pendingCaretRef.current = removeStart;
            setInput(newValue);
        }
        return true;
    }, [setInput]);

    useEffect(() => {
        const pendingCaret = pendingCaretRef.current;
        if (pendingCaret == null) {
            return;
        }
        pendingCaretRef.current = null;
        const textarea = textareaRef.current;
        if (!textarea) {
            return;
        }
        textarea.selectionStart = pendingCaret;
        textarea.selectionEnd = pendingCaret;
    }, [input]);

    useEffect(() => {
        const inputRefObject: React.RefObject<AIPanelInputRef> = {
            current: {
                focus: () => {
                    textareaRef.current?.focus();
                },
                resize: resizeTextarea,
                scrollToBottom: () => {
                    const textarea = textareaRef.current;
                    if (textarea) {
                        textarea.scrollTop = textarea.scrollHeight;
                    }
                },
                deleteLine: deleteLine,
            },
        };
        model.registerInputRef(inputRefObject);
    }, [model, resizeTextarea, deleteLine]);

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        const isComposing = e.nativeEvent?.isComposing || e.keyCode == 229;
        if (e.key === "Enter" && !e.shiftKey && !isComposing) {
            e.preventDefault();
            onSubmit(e as any);
        }
    };

    const handleFocus = useCallback(() => {
        model.requestWaveAIFocus();
    }, [model]);

    const handleBlur = useCallback(
        (e: React.FocusEvent) => {
            if (e.relatedTarget === null) {
                return;
            }

            if (waveAIHasFocusWithin(e.relatedTarget)) {
                return;
            }

            model.requestNodeFocus();
        },
        [model]
    );

    useEffect(() => {
        resizeTextarea();
    }, [input, resizeTextarea]);

    useEffect(() => {
        if (isPanelOpen) {
            resizeTextarea();
        }
    }, [isPanelOpen, resizeTextarea]);

    const handleUploadClick = () => {
        fileInputRef.current?.click();
    };

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files || []);
        const acceptableFiles = files.filter(isAcceptableFile);

        for (const file of acceptableFiles) {
            const sizeError = validateFileSize(file);
            if (sizeError) {
                model.setError(formatFileSizeError(sizeError));
                if (e.target) {
                    e.target.value = "";
                }
                return;
            }
            await model.addFile(file);
        }

        if (acceptableFiles.length < files.length) {
            console.warn(`${files.length - acceptableFiles.length} files were rejected due to unsupported file types`);
        }

        if (e.target) {
            e.target.value = "";
        }
    };

    return (
        <div className={cn("border-t", isFocused ? "border-accent/50" : "border-gray-600")}>
            <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,.pdf,.txt,.md,.js,.jsx,.ts,.tsx,.go,.py,.java,.c,.cpp,.h,.hpp,.html,.css,.scss,.sass,.json,.xml,.yaml,.yml,.sh,.bat,.sql"
                onChange={handleFileChange}
                className="hidden"
            />
            <form onSubmit={onSubmit}>
                <div className="flex items-stretch">
                    <div className="flex flex-col justify-end gap-0.5 pl-1.5 pb-2 shrink-0">
                        <Tooltip content={everyTimeTooltip} placement="right">
                            <button
                                type="button"
                                onClick={() => model.approveEveryTime()}
                                disabled={!hasPendingApproval}
                                className={cn(
                                    "w-5 h-5 rounded transition-colors flex items-center justify-center",
                                    !hasPendingApproval
                                        ? "text-gray-600 cursor-not-allowed"
                                        : sessionActive
                                          ? "text-accent hover:text-accent/80 cursor-pointer"
                                          : "text-gray-400 hover:text-accent cursor-pointer"
                                )}
                            >
                                <i className="fa fa-rotate-right text-sm"></i>
                            </button>
                        </Tooltip>
                        <Tooltip content={foreverTooltip} placement="right">
                            <button
                                type="button"
                                onClick={() => model.approveForever()}
                                disabled={!hasPendingApproval}
                                className={cn(
                                    "w-5 h-5 rounded transition-colors flex items-center justify-center",
                                    !hasPendingApproval
                                        ? "text-gray-600 cursor-not-allowed"
                                        : foreverActive
                                          ? "text-accent hover:text-accent/80 cursor-pointer"
                                          : "text-gray-400 hover:text-accent cursor-pointer"
                                )}
                            >
                                <i className="fa fa-infinity text-sm"></i>
                            </button>
                        </Tooltip>
                    </div>
                    <div className="relative flex-1 min-w-0">
                        <textarea
                            ref={textareaRef}
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            onKeyDown={handleKeyDown}
                            onFocus={handleFocus}
                            onBlur={handleBlur}
                            placeholder={placeholder}
                            className={cn(
                                "w-full  text-white px-2 py-2 pr-5 focus:outline-none resize-none overflow-auto bg-zinc-800/50"
                            )}
                            style={{ fontSize: "13px" }}
                            rows={2}
                        />
                        <Tooltip content="Attach files" placement="top" divClassName="absolute bottom-6.5 right-1">
                            <button
                                type="button"
                                onClick={handleUploadClick}
                                className={cn(
                                    "w-5 h-5 transition-colors flex items-center justify-center text-gray-400 hover:text-accent cursor-pointer"
                                )}
                            >
                                <i className="fa fa-paperclip text-sm"></i>
                            </button>
                        </Tooltip>
                        {status === "streaming" ? (
                            <Tooltip content="Stop Response" placement="top" divClassName="absolute bottom-1.5 right-1">
                                <button
                                    type="button"
                                    onClick={() => model.stopResponse()}
                                    className={cn(
                                        "w-5 h-5 transition-colors flex items-center justify-center",
                                        "text-green-500 hover:text-green-400 cursor-pointer"
                                    )}
                                >
                                    <i className="fa fa-square text-sm"></i>
                                </button>
                            </Tooltip>
                        ) : (
                            <Tooltip
                                content="Send message (Enter)"
                                placement="top"
                                divClassName="absolute bottom-1.5 right-1"
                            >
                                <button
                                    type="submit"
                                    disabled={status !== "ready" || !input.trim()}
                                    className={cn(
                                        "w-5 h-5 transition-colors flex items-center justify-center",
                                        status !== "ready" || !input.trim()
                                            ? "text-gray-400"
                                            : "text-accent/80 hover:text-accent cursor-pointer"
                                    )}
                                >
                                    <i className="fa fa-paper-plane text-sm"></i>
                                </button>
                            </Tooltip>
                        )}
                    </div>
                </div>
            </form>
        </div>
    );
});

AIPanelInput.displayName = "AIPanelInput";
