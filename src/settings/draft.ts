/**
 * The shared staged draft of ONE Review settings transaction (issue #723).
 *
 * Every value the settings menu stages lives on the transaction's single draft
 * holder tree, and every nested menu edits that tree through the sub-holder (or
 * one named slot of it) it is handed: the Tools submenu writes `draft.tools`,
 * the Web submenu writes the `web` sub-holder of that, the Retention submenu
 * writes `draft.retention`, and so on. That is the one editing path for every
 * surface, so an accepted edit belongs to the shared draft the moment the
 * operator is shown it — while they are still nested — instead of only when the
 * submenu that took it returns. The transaction's single dirty comparison and
 * its Save/Apply payload then read the same values, and no surface needs a copy
 * of the state to know what changed.
 *
 * Before the holder existed, each submenu staged into its own local copy and
 * the root adopted that copy on Back. The root then wrote the returned slice
 * back into its own locals, which is a second write path for the same value,
 * and any edit still held by an open submenu was invisible to the root.
 *
 * Only the HOLDER is shared. A staged VALUE is still replaced, never mutated in
 * place, exactly as the root's own local variable was, so nothing that keeps a
 * reference to a previous value can see a later edit through it.
 */

/**
 * One named value of the shared draft: read the staged value, or stage a new
 * one. A leaf picker that decides its value across many screens (a multi-select
 * toggle loop) takes a slot instead of a copy, so every accepted toggle lands
 * in the shared draft as it is drawn rather than on the way out.
 */
export interface DraftSlot<T> {
  get(): T;
  set(value: T): void;
}

/**
 * A slot over one property of a shared draft holder. Writing the slot replaces
 * the property on the holder the caller passed, so the holder's owner sees the
 * edit immediately; the value itself is still replaced, never mutated.
 */
export function draftSlot<Holder extends object, Key extends keyof Holder>(
  holder: Holder,
  key: Key,
): DraftSlot<Holder[Key]> {
  return {
    get: (): Holder[Key] => holder[key],
    set: (value: Holder[Key]): void => {
      holder[key] = value;
    },
  };
}
