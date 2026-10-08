import { Buffer } from "node:buffer";
import { decodePrintableKey } from "pi-session-host-tui/dist/keys.js";
import { MAX_RENAME_NAME_BYTES } from "./protocol";
import {
  CombinedAutocompleteProvider,
  CURSOR_MARKER,
  Editor,
  getKeybindings,
  matchesKey,
  parseKey,
  setKeybindings,
  sliceByColumn,
  TuiMainScreen,
  TUI_KEYBINDINGS,
  visibleWidth,
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  type EditorTheme,
  type KeybindingsManager,
  type Terminal,
} from "pi-session-host-tui";

const DEFAULT_NAME_MAX_BYTES = MAX_RENAME_NAME_BYTES;
const PATH_MAX_CODE_POINTS = 2048;
const MAX_PASTE_BYTES = 8192;
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const ABSOLUTE_PREFIX_MASK = "\u0000";
const MAX_FIELD_DIMENSION = 1000;
const CLEAR_ACTION = "app.clear";
const TUI_COPY_ACTION = "tui.input.copy";
const SUBMIT_ACTION = "tui.input.submit";
const CANCEL_ACTION = "tui.select.cancel";
const EXTERNAL_EDITOR_ACTION = "app.editor.external";

type FieldKind = "name" | "path";
type ForcedNativeAction = "tui.select.confirm" | "tui.select.cancel" | "tui.editor.undo" | "tui.editor.cursorLineStart" | "tui.editor.cursorRight";

/** The live public pi-tui keybinding manager supplied by the native host. */
export interface SessionHostFieldKeybindings {
  matches(data: string, keybinding: string): boolean;
  getDefinition?(keybinding: string): unknown;
}

export interface SessionHostFieldSubmission {
  /** Safe value for the caller. For a completed path this is the provider's actual path, not its quoted insertion syntax. */
  readonly value: string;
  /** Exact expanded text shown/stored by the native Editor. Never shell-evaluated or normalized. */
  readonly text: string;
  /** `native-completion` is provenance from a successful native provider application. */
  readonly source: "typed" | "native-completion";
}

export type SessionHostFieldRejection =
  | "unsafe-text"
  | "text-limit"
  | "paste-limit"
  | "input-chunk-limit"
  | "completion-limit"
  | "external-editor-failed";

interface CommonFieldOptions {
  readonly kind: FieldKind;
  readonly initialText?: string;
  /** Live manager from the host, including the user's active keybindings. */
  readonly keybindings?: SessionHostFieldKeybindings;
  /** App-level action IDs may be overridden by the native host. */
  readonly actionBindings?: {
    readonly clear?: string;
    readonly submit?: string;
    readonly cancel?: string;
    readonly externalEditor?: string;
  };
  readonly onChange?: (text: string) => void;
  /** Called when async native editor/provider work requests a host redraw. */
  readonly onInvalidate?: () => void;
  readonly onSubmit?: (submission: SessionHostFieldSubmission) => void;
  readonly onCancel?: () => void;
  readonly onClear?: () => void;
  /** The host owns external-editor process execution; returned text is safely applied via Editor.setText. */
  readonly onExternalEditor?: (text: string) => string | undefined | Promise<string | undefined>;
  readonly onReject?: (reason: SessionHostFieldRejection) => void;
}

export type SessionHostFieldOptions = CommonFieldOptions & (
  | {
    readonly kind: "name";
    readonly workspaceBasePath?: never;
    /** Optional tighter 1..1024 UTF-8-byte limit; defaults to the persisted rename limit. */
    readonly maxNameBytes?: number;
  }
  | { readonly kind: "path"; readonly workspaceBasePath: string; readonly maxNameBytes?: never }
);

export interface SessionHostFieldRender {
  /** Sanitized, single-line-safe text rows clipped and padded to `cols`. */
  readonly lines: string[];
  /** Zero-based cursor position. It is hidden if the native marker is outside the bounded frame. */
  readonly cursor: { readonly column: number; readonly row: number; readonly visible: boolean };
}

/**
 * The real public TUI implementation used by Editor, with only its public
 * requestRender seam delegated to the session host. Its public Terminal port
 * has no process streams and write() is a counted no-op; Main remains the only
 * real terminal owner and frame writer.
 */
export class SessionHostFieldTUI extends TuiMainScreen {
  private invalidateHost?: () => void;
  private closed = false;

  constructor(private readonly port: FieldTerminalPort, invalidateHost: () => void) {
    // TuiMainScreen is the public implementation of the public TUI interface.
    // This port is local to the field; no ProcessTerminal is constructed or started.
    super(port, false);
    this.invalidateHost = invalidateHost;
  }

  requestRender(_force?: boolean): void {
    if (this.closed) return;
    try {
      this.invalidateHost?.();
    } catch {
      // Host redraw scheduling must not escape through native editor input.
    }
  }

  resize(cols: number, rows: number): void {
    this.port.resize(cols, rows);
  }

  get terminalWriteAttempts(): number {
    return this.port.writeAttempts;
  }

  close(): void {
    this.closed = true;
    this.invalidateHost = undefined;
  }
}

/**
 * Reusable text-field adapter backed by the pinned public pi-tui Editor. The
 * wrapper adds field limits, single-line paste/control safety and app actions;
 * all cursor, word, kill/yank, undo, grapheme, paste, and completion editing
 * remains in Editor itself.
 */
export class SessionHostTextField {
  readonly tui: SessionHostFieldTUI;
  /** The actual public Editor instance; callers should prefer this field's bounded methods. */
  readonly editor: Editor;
  /** The actual native path provider (absent for name fields). */
  readonly nativeAutocompleteProvider?: CombinedAutocompleteProvider;
  /** The public provider seam installed on Editor (decorated only for absolute-path routing). */
  readonly autocompleteProvider?: AutocompleteProvider;
  readonly workspaceBasePath?: string;

  private readonly options: SessionHostFieldOptions;
  private readonly actionBindings: Required<NonNullable<SessionHostFieldOptions["actionBindings"]>>;
  private readonly liveKeybindings?: SessionHostFieldKeybindings;
  private readonly restoreKeybindings?: () => void;
  private readonly maxNameBytes: number;
  private acceptedText = "";
  private acceptedStoredText = "";
  private acceptedCursor = { line: 0, col: 0 };
  private suppressNativeChange = false;
  private settled = false;
  private disposed = false;
  private pasteStartCarry = "";
  private pasteEndCarry = "";
  private pasteParts: string[] | undefined;
  private pasteBytes = 0;
  private pasteOverflow = false;
  private pendingCompletion?: CompletionProvenance;
  private activeCompletion?: CompletionProvenance;
  private lastAutocompleteMaxVisible = -1;
  private revision = 0;
  private nativeJumpTargetPending = false;

  constructor(options: SessionHostFieldOptions) {
    const requestedNameLimit = options.kind === "name" ? options.maxNameBytes : undefined;
    this.maxNameBytes = requestedNameLimit === undefined ? DEFAULT_NAME_MAX_BYTES : requestedNameLimit;
    if (!Number.isSafeInteger(this.maxNameBytes) || this.maxNameBytes < 1 || this.maxNameBytes > DEFAULT_NAME_MAX_BYTES) {
      throw new Error(`Session host field maxNameBytes must be an integer between 1 and ${DEFAULT_NAME_MAX_BYTES}`);
    }

    const initialText = options.initialText ?? "";
    const safeInitial = sanitizeSingleLine(initialText);
    if (safeInitial !== initialText) {
      throw new Error("Session host field initial text must be safe single-line text");
    }
    if (!this.isWithinLimit(options.kind, initialText)) {
      throw new Error(`Session host field initial text exceeds its ${options.kind} limit`);
    }
    if (options.kind === "path") {
      const safeBase = sanitizeSingleLine(options.workspaceBasePath);
      if (safeBase !== options.workspaceBasePath || options.workspaceBasePath.length === 0
        || codePointLength(options.workspaceBasePath) > PATH_MAX_CODE_POINTS) {
        throw new Error("Session host field workspaceBasePath must be safe, bounded, single-line text");
      }
      this.workspaceBasePath = options.workspaceBasePath;
    }

    this.options = options;
    this.actionBindings = {
      clear: options.actionBindings?.clear ?? CLEAR_ACTION,
      submit: options.actionBindings?.submit ?? SUBMIT_ACTION,
      cancel: options.actionBindings?.cancel ?? CANCEL_ACTION,
      externalEditor: options.actionBindings?.externalEditor ?? EXTERNAL_EDITOR_ACTION,
    };
    this.liveKeybindings = options.keybindings ?? getKeybindings();
    this.restoreKeybindings = options.keybindings === undefined
      ? undefined
      : installLiveKeybindings(options.keybindings);

    const port = new FieldTerminalPort();
    this.tui = new SessionHostFieldTUI(port, () => {
      if (!this.disposed && !this.settled) options.onInvalidate?.();
    });
    try {
      this.editor = new Editor(this.tui, IDENTITY_EDITOR_THEME);
      this.editor.focused = true;
      this.editor.disableSubmit = true;
      this.editor.onChange = (text) => this.handleNativeChange(text);
      this.suppressNativeChange = true;
      this.editor.setText(initialText);
      this.suppressNativeChange = false;
      this.acceptedText = this.expandedEditorText();
      this.acceptedStoredText = this.editor.getText();
      this.acceptedCursor = this.editor.getCursor();

      if (options.kind === "path") {
        const provider = new CombinedAutocompleteProvider([], options.workspaceBasePath, null);
        this.nativeAutocompleteProvider = provider;
        this.autocompleteProvider = decorateAbsolutePathProvider(provider, (surfaceText, pathValue) => {
          if (sanitizeSingleLine(pathValue) === pathValue) {
            this.pendingCompletion = { surfaceText, pathValue };
          }
        });
        this.editor.setAutocompleteProvider(this.autocompleteProvider);
      }
    } catch (error) {
      this.suppressNativeChange = false;
      this.tui.close();
      this.restoreKeybindings?.();
      throw error;
    }
  }

  /** Exact safe text, with native paste markers expanded. Never trims or shell-decodes typed text. */
  getText(): string {
    return this.expandedEditorText();
  }

  /**
   * Value for submit/backend validation. Typed paths pass through unchanged;
   * only an unchanged, accepted native completion carries decoded-path provenance.
   */
  getValue(): string {
    const text = this.editor.getText();
    if (this.options.kind === "path") {
      const completion = this.completionFor(text);
      if (completion) return completion.pathValue;
    }
    return this.expandedEditorText();
  }

  getCursor(): ReturnType<Editor["getCursor"]> {
    return this.editor.getCursor();
  }

  isShowingAutocomplete(): boolean {
    return this.editor.isShowingAutocomplete();
  }

  /** Replace the complete field value through the public native Editor API. Over-limit input is rejected, never truncated. */
  setText(text: string): boolean {
    if (this.disposed || this.settled || typeof text !== "string") return false;
    const safe = sanitizeSingleLine(text);
    if (safe !== text) {
      this.reject("unsafe-text");
      return false;
    }
    if (!this.isWithinLimit(this.options.kind, text)) {
      this.reject("text-limit");
      return false;
    }
    const changed = this.expandedEditorText() !== text;
    this.suppressNativeChange = true;
    try {
      this.editor.setText(text);
    } finally {
      this.suppressNativeChange = false;
    }
    this.acceptedText = text;
    this.acceptedStoredText = this.editor.getText();
    this.acceptedCursor = this.editor.getCursor();
    this.pendingCompletion = undefined;
    this.activeCompletion = undefined;
    if (changed) {
      this.revision += 1;
      this.safeCallback(() => this.options.onChange?.(text));
    }
    this.invalidate();
    return true;
  }

  /** Route one key/paste packet to the real Editor, with app-level actions handled explicitly. */
  handleInput(data: string): void {
    if (this.disposed || this.settled || typeof data !== "string" || data.length === 0) return;
    if (this.pasteParts !== undefined) {
      this.consumePaste(data);
      return;
    }
    this.feedOutsidePaste(data);
  }

  /** Explicit host invalidation; the TUI never writes to the terminal. */
  invalidate(): void {
    if (this.disposed || this.settled) return;
    this.editor.invalidate();
    this.tui.requestRender();
  }

  /** Bounded native render. CURSOR_MARKER is converted to a cursor DTO and never returned in pane text. */
  render(cols: number, rows: number): SessionHostFieldRender {
    validateDimension(cols, "cols");
    validateDimension(rows, "rows");
    this.tui.resize(cols, rows);
    // Editor clamps this public setting to at least three; the frame is still clipped to the host rows below.
    const maxVisible = Math.max(3, Math.min(20, rows - 1));
    if (maxVisible !== this.lastAutocompleteMaxVisible) {
      this.editor.setAutocompleteMaxVisible(maxVisible);
      this.lastAutocompleteMaxVisible = maxVisible;
    }

    const rendered = this.editor.render(cols);
    const lines: string[] = [];
    let cursor: SessionHostFieldRender["cursor"] = { column: 0, row: 0, visible: false };
    for (let row = 0; row < rendered.length && row < rows; row += 1) {
      const source = rendered[row] ?? "";
      const markerIndex = source.indexOf(CURSOR_MARKER);
      if (markerIndex >= 0 && !cursor.visible) {
        const beforeMarker = sanitizeSingleLine(source.slice(0, markerIndex));
        cursor = {
          column: Math.min(Math.max(visibleWidth(beforeMarker), 0), cols - 1),
          row,
          visible: true,
        };
      }
      const withoutMarker = source.split(CURSOR_MARKER).join("");
      const safe = sanitizeSingleLine(withoutMarker);
      const clipped = sliceByColumn(safe, 0, cols, true);
      const used = Math.min(visibleWidth(clipped), cols);
      lines.push(clipped + " ".repeat(cols - used));
    }
    return { lines, cursor };
  }

  /** Release host redraw and keybinding ownership; no TUI or terminal stop/start is performed. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelNativeAutocomplete();
    this.pasteParts = undefined;
    this.pasteStartCarry = "";
    this.pasteEndCarry = "";
    this.pendingCompletion = undefined;
    this.activeCompletion = undefined;
    this.tui.close();
    this.restoreKeybindings?.();
  }

  private feedOutsidePaste(data: string): void {
    if (this.pasteStartCarry.length === 0 && this.matchesAction(data, this.actionBindings.clear, TUI_COPY_ACTION)) {
      this.setText("");
      this.safeCallback(() => this.options.onClear?.());
      return;
    }

    if (this.pasteStartCarry.length === 0 && this.matchesAction(data, this.actionBindings.externalEditor)) {
      this.openExternalEditor();
      return;
    }

    if (this.pasteStartCarry.length === 0 && this.matchesAction(data, this.actionBindings.cancel)) {
      if (this.editor.isShowingAutocomplete()) {
        this.forwardToEditor(data, "tui.select.cancel"); // Native first Escape dismisses the list.
      } else {
        this.settled = true;
        this.cancelNativeAutocomplete();
        this.resetPasteState();
        this.safeCallback(() => this.options.onCancel?.());
      }
      return;
    }

    if (this.pasteStartCarry.length === 0 && this.matchesAction(data, this.actionBindings.submit)) {
      if (this.editor.isShowingAutocomplete()) {
        this.forwardToEditor(data, "tui.select.confirm"); // Native Enter/action accepts the highlighted completion.
      } else {
        this.submit();
      }
      return;
    }

    const combined = this.pasteStartCarry + data;
    this.pasteStartCarry = "";
    const startIndex = combined.indexOf(BRACKETED_PASTE_START);
    if (startIndex >= 0) {
      const prefix = combined.slice(0, startIndex);
      if (prefix.length > 0) this.forwardToEditor(prefix);
      this.beginPaste();
      this.consumePaste(combined.slice(startIndex + BRACKETED_PASTE_START.length));
      return;
    }
    const carryLength = markerPrefixSuffixLength(combined, BRACKETED_PASTE_START);
    const ordinary = combined.slice(0, combined.length - carryLength);
    this.pasteStartCarry = combined.slice(combined.length - carryLength);
    if (ordinary.length > 0) this.forwardToEditor(ordinary);
  }

  private beginPaste(): void {
    this.pasteParts = [];
    this.pasteBytes = 0;
    this.pasteOverflow = false;
    this.pasteEndCarry = "";
    this.pendingCompletion = undefined;
  }

  private consumePaste(data: string): void {
    const combined = this.pasteEndCarry + data;
    const endIndex = combined.indexOf(BRACKETED_PASTE_END);
    const body = endIndex >= 0 ? combined.slice(0, endIndex) : combined;
    const carryLength = endIndex >= 0 ? 0 : markerPrefixSuffixLength(body, BRACKETED_PASTE_END);
    this.appendPasteBytes(body.slice(0, body.length - carryLength));
    this.pasteEndCarry = endIndex >= 0 ? "" : body.slice(body.length - carryLength);
    if (endIndex < 0) return;

    const remainder = combined.slice(endIndex + BRACKETED_PASTE_END.length);
    if (this.pasteOverflow) {
      this.reject("paste-limit");
    } else {
      const safePaste = sanitizeSingleLine((this.pasteParts ?? []).join(""));
      if (this.preflightInsertion(safePaste)) {
        this.forwardToEditor(`${BRACKETED_PASTE_START}${safePaste}${BRACKETED_PASTE_END}`);
      }
    }
    this.resetPasteState();
    if (remainder.length > 0) this.feedOutsidePaste(remainder);
  }

  private appendPasteBytes(text: string): void {
    if (this.pasteOverflow || text.length === 0 || this.pasteParts === undefined) return;
    for (const character of text) {
      const bytes = Buffer.byteLength(character, "utf8");
      if (this.pasteBytes + bytes > MAX_PASTE_BYTES) {
        this.pasteOverflow = true;
        this.pasteParts = [];
        return;
      }
      this.pasteParts.push(character);
      this.pasteBytes += bytes;
    }
  }

  private resetPasteState(): void {
    this.pasteParts = undefined;
    this.pasteBytes = 0;
    this.pasteOverflow = false;
    this.pasteEndCarry = "";
    this.pasteStartCarry = "";
  }

  private forwardToEditor(data: string, forceNativeAction?: ForcedNativeAction): void {
    if (data.length === 0) return;
    if (!data.includes(BRACKETED_PASTE_START) && Buffer.byteLength(data, "utf8") > MAX_PASTE_BYTES) {
      this.reject("input-chunk-limit");
      return;
    }
    if (forceNativeAction === undefined && !data.includes(BRACKETED_PASTE_START) && !this.preflightInput(data)) return;
    const previousStoredText = this.editor.getText();
    this.advanceNativeJumpState(data, forceNativeAction);
    if (forceNativeAction) this.handleEditorInputAs(data, forceNativeAction);
    else this.editor.handleInput(data);
    this.reconcileEditorChange(previousStoredText);
    if (this.editor.getText() === this.acceptedStoredText && this.expandedEditorText() === this.acceptedText) {
      this.acceptedCursor = this.editor.getCursor();
    }
    this.tui.requestRender();
  }

  private reconcileEditorChange(previousStoredText: string): void {
    const storedText = this.editor.getText();
    if (storedText === previousStoredText && storedText === this.acceptedStoredText) return;
    this.handleNativeChange(storedText);
  }

  private advanceNativeJumpState(data: string, forced?: ForcedNativeAction): void {
    if (this.nativeJumpTargetPending) {
      this.nativeJumpTargetPending = false;
      return;
    }
    if (forced !== undefined || data.includes(BRACKETED_PASTE_START)) return;
    const manager = this.liveKeybindings ?? this.safeGetKeybindings();
    if (!manager) return;
    const matches = (binding: string): boolean => this.safeMatch(manager, data, binding);
    if (!matches("tui.editor.jumpForward") && !matches("tui.editor.jumpBackward")) return;

    // Editor checks these public bindings before it enters character-jump mode.
    const earlier = [
      "tui.input.copy", "tui.editor.undo", "tui.input.tab",
      "tui.editor.deleteToLineEnd", "tui.editor.deleteToLineStart",
      "tui.editor.deleteWordBackward", "tui.editor.deleteWordForward",
      "tui.editor.deleteCharBackward", "tui.editor.deleteCharForward",
      "tui.editor.yank", "tui.editor.yankPop",
      "tui.editor.historyPrevious", "tui.editor.historyNext",
      "tui.editor.cursorLineStart", "tui.editor.cursorLineEnd",
      "tui.editor.cursorWordLeft", "tui.editor.cursorWordRight",
      "tui.input.newLine", "tui.input.submit",
      "tui.editor.cursorUp", "tui.editor.cursorDown",
      "tui.editor.cursorRight", "tui.editor.cursorLeft",
      "tui.editor.pageUp", "tui.editor.pageDown",
    ];
    if (earlier.some(matches)
      || matchesKey(data, "shift+backspace")
      || matchesKey(data, "shift+delete")) return;
    if (this.editor.isShowingAutocomplete() && [
      "tui.select.cancel", "tui.select.up", "tui.select.down", "tui.select.confirm",
    ].some(matches)) return;
    this.nativeJumpTargetPending = true;
  }

  private preflightInput(data: string): boolean {
    if (data.includes("\n") || data.includes("\r")) {
      this.reject("unsafe-text");
      return false;
    }

    if (this.matchesNativeEditorAction(data)) return true;

    const decoded = decodePrintableKey(data);
    if (this.nativeJumpTargetPending && (
      (decoded !== undefined && sanitizeSingleLine(decoded) === decoded)
      || sanitizeSingleLine(data) === data
    )) return true;
    if (decoded !== undefined) return this.preflightInsertion(decoded);
    if (matchesKey(data, "shift+space")) return this.preflightInsertion(" ");

    const parsed = parseKey(data);
    const safe = sanitizeSingleLine(data);
    if (safe !== data) {
      if (parsed === undefined) {
        this.reject("unsafe-text");
        return false;
      }
      if (parsed.startsWith("shift+")) return this.preflightInsertion(parsed.slice("shift+".length));
      return true;
    }

    const codePoint = data.codePointAt(0);
    if (codePoint === undefined || codePoint < 0x20 || codePoint === 0x7f) {
      this.reject("unsafe-text");
      return false;
    }
    return this.preflightInsertion(data);
  }

  private preflightInsertion(insertion: string): boolean {
    if (this.isWithinLimit(this.options.kind, this.acceptedText + insertion)) return true;
    this.reject("text-limit");
    return false;
  }

  private matchesNativeEditorAction(data: string): boolean {
    const manager = this.liveKeybindings ?? this.safeGetKeybindings();
    if (manager && Object.keys(TUI_KEYBINDINGS).some((binding) => this.safeMatch(manager, data, binding))) return true;
    return matchesKey(data, "shift+backspace") || matchesKey(data, "shift+delete");
  }

  private handleEditorInputAs(data: string, action: ForcedNativeAction): void {
    this.nativeJumpTargetPending = false;
    let current: KeybindingsManager;
    try {
      current = getKeybindings();
    } catch {
      this.editor.handleInput(data);
      return;
    }
    const bridge = new Proxy(current, {
      get(target, property) {
        if (property === "matches") {
          return (input: string, keybinding: string) => input === data
            ? keybinding === action
            : target.matches(input, keybinding as never);
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    try {
      setKeybindings(bridge);
    } catch {
      this.editor.handleInput(data);
      return;
    }
    try {
      this.editor.handleInput(data);
    } finally {
      try {
        if (getKeybindings() === bridge) setKeybindings(current);
      } catch {
        // Do not overwrite a newer manager installed by the host during a callback.
      }
    }
  }

  private cancelNativeAutocomplete(): void {
    if (!this.autocompleteProvider) return;
    try {
      // Public setter cancels pending requests and clears the native completion UI.
      this.editor.setAutocompleteProvider(this.autocompleteProvider);
    } catch {
      // Cancellation remains fail-closed at the field lifetime boundary.
    }
  }

  private handleNativeChange(_storedText: string): void {
    if (this.suppressNativeChange || this.disposed || this.settled) return;
    const expanded = this.expandedEditorText();
    const safe = sanitizeSingleLine(expanded);
    if (safe !== expanded) {
      this.reject("unsafe-text");
      this.restoreAcceptedText();
      return;
    }

    const storedText = this.editor.getText();
    const pending = this.pendingCompletion;
    const isPendingCompletion = pending !== undefined && pending.surfaceText === storedText;
    const completionValue = isPendingCompletion ? pending.pathValue : undefined;
    if (completionValue !== undefined && !this.isWithinLimit(this.options.kind, completionValue)) {
      this.pendingCompletion = undefined;
      this.reject("completion-limit");
      this.restoreAcceptedText();
      return;
    }
    if (!this.isWithinLimit(this.options.kind, safe)) {
      this.pendingCompletion = undefined;
      this.reject("text-limit");
      this.restoreAcceptedText();
      return;
    }

    if (isPendingCompletion && completionValue !== undefined) {
      this.activeCompletion = { surfaceText: storedText, pathValue: completionValue };
      this.pendingCompletion = undefined;
    } else if (safe !== this.acceptedText || storedText !== this.acceptedStoredText) {
      this.activeCompletion = undefined;
      this.pendingCompletion = undefined;
    }
    if (safe === this.acceptedText && storedText === this.acceptedStoredText) {
      this.acceptedCursor = this.editor.getCursor();
      return;
    }
    this.acceptedText = safe;
    this.acceptedStoredText = storedText;
    this.acceptedCursor = this.editor.getCursor();
    this.revision += 1;
    this.safeCallback(() => this.options.onChange?.(safe));
  }

  private restoreAcceptedText(): void {
    this.pendingCompletion = undefined;
    this.suppressNativeChange = true;
    try {
      // Revert the just-rejected native transaction first; this consumes its undo snapshot.
      this.handleEditorInputAs("\x1f", "tui.editor.undo");
    } finally {
      this.suppressNativeChange = false;
    }

    if (this.expandedEditorText() === this.acceptedText) {
      this.acceptedStoredText = this.editor.getText();
      this.acceptedCursor = this.editor.getCursor();
      this.invalidate();
      return;
    }

    // A fallback setter is safe only after Undo removed the rejected state and left valid text.
    const currentText = this.expandedEditorText();
    if (sanitizeSingleLine(currentText) === currentText && this.isWithinLimit(this.options.kind, currentText)) {
      this.suppressNativeChange = true;
      try {
        this.editor.setText(this.acceptedText);
        this.acceptedStoredText = this.editor.getText();
        this.restoreAcceptedCursor();
        this.acceptedCursor = this.editor.getCursor();
      } finally {
        this.suppressNativeChange = false;
      }
    } else {
      // No public Editor API can safely overwrite an unsafe state without another undo snapshot.
      this.settled = true;
      this.cancelNativeAutocomplete();
    }
    this.invalidate();
  }

  private restoreAcceptedCursor(): void {
    const targetCol = Math.min(this.acceptedCursor.col, this.editor.getText().length);
    this.handleEditorInputAs("\x01", "tui.editor.cursorLineStart");
    for (let count = 0; this.editor.getCursor().col < targetCol && count <= targetCol; count += 1) {
      const before = this.editor.getCursor().col;
      this.handleEditorInputAs("\x1b[C", "tui.editor.cursorRight");
      if (this.editor.getCursor().col <= before) break;
    }
  }

  private submit(): void {
    const text = this.expandedEditorText();
    const completion = this.options.kind === "path" ? this.completionFor(this.editor.getText()) : undefined;
    this.settled = true;
    this.cancelNativeAutocomplete();
    this.resetPasteState();
    this.safeCallback(() => this.options.onSubmit?.({
      text,
      value: completion?.pathValue ?? text,
      source: completion ? "native-completion" : "typed",
    }));
  }

  private openExternalEditor(): void {
    const handler = this.options.onExternalEditor;
    if (!handler) return;
    const text = this.expandedEditorText();
    const startingRevision = this.revision;
    let result: string | undefined | Promise<string | undefined>;
    try {
      result = handler(text);
    } catch {
      this.reject("external-editor-failed");
      return;
    }
    void Promise.resolve(result).then((replacement) => {
      if (typeof replacement === "string" && !this.disposed && !this.settled && this.revision === startingRevision) {
        this.setText(replacement);
      }
    }).catch(() => this.reject("external-editor-failed"));
  }

  private completionFor(storedText: string): CompletionProvenance | undefined {
    if (this.activeCompletion?.surfaceText === storedText) return this.activeCompletion;
    if (this.pendingCompletion?.surfaceText === storedText) return this.pendingCompletion;
    return undefined;
  }

  private matchesAction(data: string, binding: string, fallbackBinding?: string): boolean {
    const manager = this.liveKeybindings ?? this.safeGetKeybindings();
    if (manager) {
      if (this.actionIsDefined(manager, binding)) return this.safeMatch(manager, data, binding);
      if (fallbackBinding && this.actionIsDefined(manager, fallbackBinding)) {
        return this.safeMatch(manager, data, fallbackBinding);
      }
      // Host-only actions such as external-editor may not exist in pi-tui's base key table.
      if (binding === this.actionBindings.externalEditor) return matchesKey(data, "ctrl+g");
      if (binding === this.actionBindings.clear && fallbackBinding === TUI_COPY_ACTION) {
        return this.safeMatch(manager, data, fallbackBinding);
      }
      if (binding === this.actionBindings.submit) return matchesKey(data, "enter");
      if (binding === this.actionBindings.cancel) return matchesKey(data, "escape");
      return false;
    }
    if (binding === this.actionBindings.submit) return matchesKey(data, "enter");
    if (binding === this.actionBindings.cancel) return matchesKey(data, "escape");
    if (binding === this.actionBindings.externalEditor) return matchesKey(data, "ctrl+g");
    if (binding === this.actionBindings.clear) return matchesKey(data, "ctrl+c");
    return false;
  }

  private actionIsDefined(manager: SessionHostFieldKeybindings, binding: string): boolean {
    if (typeof manager.getDefinition !== "function") return true;
    try {
      return manager.getDefinition(binding) !== undefined;
    } catch {
      return false;
    }
  }

  private safeMatch(manager: SessionHostFieldKeybindings, data: string, binding: string): boolean {
    try {
      return Boolean(manager.matches(data, binding));
    } catch {
      return false;
    }
  }

  private safeGetKeybindings(): SessionHostFieldKeybindings | undefined {
    try {
      return getKeybindings();
    } catch {
      return undefined;
    }
  }

  private expandedEditorText(): string {
    return this.editor.getExpandedText();
  }

  private isWithinLimit(kind: FieldKind, value: string): boolean {
    return kind === "name"
      ? Buffer.byteLength(value, "utf8") <= this.maxNameBytes
      : codePointLength(value) <= PATH_MAX_CODE_POINTS;
  }

  private reject(reason: SessionHostFieldRejection): void {
    this.safeCallback(() => this.options.onReject?.(reason));
  }

  private safeCallback(callback: () => void): void {
    try {
      callback();
    } catch {
      // UI callbacks cannot interrupt native editor input/rendering.
    }
  }
}

/** Construct one bounded field backed by the actual pinned pi-tui Editor. */
export function createSessionHostTextField(options: SessionHostFieldOptions): SessionHostTextField {
  return new SessionHostTextField(options);
}

interface CompletionProvenance {
  readonly surfaceText: string;
  readonly pathValue: string;
}

interface CompletionApplication {
  readonly surfaceText: string;
  readonly pathValue: string;
}

interface NativeSuggestionContext {
  readonly lines: string;
  readonly cursorLine: number;
  readonly cursorCol: number;
  readonly prefix: string;
  readonly application?: CompletionApplication;
}

function decorateAbsolutePathProvider(
  provider: CombinedAutocompleteProvider,
  onApplied: (surfaceText: string, pathValue: string) => void,
): AutocompleteProvider {
  const base = provider as AutocompleteProvider;
  const nativeSuggestionContext = new WeakMap<AutocompleteItem, NativeSuggestionContext>();
  return {
    get triggerCharacters() {
      return base.triggerCharacters;
    },
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const windows = windowsAbsolutePathContext(lines, cursorLine, cursorCol);
      if (windows) {
        return windowsAbsoluteSuggestions(base, lines, cursorLine, cursorCol, windows, nativeSuggestionContext, options);
      }
      const forceFileBranch = isAbsolutePathContext(lines, cursorLine, cursorCol);
      const suggestions = await base.getSuggestions(lines, cursorLine, cursorCol, forceFileBranch
        ? { ...options, force: true }
        : options);
      if (!suggestions) return suggestions;
      const result = forceFileBranch
        ? {
          ...suggestions,
          // A same-width neutral prefix keeps Editor.applyCompletion on its file-path branch.
          prefix: suggestions.prefix.startsWith("/")
            ? `${ABSOLUTE_PREFIX_MASK}${suggestions.prefix.slice(1)}`
            : suggestions.prefix,
        }
        : suggestions;
      const acceptedItems: AutocompleteItem[] = [];
      for (const item of result.items) {
        const application = nativeCompletionApplication(base, lines, cursorLine, cursorCol, item, result.prefix);
        if (application && (sanitizeSingleLine(application.pathValue) !== application.pathValue
          || sanitizeSingleLine(application.surfaceText) !== application.surfaceText
          || codePointLength(application.pathValue) > PATH_MAX_CODE_POINTS
          || codePointLength(application.surfaceText) > PATH_MAX_CODE_POINTS)) {
          continue;
        }
        nativeSuggestionContext.set(item, {
          lines: lines.join("\n"),
          cursorLine,
          cursorCol,
          prefix: result.prefix,
          ...(application ? { application } : {}),
        });
        acceptedItems.push(item);
      }
      return { ...result, items: acceptedItems };
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      const result = base.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      const context = nativeSuggestionContext.get(item);
      if (context?.lines === lines.join("\n")
        && context.cursorLine === cursorLine
        && context.cursorCol === cursorCol
        && context.prefix === prefix
        && context.application?.surfaceText === result.lines.join("\n")) {
        onApplied(context.application.surfaceText, context.application.pathValue);
      }
      return result;
    },
    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      if (isAbsolutePathContext(lines, cursorLine, cursorCol)) return true;
      if (windowsAbsolutePathContext(lines, cursorLine, cursorCol)) return true;
      return base.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}

function nativeCompletionApplication(
  provider: AutocompleteProvider,
  lines: string[],
  cursorLine: number,
  cursorCol: number,
  item: AutocompleteItem,
  prefix: string,
): CompletionApplication | undefined {
  if (item.value.startsWith("@")) return undefined;
  const pathInsertion = pathValueFromNativeCompletion(item);
  if (pathInsertion === undefined) return undefined;

  const result = provider.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
  if (result.cursorLine !== cursorLine) return undefined;
  const currentLine = lines[cursorLine] ?? "";
  const beforePrefixLength = cursorCol - prefix.length;
  if (beforePrefixLength < 0) return undefined;
  const beforePrefix = currentLine.slice(0, beforePrefixLength);
  const afterCursor = currentLine.slice(cursorCol);
  const isQuotedPrefix = prefix.startsWith('"') || prefix.startsWith('@"');
  const adjustedSuffix = isQuotedPrefix && item.value.endsWith('"') && afterCursor.startsWith('"')
    ? afterCursor.slice(1)
    : afterCursor;
  const appliedLine = result.lines[cursorLine] ?? "";
  const insertedStart = beforePrefix.length;
  const insertedEnd = appliedLine.length - adjustedSuffix.length;
  if (insertedEnd < insertedStart
    || appliedLine.slice(0, insertedStart) !== beforePrefix
    || appliedLine.slice(insertedEnd) !== adjustedSuffix) {
    return undefined;
  }
  const insertedSurface = appliedLine.slice(insertedStart, insertedEnd);
  if (insertedSurface !== item.value) return undefined;
  const valueLine = `${beforePrefix}${pathInsertion}${adjustedSuffix}`;
  const valueLines = [...result.lines];
  valueLines[cursorLine] = valueLine;
  return { surfaceText: result.lines.join("\n"), pathValue: valueLines.join("\n") };
}

function isAbsolutePathContext(lines: string[], cursorLine: number, cursorCol: number): boolean {
  if (cursorLine !== 0) return false;
  return (lines[0] ?? "").slice(0, cursorCol).trimStart().startsWith("/");
}

/** Parsed parts of a complete Windows absolute path (drive-letter or UNC). */
export interface WindowsAbsolutePathParts {
  /** The intended directory, including its trailing separator. */
  readonly dirPart: string;
  /** The relative basename query after the last separator (may be empty). */
  readonly query: string;
}

/**
 * Parse a complete Windows absolute path into its intended directory and
 * relative basename query. Drive-letter paths require a separator immediately
 * after the colon (`C:\foo` or `C:/foo`); drive-relative forms such as `C:foo`
 * are not absolute and return undefined. Complete UNC paths start with two
 * separators and require nonempty server and share components (`\\server\share`, `//server/share`).
 */
export function parseWindowsAbsolutePath(token: string): WindowsAbsolutePathParts | undefined {
  const trimmed = token.trimStart();
  // Recognize the provider's generated outer quote context (a single opening
  // double quote with no closing quote yet) so continuing an already quoted
  // completion stays on the Windows absolute route. Manually submitted values
  // that carry a closing quote are left untouched.
  const inner = trimmed.startsWith('"') && !trimmed.endsWith('"') ? trimmed.slice(1) : trimmed;
  if (!isDriveLetterAbsolute(inner) && !isUncAbsolute(inner)) return undefined;
  // A complete bare share root (\\server\share or //server/share) scopes the
  // provider to that share directory with an empty basename query, rather than
  // splitting into a server directory plus a share-name query.
  if (isUncAbsolute(inner) && inner.slice(2).split(/[\\/]/).length === 2) {
    return { dirPart: inner + inner[0], query: "" };
  }
  let lastSeparator = -1;
  for (let index = inner.length - 1; index >= 0; index -= 1) {
    if (inner[index] === "\\" || inner[index] === "/") {
      lastSeparator = index;
      break;
    }
  }
  if (lastSeparator < 0) return undefined;
  return { dirPart: inner.slice(0, lastSeparator + 1), query: inner.slice(lastSeparator + 1) };
}

function isDriveLetterAbsolute(token: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(token);
}

function isUncAbsolute(token: string): boolean {
  if (!token.startsWith("\\\\") && !token.startsWith("//")) return false;
  const [server, share] = token.slice(2).split(/[\\/]/);
  return Boolean(server && share);
}

/** The complete Windows absolute path at the current cursor, if any. */
function windowsAbsolutePathContext(
  lines: string[],
  cursorLine: number,
  cursorCol: number,
): (WindowsAbsolutePathParts & { readonly token: string }) | undefined {
  // Windows absolute routing is only active on Windows hosts; on POSIX the
  // double-leading-slash prefix is a valid relative/absolute path form and
  // must keep its own provider behavior.
  if (process.platform !== "win32" || cursorLine !== 0) return undefined;
  const token = (lines[0] ?? "").slice(0, cursorCol).trimStart();
  const parts = parseWindowsAbsolutePath(token);
  return parts ? { ...parts, token } : undefined;
}

/** A native completion value needs the provider's generated outer quote pair when it contains whitespace. */
function needsShellQuotes(path: string): boolean {
  return /\s/.test(path);
}

/**
 * Route a complete Windows absolute path to the pinned public provider scoped
 * to its actual intended directory, with a relative basename query, and map
 * the provider's real suggestions back to absolute workspace insertion.
 */
async function windowsAbsoluteSuggestions(
  base: AutocompleteProvider,
  lines: string[],
  cursorLine: number,
  cursorCol: number,
  windows: WindowsAbsolutePathParts & { readonly token: string },
  nativeSuggestionContext: WeakMap<AutocompleteItem, NativeSuggestionContext>,
  options: { signal: AbortSignal; force?: boolean },
): Promise<AutocompleteSuggestions | null> {
  const scoped = new CombinedAutocompleteProvider([], windows.dirPart, null);
  // Represent the complete basename through the provider's public quoted-path
  // syntax so native token delimiters (spaces) inside the basename do not
  // truncate the query. The provider strips its own generated quote.
  const queryLine = `"./${windows.query}`;
  const suggestions = await scoped.getSuggestions([queryLine], 0, queryLine.length, {
    signal: options.signal,
    force: true,
  });
  if (!suggestions || suggestions.items.length === 0) return null;
  // Preserve the provider's native directory label marker (trailing "/") so
  // applyCompletion classifies directories correctly and positions the cursor
  // inside a quoted directory for nested editing. The absolute value uses the
  // provider's forward-slash display convention (matching toDisplayPath) plus
  // the native label suffix, which also lets pathValueFromNativeCompletion
  // prove the generated quote pair.
  const dirPartDisplay = windows.dirPart.replace(/\\/g, "/");
  // Editor treats every slash-prefixed suggestion as a command on Enter,
  // even complete //server/share paths. Reuse the same-width neutral mask
  // used for POSIX absolute paths; it is never inserted into field text.
  const prefix = windows.token.startsWith("/")
    ? `${ABSOLUTE_PREFIX_MASK}${windows.token.slice(1)}`
    : windows.token;
  const items: AutocompleteItem[] = [];
  for (const item of suggestions.items) {
    const absoluteRaw = dirPartDisplay + item.label;
    const value = needsShellQuotes(absoluteRaw) ? `"${absoluteRaw}"` : absoluteRaw;
    const mapped: AutocompleteItem = { ...item, value };
    const application = nativeCompletionApplication(base, lines, cursorLine, cursorCol, mapped, prefix);
    if (application && (sanitizeSingleLine(application.pathValue) !== application.pathValue
      || sanitizeSingleLine(application.surfaceText) !== application.surfaceText
      || codePointLength(application.pathValue) > PATH_MAX_CODE_POINTS
      || codePointLength(application.surfaceText) > PATH_MAX_CODE_POINTS)) {
      continue;
    }
    nativeSuggestionContext.set(mapped, {
      lines: lines.join("\n"),
      cursorLine,
      cursorCol,
      prefix,
      ...(application ? { application } : {}),
    });
    items.push(mapped);
  }
  return { items, prefix };
}

/**
 * The provider's public `value` is its native insertion syntax (which may have
 * one generated outer quote pair). Decode only that pair when the raw native
 * label proves the suffix; never shell-parse or broadly unquote user text.
 */
function pathValueFromNativeCompletion(item: AutocompleteItem): string | undefined {
  const insertion = item.value;
  if (typeof insertion !== "string" || typeof item.label !== "string") return undefined;
  if (insertion.startsWith("@")) return undefined;
  if (insertion.startsWith('"') && insertion.endsWith('"') && insertion.length >= 2) {
    const unwrapped = insertion.slice(1, -1);
    if (item.label.length > 0 && unwrapped.endsWith(item.label)) return unwrapped;
  }
  // Keep @-attachment syntax and every non-wrapper value byte-for-byte; path fields do not reinterpret it.
  return insertion;
}

const IDENTITY = (text: string): string => text;
const IDENTITY_EDITOR_THEME: EditorTheme = {
  borderColor: IDENTITY,
  selectList: {
    selectedPrefix: IDENTITY,
    selectedText: IDENTITY,
    description: IDENTITY,
    scrollInfo: IDENTITY,
    noMatch: IDENTITY,
  },
};

function installLiveKeybindings(manager: SessionHostFieldKeybindings): () => void {
  let previous: KeybindingsManager | undefined;
  try {
    previous = getKeybindings();
    setKeybindings(manager as KeybindingsManager);
  } catch {
    return () => {};
  }
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    try {
      if (getKeybindings() === manager && previous !== undefined) setKeybindings(previous);
    } catch {
      // Do not overwrite a newer host manager or let cleanup break the form.
    }
  };
}

class FieldTerminalPort implements Terminal {
  private cols = 80;
  private rowCount = 24;
  private writes = 0;

  get columns(): number { return this.cols; }
  get rows(): number { return this.rowCount; }
  get kittyProtocolActive(): boolean { return false; }
  get writeAttempts(): number { return this.writes; }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rowCount = rows;
  }

  start(_onInput: (data: string) => void, _onResize: () => void): void {
    throw new Error("SessionHostTextField never starts its local terminal port");
  }
  stop(): void {}
  async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {}
  write(data: string): void { if (data.length > 0) this.writes += 1; }
  moveBy(_lines: number): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(_title: string): void {}
  setProgress(_active: boolean): void {}
}

function sanitizeSingleLine(source: string): string {
  let result = "";
  let index = 0;
  while (index < source.length) {
    const code = source.codePointAt(index) ?? 0;
    const length = code > 0xffff ? 2 : 1;
    if (code === 0x1b) {
      const next = source.charCodeAt(index + 1);
      if (next === 0x5b) {
        index = consumeCsi(source, index + 2);
        continue;
      }
      if ([0x5d, 0x50, 0x5e, 0x5f, 0x58].includes(next)) {
        index = consumeStringControl(source, index + 2, next === 0x5d);
        continue;
      }
      index += 1;
      continue;
    }
    if (code === 0x9b) {
      index = consumeCsi(source, index + length);
      continue;
    }
    if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)) {
      index = consumeStringControl(source, index + length, code === 0x9d);
      continue;
    }
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)
      || code === 0x2028 || code === 0x2029 || (code >= 0xd800 && code <= 0xdfff)) {
      index += length;
      continue;
    }
    result += source.slice(index, index + length);
    index += length;
  }
  return result;
}

function consumeCsi(source: string, start: number): number {
  let index = start;
  while (index < source.length) {
    const code = source.codePointAt(index) ?? 0;
    index += code > 0xffff ? 2 : 1;
    if (code >= 0x40 && code <= 0x7e) return index;
  }
  return source.length;
}

function consumeStringControl(source: string, start: number, bellTerminates: boolean): number {
  let index = start;
  while (index < source.length) {
    const code = source.codePointAt(index) ?? 0;
    if ((bellTerminates && code === 0x07) || code === 0x9c) return index + 1;
    if (code === 0x1b && source[index + 1] === "\\") return index + 2;
    index += code > 0xffff ? 2 : 1;
  }
  return source.length;
}

function markerPrefixSuffixLength(text: string, marker: string): number {
  const max = Math.min(text.length, marker.length - 1);
  for (let length = max; length > 0; length -= 1) {
    if (marker.startsWith(text.slice(-length))) return length;
  }
  return 0;
}

function codePointLength(value: string): number {
  return [...value].length;
}

function validateDimension(value: number, label: "cols" | "rows"): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_FIELD_DIMENSION) {
    throw new Error(`Session host field ${label} must be an integer between 1 and ${MAX_FIELD_DIMENSION}`);
  }
}
