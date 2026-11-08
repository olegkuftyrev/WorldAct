export type HistoryMode = "input" | "change" | "merge" | "ignore" | "history";
export type BlockHistory<T> = { items: T[]; index: number; lastInput: number };

/** Honor Gutenberg's non-persistent hydration without adding a user undo level. */
export function recordBlockHistory<T>(state: BlockHistory<T>, value: T, mode: HistoryMode, now = Date.now()): void {
  if (mode === "history" || mode === "ignore") return;
  const merge = mode === "merge" || (
    mode === "input" && state.index === state.items.length - 1 &&
    state.index > 0 && now - state.lastInput < 800
  );
  if (merge) state.items[state.index] = value;
  else {
    state.items = state.items.slice(0, state.index + 1);
    state.items.push(value);
    if (state.items.length > 100) state.items.shift();
    state.index = state.items.length - 1;
  }
  state.lastInput = mode === "input" ? now : 0;
}
