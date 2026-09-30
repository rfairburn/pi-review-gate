/**
 * Prototype-safe catalog key writing shared by the settings domain
 * modules: an own, enumerable, writable, configurable data property even
 * for keys like "__proto__" or "constructor", so a staged catalog key can
 * never trigger the prototype setter.
 */

/** Define an own data property even for keys like "__proto__" or "constructor". */
export function setCatalogKey(catalog: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(catalog, key, { value, enumerable: true, writable: true, configurable: true });
}
