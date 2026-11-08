import { resolveEditorPreferences, type EditorPreferences } from "../../shared/editor-preferences";

export type EditorPreferencePatch = Partial<EditorPreferences>;
export function preferencePatch(current: EditorPreferences, patch: EditorPreferencePatch): EditorPreferencePatch {
  if (patch.distractionFree === true) return { ...patch, fixedToolbar: true };
  if (patch.distractionFree === false && current.distractionFree) return { ...patch, fixedToolbar: false };
  if (patch.fixedToolbar !== undefined) return { ...patch, distractionFree: false };
  return patch;
}
type Operation = { patch: EditorPreferencePatch; scope: string };
export type PreferenceSnapshot = { value: EditorPreferences; loading: boolean; saving: boolean; error: string; errorScope: string };

/** One account owns one ordered stream. Responses never replace newer intent. */
export class EditorPreferenceQueue {
  private confirmed = resolveEditorPreferences(null);
  private pending: Operation[] = [];
  private loaded = false;
  private running = false;
  private active = true;
  private error = "";
  private errorScope = "";
  constructor(private load: () => Promise<unknown>, private save: (patch: EditorPreferencePatch) => Promise<unknown>, private publish: (state: PreferenceSnapshot) => void) {}
  snapshot(): PreferenceSnapshot {
    return { value: this.pending.reduce((value, item) => ({ ...value, ...item.patch }), this.confirmed), loading: !this.loaded, saving: this.pending.length > 0, error: this.error, errorScope: this.errorScope };
  }
  private notify() { if (this.active) this.publish(this.snapshot()); }
  async start() {
    try { this.confirmed = resolveEditorPreferences(await this.load()); }
    catch (reason) { this.error = reason instanceof Error ? reason.message : "Editor preferences could not be loaded."; }
    this.loaded = true; this.notify(); void this.drain();
  }
  update(patch: EditorPreferencePatch, scope: string) {
    if (!this.active) return;
    this.pending.push({ patch: preferencePatch(this.snapshot().value, patch), scope });
    this.error = ""; this.errorScope = ""; this.notify(); void this.drain();
  }
  dismiss() { this.error = ""; this.notify(); }
  dispose() { this.active = false; this.pending = []; }
  private async drain() {
    if (!this.active || !this.loaded || this.running) return;
    this.running = true;
    while (this.active && this.pending.length) {
      const operation = this.pending[0];
      try { this.confirmed = resolveEditorPreferences(await this.save(operation.patch)); }
      catch (reason) { this.error = `Editor preferences could not be saved. ${reason instanceof Error ? reason.message : "Try again."}`; this.errorScope = operation.scope; }
      this.pending.shift(); this.notify();
    }
    this.running = false;
  }
}
