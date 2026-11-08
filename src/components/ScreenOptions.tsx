import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useLocation } from "react-router-dom";
import { api, json } from "../api";
import HelpTabs, { screenHelp, type HelpTab } from "./HelpTabs";
import "./screen-options.css";

export type ListTableId =
  "posts" | "pages" | "comments" | "categories" | "tags" | "users" | "media";
export type ListTablePreferences = {
  hiddenColumns: string[];
  perPage: number;
  viewMode: "list" | "excerpt";
};
export type ListTableColumn = { id: string; label: string };
export type UserListTablePreferences = {
  listTables?: Partial<Record<ListTableId, Partial<ListTablePreferences>>>;
};
const defaults: ListTablePreferences = {
  hiddenColumns: [],
  perPage: 20,
  viewMode: "list",
};
const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Display preferences could not be saved. Please try again.";

export function useListTablePreferences(screen: ListTableId) {
  const [state, setState] = useState<{
    screen: ListTableId;
    value: ListTablePreferences;
  }>({ screen, value: defaults });
  const [loading, setLoading] = useState(true),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const active = useRef(screen);
  active.current = screen;
  useEffect(() => {
    let present = true;
    setLoading(true);
    setError("");
    api<{ preferences: UserListTablePreferences }>("/profile")
      .then(({ preferences }) => {
        if (present)
          setState({
            screen,
            value: normalize(preferences?.listTables?.[screen]),
          });
      })
      .catch((reason) => {
        if (present) setError(message(reason));
      })
      .finally(() => {
        if (present) setLoading(false);
      });
    return () => {
      present = false;
    };
  }, [screen]);
  const value = state.screen === screen ? state.value : defaults;
  async function save(patch: Partial<ListTablePreferences>) {
    if (saving || loading) return false;
    setSaving(true);
    setError("");
    try {
      const { preferences } = await api<{
        preferences: UserListTablePreferences;
      }>("/preferences", json("PUT", { listTables: { [screen]: patch } }));
      if (active.current === screen)
        setState({
          screen,
          value: normalize(preferences.listTables?.[screen]),
        });
      return true;
    } catch (reason) {
      if (active.current === screen) setError(message(reason));
      return false;
    } finally {
      setSaving(false);
    }
  }
  return { value, loading, saving, error, save };
}
function normalize(
  value?: Partial<ListTablePreferences>,
): ListTablePreferences {
  return {
    hiddenColumns: Array.isArray(value?.hiddenColumns)
      ? value.hiddenColumns.filter((id) => typeof id === "string")
      : [],
    perPage:
      Number.isInteger(value?.perPage) &&
      value!.perPage! >= 1 &&
      value!.perPage! <= 100
        ? value!.perPage!
        : 20,
    viewMode: value?.viewMode === "excerpt" ? "excerpt" : "list",
  };
}

export function ListTableOptions({
  table,
  columns,
  itemLabel,
  excerpt = false,
  onApply,
}: {
  table: ReturnType<typeof useListTablePreferences>;
  columns: ListTableColumn[];
  itemLabel: string;
  excerpt?: boolean;
  onApply?: () => void;
}) {
  const [perPage, setPerPage] = useState(String(table.value.perPage)),
    [viewMode, setViewMode] = useState(table.value.viewMode),
    [saved, setSaved] = useState(false);
  useEffect(() => {
    setPerPage(String(table.value.perPage));
    setViewMode(table.value.viewMode);
  }, [table.value.perPage, table.value.viewMode]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaved(false);
    if (
      await table.save({
        perPage: Number(perPage),
        ...(excerpt ? { viewMode } : {}),
      })
    ) {
      setSaved(true);
      onApply?.();
    }
  }
  return (
    <form className="worldact-list-options" onSubmit={submit}>
      {table.loading && <p role="status">Loading your display preferences…</p>}
      {table.error && (
        <p className="worldact-options-error" role="alert">
          {table.error}
        </p>
      )}
      <fieldset disabled={table.loading || table.saving}>
        <legend>Columns</legend>
        <div className="worldact-column-choices">
          {columns.map((column) => (
            <label key={column.id}>
              <input
                type="checkbox"
                checked={!table.value.hiddenColumns.includes(column.id)}
                onChange={(event) => {
                  setSaved(false);
                  void table.save({
                    hiddenColumns: event.target.checked
                      ? table.value.hiddenColumns.filter(
                          (id) => id !== column.id,
                        )
                      : [...table.value.hiddenColumns, column.id],
                  });
                }}
              />
              {column.label}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset disabled={table.loading || table.saving}>
        <legend>Pagination</legend>
        <label>
          Number of {itemLabel} per page:{" "}
          <input
            type="number"
            min={1}
            max={100}
            required
            value={perPage}
            onChange={(event) => {
              setPerPage(event.target.value);
              setSaved(false);
            }}
            className="small-text"
          />
        </label>
      </fieldset>
      {excerpt && (
        <fieldset disabled={table.loading || table.saving}>
          <legend>View mode</legend>
          <label>
            <input
              type="radio"
              name="list-view-mode"
              value="list"
              checked={viewMode === "list"}
              onChange={() => setViewMode("list")}
            />
            Compact view
          </label>
          <label>
            <input
              type="radio"
              name="list-view-mode"
              value="excerpt"
              checked={viewMode === "excerpt"}
              onChange={() => setViewMode("excerpt")}
            />
            Extended view
          </label>
        </fieldset>
      )}
      <p className="submit">
        <button
          className="button button-primary"
          disabled={table.loading || table.saving}
        >
          {table.saving ? "Saving…" : "Apply"}
        </button>
        {saved && <span role="status">Display settings saved.</span>}
      </p>
    </form>
  );
}

export function ScreenTabs({
  children,
  helpTabs,
  sidebar,
}: {
  children?: ReactNode;
  helpTabs?: HelpTab[];
  sidebar?: ReactNode;
}) {
  const location = useLocation();
  const [open, setOpen] = useState<"options" | "help" | null>(null);
  const optionsButton = useRef<HTMLButtonElement>(null),
    helpButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setOpen(null);
  }, [location.pathname]);
  const tabs = helpTabs || screenHelp(location.pathname, location.search);
  return (
    <div
      className="worldact-screen-meta"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          (open === "options" ? optionsButton : helpButton).current?.focus();
          setOpen(null);
        }
      }}
    >
      <div id="screen-meta" className="metabox-prefs" hidden={!open}>
        {children && (
          <section
            id="screen-options-wrap"
            className="worldact-screen-options"
            hidden={open !== "options"}
            aria-label="Screen Options"
          >
            {children}
          </section>
        )}
        <section
          id="contextual-help-wrap"
          hidden={open !== "help"}
          aria-label="Contextual Help"
        >
          <HelpTabs tabs={tabs} sidebar={sidebar} />
        </section>
      </div>
      <div id="screen-meta-links">
        {children && (
          <div id="screen-options-link-wrap" className="screen-meta-toggle">
            <button
              ref={optionsButton}
              className="button show-settings"
              aria-expanded={open === "options"}
              aria-controls="screen-options-wrap"
              onClick={() => setOpen(open === "options" ? null : "options")}
            >
              Screen Options{" "}
              <span
                className="dashicons dashicons-arrow-down-alt2"
                aria-hidden="true"
              />
            </button>
          </div>
        )}
        <div id="contextual-help-link-wrap" className="screen-meta-toggle">
          <button
            ref={helpButton}
            className="button show-settings"
            aria-expanded={open === "help"}
            aria-controls="contextual-help-wrap"
            onClick={() => setOpen(open === "help" ? null : "help")}
          >
            Help{" "}
            <span
              className="dashicons dashicons-arrow-down-alt2"
              aria-hidden="true"
            />
          </button>
        </div>
      </div>
    </div>
  );
}
