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
	/** Real private directory, with verified owner-only access. */
	assertPrivateDirectory(path: string): void;
	/** Establish and verify privacy on a positively owned new directory. */
	protectCreatedDirectory(path: string): void;
	/** Real private regular file, never a symlink/reparse or unsafe-permission file. */
	assertPrivateFile(path: string): void;
	/** Establish and verify privacy on a positively owned empty new file. */
	protectCreatedFile(path: string): void;
}
