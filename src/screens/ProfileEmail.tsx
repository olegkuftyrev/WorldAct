import { useContext, useEffect, useState, type FormEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import { api, ApiError, json, type User } from "../api";
import {
  Session,
  Notice,
  ResourceState,
  errorText,
} from "../components/AdminUI";
import { AccountLayout } from "./Accounts";
import type { PendingAdminEmail } from "./SiteIdentity";

export type PendingProfileEmail = PendingAdminEmail;

export function deliveryMessage(delivery: string | undefined) {
  return delivery === "local-outbox"
    ? "The confirmation email is available in the local outgoing mail."
    : delivery === "sent"
      ? "A confirmation email has been sent."
      : "The confirmation email is queued. Check outgoing mail for delivery status.";
}

export function ProfileEmailNotice({
  pending,
  currentEmail,
  onChanged,
}: {
  pending: PendingProfileEmail | null;
  currentEmail: string;
  onChanged: (pending: PendingProfileEmail | null) => void;
}) {
  const { user } = useContext(Session);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  async function run(operation: "cancel" | "resend") {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (operation === "cancel") {
        await api("/profile/email", json("DELETE"));
        onChanged(null);
      } else {
        const result = await api<{
          pending: PendingProfileEmail;
          delivery: string;
        }>("/profile/email/resend", json("POST"));
        onChanged(result.pending);
        setNotice(deliveryMessage(result.delivery));
      }
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }
  if (!pending) return null;
  return (
    <div className="pending-admin-email">
      <p>
        {pending.expired
          ? "The confirmation link for"
          : "There is a pending change of your email to"}{" "}
        <strong>{pending.email}</strong>
        {pending.expired ? " has expired." : "."} Your current email remains{" "}
        <strong>{currentEmail}</strong> until you confirm the new address.
      </p>
      <p>
        {pending.expired
          ? "Resend to request a new confirmation link."
          : `Confirm before ${new Date(pending.expiresAt).toLocaleString()}.`}
      </p>
      <div className="identity-actions">
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() => void run("resend")}
        >
          {busy ? "Please wait…" : "Resend confirmation"}
        </button>
        <button
          type="button"
          className="button-link"
          disabled={busy}
          onClick={() => void run("cancel")}
        >
          Cancel email change
        </button>
        {user?.role === "administrator" && (
          <Link to="/admin/tools?tab=mail">View outgoing mail</Link>
        )}
      </div>
      {error && <Notice error>{error}</Notice>}
      {notice && <p role="status">{notice}</p>}
    </div>
  );
}

export default function ProfileEmailConfirmation() {
  const { user, setUser } = useContext(Session),
    location = useLocation();
  const token = new URLSearchParams(location.search).get("token") || "";
  const [preview, setPreview] = useState<{
    email: string;
    expiresAt: string;
    siteTitle: string;
  } | null>(null);
  const [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [complete, setComplete] = useState(false),
    [unauthorized, setUnauthorized] = useState(false);
  useEffect(() => {
    let active = true;
    setPreview(null);
    setError("");
    setComplete(false);
    setUnauthorized(false);
    if (!user) return;
    setLoading(true);
    api<typeof preview>(
      `/profile/email/confirmation?${new URLSearchParams({ token })}`,
    )
      .then((value) => {
        if (active) setPreview(value);
      })
      .catch((reason) => {
        if (active) {
          setError(errorText(reason));
          if (reason instanceof ApiError && reason.status === 401) {
            setUnauthorized(true);
            setUser(null);
          }
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [token, user?.id]);
  async function confirm(event: FormEvent) {
    event.preventDefault();
    if (!preview || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ user: User }>(
        "/profile/email/confirmation",
        json("POST", { token }),
      );
      setUser({ ...user!, ...result.user });
      setComplete(true);
      setPreview(null);
    } catch (reason) {
      setError(errorText(reason));
      if (reason instanceof ApiError && [409, 410].includes(reason.status))
        setPreview(null);
      if (reason instanceof ApiError && reason.status === 401) {
        setUnauthorized(true);
        setUser(null);
      }
    } finally {
      setBusy(false);
    }
  }
  const from = location.pathname + location.search;
  return (
    <AccountLayout>
      {!user || unauthorized ? (
        <>
          <p className="message">
            Sign in to the account that requested this email change to continue.
          </p>
          <p>
            <Link
              className="button button-primary button-large"
              to="/login"
              state={{ from }}
            >
              Log In
            </Link>
          </p>
        </>
      ) : (
        <>
          <ResourceState loading={loading} error="" />
          {error && (
            <div id="login_error" role="alert">
              {error}
              <p>
                <Link to="/admin/profile">Return to your profile</Link>
              </p>
            </div>
          )}
          {complete ? (
            <>
              <p className="message">Your email address has been updated.</p>
              <p>
                <Link to="/admin/profile">Return to your profile</Link>
              </p>
            </>
          ) : (
            preview && (
              <>
                <p className="message">
                  Confirm your email address for {preview.siteTitle}.
                </p>
                <form onSubmit={confirm}>
                  <p>
                    Change the email address for{" "}
                    <strong>{user.username}</strong> to{" "}
                    <strong>{preview.email}</strong>?
                  </p>
                  <p>
                    This link expires{" "}
                    {new Date(preview.expiresAt).toLocaleString()}. Opening this
                    page does not change your address.
                  </p>
                  <p className="submit">
                    <button
                      className="button button-primary button-large"
                      disabled={busy}
                    >
                      {busy ? "Confirming…" : "Confirm Email Address"}
                    </button>
                  </p>
                </form>
              </>
            )
          )}
        </>
      )}
    </AccountLayout>
  );
}
