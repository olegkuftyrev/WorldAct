import { Link } from "react-router-dom";
import {
  createContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  useContext,
  type Dispatch,
  type SetStateAction,
  type RefObject,
  type ReactNode,
} from "react";
import { api, type User } from "../api";
export const Session = createContext<{
  user: User | null;
  setUser: (user: User | null) => void;
}>({ user: null, setUser: () => {} });
export { Icon, Brand, errorText, Notice, ResourceState } from "./PublicPrimitives";
import { errorText, Icon } from "./PublicPrimitives";
export function useResource<T>(path: string | null) {
  const { user } = useContext(Session);
  const actor = user ? `${user.id}:${user.role}` : "anonymous";
  const ownerRef = useRef({ path, actor });
  if (ownerRef.current.path !== path || ownerRef.current.actor !== actor)
    ownerRef.current = { path, actor };
  const owner = ownerRef.current;
  const mounted = useRef(false);
  const requestId = useRef(0);
  const [state, setState] = useState({ owner, data: null as T | null, error: "", loading: Boolean(path) });
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; requestId.current++; };
  }, []);
  const reload = useCallback(async () => {
    // A captured reload from a departed route/account must not acquire a new
    // request number and supersede the current resource.
    if (!mounted.current || ownerRef.current !== owner) return;
    const currentRequest = ++requestId.current;
    const current = () => mounted.current && ownerRef.current === owner && currentRequest === requestId.current;
    if (!path) {
      setState({ owner, data: null, error: "", loading: false });
      return;
    }
    setState(previous => ({ owner, data: previous.owner === owner ? previous.data : null, error: "", loading: true }));
    try {
      const value = await api<T>(path);
      if (current()) setState({ owner, data: value, error: "", loading: false });
    } catch (e) {
      if (current()) setState(previous => ({ ...previous, error: errorText(e), loading: false }));
    }
  }, [path, owner]);
  const setData: Dispatch<SetStateAction<T | null>> = useCallback(value => {
    if (!mounted.current || ownerRef.current !== owner) return;
    setState(previous => ({ owner, data: typeof value === "function" ? (value as (previous: T | null) => T | null)(previous.owner === owner ? previous.data : null) : value, error: "", loading: false }));
  }, [owner]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data: state.owner === owner ? state.data : null, setData,
    error: state.owner === owner ? state.error : "",
    loading: state.owner === owner ? state.loading : Boolean(path), reload };
}
export function Panel({
  title,
  id,
  children,
}: {
  title: string;
  id?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section id={id} className={`postbox ${open ? "" : "closed"}`}>
      <div className="postbox-header">
        <h2 className="hndle">{title}</h2>
        <div className="handle-actions">
          <button
            className="handlediv"
            aria-expanded={open}
            aria-label={`${open ? "Collapse" : "Expand"} ${title}`}
            onClick={() => setOpen(!open)}
          >
            <span className="toggle-indicator" />
          </button>
        </div>
      </div>
      {open && <div className="inside">{children}</div>}
    </section>
  );
}

export function Modal({
  title,
  close,
  children,
  actions,
  initialFocus,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
  actions?: ReactNode;
  initialFocus?: RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDivElement>(null),
    closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const preferred = initialFocus?.current;
    (preferred && !preferred.matches(":disabled") ? preferred : ref.current)?.focus();
    const keydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.isComposing && !e.defaultPrevented) closeRef.current();
      if (e.key === "Tab" && ref.current) {
        const focusable = Array.from(
          ref.current.querySelectorAll<HTMLElement>(
            'button,a,input,textarea,select,[tabindex="0"]',
          ),
        ).filter((item) => !item.hasAttribute("disabled"));
        const first = focusable[0],
          last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener("keydown", keydown);
    return () => {
      window.removeEventListener("keydown", keydown);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="wa-modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="wa-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
      >
        <header>
          <h1>{title}</h1>
          {actions}
          <button
            className="editor-icon-button"
            aria-label="Close dialog"
            onClick={close}
          >
            <Icon name="no-alt" />
          </button>
        </header>
        <div className="wa-modal-content">{children}</div>
      </div>
    </div>
  );
}

export { ScreenTabs } from "./ScreenOptions";
