import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { dispatch } from "@wordpress/data";
import { store as nativePreferences } from "@wordpress/preferences";
import { useLocation } from "react-router-dom";
import { Session } from "../components/AdminUI";
import { api, json } from "../api";
import { resolveEditorPreferences } from "../../shared/editor-preferences";
import { EditorPreferenceQueue, type EditorPreferencePatch, type PreferenceSnapshot } from "./preferenceQueue";

const empty = (): PreferenceSnapshot => ({ value: resolveEditorPreferences(null), loading: true, saving: false, error: "", errorScope: "" });
const Context = createContext({ ...empty(), update: (_patch: EditorPreferencePatch) => {}, dismiss: () => {} });
export function EditorPreferencesProvider({ children }: { children: ReactNode }) {
  const { user } = useContext(Session), location = useLocation();
  const [state, setState] = useState<{ userId: number | undefined; snapshot: PreferenceSnapshot }>({ userId: undefined, snapshot: empty() });
  const queue = useRef<EditorPreferenceQueue | null>(null), owner = useRef(user?.id), route = useRef(location.pathname);
  owner.current = user?.id; route.current = location.pathname;
  useEffect(() => {
    const userId = user?.id;
    setState({ userId, snapshot: empty() });
    if (!userId) { queue.current = null; return; }
    const current = new EditorPreferenceQueue(
      async () => (await api<{ preferences: { editor?: unknown } }>("/profile")).preferences?.editor,
      async editor => (await api<{ preferences: { editor?: unknown } }>("/preferences", json("PUT", { editor }))).preferences?.editor,
      snapshot => { if (owner.current === userId) setState({ userId, snapshot }); },
    );
    queue.current = current; void current.start();
    return () => { current.dispose(); if (queue.current === current) queue.current = null; };
  }, [user?.id]);
  const snapshot = state.userId === user?.id ? state.snapshot : empty();
  // Public native controls consult this store. No browser persistence layer is
  // installed; PostgreSQL and the account queue remain the only setting owner.
  useLayoutEffect(() => { void dispatch(nativePreferences).set("core", "showIconLabels", snapshot.value.showIconLabels); }, [snapshot.value.showIconLabels, user?.id]);
  return <Context.Provider value={{ ...snapshot, error: !snapshot.errorScope || snapshot.errorScope === location.pathname ? snapshot.error : "", update: patch => queue.current?.update(patch, route.current), dismiss: () => queue.current?.dismiss() }}>{children}</Context.Provider>;
}
export const useEditorPreferences = () => useContext(Context);
