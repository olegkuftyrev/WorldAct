import {
  useContext,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Link,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import { api, date, json, type User } from "../api";
import {
  Brand,
  Icon,
  Modal,
  Notice,
  ResourceState,
  ScreenTabs,
  Session,
  errorText,
  useResource,
} from "../components/AdminUI";
import "../accounts.css";

type RegistrationSettings = { enabled: boolean };
function AccountLayout({ children }: { children: ReactNode }) {
  return (
    <div id="login" className="worldact-account-screen">
      <h1>
        <Link to="/" aria-label="WorldAct home">
          <Brand />
          <span className="screen-reader-text">WorldAct</span>
        </Link>
      </h1>
      {children}
      <p id="nav">
        <Link to="/login">Log in</Link> |{" "}
        <Link to="/lost-password">Lost your password?</Link>
      </p>
      <p id="backtoblog">
        <Link to="/">← Go to WorldAct</Link>
      </p>
    </div>
  );
}
export function RegistrationLink() {
  const registration = useResource<RegistrationSettings>("/auth/registration");
  return registration.data?.enabled ? (
    <>
      <Link to="/register">Register</Link>
      <span aria-hidden="true"> | </span>
    </>
  ) : null;
}
export function Register() {
  const registration = useResource<RegistrationSettings>("/auth/registration");
  const navigate = useNavigate();
  const [username, setUsername] = useState(""),
    [email, setEmail] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api<{ ok: true; message: string; delivery: string }>(
        "/auth/register",
        json("POST", { username, email }),
      );
      navigate("/check-email", {
        replace: true,
        state: { message: result.message, delivery: result.delivery },
      });
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <AccountLayout>
      <ResourceState
        loading={registration.loading}
        error={registration.error}
        retry={registration.reload}
      />
      {error && (
        <div id="login_error" role="alert">
          {error}
        </div>
      )}
      {registration.data?.enabled ? (
        <>
          <p className="message register">Register For This Site</p>
          <form id="registerform" onSubmit={submit}>
            <p>
              <label htmlFor="register-username">Username</label>
              <input
                id="register-username"
                className="input"
                autoComplete="username"
                required
                maxLength={60}
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
            </p>
            <p>
              <label htmlFor="register-email">Email</label>
              <input
                id="register-email"
                className="input"
                type="email"
                autoComplete="email"
                required
                maxLength={254}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </p>
            <p id="reg_passmail">
              Registration confirmation will be emailed to you.
            </p>
            <p className="submit">
              <button
                className="button button-primary button-large"
                disabled={busy}
              >
                {busy ? "Registering…" : "Register"}
              </button>
            </p>
          </form>
        </>
      ) : (
        registration.data &&
        !registration.data.enabled && (
          <div id="login_error" role="status">
            User registration is currently not allowed.
          </div>
        )
      )}
    </AccountLayout>
  );
}
export function CheckEmail() {
  const location = useLocation();
  const state = location.state as {
    message?: string;
    delivery?: string;
  } | null;
  return (
    <AccountLayout>
      <p className="message" role="status">
        {state?.message ||
          "Registration complete. Check your email for a link to set your password."}
      </p>
      {state?.delivery === "local-outbox" && (
        <p className="account-delivery-note">
          Email delivery is local. A site administrator can open the message in
          Tools → Mail.
        </p>
      )}
    </AccountLayout>
  );
}
type PublicPrivacyRequest = {
  type: "export" | "erase";
  status: string;
  emailMasked: string;
  expiresAt: string;
};
export function PrivacyConfirmation() {
  const [params] = useSearchParams();
  const token = params.get("token") || "";
  const resource = useResource<{
    request: PublicPrivacyRequest;
    message: string;
  }>(`/privacy/confirm?token=${encodeURIComponent(token)}`);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [confirmed, setConfirmed] = useState(false);
  async function confirm() {
    setBusy(true);
    setError("");
    try {
      await api("/privacy/confirm", json("POST", { token }));
      setConfirmed(true);
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  const request = resource.data?.request;
  const complete =
    confirmed ||
    Boolean(request && ["confirmed", "completed"].includes(request.status));
  return (
    <AccountLayout>
      <ResourceState
        loading={resource.loading}
        error={resource.error}
        retry={resource.reload}
      />
      {error && (
        <div id="login_error" role="alert">
          {error}
        </div>
      )}
      {complete ? (
        <div className="message privacy-confirmed" role="status">
          <h2>Action has been confirmed.</h2>
          <p>
            Your request is confirmed. The site administrator can now process
            it. You can close this window.
          </p>
        </div>
      ) : (
        request && (
          <>
            <div className="message">
              <h2>Confirm your personal data request</h2>
              <p>
                A request to {request.type === "export" ? "export" : "erase"}{" "}
                personal data associated with{" "}
                <strong>{request.emailMasked}</strong> needs your confirmation.
              </p>
            </div>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void confirm();
              }}
            >
              <p>
                {request.type === "erase"
                  ? "Confirming this request allows the site administrator to anonymize identifying details in your comments. The administrator reviews the request before performing erasure."
                  : "Confirming this request allows the site administrator to prepare an export of personal data associated with your email address."}
              </p>
              <p>If you did not make this request, close this page.</p>
              <p className="submit">
                <button
                  className="button button-primary button-large"
                  disabled={busy}
                >
                  {busy ? "Confirming…" : "Confirm Request"}
                </button>
              </p>
            </form>
          </>
        )
      )}
    </AccountLayout>
  );
}

type PrivacyType = "export" | "erase";
type PrivacyRequest = {
  id: number;
  email: string;
  type: PrivacyType;
  status: string;
  createdAt: string;
  updatedAt: string;
  confirmedAt: string | null;
  completedAt: string | null;
  confirmationExpiresAt: string | null;
  hasExport: boolean;
  downloadExpiresAt: string | null;
  error: string | null;
  result: Record<string, unknown> | null;
};
type PrivacyResult = {
  requests: PrivacyRequest[];
  counts: Record<string, number>;
  pagination: {
    page: number;
    perPage: number;
    totalRequests: number;
    totalPages: number;
  };
  retention?: Record<string, unknown>;
};
type RequestDialog = {
  action: "confirm" | "erase" | "delete";
  requests: PrivacyRequest[];
} | null;
const statusLabels: Record<string, string> = {
  pending: "Pending",
  confirmed: "Confirmed",
  completed: "Completed",
  failed: "Failed",
};
export function PrivacyRequests({ type }: { type: PrivacyType }) {
  const { user } = useContext(Session);
  const [params, setParams] = useSearchParams();
  const status = params.get("status") || "all",
    search = params.get("search") || "",
    page = Math.max(1, Number(params.get("page")) || 1),
    orderby = params.get("orderby") || "createdAt",
    order = params.get("order") || "desc";
  const query = new URLSearchParams({
    type,
    status,
    page: String(page),
    perPage: "20",
    orderby,
    order,
  });
  if (search) query.set("search", search);
  const resource = useResource<PrivacyResult>(
    `/tools/privacy/requests?${query}`,
  );
  const [email, setEmail] = useState(""),
    [sendConfirmation, setSendConfirmation] = useState(true),
    [verified, setVerified] = useState(false),
    [searchInput, setSearchInput] = useState(search),
    [selected, setSelected] = useState<number[]>([]),
    [busy, setBusy] = useState<number | "new" | "bulk" | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [dialog, setDialog] = useState<RequestDialog>(null),
    [attested, setAttested] = useState(false);
  useEffect(() => {
    setSelected([]);
    setSearchInput(search);
    setError("");
    setNotice("");
    setDialog(null);
  }, [type, status, search, page]);
  const requests = resource.data?.requests || [],
    pagination = resource.data?.pagination;
  const title =
    type === "export" ? "Export Personal Data" : "Erase Personal Data";
  const admin = user?.role === "administrator";
  function change(nextValues: Record<string, string>) {
    const next = new URLSearchParams(params);
    next.set("tab", type === "export" ? "privacy-export" : "privacy-erase");
    for (const [key, value] of Object.entries(nextValues))
      value ? next.set(key, value) : next.delete(key);
    if (!("page" in nextValues)) next.delete("page");
    setParams(next);
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    if (!sendConfirmation && !verified) return;
    setBusy("new");
    setError("");
    setNotice("");
    try {
      const result = await api<{ request: PrivacyRequest; message: string }>(
        "/tools/privacy/requests",
        json("POST", { email, type, sendConfirmation }),
      );
      setEmail("");
      setVerified(false);
      setNotice(result.message || "Request added.");
      await resource.reload();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(null);
    }
  }
  async function action(
    request: PrivacyRequest,
    operation: "resend" | "export",
  ) {
    setBusy(request.id);
    setError("");
    setNotice("");
    try {
      const response = await api<{ message?: string }>(
        `/tools/privacy/requests/${request.id}/${operation}`,
        json("POST", {}),
      );
      setNotice(
        operation === "resend"
          ? response.message ||
              "Confirmation email prepared. Delivery details are available in Tools → Mail."
          : "Personal data export generated. Download the file from the request row.",
      );
      await resource.reload();
    } catch (error) {
      setError(errorText(error));
      await resource.reload();
    } finally {
      setBusy(null);
    }
  }
  function review(
    action: NonNullable<RequestDialog>["action"],
    requests: PrivacyRequest[],
  ) {
    setAttested(false);
    setDialog({ action, requests });
    setError("");
  }
  async function execute() {
    if (!dialog || (dialog.action !== "delete" && !attested)) return;
    setBusy(dialog.requests.length > 1 ? "bulk" : dialog.requests[0].id);
    setError("");
    setNotice("");
    try {
      for (const request of dialog.requests) {
        await api(
          `/tools/privacy/requests/${request.id}${dialog.action === "delete" ? "" : `/${dialog.action}`}`,
          json(
            dialog.action === "delete"
              ? "DELETE"
              : dialog.action === "confirm"
                ? "PUT"
                : "POST",
            dialog.action === "delete" ? undefined : {},
          ),
        );
      }
      setNotice(
        dialog.action === "erase"
          ? "Personal data erasure completed. Identifying comment details were anonymized; retained data is listed in the request result."
          : dialog.action === "confirm"
            ? "Request marked as confirmed."
            : "Request deleted.",
      );
      setDialog(null);
      setSelected([]);
    } catch (error) {
      setError(errorText(error));
    } finally {
      await resource.reload();
      setBusy(null);
    }
  }
  const checkAll =
    requests.length > 0 &&
    requests.every((request) => selected.includes(request.id));
  const header = (
    <tr>
      <td className="manage-column column-cb check-column">
        <input
          aria-label="Select all requests"
          type="checkbox"
          checked={checkAll}
          onChange={(event) =>
            setSelected(
              event.target.checked ? requests.map((request) => request.id) : [],
            )
          }
        />
      </td>
      <th scope="col" className="column-email column-primary">
        <button
          className="button-link table-sort"
          onClick={() =>
            change({
              orderby: "email",
              order: orderby === "email" && order === "asc" ? "desc" : "asc",
            })
          }
        >
          Requester {orderby === "email" ? (order === "asc" ? "↑" : "↓") : ""}
        </button>
      </th>
      <th scope="col" className="column-status">
        Status
      </th>
      <th scope="col" className="column-created">
        <button
          className="button-link table-sort"
          onClick={() =>
            change({
              orderby: "createdAt",
              order:
                orderby === "createdAt" && order === "desc" ? "asc" : "desc",
            })
          }
        >
          Requested{" "}
          {orderby === "createdAt" ? (order === "asc" ? "↑" : "↓") : ""}
        </button>
      </th>
      <th scope="col" className="column-actions">
        Next steps
      </th>
    </tr>
  );
  const pager = (
    <div className="tablenav-pages">
      <span className="displaying-num">
        {pagination?.totalRequests || 0}{" "}
        {(pagination?.totalRequests || 0) === 1 ? "item" : "items"}
      </span>
      {pagination && pagination.totalPages > 1 && (
        <span className="pagination-links">
          <button
            className="button"
            aria-label="Previous page"
            disabled={page <= 1}
            onClick={() => change({ page: String(page - 1) })}
          >
            ‹
          </button>
          <span>
            {page} of {pagination.totalPages}
          </span>
          <button
            className="button"
            aria-label="Next page"
            disabled={page >= pagination.totalPages}
            onClick={() => change({ page: String(page + 1) })}
          >
            ›
          </button>
        </span>
      )}
    </div>
  );
  return (
    <>
      <ScreenTabs />
      <main className="wrap privacy-requests-wrap">
        <h1>{title}</h1>
        <nav
          className="nav-tab-wrapper privacy-tools-tabs"
          aria-label="Privacy tools"
        >
          <Link
            className={`nav-tab ${type === "export" ? "nav-tab-active" : ""}`}
            to="/admin/tools?tab=privacy-export"
          >
            Export Personal Data
          </Link>
          <Link
            className={`nav-tab ${type === "erase" ? "nav-tab-active" : ""}`}
            to="/admin/tools?tab=privacy-erase"
          >
            Erase Personal Data
          </Link>
        </nav>
        {!admin ? (
          <Notice error>
            You do not have permission to manage personal data requests.
          </Notice>
        ) : (
          <>
            <p>
              {type === "export"
                ? "Create and manage requests to export known personal data for an email address. Export files contain account profile fields and matching comments."
                : "Create and manage requests to erase personal data. Erasure anonymizes matching comment names, email addresses, website URLs, and account links. Accounts, posts, pages, media, comment text, moderation status, and request audit records are retained."}
            </p>
            {notice && (
              <Notice onDismiss={() => setNotice("")}>{notice}</Notice>
            )}
            {error && (
              <Notice error onDismiss={() => setError("")}>
                {error}
              </Notice>
            )}
            <form className="wp-privacy-request-form" onSubmit={create}>
              <h2>
                Add Data {type === "export" ? "Export" : "Erasure"} Request
              </h2>
              <table className="form-table">
                <tbody>
                  <tr>
                    <th scope="row">
                      <label htmlFor="privacy-email">Email address</label>
                    </th>
                    <td>
                      <input
                        id="privacy-email"
                        className="regular-text"
                        type="email"
                        autoComplete="off"
                        required
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                      />
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">Confirmation email</th>
                    <td>
                      <label>
                        <input
                          type="checkbox"
                          checked={sendConfirmation}
                          onChange={(event) => {
                            setSendConfirmation(event.target.checked);
                            setVerified(false);
                          }}
                        />{" "}
                        Send personal data{" "}
                        {type === "export" ? "export" : "erasure"} confirmation
                        email.
                      </label>
                      {!sendConfirmation && (
                        <div className="privacy-admin-verification">
                          <p>
                            This request will be marked as confirmed without an
                            email confirmation.
                          </p>
                          <label>
                            <input
                              type="checkbox"
                              required
                              checked={verified}
                              onChange={(event) =>
                                setVerified(event.target.checked)
                              }
                            />{" "}
                            I have verified this request with the requester.
                          </label>
                        </div>
                      )}
                    </td>
                  </tr>
                </tbody>
              </table>
              <p className="submit">
                <button
                  className="button"
                  disabled={busy !== null || (!sendConfirmation && !verified)}
                >
                  {busy === "new" ? "Sending…" : "Send Request"}
                </button>
              </p>
            </form>
            <hr />
            <ResourceState
              loading={resource.loading}
              error={resource.error}
              retry={resource.reload}
            />
            <ul className="subsubsub">
              {["all", "pending", "confirmed", "completed", "failed"]
                .filter(
                  (value) =>
                    value === "all" ||
                    (resource.data?.counts[value] || 0) > 0 ||
                    status === value,
                )
                .map((value, index) => (
                  <li key={value}>
                    {index > 0 && " | "}
                    <button
                      className={`button-link ${status === value ? "current" : ""}`}
                      onClick={() => change({ status: value })}
                    >
                      {value === "all" ? "All" : statusLabels[value]}{" "}
                      <span className="count">
                        ({resource.data?.counts[value] || 0})
                      </span>
                    </button>
                  </li>
                ))}
            </ul>
            <form
              className="search-box"
              onSubmit={(event) => {
                event.preventDefault();
                change({ search: searchInput });
              }}
            >
              <label className="screen-reader-text" htmlFor="privacy-search">
                Search Requests
              </label>
              <input
                id="privacy-search"
                type="search"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
              />
              <button className="button">Search Requests</button>
            </form>
            <div className="tablenav top">
              <div className="alignleft actions">
                <button
                  className="button"
                  disabled={!selected.length || busy !== null}
                  onClick={() =>
                    review(
                      "delete",
                      requests.filter((request) =>
                        selected.includes(request.id),
                      ),
                    )
                  }
                >
                  Delete selected requests
                </button>
              </div>
              {pager}
            </div>
            <table className="wp-list-table widefat fixed striped privacy-requests">
              <thead>{header}</thead>
              <tbody>
                {requests.map((request) => {
                  const confirmed =
                    Boolean(request.confirmedAt) ||
                    ["confirmed", "completed"].includes(request.status);
                  return (
                    <tr key={request.id}>
                      <th scope="row" className="check-column">
                        <input
                          type="checkbox"
                          aria-label={`Select ${request.email}`}
                          checked={selected.includes(request.id)}
                          onChange={(event) =>
                            setSelected(
                              event.target.checked
                                ? [...selected, request.id]
                                : selected.filter((id) => id !== request.id),
                            )
                          }
                        />
                      </th>
                      <td className="column-email column-primary">
                        <strong>{request.email}</strong>
                        <div className="row-actions visible">
                          <button
                            className="button-link button-link-delete"
                            disabled={busy !== null}
                            onClick={() => review("delete", [request])}
                          >
                            Delete request
                          </button>
                        </div>
                      </td>
                      <td className="column-status" data-colname="Status">
                        <span
                          className={`privacy-status privacy-${request.status}`}
                        >
                          {statusLabels[request.status] || request.status}
                        </span>
                        {request.confirmedAt && (
                          <small>Confirmed {date(request.confirmedAt)}</small>
                        )}
                      </td>
                      <td className="column-created" data-colname="Requested">
                        {date(request.createdAt)}
                        {request.completedAt && (
                          <small>Completed {date(request.completedAt)}</small>
                        )}
                      </td>
                      <td className="column-actions" data-colname="Next steps">
                        {busy === request.id ? (
                          <span role="status">
                            <span className="spinner is-active" /> Working…
                          </span>
                        ) : (
                          <>
                            {!confirmed ? (
                              <>
                                <p>Waiting for confirmation.</p>
                                <div className="privacy-row-buttons">
                                  <button
                                    className="button"
                                    disabled={busy !== null}
                                    onClick={() =>
                                      void action(request, "resend")
                                    }
                                  >
                                    Resend email
                                  </button>
                                  <button
                                    className="button-link"
                                    disabled={busy !== null}
                                    onClick={() => review("confirm", [request])}
                                  >
                                    Mark confirmed
                                  </button>
                                </div>
                              </>
                            ) : type === "export" ? (
                              <div className="privacy-row-buttons">
                                {request.hasExport && (
                                  <a
                                    className="button"
                                    href={`/api/tools/privacy/requests/${request.id}/download`}
                                  >
                                    Download Personal Data
                                  </a>
                                )}
                                {request.status === "completed" ? (
                                  !request.hasExport && (
                                    <div>
                                      <p>
                                        This export has expired or was revoked.
                                      </p>
                                      <button
                                        className="button-link"
                                        onClick={() => {
                                          setEmail(request.email);
                                          setSendConfirmation(true);
                                          setVerified(false);
                                          document
                                            .getElementById("privacy-email")
                                            ?.focus();
                                        }}
                                      >
                                        Add a new export request
                                      </button>
                                    </div>
                                  )
                                ) : (
                                  <button
                                    className="button"
                                    disabled={busy !== null}
                                    onClick={() =>
                                      void action(request, "export")
                                    }
                                  >
                                    Export Personal Data
                                  </button>
                                )}
                              </div>
                            ) : request.status !== "completed" ? (
                              <button
                                className="button"
                                disabled={busy !== null}
                                onClick={() => review("erase", [request])}
                              >
                                Erase Personal Data
                              </button>
                            ) : (
                              <p>Request completed.</p>
                            )}
                            {request.error && (
                              <p className="privacy-request-error">
                                {request.error}
                              </p>
                            )}
                            {request.result && (
                              <details className="privacy-request-result">
                                <summary>View result</summary>
                                <PrivacyResultDetails result={request.result} />
                              </details>
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {!resource.loading && !requests.length && (
                  <tr className="no-items">
                    <td colSpan={5}>No requests found.</td>
                  </tr>
                )}
              </tbody>
              <tfoot>{header}</tfoot>
            </table>
            <div className="tablenav bottom">{pager}</div>
          </>
        )}
        {dialog && (
          <Modal
            title={
              dialog.action === "delete"
                ? "Delete personal data request"
                : dialog.action === "confirm"
                  ? "Mark request as confirmed"
                  : "Erase personal data"
            }
            close={() => {
              if (busy === null) setDialog(null);
            }}
          >
            <p>
              {dialog.action === "delete"
                ? "The selected request records and generated export files will be permanently deleted. This does not erase accounts or comments."
                : dialog.action === "confirm"
                  ? "Marking this request as confirmed allows an administrator to perform the requested action without email confirmation."
                  : "This action anonymizes identifying names, email addresses, website URLs, and account links in matching comments and revokes generated export downloads for this email address. It cannot be undone."}
            </p>
            <ul>
              {dialog.requests.map((request) => (
                <li key={request.id}>
                  <strong>{request.email}</strong> —{" "}
                  {request.type === "export" ? "Export" : "Erase"}
                </li>
              ))}
            </ul>
            {dialog.action === "erase" && (
              <div className="privacy-retained-data">
                <h2>Data that will be retained</h2>
                <p>
                  Accounts and profile details, published and unpublished posts
                  and pages, media, comment text and moderation status, and
                  privacy request audit records remain on the site.
                </p>
              </div>
            )}
            {dialog.action !== "delete" && (
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={attested}
                  onChange={(event) => setAttested(event.target.checked)}
                />
                {dialog.action === "confirm"
                  ? "I have verified this request with the requester."
                  : "I understand which personal data will be erased and which data will be retained."}
              </label>
            )}
            {error && <Notice error>{error}</Notice>}
            <p className="privacy-dialog-actions">
              <button
                className="button"
                disabled={busy !== null}
                onClick={() => setDialog(null)}
              >
                Cancel
              </button>
              <button
                className={`button ${dialog.action === "erase" || dialog.action === "delete" ? "button-danger" : "button-primary"}`}
                disabled={
                  busy !== null || (dialog.action !== "delete" && !attested)
                }
                onClick={() => void execute()}
              >
                {busy !== null
                  ? "Working…"
                  : dialog.action === "delete"
                    ? "Delete Request"
                    : dialog.action === "confirm"
                      ? "Mark Confirmed"
                      : "Erase Personal Data"}
              </button>
            </p>
          </Modal>
        )}
      </main>
    </>
  );
}
function PrivacyResultDetails({ result }: { result: Record<string, unknown> }) {
  return (
    <div>
      {Object.entries(result).map(([key, value]) =>
        Array.isArray(value) ? (
          <div key={key}>
            <strong>
              {key === "retained"
                ? "Retained data"
                : key === "messages"
                  ? "Details"
                  : key}
            </strong>
            <ul>
              {value
                .filter(
                  (item) =>
                    typeof item === "string" || typeof item === "number",
                )
                .map((item, index) => (
                  <li key={index}>{String(item)}</li>
                ))}
            </ul>
          </div>
        ) : typeof value === "number" || typeof value === "string" ? (
          <p key={key}>
            {key === "commentsAnonymized"
              ? "Comments anonymized"
              : key === "exportsRevoked"
                ? "Export downloads revoked"
                : key}
            : <strong>{String(value)}</strong>
          </p>
        ) : null,
      )}
    </div>
  );
}

export function DeleteUserDialog({
  target,
  users,
  currentUserId,
  onClose,
  onDeleted,
}: {
  target: User;
  users: User[];
  currentUserId: number;
  onClose: () => void;
  onDeleted: () => void | Promise<void>;
}) {
  const [choice, setChoice] = useState<"reassign" | "delete">("reassign"),
    [replacement, setReplacement] = useState(String(currentUserId)),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const query =
        choice === "delete"
          ? "deleteContent=true"
          : `reassignTo=${encodeURIComponent(replacement)}`;
      await api(`/users/${target.id}?${query}`, json("DELETE"));
      await onDeleted();
    } catch (error) {
      setError(errorText(error));
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Delete User"
      close={() => {
        if (!busy) onClose();
      }}
    >
      <form className="delete-user-form" onSubmit={submit}>
        <p>You have specified this user for deletion:</p>
        <p>
          <strong>
            ID #{target.id}: {target.username}
          </strong>{" "}
          ({target.displayName})
        </p>
        <p>What should be done with content owned by this user?</p>
        <fieldset disabled={busy}>
          <label className="checkbox-label">
            <input
              type="radio"
              name="delete-user-content"
              value="delete"
              checked={choice === "delete"}
              onChange={() => setChoice("delete")}
            />{" "}
            Delete all content.
          </label>
          {choice === "delete" && (
            <p className="description delete-user-warning">
              All posts, pages, and media owned by this user will be permanently
              deleted, including uploaded media files.
            </p>
          )}
          <label className="checkbox-label">
            <input
              type="radio"
              name="delete-user-content"
              value="reassign"
              checked={choice === "reassign"}
              onChange={() => setChoice("reassign")}
            />{" "}
            Attribute all content to:
          </label>
          <select
            aria-label="Reassign content to"
            value={replacement}
            disabled={choice !== "reassign"}
            onChange={(event) => setReplacement(event.target.value)}
            required
          >
            {users
              .filter((user) => user.id !== target.id)
              .map((user) => (
                <option key={user.id} value={user.id}>
                  {user.displayName} ({user.username})
                </option>
              ))}
          </select>
        </fieldset>
        <p className="description">Deleting the account cannot be undone.</p>
        {error && <Notice error>{error}</Notice>}
        <p className="privacy-dialog-actions">
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="button button-primary"
            disabled={busy || (choice === "reassign" && !replacement)}
          >
            {busy ? "Deleting…" : "Confirm Deletion"}
          </button>
        </p>
      </form>
    </Modal>
  );
}
