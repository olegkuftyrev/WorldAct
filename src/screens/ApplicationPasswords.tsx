import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, date, json } from "../api";
import {
  errorText,
  Modal,
  Notice,
  ResourceState,
  useResource,
} from "../components/AdminUI";
import "../application-passwords.css";

type ApplicationPassword = {
  uuid: string;
  appId: string | null;
  name: string;
  created: string;
  lastUsed: string | null;
  lastIp: string | null;
};
export default function ApplicationPasswords({
  userId,
  self,
}: {
  userId: number;
  self: boolean;
}) {
  const endpoint = self
    ? "/profile/application-passwords"
    : `/users/${userId}/application-passwords`;
  const resource = useResource<{ passwords: ApplicationPassword[] }>(endpoint);
  const [name, setName] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [secret, setSecret] = useState<{
    password: string;
    record: ApplicationPassword;
  } | null>(null);
  const [confirming, setConfirming] = useState<
    ApplicationPassword | "all" | null
  >(null);
  const [renaming, setRenaming] = useState<ApplicationPassword | null>(null),
    [newName, setNewName] = useState("");
  const active = useRef(userId);
  active.current = userId;
  useEffect(() => {
    setSecret(null);
    setName("");
    setError("");
    setNotice("");
    setConfirming(null);
    setRenaming(null);
  }, [userId]);
  async function create(event: FormEvent) {
    event.preventDefault();
    if (secret) {
      setError(
        "Save the displayed application password and select Done before creating another.",
      );
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    const target = userId;
    try {
      const result = await api<{
        applicationPassword: ApplicationPassword;
        password: string;
      }>(endpoint, json("POST", { name: name.trim() }));
      if (active.current === target) {
        setSecret({
          password: result.password,
          record: result.applicationPassword,
        });
        setName("");
        setNotice("Application password created.");
        await resource.reload();
      }
    } catch (reason) {
      if (active.current === target) setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }
  async function revoke() {
    if (!confirming) return;
    setBusy(true);
    setError("");
    try {
      await api(
        confirming === "all"
          ? endpoint
          : `${endpoint}/${encodeURIComponent(confirming.uuid)}`,
        json("DELETE"),
      );
      if (confirming === "all" || confirming.uuid === secret?.record.uuid)
        setSecret(null);
      setNotice(
        confirming === "all"
          ? "All application passwords revoked."
          : "Application password revoked.",
      );
      setConfirming(null);
      await resource.reload();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }
  async function rename(event: FormEvent) {
    event.preventDefault();
    if (!renaming) return;
    setBusy(true);
    setError("");
    try {
      await api(
        `${endpoint}/${encodeURIComponent(renaming.uuid)}`,
        json("PUT", { name: newName.trim() }),
      );
      setRenaming(null);
      setNotice("Application password name updated.");
      await resource.reload();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="worldact-application-passwords"
      aria-labelledby="application-passwords-heading"
    >
      <h2 id="application-passwords-heading">Application Passwords</h2>
      <p>
        Application passwords let approved applications access the REST API with
        this account's permissions. Create a separate named password for each
        application so you can revoke its access.
      </p>
      <ResourceState
        loading={resource.loading}
        error={resource.error}
        retry={resource.reload}
      />
      {error && !confirming && !renaming && <Notice error>{error}</Notice>}
      {notice && <Notice onDismiss={() => setNotice("")}>{notice}</Notice>}
      {secret && (
        <div className="notice notice-success application-password-secret">
          <h3>Save your application password</h3>
          <p>Copy this password now. It is shown only once.</p>
          <label htmlFor="application-password-secret">
            Password for {secret.record.name}
          </label>
          <input
            id="application-password-secret"
            type="text"
            readOnly
            value={secret.password}
            autoComplete="off"
            spellCheck={false}
            onFocus={(event) => event.target.select()}
          />
          <div className="application-password-actions">
            <button
              className="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(secret.password);
                  setNotice("Application password copied.");
                } catch {
                  setError(
                    "Copy could not be completed. Select the password and copy it with your keyboard.",
                  );
                }
              }}
            >
              Copy Password
            </button>
            <button className="button" onClick={() => setSecret(null)}>
              Done
            </button>
          </div>
        </div>
      )}
      <form className="application-password-create" onSubmit={create}>
        <label htmlFor="application-password-name">
          New Application Password Name
        </label>
        <input
          type="text"
          className="regular-text"
          id="application-password-name"
          required
          maxLength={200}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="For example, Desktop publishing app"
        />
        <p className="description">
          Use a name that helps you recognize the application later.
        </p>
        <button className="button" disabled={busy || !name.trim() || !!secret}>
          {busy ? "Working…" : "Add New Application Password"}
        </button>
      </form>
      <table className="wp-list-table widefat fixed striped application-passwords-table">
        <thead>
          <tr>
            <th className="column-name">Name</th>
            <th>Created</th>
            <th>Last Used</th>
            <th>Last IP</th>
            <th className="column-revoke">Actions</th>
          </tr>
        </thead>
        <tbody>
          {resource.data?.passwords.map((record) => (
            <tr key={record.uuid}>
              <td className="column-name column-primary">
                <strong>{record.name}</strong>
              </td>
              <td data-colname="Created">{date(record.created)}</td>
              <td data-colname="Last Used">
                {record.lastUsed ? date(record.lastUsed) : "Never"}
              </td>
              <td data-colname="Last IP">{record.lastIp || "—"}</td>
              <td data-colname="Actions">
                <div className="application-password-actions">
                  <button
                    type="button"
                    className="button-link"
                    disabled={busy}
                    onClick={() => {
                      setRenaming(record);
                      setNewName(record.name);
                      setError("");
                    }}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    className="button-link button-link-delete"
                    disabled={busy}
                    onClick={() => {
                      setConfirming(record);
                      setError("");
                    }}
                  >
                    Revoke
                  </button>
                </div>
              </td>
            </tr>
          ))}
          {!resource.loading &&
            resource.data &&
            !resource.data.passwords.length && (
              <tr className="no-items">
                <td colSpan={5}>No application passwords found.</td>
              </tr>
            )}
        </tbody>
      </table>
      {!!resource.data?.passwords.length && (
        <p>
          <button
            type="button"
            className="button button-link-delete"
            disabled={busy}
            onClick={() => {
              setConfirming("all");
              setError("");
            }}
          >
            Revoke All Application Passwords
          </button>
        </p>
      )}
      {confirming && (
        <Modal
          title={
            confirming === "all"
              ? "Revoke All Application Passwords"
              : "Revoke Application Password"
          }
          close={() => {
            if (!busy) setConfirming(null);
          }}
        >
          <p>
            {confirming === "all" ? (
              "All applications using this account's application passwords will lose API access."
            ) : (
              <>
                The application using <strong>{confirming.name}</strong> will
                lose API access.
              </>
            )}
          </p>
          <p>You can create a new password later to grant access again.</p>
          {error && <Notice error>{error}</Notice>}
          <div className="application-password-actions">
            <button
              className="button"
              disabled={busy}
              onClick={() => setConfirming(null)}
            >
              Cancel
            </button>
            <button
              className="button button-danger"
              disabled={busy}
              onClick={() => void revoke()}
            >
              {busy
                ? "Revoking…"
                : confirming === "all"
                  ? "Revoke All"
                  : "Revoke"}
            </button>
          </div>
        </Modal>
      )}
      {renaming && (
        <Modal
          title="Rename Application Password"
          close={() => {
            if (!busy) setRenaming(null);
          }}
        >
          <form onSubmit={rename}>
            <label htmlFor="rename-application-password">Name</label>
            <input
              id="rename-application-password"
              className="regular-text"
              required
              maxLength={200}
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              autoFocus
            />
            {error && <Notice error>{error}</Notice>}
            <p className="application-password-actions">
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => setRenaming(null)}
              >
                Cancel
              </button>
              <button
                className="button button-primary"
                disabled={busy || !newName.trim()}
              >
                {busy ? "Saving…" : "Update Name"}
              </button>
            </p>
          </form>
        </Modal>
      )}
    </section>
  );
}
