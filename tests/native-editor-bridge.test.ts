/**
 * Issue #26: the host-wired native editor bridge (src/native-editor-bridge.ts).
 *
 * Two tiers:
 *
 * 1. Fake-host wiring (always runs): a structural CustomEditor stand-in plus
 * a faithful simulation of the two public host behaviors the bridge relies on:
 * `setCustomEditorComponent` (synchronous factory call with the host's TUI,
 * editor theme, and live KeybindingsManager; onSubmit/onChange wired from the
 * default editor; draft carry-over via setText; autocomplete provider attach;
 * app-level handler copy for CustomEditor subclasses) and `showExtensionCustom`
 * (savedText captured BEFORE the wrapper factory runs; restore-on-close).
 *
 * Wiring tier pins: prefill applied after the host's draft capture, Enter/Esc/
 * Ctrl+D-empty interception, list-first key semantics, exactly-one settle,
 * chat-draft survival, ownership-checked restore, foreign-ownership notice,
 * fail closed on every missing seam, the no-chat-send submit takeover, the
 * observation-only onHostInsert paste seam, and session-reset abort.
 *
 * Integration tier drives the installed Pi's actual CustomEditor + pi-tui with
 * real keys: docs/ + Tab native path completion, Esc list dismissal, Ctrl+C
 * clear through the host's copied app handler (double press exits), Ctrl+G
 * external editing of the field instance, Ctrl+V image paste observed through
 * onHostInsert, the fd-backed `@` picker (when fd is available), and
 * Shift+Enter newlines. Skipped when no Pi install is resolvable — unless
 * PI_REVIEW_GATE_REQUIRE_PI_HOST=1, which turns a missing host into a hard
 * failure so any environment that has Pi can enforce these tests.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  abortActiveNativeEditorField,
  editTextWithNativeEditor,
  setNativeEditorHost,
  setNativeEditorHostEntryProvider as setNativeEditorHostEntryProviderForTest,
} from "../src/native-editor-bridge";
import type { NativeEditorFieldUi } from "../src/native-editor-bridge";
import {
  CTRL_C,
  CTRL_D,
  CTRL_G,
  CTRL_V,
  ENTER,
  ESCAPE,
  SHIFT_ENTER,
  TAB,
  createBridgeUi,
  createFakeCustomEditorClass,
  fakeHost,
  fakeKeybindingsManager,
  findFdBinary,
  loadRealBridgeHost,
  makeDocsFixture,
  realHostAfter,
  REAL_IDENTITY_THEME,
  settle,
  skipOrFail,
  typeText,
  createRealKeybindingsManager,
} from "./bridge-fakes";
import type { FakeBridgeEditor } from "./bridge-fakes";


// ---------------------------------------------------------------------------
// Wiring tier: prefill, keys, settle, ownership, draft survival, fail closed
// ---------------------------------------------------------------------------

test("prefill applies after the host's draft capture; Enter submits the edited field value", async () => {
  const instances: FakeBridgeEditor[] = [];
  setNativeEditorHost(fakeHost(instances));
  const { ui, state } = createBridgeUi({
    keybindings: fakeKeybindingsManager(),
    draft: "my chat draft",
    drivers: [
      (component) => {
        const frame = component.render?.(80)?.join("\n") ?? "";
        assert.ok(frame.includes("staged value"), `prefill visible: ${frame}`);
        for (const ch of "-edited") component.handleInput?.(ch);
        component.handleInput?.(ENTER);
      },
    ],
  });

  const result = await editTextWithNativeEditor(ui, { title: "Test field", prefill: "staged value" });
  assert.deepEqual(result, { kind: "value", value: "staged value-edited" });
  assert.equal(instances.length, 1, "one editor instance via the installed factory");
  assert.equal(state.slotFactory, undefined, "prior (default) factory restored");
  assert.equal(state.draft, "my chat draft", "chat draft survives the round trip");
  assert.deepEqual(state.chatSubmits, [], "no chat message was sent");
});

test("Esc cancels with undefined and restores the prior factory", async () => {
  const instances: FakeBridgeEditor[] = [];
  setNativeEditorHost(fakeHost(instances));
  const { ui, state } = createBridgeUi({
    keybindings: fakeKeybindingsManager(),
    draft: "draft d",
    drivers: [(component) => component.handleInput?.(ESCAPE)],
  });

  const result = await editTextWithNativeEditor(ui, { title: "T", prefill: "p" });
  assert.deepEqual(result, { kind: "cancel" });
  assert.equal(state.slotFactory, undefined, "prior factory restored on cancel");
  assert.equal(state.draft, "draft d");
  assert.equal(state.shutdowns, 0, "Esc never reached the host interrupt path");
});

test("Ctrl+D on an empty editor cancels; with text it reaches the editor", async () => {
  const instances: FakeBridgeEditor[] = [];
  setNativeEditorHost(fakeHost(instances));
  const { ui, state } = createBridgeUi({
    keybindings: fakeKeybindingsManager(),
    drivers: [(component) => component.handleInput?.(CTRL_D)],
  });

  const result = await editTextWithNativeEditor(ui, { title: "T", prefill: "" });
  assert.deepEqual(result, { kind: "cancel" }, "empty-editor Ctrl+D cancels the field");
  assert.equal(state.shutdowns, 0, "the host exit path never fired");

  const instances2: FakeBridgeEditor[] = [];
  setNativeEditorHost(fakeHost(instances2));
  const { ui: ui2 } = createBridgeUi({
    keybindings: fakeKeybindingsManager(),
    drivers: [
      (component) => {
        component.handleInput?.(CTRL_D); // not intercepted: text present
        component.handleInput?.(ENTER); // then the field submits
      },
    ],
  });
  const result2 = await editTextWithNativeEditor(ui2, { title: "T", prefill: "ab" });
  assert.deepEqual(result2, { kind: "value", value: "ab" });
  assert.ok(instances2[0]!.received.includes(CTRL_D), "Ctrl+D with text reached the editor");
});

test("Enter and Esc first let a visible completion list be handled, then submit/cancel", async () => {
  const instances: FakeBridgeEditor[] = [];
  setNativeEditorHost(fakeHost(instances));
  const { ui } = createBridgeUi({
    keybindings: fakeKeybindingsManager(),
    drivers: [
      (component) => {
        for (const ch of "docs/") component.handleInput?.(ch);
        component.handleInput?.(TAB); // open the (fake) list
        assert.equal(instances[0]!.showingList, true, "the list is visible");
        component.handleInput?.(ENTER); // confirm the native selection, no submit
        assert.equal(instances[0]!.showingList, false, "the list closed with the applied selection");
        component.handleInput?.(ENTER); // now the field submits
      },
    ],
  });
  const result = await editTextWithNativeEditor(ui, { title: "T", prefill: "" });
  assert.deepEqual(result, { kind: "value", value: "docs/assets/" });

  const instances2: FakeBridgeEditor[] = [];
  setNativeEditorHost(fakeHost(instances2));
  const { ui: ui2 } = createBridgeUi({
    keybindings: fakeKeybindingsManager(),
    drivers: [
      (component) => {
        for (const ch of "docs/") component.handleInput?.(ch);
        component.handleInput?.(TAB); // open the list
        component.handleInput?.(ESCAPE); // first Esc dismisses the list
        assert.equal(instances2[0]!.showingList, false, "the list was dismissed");
        component.handleInput?.(ESCAPE); // second Esc cancels the field
      },
    ],
  });
  const result2 = await editTextWithNativeEditor(ui2, { title: "T", prefill: "" });
  assert.deepEqual(result2, { kind: "cancel" });
});

test("a foreign prior factory is restored as-is with a one-time notice", async () => {
  const instances: FakeBridgeEditor[] = [];
  setNativeEditorHost(fakeHost(instances));
  const foreignFactory = (() => ({})) as never;
  const { ui, state } = createBridgeUi({
    keybindings: fakeKeybindingsManager(),
    priorFactory: foreignFactory,
    drivers: [(component) => component.handleInput?.(ENTER)],
  });

  const result = await editTextWithNativeEditor(ui, { title: "T", prefill: "x" });
  assert.equal(result.kind, "value");
  assert.equal(state.slotFactory, foreignFactory, "the foreign factory is restored by identity");
  assert.ok(
    state.notices.some((n) => n.type === "info" && /another extension/i.test(n.message)),
    `foreign ownership is named: ${JSON.stringify(state.notices)}`,
  );
});

test("missing seams fail closed without presenting a field", async () => {
  const instances: FakeBridgeEditor[] = [];
  setNativeEditorHost(fakeHost(instances));
  const full = createBridgeUi({ keybindings: fakeKeybindingsManager(), drivers: [] });

  // No setEditorComponent at all.
  const noSet: NativeEditorFieldUi = { custom: full.ui.custom, getEditorComponent: full.ui.getEditorComponent };
  assert.deepEqual(
    await editTextWithNativeEditor(noSet, { title: "T" }),
    { kind: "unavailable", reason: "the host UI is missing the custom/setEditorComponent/getEditorComponent seams" },
  );

  // No custom slot.
  const noCustom: NativeEditorFieldUi = { setEditorComponent: full.ui.setEditorComponent, getEditorComponent: full.ui.getEditorComponent };
  assert.deepEqual(
    await editTextWithNativeEditor(noCustom, { title: "T" }),
    { kind: "unavailable", reason: "the host UI is missing the custom/setEditorComponent/getEditorComponent seams" },
  );

  // Unloadable host: clear any override and point entry discovery at a
  // non-existent file so resolution fails deterministically.
  setNativeEditorHost(undefined);
  const { ui } = createBridgeUi({ keybindings: fakeKeybindingsManager(), drivers: [] });
  setNativeEditorHostEntryProviderForTest(() => "/nonexistent/pi-entry.js");
  try {
    const result = await editTextWithNativeEditor(ui, { title: "T" });
    assert.equal(result.kind, "unavailable", `host load failure fails closed: ${JSON.stringify(result)}`);
  } finally {
    setNativeEditorHostEntryProviderForTest(undefined);
  }
  assert.equal(instances.length, 0, "no editor was created");
});

test("a failed field prefill never exposes or submits the displaced chat draft", async () => {
  const instances: FakeBridgeEditor[] = [];
  const Base = fakeHost(instances).CustomEditor;
  class RejectFieldPrefill extends Base {
    override setText(text: string): void {
      if (text === "field prefill") throw new Error("prefill failed");
      super.setText(text);
    }
  }
  setNativeEditorHost({ CustomEditor: RejectFieldPrefill });
  const { ui, state } = createBridgeUi({
    keybindings: fakeKeybindingsManager(),
    draft: "private chat draft",
    drivers: [],
  });

  assert.deepEqual(await editTextWithNativeEditor(ui, { title: "T", prefill: "field prefill" }),
    { kind: "unavailable", reason: "the custom component slot failed" });
  assert.equal(state.draft, "private chat draft");
  assert.equal(state.slotFactory, undefined);
  assert.deepEqual(state.chatSubmits, []);
});

test("a rejecting custom component is unavailable, never a user cancellation", async () => {
  const instances: FakeBridgeEditor[] = [];
  setNativeEditorHost(fakeHost(instances));
  const { ui, state } = createBridgeUi({
    keybindings: fakeKeybindingsManager(),
    draft: "chat draft",
    drivers: [() => { throw new Error("driver failed"); }],
  });

  assert.deepEqual(await editTextWithNativeEditor(ui, { title: "T", prefill: "field" }),
    { kind: "unavailable", reason: "the custom component slot failed" });
  assert.equal(state.draft, "chat draft");
  assert.deepEqual(state.chatSubmits, []);
});

test("a host that does not create the instance synchronously fails closed and restores", async () => {
  const instances: FakeBridgeEditor[] = [];
  setNativeEditorHost(fakeHost(instances));
  const { ui, state } = createBridgeUi({ keybindings: fakeKeybindingsManager(), draft: "d", drivers: [] });
  // Replace the slot setter with one that records but never calls the factory.
  ui.setEditorComponent = (factory) => {
    state.slotFactory = factory;
  };

  const result = await editTextWithNativeEditor(ui, { title: "T", prefill: "p" });
  assert.equal(result.kind, "unavailable");
  assert.equal(state.slotFactory, undefined, "the prior factory was restored");
});


test("the native submit path never sends a chat message (onSubmit takeover)", async () => {
  const instances: FakeBridgeEditor[] = [];
  setNativeEditorHost(fakeHost(instances));
  const { ui, state } = createBridgeUi({
    keybindings: fakeKeybindingsManager(),
    draft: "draft",
    drivers: [
      (component) => {
        // Simulate the native submit path firing directly on the instance
        // (e.g. under keybinding divergence): it must settle the field, not
        // reach the chat submitter the host wired at creation time.
        instances[0]!.onSubmit?.("must not be a chat message");
      },
    ],
  });

  const result = await editTextWithNativeEditor(ui, { title: "T", prefill: "field value" });
  assert.equal(result.kind, "value");
  if (result.kind === "value") assert.equal(result.value, "must not be a chat message");
  assert.deepEqual(state.chatSubmits, [], "the chat submitter was never invoked");
});

test("onHostInsert observes exactly what the host handler inserts, without breaking insertion", async () => {
  const instances: FakeBridgeEditor[] = [];
  setNativeEditorHost(fakeHost(instances));
  const observed: string[] = [];
  const { ui } = createBridgeUi({
    keybindings: fakeKeybindingsManager(),
    drivers: [
      (component) => {
        // The host's native paste handler inserts through the instance's
        // public insertTextAtCursor — exactly what this call simulates.
        instances[0]!.insertTextAtCursor("/tmp/pi-clipboard-abc.png");
        component.handleInput?.(ENTER);
      },
    ],
  });

  const result = await editTextWithNativeEditor(ui, {
    title: "T",
    prefill: "",
    onHostInsert: (text) => observed.push(text),
  });
  assert.deepEqual(observed, ["/tmp/pi-clipboard-abc.png"], "the observer saw exactly the inserted text");
  assert.equal(result.kind, "value");
  if (result.kind === "value") {
    assert.ok(result.value.includes("/tmp/pi-clipboard-abc.png"), "the native insertion still happened");
  }

  // A throwing observer must not break the native insertion.
  const instances2: FakeBridgeEditor[] = [];
  setNativeEditorHost(fakeHost(instances2));
  const { ui: ui2 } = createBridgeUi({
    keybindings: fakeKeybindingsManager(),
    drivers: [
      (component) => {
        instances2[0]!.insertTextAtCursor("plain");
        component.handleInput?.(ENTER);
      },
    ],
  });
  const result2 = await editTextWithNativeEditor(ui2, {
    title: "T",
    prefill: "",
    onHostInsert: () => {
      throw new Error("observer failure");
    },
  });
  assert.equal(result2.kind, "value");
  if (result2.kind === "value") assert.ok(result2.value.includes("plain"), "insertion survived the observer failure");
});

test("abortActiveNativeEditorField settles as cancel, restores the draft into the instance, and leaves the slot to the host", async () => {
  const instances: FakeBridgeEditor[] = [];
  setNativeEditorHost(fakeHost(instances));
  const { ui, state } = createBridgeUi({
    keybindings: fakeKeybindingsManager(),
    draft: "precious draft",
    drivers: [
      (component) => {
        for (const ch of "partial") component.handleInput?.(ch);
        abortActiveNativeEditorField();
        assert.equal(instances[0]!.getText(), "precious draft");
      },
    ],
  });
  const pending = editTextWithNativeEditor(ui, { title: "T", prefill: "" });
  await settle(5); // let the open flow reach the driver before awaiting
  const result = await pending;
  assert.deepEqual(result, { kind: "cancel" });
  // After an abort the host owns the slot (its resetExtensionUI clears it);
  // the bridge must not have restored the factory itself.
  assert.notEqual(state.slotFactory, undefined, "the slot is left for the host's own reset");
  abortActiveNativeEditorField(); // idempotent with no field open
});

test("exactly one settle: input after submit is ignored; a concurrent open is refused", async () => {
  const instances: FakeBridgeEditor[] = [];
  setNativeEditorHost(fakeHost(instances));
  const { ui } = createBridgeUi({
    keybindings: fakeKeybindingsManager(),
    drivers: [
      (component) => {
        component.handleInput?.(ENTER);
        component.handleInput?.(ENTER); // second Enter after settle
        component.handleInput?.("x");
      },
    ],
  });
  const result = await editTextWithNativeEditor(ui, { title: "T", prefill: "v" });
  assert.deepEqual(result, { kind: "value", value: "v" });
  // A second concurrent field open is refused while one is active.
  const instances2: FakeBridgeEditor[] = [];
  setNativeEditorHost(fakeHost(instances2));
  let released = false;
  const { ui: ui2 } = createBridgeUi({
    keybindings: fakeKeybindingsManager(),
    drivers: [
      () => new Promise<void>((resolve) => {
        void editTextWithNativeEditor(ui2, { title: "T2", prefill: "" }).then((second) => {
          assert.deepEqual(second, { kind: "unavailable", reason: "a native editor field is already open" });
          released = true;
          resolve();
        });
      }),
    ],
  });
  const first = editTextWithNativeEditor(ui2, { title: "T", prefill: "" });
  await settle(5);
  assert.ok(released, "the concurrent open was refused");
  // Now close the first field through its settle callback.
  instances2[0]!.onFieldSettle?.("done");
  const result2 = await first;
  assert.deepEqual(result2, { kind: "value", value: "done" });
});

// ---------------------------------------------------------------------------
// Real-host integration tier (installed Pi's CustomEditor + pi-tui)
// ---------------------------------------------------------------------------

test("real host: docs/ + Tab opens the native list, second Tab applies, Enter submits", async (t) => {
  const loaded = await loadRealBridgeHost();
  if (!loaded) {
    skipOrFail(t, "no installed Pi is resolvable in this environment");
    return;
  }
  setNativeEditorHost(loaded.host);
  realHostAfter(t);

  const root = await makeDocsFixture();
  const keybindings = createRealKeybindingsManager(loaded.tui);
  const { ui } = createBridgeUi({
    theme: REAL_IDENTITY_THEME,
    keybindings,
    provider: new (loaded.tui.CombinedAutocompleteProvider as new (commands: never[], basePath: string) => unknown)([], root),
    draft: "chat draft",
    drivers: [
      async (component) => {
        typeText(component, "docs/");
        await settle();
        component.handleInput?.(TAB); // open the native list
        await settle();
        const frame = component.render!(200).join("\n");
        assert.ok(frame.includes("assets/"), `folder listed: ${frame}`);
        assert.ok(frame.includes("guide.md"), `file listed (the native provider lists files too): ${frame}`);
        assert.ok(frame.includes("intro.md"), `second file listed: ${frame}`);
        assert.ok(!frame.includes("other/"), "anchored to the passed session cwd, not process.cwd");
        component.handleInput?.(TAB); // apply the highlighted folder natively
        await settle();
        component.handleInput?.(ENTER); // the field submits (intercepted)
      },
    ],
  });

  const result = await editTextWithNativeEditor(ui, { title: "Workspace", prefill: "" });
  assert.deepEqual(result, { kind: "value", value: "docs/assets/" });
});

test("real host: Esc dismisses a visible completion list first, then cancels", async (t) => {
  const loaded = await loadRealBridgeHost();
  if (!loaded) {
    skipOrFail(t, "no installed Pi is resolvable in this environment");
    return;
  }
  setNativeEditorHost(loaded.host);
  realHostAfter(t);

  const root = await makeDocsFixture();
  const keybindings = createRealKeybindingsManager(loaded.tui);
  const { ui, state } = createBridgeUi({
    theme: REAL_IDENTITY_THEME,
    keybindings,
    provider: new (loaded.tui.CombinedAutocompleteProvider as new (commands: never[], basePath: string) => unknown)([], root),
    draft: "draft kept",
    drivers: [
      async (component) => {
        typeText(component, "docs/");
        await settle();
        component.handleInput?.(TAB); // open the list
        await settle();
        assert.ok(component.render!(200).join("\n").includes("assets/"), "the list is visible");
        component.handleInput?.(ESCAPE); // first Esc: dismiss the list
        await settle();
        const frame = component.render!(200).join("\n");
        assert.ok(!frame.includes("assets/"), `the list was dismissed: ${frame}`);
        assert.ok(frame.includes("docs/"), "the draft text survives the dismissal");
        component.handleInput?.(ESCAPE); // second Esc: cancel the field
      },
    ],
  });

  const result = await editTextWithNativeEditor(ui, { title: "Workspace", prefill: "" });
  assert.deepEqual(result, { kind: "cancel" });
  assert.equal(state.draft, "draft kept");
});

test("real host: Ctrl+C clears the field draft; double Ctrl+C exits through session_shutdown abort", async (t) => {
  const loaded = await loadRealBridgeHost();
  if (!loaded) {
    skipOrFail(t, "no installed Pi is resolvable in this environment");
    return;
  }
  setNativeEditorHost(loaded.host);
  realHostAfter(t);

  const keybindings = createRealKeybindingsManager(loaded.tui);
  // Production: the host's copied app.clear clears once, then a second press
  // within 500ms exits the session — which fires session_shutdown, and the
  // settings command wires that to abortActiveNativeEditorField().
  let lastClear = 0;
  const { ui, state } = createBridgeUi({
    theme: REAL_IDENTITY_THEME,
    keybindings,
    draft: "draft survives exit",
    appHandlers: {
      "app.clear": (editor) => () => {
        const now = Date.now();
        if (now - lastClear < 500) {
          state.shutdowns += 1;
          abortActiveNativeEditorField(); // the session_shutdown hook
          return;
        }
        lastClear = now;
        editor.setText("");
      },
    },
    drivers: [
      (component) => {
        typeText(component, "some text");
        component.handleInput?.(CTRL_C); // single: clear the field draft
        const frame = component.render!(200).join("\n");
        assert.ok(!frame.includes("some text"), `the draft was cleared: ${frame}`);
        component.handleInput?.(CTRL_C); // double within 500ms: host exit
      },
    ],
  });

  const result = await editTextWithNativeEditor(ui, { title: "T", prefill: "" });
  assert.deepEqual(result, { kind: "cancel" }, "the abort settles the field as a cancel");
  assert.equal(state.shutdowns, 1, "the double Ctrl+C reached the host exit path exactly once");
  assert.equal(state.draft, "draft survives exit", "the chat draft survived the aborted field");
});

test("real host: Ctrl+G runs the external editor against the field instance", async (t) => {
  const loaded = await loadRealBridgeHost();
  if (!loaded) {
    skipOrFail(t, "no installed Pi is resolvable in this environment");
    return;
  }
  setNativeEditorHost(loaded.host);
  realHostAfter(t);

  const keybindings = createRealKeybindingsManager(loaded.tui);
  // Faithful simulation of handleOpenExternalEditor's terminal acts on the
  // instance: read via getExpandedText, write back via setText.
  const externalEdits: string[] = [];
  const { ui } = createBridgeUi({
    theme: REAL_IDENTITY_THEME,
    keybindings,
    appHandlers: {
      "app.editor.external": (editor) => () => {
        const content = editor.getExpandedText();
        externalEdits.push(content);
        editor.setText(`${content} [externally edited]`);
      },
    },
    drivers: [
      (component) => {
        typeText(component, "base line");
        component.handleInput?.(CTRL_G); // the real key matches app.editor.external
        component.handleInput?.(ENTER);
      },
    ],
  });

  const result = await editTextWithNativeEditor(ui, { title: "T", prefill: "" });
  assert.deepEqual(externalEdits, ["base line"], "the external editor saw the field's expanded text exactly once");
  assert.deepEqual(result, { kind: "value", value: "base line [externally edited]"}, "the externally edited text is what the field submits");
});

test("real host: Ctrl+V image paste is observed through onHostInsert with exactly the inserted path", async (t) => {
  const loaded = await loadRealBridgeHost();
  if (!loaded) {
    skipOrFail(t, "no installed Pi is resolvable in this environment");
    return;
  }
  setNativeEditorHost(loaded.host);
  realHostAfter(t);

  const keybindings = createRealKeybindingsManager(loaded.tui);
  const FAKE_IMAGE_PATH = "/tmp/pi-clipboard-fake-1234.png";
  // The host's handleClipboardPaste terminal act: insertTextAtCursor(path) on
  // this.editor — wired here exactly as the host wires onPasteImage.
  const observed: string[] = [];
  const { ui } = createBridgeUi({
    theme: REAL_IDENTITY_THEME,
    keybindings,
    onPasteImage: (editor) => () => {
      editor.insertTextAtCursor(FAKE_IMAGE_PATH);
    },
    drivers: [
      (component) => {
        component.handleInput?.(CTRL_V); // real keypress through the real editor
        component.handleInput?.(ENTER);
      },
    ],
  });

  const result = await editTextWithNativeEditor(ui, {
    title: "T",
    prefill: "",
    onHostInsert: (text) => observed.push(text),
  });
  assert.deepEqual(observed, [FAKE_IMAGE_PATH], "the observer saw exactly the path Pi's handler inserted");
  assert.equal(result.kind, "value");
  if (result.kind === "value") assert.ok(result.value.includes(FAKE_IMAGE_PATH), "the path is in the submitted value");
});

test("real host: the fd-backed @ picker fuzzy-matches files and Tab applies the selection", async (t) => {
  const loaded = await loadRealBridgeHost();
  if (!loaded) {
    skipOrFail(t, "no installed Pi is resolvable in this environment");
    return;
  }
  const fdPath = findFdBinary();
  if (!fdPath) {
    t.skip("fd is not on PATH; the @ picker cannot be exercised (reported gap)");
    return;
  }
  setNativeEditorHost(loaded.host);
  realHostAfter(t);

  const root = await makeDocsFixture();
  const keybindings = createRealKeybindingsManager(loaded.tui);
  const { ui } = createBridgeUi({
    theme: REAL_IDENTITY_THEME,
    keybindings,
    provider: new (loaded.tui.CombinedAutocompleteProvider as new (commands: never[], basePath: string, fdPath?: string) => unknown)([], root, fdPath),
    drivers: [
      async (component) => {
        typeText(component, "@gui"); // fuzzy prefix for docs/guide.md
        component.handleInput?.(TAB); // forced fuzzy file search
        await settle(300); // the fd round trip completes; a single match auto-applies
        const frame = component.render!(200).join("\n");
        assert.ok(frame.includes("@docs/guide.md"), `the fuzzy match was applied natively: ${frame}`);
        component.handleInput?.(ENTER); // the field submits (intercepted)
      },
    ],
  });

  const result = await editTextWithNativeEditor(ui, { title: "T", prefill: "" });
  assert.equal(result.kind, "value");
  if (result.kind === "value") {
    assert.ok(result.value.includes("@docs/guide.md"), `the selected file is in the submitted value: ${result.value}`);
  }
});

test("real host: Shift+Enter inserts a newline and multi-line values submit intact", async (t) => {
  const loaded = await loadRealBridgeHost();
  if (!loaded) {
    skipOrFail(t, "no installed Pi is resolvable in this environment");
    return;
  }
  setNativeEditorHost(loaded.host);
  realHostAfter(t);

  const keybindings = createRealKeybindingsManager(loaded.tui);
  const { ui } = createBridgeUi({
    theme: REAL_IDENTITY_THEME,
    keybindings,
    drivers: [
      (component) => {
        typeText(component, "line one");
        component.handleInput?.(SHIFT_ENTER); // native newline
        typeText(component, "line two");
        component.handleInput?.(ENTER);
      },
    ],
  });

  const result = await editTextWithNativeEditor(ui, { title: "T", prefill: "" });
  assert.deepEqual(result, { kind: "value", value: "line one\nline two" });
});

test("real host: the chat draft survives a full open/edit/close round trip exactly once", async (t) => {
  const loaded = await loadRealBridgeHost();
  if (!loaded) {
    skipOrFail(t, "no installed Pi is resolvable in this environment");
    return;
  }
  setNativeEditorHost(loaded.host);
  realHostAfter(t);

  const keybindings = createRealKeybindingsManager(loaded.tui);
  const { ui, state } = createBridgeUi({
    theme: REAL_IDENTITY_THEME,
    keybindings,
    draft: "the one chat draft",
    drivers: [
      (component) => {
        typeText(component, "field edit");
        component.handleInput?.(ENTER);
      },
    ],
  });

  const result = await editTextWithNativeEditor(ui, { title: "T", prefill: "" });
  assert.equal(result.kind, "value");
  assert.equal(state.draft, "the one chat draft", "the draft is restored into the default editor exactly once");
  assert.deepEqual(state.chatSubmits, [], "nothing was sent to chat");
});
