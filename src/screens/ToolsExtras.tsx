import { useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, json, type Post } from "../api";
import {
  Notice,
  ResourceState,
  errorText,
  useResource,
} from "../components/AdminUI";
import "../tools-extras.css";

type Scalar = string | number | boolean | null;
type HealthInfo = {
  generatedAt: string;
  sections: { id: string; label: string; fields: Record<string, Scalar> }[];
  tables: { name: string; estimated_rows: number; bytes: number | string }[];
  redacted: string[];
};
const scalar = (value: Scalar) =>
  value === null
    ? "Not set"
    : typeof value === "boolean"
      ? value
        ? "Yes"
        : "No"
      : String(value);
const human = (value: string) =>
  value.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
function debugText(info: HealthInfo) {
  return [
    `### WorldAct Site Health Information`,
    `Generated: ${info.generatedAt}`,
    ...info.sections.flatMap((section) => [
      "",
      `## ${section.label}`,
      ...Object.entries(section.fields).map(
        ([name, value]) => `${name}: ${scalar(value)}`,
      ),
    ]),
    "",
    "## Database tables",
    ...info.tables.map(
      (table) =>
        `${table.name}: ${table.estimated_rows} estimated rows; ${table.bytes} bytes`,
    ),
    "",
    `Excluded: ${info.redacted.join(", ")}`,
  ].join("\n");
}
export function HealthDetails({ children }: { children: ReactNode }) {
  const [params, setParams] = useSearchParams();
  const info = params.get("view") === "info",
    resource = useResource<HealthInfo>(info ? "/tools/health/info" : null);
  const [notice, setNotice] = useState(""),
    [error, setError] = useState("");
  function change(view: string) {
    const next = new URLSearchParams(params);
    next.set("tab", "health");
    view ? next.set("view", view) : next.delete("view");
    setParams(next);
    setNotice("");
    setError("");
  }
  return (
    <section className="worldact-health-details">
      <nav className="health-view-tabs" aria-label="Site Health views">
        <button
          type="button"
          aria-current={!info ? "page" : undefined}
          className={!info ? "current" : ""}
          onClick={() => change("")}
        >
          Status
        </button>
        <button
          type="button"
          aria-current={info ? "page" : undefined}
          className={info ? "current" : ""}
          onClick={() => change("info")}
        >
          Info
        </button>
      </nav>
      {!info ? (
        children
      ) : (
        <>
          <h2>Site Health Info</h2>
          <p>
            This information describes your site's current runtime, database,
            storage, themes, and mail configuration.
          </p>
          <ResourceState
            loading={resource.loading}
            error={resource.error}
            retry={resource.reload}
          />
          {resource.data && (
            <>
              <div className="identity-actions">
                <button
                  type="button"
                  className="button button-primary"
                  onClick={async () => {
                    setError("");
                    try {
                      await navigator.clipboard.writeText(
                        debugText(resource.data!),
                      );
                      setNotice("Site information copied to clipboard.");
                    } catch {
                      setError(
                        "Copy could not be completed. Select the information below and copy it with your keyboard.",
                      );
                    }
                  }}
                >
                  Copy site info to clipboard
                </button>
                <button
                  type="button"
                  className="button"
                  disabled={resource.loading}
                  onClick={() => void resource.reload()}
                >
                  Refresh information
                </button>
              </div>
              {notice && <p role="status">{notice}</p>}
              {error && <Notice error>{error}</Notice>}
              <details className="worldact-health-check">
                <summary>View copyable information</summary>
                <textarea
                  aria-label="Site debug information"
                  readOnly
                  rows={12}
                  value={debugText(resource.data)}
                  onFocus={(event) => event.target.select()}
                />
              </details>
              {resource.data.sections.map((section) => (
                <details className="worldact-health-check" key={section.id}>
                  <summary>{section.label}</summary>
                  <table className="widefat health-info-table">
                    <tbody>
                      {Object.entries(section.fields).map(([name, value]) => (
                        <tr key={name}>
                          <th scope="row">{human(name)}</th>
                          <td>{scalar(value)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              ))}
              <details className="worldact-health-check">
                <summary>Database tables</summary>
                <table className="widefat health-info-table">
                  <thead>
                    <tr>
                      <th>Table</th>
                      <th>Estimated rows</th>
                      <th>Size</th>
                    </tr>
                  </thead>
                  <tbody>
                    {resource.data.tables.map((table) => (
                      <tr key={table.name}>
                        <th scope="row">{table.name}</th>
                        <td>{table.estimated_rows}</td>
                        <td>
                          {new Intl.NumberFormat().format(Number(table.bytes))}{" "}
                          bytes
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
              <p className="description">
                Generated {new Date(resource.data.generatedAt).toLocaleString()}
                . Excluded from this report: {resource.data.redacted.join(", ")}
                .
              </p>
            </>
          )}
        </>
      )}
    </section>
  );
}
type PolicyGuide = {
  siteTitle: string;
  siteUrl: string;
  generatedAt: string;
  sections: { id: string; title: string; text: string[] }[];
  reviewRequired: string[];
};
export function PrivacyPolicyGuide({
  onCreated,
}: {
  onCreated: (post: Post) => Promise<void> | void;
}) {
  const resource = useResource<PolicyGuide>("/tools/privacy/policy-guide");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [created, setCreated] = useState<Post | null>(null);
  function suggestedText() {
    return (
      resource.data?.sections
        .map((section) => [section.title, ...section.text].join("\n\n"))
        .join("\n\n") || ""
    );
  }
  return (
    <div className="worldact-privacy-guide">
      <p>
        Create a draft policy from the suggested text, then review it to
        describe how your site collects and uses personal data.
      </p>
      <ResourceState
        loading={resource.loading}
        error={resource.error}
        retry={resource.reload}
      />
      {resource.data && (
        <>
          <details>
            <summary>Privacy Policy Guide</summary>
            <div className="privacy-guide-content">
              <p>
                Suggested text for <strong>{resource.data.siteTitle}</strong> (
                {resource.data.siteUrl}).
              </p>
              {resource.data.sections.map((section) => (
                <section key={section.id}>
                  <h3>{section.title}</h3>
                  {section.text.map((text, index) => (
                    <p key={index}>{text}</p>
                  ))}
                </section>
              ))}
              <div className="privacy-retained-data">
                <h3>Review before publishing</h3>
                <ul>
                  {resource.data.reviewRequired.map((text, index) => (
                    <li key={index}>{text}</li>
                  ))}
                </ul>
              </div>
              <button
                type="button"
                className="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(suggestedText());
                    setNotice("Suggested policy text copied.");
                  } catch {
                    setError(
                      "Copy could not be completed. Select the suggested text and copy it with your keyboard.",
                    );
                  }
                }}
              >
                Copy suggested text
              </button>
            </div>
          </details>
          <div className="identity-actions">
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                setNotice("");
                try {
                  const result = await api<{
                    post: Post;
                    reviewRequired: string[];
                  }>(
                    "/tools/privacy/policy-draft",
                    json("POST", { setAsPolicy: true }),
                  );
                  setCreated(result.post);
                  await onCreated(result.post);
                  setNotice(
                    "A draft policy page was created and selected. Review and publish it in the editor.",
                  );
                } catch (reason) {
                  setError(errorText(reason));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Creating…" : "Create New Privacy Policy Page"}
            </button>
            {created && (
              <Link
                className="button button-primary"
                to={`/admin/pages/${created.id}`}
              >
                Edit draft policy
              </Link>
            )}
          </div>
        </>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && <Notice error>{error}</Notice>}
    </div>
  );
}
