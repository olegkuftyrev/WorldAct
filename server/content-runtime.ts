import { compileRuntimeContentRegistry, isCompiledContentRuntime, type RuntimeContentSnapshot } from "./runtime-content-registry.js";

export type ContentBootstrap = Readonly<{ snapshot: RuntimeContentSnapshot }>;
const bootstrapBrand = Symbol("content-bootstrap"), bootstrapToken = Object.freeze({});
function invalid(): never { throw new Error("Invalid content bootstrap: SNAPSHOT_PROVENANCE."); }

export function createContentBootstrap(snapshot: unknown): ContentBootstrap {
  if (!isCompiledContentRuntime(snapshot)) invalid();
  const bootstrap: ContentBootstrap = { snapshot };
  Object.defineProperty(bootstrap, bootstrapBrand, { value: bootstrapToken });
  return Object.freeze(bootstrap);
}

// A module singleton within each process; separate CLI/API processes compare
// reviewed profileVersion/fingerprint, never JavaScript object identity.
export const defaultContentBootstrap = createContentBootstrap(compileRuntimeContentRegistry([]));

/** This build has no custom catalog or service authority. Fail before acquiring
 * a migration client or starting API listener/workers, not before static imports. */
export function assertBuiltinStorageBoundary(value: unknown): void {
  if (!value || typeof value !== "object" || !Object.isFrozen(value) || Object.getOwnPropertyDescriptor(value, bootstrapBrand)?.value !== bootstrapToken) invalid();
  const snapshot = Object.getOwnPropertyDescriptor(value, "snapshot")?.value;
  if (!isCompiledContentRuntime(snapshot)) invalid();
  if (snapshot.contentKeys.join("\0") !== "post\0page" || snapshot.taxonomyKeys.join("\0") !== "category\0tag" || snapshot.sources.length !== 1 || snapshot.sources[0].owner !== "worldact/builtin" || snapshot.sources[0].integrityRevision !== 1)
    throw new Error("Custom content storage is not enabled in this build.");
}
