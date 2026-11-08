import { useState, type FormEvent } from "react";
import { api } from "../api";
import {
  Notice,
  ResourceState,
  errorText,
  useResource,
} from "../components/AdminUI";
import {
  emptyExportSelection,
  exportCategoryLabels,
  wxrExportQuery,
  type ExportContent as ContentType,
} from "../wxrExportSelection";

type Options = {
  authors: Array<{ id: number; displayName: string }>;
  categories: Array<{ id: number; name: string; parentId: number | null }>;
  months: Record<Exclude<ContentType, "all">, string[]>;
};
function download(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob),
    link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function monthLabel(month: string) {
  const [year, index] = month.split("-");
  return `${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][Number(index) - 1]} ${year}`;
}
export default function ExportContent() {
  const options = useResource<Options>("/tools/export/options");
  const [selection, setSelection] = useState(emptyExportSelection);
  const [busy, setBusy] = useState<"xml" | "json" | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const set = (key: keyof typeof selection, value: string) => {
    setSelection((current) => ({ ...current, [key]: value }));
    setError("");
  };
  async function exportFile(format: "xml" | "json") {
    if (busy) return;
    setBusy(format);
    setError("");
    setNotice("");
    try {
      if (format === "xml") {
        const query = wxrExportQuery(selection);
        const response = await fetch(`/api/tools/export?${query}`, {
          credentials: "same-origin",
        });
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          throw new Error(
            body?.error || "The XML export could not be generated.",
          );
        }
        download("worldact-export.xml", await response.blob());
      } else
        download(
          `worldact-export-${new Date().toISOString().slice(0, 10)}.json`,
          new Blob([JSON.stringify(await api("/tools/export"), null, 2)], {
            type: "application/json",
          }),
        );
      setNotice(
        format === "xml"
          ? "XML export downloaded."
          : "Full JSON archive downloaded.",
      );
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(null);
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    void exportFile("xml");
  }
  const months =
    selection.content === "all"
      ? []
      : options.data?.months[selection.content] || [];
  return (
    <div className="worldact-tool-panel worldact-export">
      <p>
        When you click the button below WorldAct will create an XML file for you
        to save to your computer.
      </p>
      <p>
        This format, called WordPress eXtended RSS or WXR, will contain your
        posts, pages, comments, custom fields, categories, and tags. Once you’ve
        saved the download file, you can use the Import function in another
        WorldAct or WordPress installation to import the content from this site.
      </p>
      {error && <Notice error>{error}</Notice>}
      {notice && <Notice>{notice}</Notice>}
      <h2>Choose what to export</h2>
      <ResourceState {...options} retry={options.reload} />
      <form onSubmit={submit}>
        <fieldset disabled={busy !== null || options.loading || !options.data}>
          <legend className="screen-reader-text">Content to export</legend>
          {(
            [
              ["all", "All content"],
              ["posts", "Posts"],
              ["pages", "Pages"],
              ["attachment", "Media"],
            ] as const
          ).map(([content, label]) => (
            <div className="export-content-choice" key={content}>
              <p>
                <label>
                  <input
                    type="radio"
                    name="export-content"
                    value={content}
                    checked={selection.content === content}
                    onChange={() =>
                      setSelection({ ...emptyExportSelection, content })
                    }
                  />{" "}
                  {label}
                </label>
              </p>
              {selection.content === content && content === "all" && (
                <p className="description">
                  This will contain all of your posts, pages, comments,
                  categories, tags, navigation, and reusable content. Media
                  files remain external URLs in XML.
                </p>
              )}
              {selection.content === content && content !== "all" && (
                <div className="export-filters">
                  {content === "posts" && (
                    <p>
                      <label>
                        Categories:{" "}
                        <select
                          aria-label="Export category"
                          value={selection.category}
                          onChange={(event) =>
                            set("category", event.target.value)
                          }
                        >
                          <option value="">All</option>
                          {exportCategoryLabels(
                            options.data?.categories || [],
                          ).map((category) => (
                            <option key={category.id} value={category.id}>
                              {category.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    </p>
                  )}
                  <p>
                    <label>
                      Authors:{" "}
                      <select
                        aria-label="Export author"
                        value={selection.author}
                        onChange={(event) => set("author", event.target.value)}
                      >
                        <option value="">All</option>
                        {options.data?.authors.map((author) => (
                          <option key={author.id} value={author.id}>
                            {author.displayName}
                          </option>
                        ))}
                      </select>
                    </label>
                  </p>
                  <p>Date range:</p>
                  <div className="export-date-range">
                    <label>
                      <span className="screen-reader-text">Start month</span>
                      <select
                        aria-label="Start month"
                        value={selection.startDate}
                        onChange={(event) =>
                          set("startDate", event.target.value)
                        }
                      >
                        <option value="">Start date</option>
                        {months.map((month) => (
                          <option key={month} value={month}>
                            {monthLabel(month)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span className="screen-reader-text">End month</span>
                      <select
                        aria-label="End month"
                        value={selection.endDate}
                        onChange={(event) => set("endDate", event.target.value)}
                      >
                        <option value="">End date</option>
                        {months.map((month) => (
                          <option key={month} value={month}>
                            {monthLabel(month)}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  {!months.length && (
                    <p className="description">
                      No {content === "attachment" ? "media" : content} are
                      available for date filtering.
                    </p>
                  )}
                  {content !== "attachment" && (
                    <p>
                      <label>
                        Status:{" "}
                        <select
                          aria-label="Export status"
                          value={selection.status}
                          onChange={(event) =>
                            set("status", event.target.value)
                          }
                        >
                          <option value="">All</option>
                          {(
                            [
                              ["publish", "Published"],
                              ["future", "Scheduled"],
                              ["draft", "Draft"],
                              ["pending", "Pending"],
                              ["private", "Private"],
                              ["trash", "Trash"],
                            ] as const
                          ).map(([value, text]) => (
                            <option key={value} value={value}>
                              {text}
                            </option>
                          ))}
                        </select>
                      </label>
                    </p>
                  )}
                </div>
              )}
            </div>
          ))}
          <p className="submit">
            <button className="button button-primary">
              {busy === "xml" ? "Preparing export…" : "Download Export File"}
            </button>
          </p>
        </fieldset>
      </form>
      <hr />
      <h2>WorldAct full archive</h2>
      <p>
        Download a separate JSON archive of all posts, pages, terms, comments,
        navigation, templates, styles, settings, and supported media files. JSON
        archives embed up to 64 MiB of media. The content filters above apply to
        XML only. Account passwords and session data are excluded.
      </p>
      <p>
        <button
          type="button"
          className="button"
          disabled={busy !== null}
          onClick={() => void exportFile("json")}
        >
          {busy === "json"
            ? "Preparing archive…"
            : "Download Full JSON Archive"}
        </button>
      </p>
    </div>
  );
}
