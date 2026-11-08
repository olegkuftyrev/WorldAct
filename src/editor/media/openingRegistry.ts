import { createRegistry, type DataRegistry } from "@wordpress/data";

/** Own the inherited subscriptions the source registry otherwise retains. */
export function createOpeningRegistry(parent: DataRegistry) {
  const subscriptions = new Set<() => void>();
  const inherited: DataRegistry = {
    ...parent,
    subscribe: (...args) => {
      const release = parent.subscribe(...args);
      let active = true;
      const unsubscribe = () => {
        if (!active) return;
        active = false;
        subscriptions.delete(unsubscribe);
        release();
      };
      subscriptions.add(unsubscribe);
      return unsubscribe;
    },
  };
  const registry = createRegistry({}, inherited);
  return {
    registry,
    dispose() {
      for (const unsubscribe of subscriptions) unsubscribe();
      subscriptions.clear();
    },
  };
}
