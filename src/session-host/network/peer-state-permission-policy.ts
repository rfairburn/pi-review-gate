/**
 * Synchronous protection seam for explicitly opened peer state.
 *
 * The caller fences path and descriptor identity. Protection methods may be
 * called only for objects the caller has just created and still positively
 * owns; they are not a repair API for pre-existing account files. Secret bytes
 * must not be written until protection succeeds.
 */
export interface PeerStatePermissionPolicy {
	/** Real owner-controlled parent directory; public read access is permissible. */
	assertOwnerControlledDirectory(path: string): void;
	/**
	 * Optional read-only proof for an EXISTING higher ancestor above an artifact
	 * parent (Windows native MCP staging and consumption only): a real directory
	 * that no untrusted principal can rewrite, and through which (no
	 * `FILE_DELETE_CHILD`, no file/entry replacement right) no untrusted
	 * principal can remove or replace an existing entry. It does not vouch for a
	 * child's own descriptor, which may grant `DELETE`: the caller proves each
	 * component of the checked chain from its own descriptor, top-down. It
	 * grants nothing and requires no authority for this account.
	 * Callers without it fall back to the stricter
	 * {@link assertOwnerControlledDirectory}; it never stands in for that proof on
	 * a directory anything is created in.
	 */
	assertReplacementProtectedAncestor?(path: string): void;
	/**
	 * Optional read-only proof (#682, Windows Claude callback lane only) that an
	 * EXISTING executable file cannot be modified, replaced, or re-permissioned by
	 * any untrusted principal. It vouches for that file's own descriptor only; the
	 * caller proves every ancestor with {@link assertReplacementProtectedAncestor}.
	 * A policy without it proves nothing for an executable.
	 */
	assertProtectedExecutable?(path: string): void;
	/** Real private directory, with verified owner-only access. */
	assertPrivateDirectory(path: string): void;
	/** Establish and verify privacy on a positively owned new directory. */
	protectCreatedDirectory(path: string): void;
	/** Real private regular file, never a symlink/reparse or unsafe-permission file. */
	assertPrivateFile(path: string): void;
	/** Establish and verify privacy on a positively owned empty new file. */
	protectCreatedFile(path: string): void;
}
