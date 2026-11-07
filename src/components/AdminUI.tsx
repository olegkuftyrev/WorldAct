import { Link } from "react-router-dom";
import {
  createContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import { api, type User } from "../api";
export const Session = createContext<{
  user: User | null;
  setUser: (user: User | null) => void;
}>({ user: null, setUser: () => {} });
export const Icon = ({
  name,
  ...props
}: {
  name: string;
  className?: string;
}) => (
  <span
    {...props}
    aria-hidden="true"
    className={`dashicons dashicons-${name} ${props.className || ""}`}
  />
);
export const Brand = () => (
  <span className="worldact-mark" aria-hidden="true">
    W
  </span>
);
export const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
export function useResource<T>(path: string) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setData(await api<T>(path));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, setData, error, loading, reload };
}
export function Notice({
  children,
  error = false,
  onDismiss,
}: {
  children: ReactNode;
  error?: boolean;
  onDismiss?: () => void;
}) {
  return (
    <div
      role={error ? "alert" : "status"}
      className={`notice notice-${error ? "error" : "success"} ${onDismiss ? "is-dismissible" : ""}`}
    >
      <p>{children}</p>
      {onDismiss && (
        <button
          type="button"
          aria-label="Dismiss notice"
          className="notice-dismiss"
          onClick={onDismiss}
        >
          <span className="screen-reader-text">Dismiss</span>
        </button>
      )}
    </div>
  );
}
export function ResourceState({
  loading,
  error,
  retry,
}: {
  loading: boolean;
  error: string;
  retry?: () => void;
}) {
  return error ? (
    <Notice error>
      {error}{" "}
      {retry && (
        <button className="button-link" onClick={retry}>
          Try again
        </button>
      )}
    </Notice>
  ) : loading ? (
    <p className="loading-state">
      <span className="spinner is-active" />
      Loading…
    </p>
  ) : null;
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
}: {
  title: string;
  close: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null),
    closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const keydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
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

export function ScreenTabs({ children }: { children?: ReactNode }) {
  const [help, setHelp] = useState(false),
    [options, setOptions] = useState(false);
  return (
    <>
      <div id="screen-meta-links">
        <button className="show-settings" onClick={() => setOptions(!options)}>
          Screen Options <Icon name="arrow-down-alt2" />
        </button>
        <button className="show-settings" onClick={() => setHelp(!help)}>
          Help <Icon name="arrow-down-alt2" />
        </button>
      </div>
      {(help || options) && (
        <div className="screen-help">
          {help ? (
            <>
              <strong>Overview</strong>
              <p>
                Manage your site using the menu on the left. Create posts and
                pages, manage media and comments, and adjust your site settings.
              </p>
              <Link to="/admin/about">About this study project</Link>
            </>
          ) : (
            children || (
              <p>
                Dashboard panels can be expanded or collapsed using the arrow in
                each panel heading.
              </p>
            )
          )}
        </div>
      )}
    </>
  );
}
