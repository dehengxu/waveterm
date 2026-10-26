// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { WaveAIModel } from "@/app/aipanel/waveai-model";
import { FocusManager } from "@/app/store/focusManager";
import {
    atoms,
    createBlock,
    createBlockSplitHorizontally,
    createBlockSplitVertically,
    createTab,
    getAllBlockComponentModels,
    getApi,
    getBlockComponentModel,
    getFocusedBlockId,
    getSettingsKeyAtom,
    globalStore,
    recordTEvent,
    refocusNode,
    replaceBlock,
    WOS,
} from "@/app/store/global";
import { getActiveTabModel } from "@/app/store/tab-model";
import type { TermViewModel } from "@/app/view/term/term-model";
import { WorkspaceLayoutModel } from "@/app/workspace/workspace-layout-model";
import { deleteLayoutModelForTab, getLayoutModelForStaticTab, NavigateDirection } from "@/layout/index";
import * as keyutil from "@/util/keyutil";
import { isWindows } from "@/util/platformutil";
import { CHORD_TIMEOUT } from "@/util/sharedconst";
import { fireAndForget } from "@/util/util";
import * as jotai from "jotai";
import { modalsModel } from "./modalmodel";
import { isBuilderWindow, isTabWindow } from "./windowtype";

type KeyHandler = (event: WaveKeyboardEvent) => boolean;

const simpleControlShiftAtom = jotai.atom(false);
const globalKeyMap = new Map<string, (waveEvent: WaveKeyboardEvent) => boolean>();
const globalChordMap = new Map<string, Map<string, KeyHandler>>();
let globalKeybindingsDisabled = false;

// track current chord state and timeout (for resetting)
let activeChord: string | null = null;
let chordTimeout: NodeJS.Timeout = null;

function resetChord() {
    activeChord = null;
    if (chordTimeout) {
        clearTimeout(chordTimeout);
        chordTimeout = null;
    }
}

function setActiveChord(activeChordArg: string) {
    getApi().setKeyboardChordMode();
    if (chordTimeout) {
        clearTimeout(chordTimeout);
    }
    activeChord = activeChordArg;
    chordTimeout = setTimeout(() => resetChord(), CHORD_TIMEOUT);
}

export function keyboardMouseDownHandler(e: MouseEvent) {
    if (!e.ctrlKey || !e.shiftKey) {
        unsetControlShift();
    }
}

function getFocusedBlockInStaticTab(): string {
    const layoutModel = getLayoutModelForStaticTab();
    const focusedNode = globalStore.get(layoutModel.focusedNode);
    return focusedNode.data?.blockId;
}

function getSimpleControlShiftAtom() {
    return simpleControlShiftAtom;
}

function setControlShift() {
    globalStore.set(simpleControlShiftAtom, true);
    const disableDisplay = globalStore.get(getSettingsKeyAtom("app:disablectrlshiftdisplay"));
    if (!disableDisplay) {
        setTimeout(() => {
            const simpleState = globalStore.get(simpleControlShiftAtom);
            if (simpleState) {
                globalStore.set(atoms.controlShiftDelayAtom, true);
            }
        }, 400);
    }
}

function unsetControlShift() {
    globalStore.set(simpleControlShiftAtom, false);
    globalStore.set(atoms.controlShiftDelayAtom, false);
}

function disableGlobalKeybindings() {
    globalKeybindingsDisabled = true;
}

function enableGlobalKeybindings() {
    globalKeybindingsDisabled = false;
}

function shouldDispatchToBlock(e: WaveKeyboardEvent): boolean {
    if (globalStore.get(atoms.modalOpen)) {
        return false;
    }
    const activeElem = document.activeElement;
    if (activeElem != null && activeElem instanceof HTMLElement) {
        if (activeElem.tagName == "INPUT" || activeElem.tagName == "TEXTAREA" || activeElem.contentEditable == "true") {
            if (activeElem.classList.contains("dummy-focus") || activeElem.classList.contains("dummy")) {
                return true;
            }
            if (keyutil.isInputEvent(e)) {
                return false;
            }
            return true;
        }
    }
    return true;
}

function getStaticTabBlockCount(): number {
    const tabId = globalStore.get(atoms.staticTabId);
    const tabORef = WOS.makeORef("tab", tabId);
    const tabAtom = WOS.getWaveObjectAtom<Tab>(tabORef);
    const tabData = globalStore.get(tabAtom);
    return tabData?.blockids?.length ?? 0;
}

function simpleCloseStaticTab() {
    const workspaceId = globalStore.get(atoms.workspaceId);
    const tabId = globalStore.get(atoms.staticTabId);
    const confirmClose = globalStore.get(getSettingsKeyAtom("tab:confirmclose")) ?? false;
    getApi()
        .closeTab(workspaceId, tabId, confirmClose)
        .then((didClose) => {
            if (didClose) {
                deleteLayoutModelForTab(tabId);
            }
        })
        .catch((e) => {
            console.log("error closing tab", e);
        });
}

// The settings view owns the "discard unsaved changes" question, so ask it
// before we close it. Returns false when the user cancelled the discard.
// Blocks that are not the settings view never prompt.
function confirmDiscardConfigChanges(blockId: string): boolean {
    const viewModel = getBlockComponentModel(blockId)?.viewModel;
    if (viewModel?.viewType != "waveconfig") {
        return true;
    }
    const confirmDiscardChanges = (viewModel as { confirmDiscardChanges?: () => boolean })?.confirmDiscardChanges;
    if (typeof confirmDiscardChanges === "function" && !confirmDiscardChanges.call(viewModel)) {
        return false;
    }
    return true;
}

function uxCloseBlock(blockId: string) {
    if (!confirmDiscardConfigChanges(blockId)) {
        // the user cancelled -- leave the block open
        return;
    }
    const workspaceLayoutModel = WorkspaceLayoutModel.getInstance();
    const isAIPanelOpen = workspaceLayoutModel.getAIPanelVisible();
    if (isAIPanelOpen && getStaticTabBlockCount() === 1) {
        const aiModel = WaveAIModel.getInstance();
        const shouldSwitchToAI = !globalStore.get(aiModel.isChatEmptyAtom) || aiModel.hasNonEmptyInput();
        if (shouldSwitchToAI) {
            replaceBlock(blockId, { meta: { view: "launcher" } }, false);
            setTimeout(() => WaveAIModel.getInstance().focusInput(), 50);
            return;
        }
    }

    const blockAtom = WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId));
    const blockData = globalStore.get(blockAtom);
    const isAIFileDiff = blockData?.meta?.view === "aifilediff";

    // If this is the last block, closing it will close the tab — route through simpleCloseStaticTab
    // so the tab:confirmclose setting is respected.
    if (getStaticTabBlockCount() === 1) {
        simpleCloseStaticTab();
        return;
    }

    const layoutModel = getLayoutModelForStaticTab();
    const node = layoutModel.getNodeByBlockId(blockId);
    if (node) {
        fireAndForget(() => layoutModel.closeNode(node.id));

        if (isAIFileDiff && isAIPanelOpen) {
            setTimeout(() => WaveAIModel.getInstance().focusInput(), 50);
        }
    }
}

function genericClose() {
    const focusType = FocusManager.getInstance().getFocusType();
    if (focusType === "waveai") {
        WorkspaceLayoutModel.getInstance().setAIPanelVisible(false);
        return;
    }

    const workspaceLayoutModel = WorkspaceLayoutModel.getInstance();
    const isAIPanelOpen = workspaceLayoutModel.getAIPanelVisible();
    if (isAIPanelOpen && getStaticTabBlockCount() === 1) {
        const aiModel = WaveAIModel.getInstance();
        const shouldSwitchToAI = !globalStore.get(aiModel.isChatEmptyAtom) || aiModel.hasNonEmptyInput();
        if (shouldSwitchToAI) {
            const layoutModel = getLayoutModelForStaticTab();
            const focusedNode = globalStore.get(layoutModel.focusedNode);
            if (focusedNode) {
                replaceBlock(focusedNode.data.blockId, { meta: { view: "launcher" } }, false);
                setTimeout(() => WaveAIModel.getInstance().focusInput(), 50);
                return;
            }
        }
    }
    const blockCount = getStaticTabBlockCount();
    if (blockCount === 0) {
        simpleCloseStaticTab();
        return;
    }

    // The focused block may be the settings view with unsaved changes -- ask
    // before closing it, same as the close button in its header.
    const focusedLayoutModel = getLayoutModelForStaticTab();
    const focusedBlockId = globalStore.get(focusedLayoutModel.focusedNode)?.data?.blockId;
    if (focusedBlockId != null && !confirmDiscardConfigChanges(focusedBlockId)) {
        return;
    }

    // If this is the last block, closing it will close the tab — route through simpleCloseStaticTab
    // so the tab:confirmclose setting is respected.
    if (blockCount === 1) {
        simpleCloseStaticTab();
        return;
    }

    const layoutModel = getLayoutModelForStaticTab();
    const focusedNode = globalStore.get(layoutModel.focusedNode);
    const blockId = focusedNode?.data?.blockId;
    const blockAtom = blockId ? WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)) : null;
    const blockData = blockAtom ? globalStore.get(blockAtom) : null;
    const isAIFileDiff = blockData?.meta?.view === "aifilediff";

    fireAndForget(layoutModel.closeFocusedNode.bind(layoutModel));

    if (isAIFileDiff && isAIPanelOpen) {
        setTimeout(() => WaveAIModel.getInstance().focusInput(), 50);
    }
}

function switchBlockByBlockNum(index: number) {
    const layoutModel = getLayoutModelForStaticTab();
    if (!layoutModel) {
        return;
    }
    layoutModel.switchNodeFocusByBlockNum(index);
    setTimeout(() => {
        globalRefocus();
    }, 10);
}

function switchBlockInDirection(direction: NavigateDirection) {
    const layoutModel = getLayoutModelForStaticTab();
    const focusType = FocusManager.getInstance().getFocusType();

    if (direction === NavigateDirection.Left) {
        const numBlocks = globalStore.get(layoutModel.numLeafs);
        if (focusType === "waveai") {
            return;
        }
        if (numBlocks === 1) {
            FocusManager.getInstance().requestWaveAIFocus();
            setTimeout(() => {
                FocusManager.getInstance().refocusNode();
            }, 10);
            return;
        }
    }

    if (direction === NavigateDirection.Right && focusType === "waveai") {
        FocusManager.getInstance().requestNodeFocus();
        return;
    }

    const inWaveAI = focusType === "waveai";
    const navResult = layoutModel.switchNodeFocusInDirection(direction, inWaveAI);
    if (navResult.atLeft) {
        FocusManager.getInstance().requestWaveAIFocus();
        setTimeout(() => {
            FocusManager.getInstance().refocusNode();
        }, 10);
        return;
    }
    setTimeout(() => {
        globalRefocus();
    }, 10);
}

function getAllTabs(ws: Workspace): string[] {
    return ws.tabids ?? [];
}

function switchTabAbs(index: number) {
    console.log("switchTabAbs", index);
    const ws = globalStore.get(atoms.workspace);
    const newTabIdx = index - 1;
    const tabids = getAllTabs(ws);
    if (newTabIdx < 0 || newTabIdx >= tabids.length) {
        return;
    }
    const newActiveTabId = tabids[newTabIdx];
    getApi().setActiveTab(newActiveTabId);
}

function switchTab(offset: number) {
    console.log("switchTab", offset);
    const ws = globalStore.get(atoms.workspace);
    const curTabId = globalStore.get(atoms.staticTabId);
    let tabIdx = -1;
    const tabids = getAllTabs(ws);
    for (let i = 0; i < tabids.length; i++) {
        if (tabids[i] == curTabId) {
            tabIdx = i;
            break;
        }
    }
    if (tabIdx == -1) {
        return;
    }
    const newTabIdx = (tabIdx + offset + tabids.length) % tabids.length;
    const newActiveTabId = tabids[newTabIdx];
    getApi().setActiveTab(newActiveTabId);
}

function handleCmdI() {
    globalRefocus();
}

function globalRefocusWithTimeout(timeoutVal: number) {
    setTimeout(() => {
        globalRefocus();
    }, timeoutVal);
}

function globalRefocus() {
    if (isBuilderWindow()) {
        return;
    }

    const layoutModel = getLayoutModelForStaticTab();
    const focusedNode = globalStore.get(layoutModel.focusedNode);
    if (focusedNode == null) {
        // focus a node
        layoutModel.focusFirstNode();
        return;
    }
    const blockId = focusedNode?.data?.blockId;
    if (blockId == null) {
        return;
    }
    refocusNode(blockId);
}

function getDefaultNewBlockDef(): BlockDef {
    const adnbAtom = getSettingsKeyAtom("app:defaultnewblock");
    const adnb = globalStore.get(adnbAtom) ?? "term";
    if (adnb == "launcher") {
        return {
            meta: {
                view: "launcher",
            },
        };
    }
    // "term", blank, anything else, fall back to terminal
    const termBlockDef: BlockDef = {
        meta: {
            view: "term",
            controller: "shell",
        },
    };
    const layoutModel = getLayoutModelForStaticTab();
    const focusedNode = globalStore.get(layoutModel.focusedNode);
    if (focusedNode != null) {
        const blockAtom = WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", focusedNode.data?.blockId));
        const blockData = globalStore.get(blockAtom);
        if (blockData?.meta?.view == "term") {
            if (blockData?.meta?.["cmd:cwd"] != null) {
                termBlockDef.meta["cmd:cwd"] = blockData.meta["cmd:cwd"];
            }
        }
        if (blockData?.meta?.connection != null) {
            termBlockDef.meta.connection = blockData.meta.connection;
        }
    }
    return termBlockDef;
}

async function handleCmdN() {
    const blockDef = getDefaultNewBlockDef();
    await createBlock(blockDef);
}

async function handleSplitHorizontal(position: "before" | "after") {
    const layoutModel = getLayoutModelForStaticTab();
    const focusedNode = globalStore.get(layoutModel.focusedNode);
    if (focusedNode == null) {
        return;
    }
    const blockDef = getDefaultNewBlockDef();
    await createBlockSplitHorizontally(blockDef, focusedNode.data.blockId, position);
}

async function handleSplitVertical(position: "before" | "after") {
    const layoutModel = getLayoutModelForStaticTab();
    const focusedNode = globalStore.get(layoutModel.focusedNode);
    if (focusedNode == null) {
        return;
    }
    const blockDef = getDefaultNewBlockDef();
    await createBlockSplitVertically(blockDef, focusedNode.data.blockId, position);
}

let lastHandledEvent: KeyboardEvent | null = null;

// returns [keymatch, T]
function checkKeyMap<T>(waveEvent: WaveKeyboardEvent, keyMap: Map<string, T>): [string, T] {
    for (const key of keyMap.keys()) {
        if (keyutil.checkKeyPressed(waveEvent, key)) {
            const val = keyMap.get(key);
            return [key, val];
        }
    }
    return [null, null];
}

function appHandleKeyDown(waveEvent: WaveKeyboardEvent): boolean {
    if (globalKeybindingsDisabled) {
        return false;
    }
    const nativeEvent = (waveEvent as any).nativeEvent;
    if (lastHandledEvent != null && nativeEvent != null && lastHandledEvent === nativeEvent) {
        return false;
    }
    lastHandledEvent = nativeEvent;
    if (activeChord) {
        console.log("handle activeChord", activeChord);
        // If we're in chord mode, look for the second key.
        const chordBindings = globalChordMap.get(activeChord);
        if (chordBindings == null) {
            // the chord was rebound while it was active
            resetChord();
            return true;
        }
        const [, handler] = checkKeyMap(waveEvent, chordBindings);
        if (handler) {
            resetChord();
            return handler(waveEvent);
        } else {
            // invalid chord; reset state and consume key
            resetChord();
            return true;
        }
    }
    const [chordKeyMatch] = checkKeyMap(waveEvent, globalChordMap);
    if (chordKeyMatch) {
        setActiveChord(chordKeyMatch);
        return true;
    }

    const [, globalHandler] = checkKeyMap(waveEvent, globalKeyMap);
    if (globalHandler) {
        const handled = globalHandler(waveEvent);
        if (handled) {
            return true;
        }
    }
    if (isTabWindow()) {
        const layoutModel = getLayoutModelForStaticTab();
        const focusedNode = globalStore.get(layoutModel.focusedNode);
        const blockId = focusedNode?.data?.blockId;
        if (blockId != null && shouldDispatchToBlock(waveEvent)) {
            const bcm = getBlockComponentModel(blockId);
            const viewModel = bcm?.viewModel;
            if (viewModel?.keyDownHandler) {
                const handledByBlock = viewModel.keyDownHandler(waveEvent);
                if (handledByBlock) {
                    return true;
                }
            }
        }
    }
    return false;
}

function registerControlShiftStateUpdateHandler() {
    getApi().onControlShiftStateUpdate((state: boolean) => {
        if (state) {
            setControlShift();
        } else {
            unsetControlShift();
        }
    });
}

function registerElectronReinjectKeyHandler() {
    getApi().onReinjectKey((event: WaveKeyboardEvent) => {
        appHandleKeyDown(event);
    });
}

// Opens the Wave settings view (the "waveconfig" block) in the current tab.
async function openSettingsBlock() {
    await createBlock({ meta: { view: "waveconfig" } }, false, true);
}

// Handles actions that originate in the main process, either from a
// system-wide global hotkey or from the "Settings…" menu item.
export function registerGlobalHotkeyActionHandler() {
    getApi().onOpenSettings(() => {
        fireAndForget(() => openSettingsBlock());
    });
    getApi().onGlobalHotkeyAction((actionId: string) => {
        switch (actionId) {
            case "ai.focus": {
                FocusManager.getInstance().requestWaveAIFocus();
                setTimeout(() => {
                    FocusManager.getInstance().refocusNode();
                }, 10);
                return;
            }
            case "ai.toggle": {
                const layoutModel = WorkspaceLayoutModel.getInstance();
                layoutModel.setAIPanelVisible(!layoutModel.getAIPanelVisible());
                return;
            }
            case "term.focus": {
                globalRefocus();
                return;
            }
            default:
                console.log("unhandled global hotkey action", actionId);
                return;
        }
    });
}

function tryReinjectKey(event: WaveKeyboardEvent): boolean {
    return appHandleKeyDown(event);
}

function countTermBlocks(): number {
    const allBCMs = getAllBlockComponentModels();
    let count = 0;
    const gsGetBound = globalStore.get.bind(globalStore);
    for (const bcm of allBCMs) {
        const viewModel = bcm.viewModel;
        if (viewModel.viewType == "term" && viewModel.isBasicTerm?.(gsGetBound)) {
            count++;
        }
    }
    return count;
}

// ── Command registry ────────────────────────────────────────────────
//
// Every function shortcut is described by a CommandDef so that it can be
// rebound from the Keybindings settings page. The defaults live in code, the
// user overrides live in the "functions" section of keybindings.json and
// only store the difference, so commands added upstream never invalidate an
// existing user config.

type CommandGroup = "tabs" | "layout" | "navigation" | "search" | "ai" | "terminal" | "misc";

const CommandGroupLabels: Record<CommandGroup, string> = {
    tabs: "标签页",
    layout: "布局与块",
    navigation: "焦点导航",
    search: "搜索",
    ai: "Wave AI",
    terminal: "终端",
    misc: "其他",
};

type CommandDef = {
    id: string;
    group: CommandGroup;
    label: string;
    // built-in bindings -- a user override replaces all of them
    defaultKeys: string[];
    handler?: KeyHandler;
    // true for the prefix of a chord (e.g. "Ctrl:Shift:s")
    chordPrefix?: boolean;
    // set on the second-level keys of a chord
    chordSubKey?: string;
    // the chord prefix command this command belongs to
    chordId?: string;
    // fixed commands are dispatched by the app menu and cannot be rebound
    fixed?: boolean;
};

type FunctionBindings = {
    // command id -> effective keys (empty when the command is disabled)
    commandKeys: Map<string, string[]>;
    // key -> command id
    keyOwners: Map<string, string>;
    // command id -> the command whose key it took over
    conflicts: Map<string, string>;
    // command ids that this build does not know about
    unknownCommands: string[];
};

function makeMagnifyHandler(): KeyHandler {
    return () => {
        const layoutModel = getLayoutModelForStaticTab();
        const focusedNode = globalStore.get(layoutModel.focusedNode);
        if (focusedNode != null) {
            const ephemeralNode = globalStore.get(layoutModel.ephemeralNode);
            if (ephemeralNode?.id === focusedNode.id) {
                layoutModel.addEphemeralNodeToLayout();
            } else {
                layoutModel.magnifyNodeToggle(focusedNode.id);
            }
        }
        return true;
    };
}

function makeArrowNavHandler(direction: NavigateDirection): KeyHandler {
    return () => {
        const disableCtrlShiftArrows = globalStore.get(getSettingsKeyAtom("app:disablectrlshiftarrows"));
        if (disableCtrlShiftArrows) {
            return false;
        }
        switchBlockInDirection(direction);
        return true;
    };
}

function makeReplaceWithLauncherHandler(): KeyHandler {
    return () => {
        const blockId = getFocusedBlockId();
        if (blockId == null) {
            return true;
        }
        replaceBlock(
            blockId,
            {
                meta: {
                    view: "launcher",
                },
            },
            true
        );
        return true;
    };
}

function makeRenameTabHandler(): KeyHandler {
    return () => {
        const tabModel = getActiveTabModel();
        if (tabModel?.startRenameCallback != null) {
            tabModel.startRenameCallback();
            return true;
        }
        return false;
    };
}

function makeSwitchConnectionHandler(): KeyHandler {
    return () => {
        const bcm = getBlockComponentModel(getFocusedBlockInStaticTab());
        if (bcm.openSwitchConnection != null) {
            recordTEvent("action:other", { "action:type": "conndropdown", "action:initiator": "keyboard" });
            bcm.openSwitchConnection();
            return true;
        }
    };
}

function makeToggleTermMultiInputHandler(): KeyHandler {
    return () => {
        const tabModel = getActiveTabModel();
        if (tabModel == null) {
            return true;
        }
        const curMI = globalStore.get(tabModel.isTermMultiInput);
        if (!curMI && countTermBlocks() <= 1) {
            // don't turn on multi-input unless there are 2 or more basic term blocks
            return true;
        }
        globalStore.set(tabModel.isTermMultiInput, !curMI);
        return true;
    };
}

function makeSwitchTabAbsHandler(index: number): KeyHandler {
    return () => {
        switchTabAbs(index);
        return true;
    };
}

function makeSwitchBlockByNumHandler(index: number): KeyHandler {
    return () => {
        switchBlockByBlockNum(index);
        return true;
    };
}

function makeFocusAiInputHandler(): KeyHandler {
    return () => {
        WaveAIModel.getInstance().focusInput();
        return true;
    };
}

// The AI focus shortcut is Ctrl+Shift+0 on macOS/Linux and Alt+0 on Windows.
function getAiFocusDefaultKeys(): string[] {
    if (isWindows()) {
        return ["Alt:c{Digit0}", "Alt:c{Numpad0}"];
    }
    return ["Ctrl:Shift:c{Digit0}", "Ctrl:Shift:c{Numpad0}"];
}

function makeToggleAiPanelHandler(): KeyHandler {
    return () => {
        const currentVisible = WorkspaceLayoutModel.getInstance().getAIPanelVisible();
        WorkspaceLayoutModel.getInstance().setAIPanelVisible(!currentVisible);
        return true;
    };
}

// Deletes the whole line the caret is on. The AI panel input owns its
// text (it goes through the model atom), a terminal block gets the
// readline "kill line" sequence instead.
function makeDeleteLineHandler(): KeyHandler {
    return () => {
        if (WaveAIModel.getInstance().deleteInputLine()) {
            return true;
        }
        const blockId = getFocusedBlockInStaticTab();
        if (blockId == null) {
            return false;
        }
        const bcm = getBlockComponentModel(blockId);
        const viewModel = bcm?.viewModel;
        if (viewModel?.viewType != "term") {
            return false;
        }
        const termModel = viewModel as TermViewModel;
        const termElem = termModel.termRef?.current?.connectElem;
        const activeElem = document.activeElement;
        if (termElem == null || activeElem == null || !termElem.contains(activeElem)) {
            // the terminal does not hold the focus (the user may be typing
            // in a block's search field) -- leave the key alone
            return false;
        }
        // Ctrl+U kills back to the start of the line, Ctrl+K kills forward
        // to the end of it -- together they remove the whole line.
        termModel.sendDataToController("\x15\x0b");
        return true;
    };
}

function makeSplitBlockHandler(axis: "horizontal" | "vertical", position: "before" | "after"): KeyHandler {
    return () => {
        if (axis === "vertical") {
            handleSplitVertical(position);
        } else {
            handleSplitHorizontal(position);
        }
        return true;
    };
}

function activateSearch(event: WaveKeyboardEvent): boolean {
    const bcm = getBlockComponentModel(getFocusedBlockInStaticTab());
    // Ctrl+f is reserved in most shells
    if (event.control && bcm.viewModel.viewType == "term") {
        return false;
    }
    if (bcm.viewModel.searchAtoms) {
        if (globalStore.get(bcm.viewModel.searchAtoms.isOpen)) {
            // Already open — increment the focusInput counter so this block's
            // SearchComponent focuses its own input (avoids a global DOM query
            // that could target the wrong block when multiple searches are open).
            const cur = globalStore.get(bcm.viewModel.searchAtoms.focusInput) as number;
            globalStore.set(bcm.viewModel.searchAtoms.focusInput, cur + 1);
        } else {
            globalStore.set(bcm.viewModel.searchAtoms.isOpen, true);
        }
        return true;
    }
    return false;
}

function deactivateSearch(): boolean {
    const bcm = getBlockComponentModel(getFocusedBlockInStaticTab());
    if (bcm.viewModel.searchAtoms && globalStore.get(bcm.viewModel.searchAtoms.isOpen)) {
        globalStore.set(bcm.viewModel.searchAtoms.isOpen, false);
        return true;
    }
    return false;
}

// Closes the settings view when it is the focused block. The settings view
// owns the "discard unsaved changes" question, so we ask it before closing.
// The visual tab of the settings view saves immediately, so it never has
// pending changes and never prompts.
function closeFocusedConfigBlock(): boolean {
    const layoutModel = getLayoutModelForStaticTab();
    const focusedNode = globalStore.get(layoutModel.focusedNode);
    const blockId = focusedNode?.data?.blockId;
    if (blockId == null) {
        return false;
    }
    const viewModel = getBlockComponentModel(blockId)?.viewModel;
    if (viewModel?.viewType != "waveconfig") {
        return false;
    }
    if (!confirmDiscardConfigChanges(blockId)) {
        // the user cancelled -- swallow the key so nothing else reacts to it
        return true;
    }
    if (getStaticTabBlockCount() <= 1) {
        // the settings view is the only block in the tab, close the tab
        simpleCloseStaticTab();
    } else {
        const node = layoutModel.getNodeByBlockId(blockId);
        if (node) {
            fireAndForget(() => layoutModel.closeNode(node.id));
        }
    }
    return true;
}

function makeEscapeHandler(): KeyHandler {
    return () => {
        if (modalsModel.hasOpenModals()) {
            modalsModel.popModal();
            return true;
        }
        if (deactivateSearch()) {
            return true;
        }
        return closeFocusedConfigBlock();
    };
}

let commandDefsCache: CommandDef[] = null;

// The registry is built lazily because one of the default bindings depends
// on the platform, which is only known once the window is initialized.
function getCommandDefs(): CommandDef[] {
    if (commandDefsCache != null) {
        return commandDefsCache;
    }
    const chordId = "wave.block.split.chord";
    const defs: CommandDef[] = [
        // ── tabs ──
        {
            id: "wave.tab.next",
            group: "tabs",
            label: "切换到下一个标签页",
            defaultKeys: ["Cmd:]", "Shift:Cmd:]"],
            handler: () => {
                switchTab(1);
                return true;
            },
        },
        {
            id: "wave.tab.prev",
            group: "tabs",
            label: "切换到上一个标签页",
            defaultKeys: ["Cmd:[", "Shift:Cmd:["],
            handler: () => {
                switchTab(-1);
                return true;
            },
        },
        {
            id: "wave.tab.new",
            group: "tabs",
            label: "新建标签页",
            defaultKeys: ["Cmd:t"],
            handler: () => {
                createTab();
                return true;
            },
        },
        {
            id: "wave.tab.close",
            group: "tabs",
            label: "关闭当前标签页",
            defaultKeys: ["Cmd:Shift:w"],
            handler: () => {
                simpleCloseStaticTab();
                return true;
            },
        },
        {
            id: "wave.tab.rename",
            group: "tabs",
            label: "重命名当前标签页",
            defaultKeys: ["F2"],
            handler: makeRenameTabHandler(),
        },
        // ── layout ──
        {
            id: "wave.block.new",
            group: "layout",
            label: "新建块",
            defaultKeys: ["Cmd:n"],
            handler: () => {
                handleCmdN();
                return true;
            },
        },
        {
            id: "wave.block.split.right",
            group: "layout",
            label: "在右侧分割块",
            defaultKeys: ["Cmd:d"],
            handler: () => {
                handleSplitHorizontal("after");
                return true;
            },
        },
        {
            id: "wave.block.split.bottom",
            group: "layout",
            label: "在下方分割块",
            defaultKeys: ["Shift:Cmd:d"],
            handler: () => {
                handleSplitVertical("after");
                return true;
            },
        },
        {
            id: "wave.block.magnify",
            group: "layout",
            label: "放大 / 还原当前块",
            defaultKeys: ["Cmd:m"],
            handler: makeMagnifyHandler(),
        },
        {
            id: "wave.block.replace.launcher",
            group: "layout",
            label: "用启动器替换当前块",
            defaultKeys: ["Ctrl:Shift:x"],
            handler: makeReplaceWithLauncherHandler(),
        },
        {
            id: chordId,
            group: "layout",
            label: "分割块组合键前缀",
            defaultKeys: ["Ctrl:Shift:s"],
            chordPrefix: true,
        },
        {
            id: "wave.block.split.up",
            group: "layout",
            label: "在上方分割块",
            defaultKeys: [],
            chordId: chordId,
            chordSubKey: "ArrowUp",
            handler: makeSplitBlockHandler("vertical", "before"),
        },
        {
            id: "wave.block.split.down",
            group: "layout",
            label: "在下方分割块",
            defaultKeys: [],
            chordId: chordId,
            chordSubKey: "ArrowDown",
            handler: makeSplitBlockHandler("vertical", "after"),
        },
        {
            id: "wave.block.split.left",
            group: "layout",
            label: "在左侧分割块",
            defaultKeys: [],
            chordId: chordId,
            chordSubKey: "ArrowLeft",
            handler: makeSplitBlockHandler("horizontal", "before"),
        },
        {
            id: "wave.block.split.right.chord",
            group: "layout",
            label: "在右侧分割块",
            defaultKeys: [],
            chordId: chordId,
            chordSubKey: "ArrowRight",
            handler: makeSplitBlockHandler("horizontal", "after"),
        },
        // ── navigation ──
        {
            id: "wave.focus.up",
            group: "navigation",
            label: "焦点移到上方的块",
            defaultKeys: ["Ctrl:Shift:ArrowUp"],
            handler: makeArrowNavHandler(NavigateDirection.Up),
        },
        {
            id: "wave.focus.down",
            group: "navigation",
            label: "焦点移到下方的块",
            defaultKeys: ["Ctrl:Shift:ArrowDown"],
            handler: makeArrowNavHandler(NavigateDirection.Down),
        },
        {
            id: "wave.focus.left",
            group: "navigation",
            label: "焦点移到左侧的块",
            defaultKeys: ["Ctrl:Shift:ArrowLeft"],
            handler: makeArrowNavHandler(NavigateDirection.Left),
        },
        {
            id: "wave.focus.right",
            group: "navigation",
            label: "焦点移到右侧的块",
            defaultKeys: ["Ctrl:Shift:ArrowRight"],
            handler: makeArrowNavHandler(NavigateDirection.Right),
        },
        {
            id: "wave.focus.left.vim",
            group: "navigation",
            label: "焦点移到左侧的块（vim 风格）",
            defaultKeys: ["Ctrl:Shift:h"],
            handler: makeArrowNavHandler(NavigateDirection.Left),
        },
        {
            id: "wave.focus.down.vim",
            group: "navigation",
            label: "焦点移到下方的块（vim 风格）",
            defaultKeys: ["Ctrl:Shift:j"],
            handler: makeArrowNavHandler(NavigateDirection.Down),
        },
        {
            id: "wave.focus.up.vim",
            group: "navigation",
            label: "焦点移到上方的块（vim 风格）",
            defaultKeys: ["Ctrl:Shift:k"],
            handler: makeArrowNavHandler(NavigateDirection.Up),
        },
        {
            id: "wave.focus.right.vim",
            group: "navigation",
            label: "焦点移到右侧的块（vim 风格）",
            defaultKeys: ["Ctrl:Shift:l"],
            handler: makeArrowNavHandler(NavigateDirection.Right),
        },
        // ── search ──
        {
            id: "wave.search.toggle",
            group: "search",
            label: "打开块内搜索",
            defaultKeys: ["Cmd:f"],
            handler: activateSearch,
        },
        {
            id: "wave.escape",
            group: "search",
            label: "关闭弹窗 / 退出搜索",
            defaultKeys: ["Escape"],
            handler: makeEscapeHandler(),
        },
        // ── ai ──
        {
            id: "wave.ai.panel.toggle",
            group: "ai",
            label: "显示 / 隐藏 AI 面板",
            defaultKeys: ["Cmd:Shift:a"],
            handler: makeToggleAiPanelHandler(),
        },
        {
            id: "wave.ai.focus",
            group: "ai",
            label: "聚焦 AI 输入框",
            defaultKeys: getAiFocusDefaultKeys(),
            handler: makeFocusAiInputHandler(),
        },
        // ── terminal ──
        {
            id: "wave.term.focus",
            group: "terminal",
            label: "聚焦当前块的输入",
            defaultKeys: ["Cmd:i"],
            handler: () => {
                handleCmdI();
                return true;
            },
        },
        {
            id: "wave.term.multiinput",
            group: "terminal",
            label: "切换终端多输入模式",
            defaultKeys: ["Ctrl:Shift:i"],
            handler: makeToggleTermMultiInputHandler(),
        },
        // ── misc ──
        {
            id: "wave.edit.delete.line",
            group: "misc",
            label: "删除当前整行",
            defaultKeys: ["Cmd:Backspace"],
            handler: makeDeleteLineHandler(),
        },
        {
            id: "wave.close",
            group: "misc",
            label: "关闭当前块（最后一个块时关闭标签页）",
            defaultKeys: ["Cmd:w"],
            handler: () => {
                genericClose();
                return true;
            },
        },
        {
            id: "wave.conn.switch",
            group: "misc",
            label: "打开连接切换器",
            defaultKeys: ["Cmd:g"],
            handler: makeSwitchConnectionHandler(),
        },
        {
            id: "wave.settings.open",
            group: "misc",
            label: "打开设置",
            defaultKeys: ["Cmd:,"],
            // handled by the Electron app menu accelerator, not by the keymap
            fixed: true,
        },
    ];
    for (let idx = 1; idx <= 9; idx++) {
        defs.push({
            id: `wave.tab.switch.${idx}`,
            group: "tabs",
            label: `切换到第 ${idx} 个标签页`,
            defaultKeys: [`Cmd:${idx}`],
            handler: makeSwitchTabAbsHandler(idx),
        });
        defs.push({
            id: `wave.block.switch.${idx}`,
            group: "navigation",
            label: `切换到第 ${idx} 个块`,
            defaultKeys: [`Ctrl:Shift:c{Digit${idx}}`, `Ctrl:Shift:c{Numpad${idx}}`],
            handler: makeSwitchBlockByNumHandler(idx),
        });
    }
    commandDefsCache = defs;
    return defs;
}

// Resolves the effective keybinding for every command: the built-in
// defaults, overridden by the user's "functions" section. An empty
// override disables the command.
function computeFunctionBindings(overrides: Record<string, string>): FunctionBindings {
    const defs = getCommandDefs();
    const defById = new Map<string, CommandDef>();
    for (const def of defs) {
        defById.set(def.id, def);
    }
    const commandKeys = new Map<string, string[]>();
    const keyOwners = new Map<string, string>();
    const conflicts = new Map<string, string>();
    const unknownCommands: string[] = [];

    for (const def of defs) {
        if (def.chordSubKey) {
            // only reachable through its chord prefix
            commandKeys.set(def.id, []);
            continue;
        }
        const keys = [...def.defaultKeys];
        for (const key of keys) {
            if (!keyOwners.has(key)) {
                keyOwners.set(key, def.id);
            }
        }
        commandKeys.set(def.id, keys);
    }

    for (const [commandId, rawKey] of Object.entries(overrides ?? {})) {
        const def = defById.get(commandId);
        if (def == null) {
            unknownCommands.push(commandId);
            continue;
        }
        if (def.fixed || def.chordSubKey) {
            // not rebindable
            continue;
        }
        const key = (rawKey ?? "").trim();
        if (key !== "") {
            const reservedOwner = keyOwners.get(key);
            if (reservedOwner != null && defById.get(reservedOwner)?.fixed) {
                // reserved by an app menu accelerator -- ignore the override
                continue;
            }
        }
        // release the keys this command used to own
        for (const oldKey of commandKeys.get(commandId) ?? []) {
            if (keyOwners.get(oldKey) === commandId) {
                keyOwners.delete(oldKey);
            }
        }
        if (key === "") {
            // an empty value disables the command
            commandKeys.set(commandId, []);
            continue;
        }
        const prevOwner = keyOwners.get(key);
        if (prevOwner != null && prevOwner !== commandId) {
            // the user override wins, the displaced command loses its binding
            conflicts.set(commandId, prevOwner);
            commandKeys.set(
                prevOwner,
                (commandKeys.get(prevOwner) ?? []).filter((k) => k !== key)
            );
        }
        keyOwners.set(key, commandId);
        commandKeys.set(commandId, [key]);
    }
    return { commandKeys, keyOwners, conflicts, unknownCommands };
}

function buildEffectiveKeyMaps(overrides: Record<string, string>): {
    keyMap: Map<string, KeyHandler>;
    chordMap: Map<string, Map<string, KeyHandler>>;
} {
    const defs = getCommandDefs();
    const defById = new Map<string, CommandDef>();
    for (const def of defs) {
        defById.set(def.id, def);
    }
    const bindings = computeFunctionBindings(overrides);
    const keyMap = new Map<string, KeyHandler>();
    for (const [key, commandId] of bindings.keyOwners) {
        const def = defById.get(commandId);
        if (def == null || def.fixed || def.chordPrefix) {
            continue;
        }
        if (def.handler) {
            keyMap.set(key, def.handler);
        }
    }
    const chordMap = new Map<string, Map<string, KeyHandler>>();
    for (const def of defs) {
        if (!def.chordPrefix) {
            continue;
        }
        for (const prefix of bindings.commandKeys.get(def.id) ?? []) {
            const subs = new Map<string, KeyHandler>();
            for (const subDef of defs) {
                if (subDef.chordId !== def.id || subDef.chordSubKey == null || subDef.handler == null) {
                    continue;
                }
                subs.set(subDef.chordSubKey, subDef.handler);
            }
            chordMap.set(prefix, subs);
        }
    }
    return { keyMap, chordMap };
}

function getFunctionOverrides(): Record<string, string> {
    const fullConfig = globalStore.get(atoms.fullConfigAtom);
    return fullConfig?.keybindings?.functions ?? {};
}

function makeFunctionOverridesSignature(overrides: Record<string, string>): string {
    const entries = Object.entries(overrides ?? {}).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return JSON.stringify(entries);
}

// Rebuilds the keymap from the current command registry plus the user's
// overrides, then re-registers the webview keys so that the main process
// intercepts exactly the keys that are currently bound.
function applyFunctionKeybindings(overrides?: Record<string, string>) {
    const ov = overrides ?? getFunctionOverrides();
    const { keyMap, chordMap } = buildEffectiveKeyMaps(ov);
    globalKeyMap.clear();
    for (const [key, handler] of keyMap) {
        globalKeyMap.set(key, handler);
    }
    globalChordMap.clear();
    for (const [prefix, subs] of chordMap) {
        globalChordMap.set(prefix, subs);
    }
    const allKeys = Array.from(globalKeyMap.keys());
    // special case keys, handled by web view
    allKeys.push("Cmd:l", "Cmd:r", "Cmd:ArrowRight", "Cmd:ArrowLeft", "Cmd:o");
    getApi().registerGlobalWebviewKeys(allKeys);
}

let functionKeybindingsUnsubFn: (() => void) | null = null;
let lastFunctionOverridesSig = "";

function registerGlobalKeys() {
    // build (and cache) the registry before the first apply
    getCommandDefs();
    const overrides = getFunctionOverrides();
    lastFunctionOverridesSig = makeFunctionOverridesSignature(overrides);
    applyFunctionKeybindings(overrides);
    // the user config can change at runtime (the settings page writes
    // keybindings.json), so rebuild the keymap whenever the config changes
    functionKeybindingsUnsubFn?.();
    functionKeybindingsUnsubFn = globalStore.sub(atoms.fullConfigAtom, () => {
        const nextOverrides = getFunctionOverrides();
        const sig = makeFunctionOverridesSignature(nextOverrides);
        if (sig === lastFunctionOverridesSig) {
            return;
        }
        lastFunctionOverridesSig = sig;
        applyFunctionKeybindings(nextOverrides);
    });
}

function registerBuilderGlobalKeys() {
    globalKeyMap.set("Cmd:w", () => {
        getApi().closeBuilderWindow();
        return true;
    });
    const allKeys = Array.from(globalKeyMap.keys());
    getApi().registerGlobalWebviewKeys(allKeys);
}

function getAllGlobalKeyBindings(): string[] {
    const allKeys = Array.from(globalKeyMap.keys());
    return allKeys;
}

export {
    appHandleKeyDown,
    CommandGroupLabels,
    computeFunctionBindings,
    disableGlobalKeybindings,
    enableGlobalKeybindings,
    getCommandDefs,
    getSimpleControlShiftAtom,
    globalRefocus,
    globalRefocusWithTimeout,
    registerBuilderGlobalKeys,
    registerControlShiftStateUpdateHandler,
    registerElectronReinjectKeyHandler,
    registerGlobalKeys,
    tryReinjectKey,
    unsetControlShift,
    uxCloseBlock,
};
export type { CommandDef, CommandGroup, FunctionBindings };
