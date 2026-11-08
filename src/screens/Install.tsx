import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Link, useLocation } from "react-router-dom";
import { api, ApiError, json, type User } from "../api";
import {
  Brand,
  Icon,
  ResourceState,
  errorText,
  useResource,
} from "../components/AdminUI";
import "../install.css";

let rememberedToken = "";
function takeInstallationToken() {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  if (fragment.has("token")) {
    rememberedToken = fragment.get("token") || "";
    window.history.replaceState(
      window.history.state,
      "",
      window.location.pathname + window.location.search,
    );
  }
  return rememberedToken;
}
function generatePassword() {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";
  return [...crypto.getRandomValues(new Uint8Array(24))]
    .map((value) => alphabet[value % alphabet.length])
    .join("");
}
type Strength = (password: string, inputs: string[]) => { score: number };
let strengthPromise: Promise<Strength> | undefined;
function loadStrength() {
  if (!strengthPromise)
    strengthPromise = new Promise<Strength>((resolve, reject) => {
      const existing = (window as Window & { zxcvbn?: Strength }).zxcvbn;
      if (existing) {
        resolve(existing);
        return;
      }
      const script = document.createElement("script");
      script.src = "/vendor/wordpress/wp-includes/js/zxcvbn.min.js";
      script.onload = () => {
        const strength = (window as Window & { zxcvbn?: Strength }).zxcvbn;
        strength
          ? resolve(strength)
          : reject(new Error("Password strength could not be loaded."));
      };
      script.onerror = () =>
        reject(new Error("Password strength could not be loaded."));
      document.head.append(script);
    });
  return strengthPromise;
}

export default function Install() {
  const location = useLocation();
  const [token, setToken] = useState(takeInstallationToken);
  const state = useResource<{
    installed: boolean;
    available: boolean;
    language: string;
  }>("/install");
  const [form, setForm] = useState(() => ({
    siteTitle: "",
    username: "",
    email: "",
    password: generatePassword(),
    discourageSearchEngines: false,
  }));
  const [visible, setVisible] = useState(true),
    [weakConfirmed, setWeakConfirmed] = useState(false),
    [score, setScore] = useState<number | null>(null),
    [strength, setStrength] = useState<Strength | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [success, setSuccess] = useState<{ user: User; delivery: string } | null>(
      null,
    );
  const errorRef = useRef<HTMLDivElement>(null),
    successRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const target = success
      ? successRef.current
      : error
        ? errorRef.current
        : null;
    target?.focus();
    target?.scrollIntoView({ block: "nearest" });
  }, [error, success]);
  useLayoutEffect(() => {
    if (!new URLSearchParams(window.location.hash.slice(1)).has("token"))
      return;
    setToken(takeInstallationToken());
    setError("");
    setSuccess(null);
    void state.reload();
  }, [location]);
  useEffect(() => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/vendor/wordpress/wp-admin/css/install.css";
    document.head.append(link);
    let active = true;
    loadStrength()
      .then((value) => {
        if (active) setStrength(() => value);
      })
      .catch(() => {});
    return () => {
      active = false;
      link.remove();
    };
  }, []);
  useEffect(() => {
    setScore(
      strength
        ? strength(form.password.slice(0, 256), [
            form.username,
            form.siteTitle,
            form.email,
          ]).score
        : null,
    );
    setWeakConfirmed(false);
  }, [form.password, form.username, form.siteTitle, form.email, strength]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ user: User; delivery: string }>(
        "/install",
        json("POST", { token, ...form }),
      );
      setSuccess(result);
      setToken("");
      rememberedToken = "";
      setForm((current) => ({ ...current, password: "" }));
    } catch (reason) {
      setError(errorText(reason));
      if (reason instanceof ApiError && reason.status === 409)
        await state.reload();
    } finally {
      setBusy(false);
    }
  }
  const ready = state.data?.available && !state.data.installed;
  const weak = score !== null && score < 3;
  return (
    <main className="worldact-install">
      <h1 id="logo">
        <Brand />
        <span className="screen-reader-text">WorldAct</span>
      </h1>
      <ResourceState {...state} retry={state.reload} />
      {error && (
        <div className="message" role="alert" tabIndex={-1} ref={errorRef}>
          {error}
        </div>
      )}
      {success ? (
        <>
          <h1 tabIndex={-1} ref={successRef}>
            Success!
          </h1>
          <p>WorldAct has been installed. Thank you, and enjoy!</p>
          <table className="form-table install-success">
            <tbody>
              <tr>
                <th>Username</th>
                <td>
                  <code>{success.user.username}</code>
                </td>
              </tr>
              <tr>
                <th>Password</th>
                <td>
                  <p>Your chosen password.</p>
                </td>
              </tr>
            </tbody>
          </table>
          {success.delivery === "local-outbox" && (
            <p>A welcome message is available in the local outgoing mail.</p>
          )}
          <p className="step">
            <Link
              className="button button-large"
              to="/login"
              state={{ from: "/admin" }}
            >
              Log In
            </Link>
          </p>
        </>
      ) : state.data?.installed ? (
        <>
          <h1>Already Installed</h1>
          <p>
            You appear to have already installed WorldAct. To continue, sign in
            to your existing account.
          </p>
          <p className="step">
            <Link className="button button-large" to="/login">
              Log In
            </Link>
          </p>
        </>
      ) : ready && /^[a-f0-9]{64}$/.test(token) ? (
        <>
          <h1>Welcome</h1>
          <p>
            Welcome to the famous five-minute WorldAct installation process!
            Just fill in the information below and you’ll be on your way to
            using the most extendable and powerful personal publishing platform
            in the world.
          </p>
          <h2>Information needed</h2>
          <p>
            Please provide the following information. Don’t worry, you can
            always change these settings later.
          </p>
          <form id="setup" onSubmit={submit}>
            <fieldset disabled={busy}>
              <legend className="screen-reader-text">
                Installation details
              </legend>
              <table className="form-table">
                <tbody>
                  <tr>
                    <th scope="row">
                      <label htmlFor="install-title">Site Title</label>
                    </th>
                    <td>
                      <input
                        id="install-title"
                        type="text"
                        value={form.siteTitle}
                        required
                        maxLength={150}
                        autoFocus
                        onChange={(event) =>
                          setForm({ ...form, siteTitle: event.target.value })
                        }
                      />
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">
                      <label htmlFor="install-user">Username</label>
                    </th>
                    <td>
                      <input
                        id="install-user"
                        type="text"
                        autoComplete="username"
                        spellCheck={false}
                        value={form.username}
                        required
                        maxLength={60}
                        pattern="[a-zA-Z0-9_.@\-]+"
                        aria-describedby="install-user-desc"
                        onChange={(event) =>
                          setForm({ ...form, username: event.target.value })
                        }
                      />
                      <p id="install-user-desc">
                        Usernames can have only alphanumeric characters,
                        underscores, hyphens, periods, and the @ symbol.
                      </p>
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">
                      <label htmlFor="pass1">Password</label>
                    </th>
                    <td>
                      <div className="wp-pwd">
                        <div className="password-input-wrapper">
                          <input
                            id="pass1"
                            type={visible ? "text" : "password"}
                            autoComplete="new-password"
                            spellCheck={false}
                            value={form.password}
                            required
                            minLength={12}
                            maxLength={1024}
                            aria-describedby="pass-strength-result install-password-desc"
                            onChange={(event) =>
                              setForm({ ...form, password: event.target.value })
                            }
                          />
                          <div
                            id="pass-strength-result"
                            className={
                              score === null
                                ? ""
                                : score < 2
                                  ? "short"
                                  : score === 2
                                    ? "bad"
                                    : score === 3
                                      ? "good"
                                      : "strong"
                            }
                            aria-live="polite"
                          >
                            {score === null
                              ? "Use at least 12 characters"
                              : [
                                  "Very weak",
                                  "Weak",
                                  "Weak",
                                  "Medium",
                                  "Strong",
                                ][score]}
                          </div>
                        </div>
                        <button
                          type="button"
                          className="button wp-hide-pw user-new-password-toggle"
                          aria-label={
                            visible ? "Hide password" : "Show password"
                          }
                          onClick={() => setVisible(!visible)}
                        >
                          <Icon name={visible ? "hidden" : "visibility"} />
                          <span className="text">
                            {visible ? "Hide" : "Show"}
                          </span>
                        </button>
                      </div>
                      <button
                        type="button"
                        className="button install-generate"
                        onClick={() => {
                          setForm({ ...form, password: generatePassword() });
                          setVisible(true);
                        }}
                      >
                        Generate Password
                      </button>
                      <p id="install-password-desc">
                        <strong>Important:</strong> You will need this password
                        to log in. Please store it in a secure location.
                      </p>
                    </td>
                  </tr>
                  {weak && (
                    <tr>
                      <th scope="row">Confirm Password</th>
                      <td>
                        <label>
                          <input
                            type="checkbox"
                            checked={weakConfirmed}
                            onChange={(event) =>
                              setWeakConfirmed(event.target.checked)
                            }
                            required
                          />{" "}
                          Confirm use of weak password
                        </label>
                      </td>
                    </tr>
                  )}
                  <tr>
                    <th scope="row">
                      <label htmlFor="install-email">Your Email</label>
                    </th>
                    <td>
                      <input
                        id="install-email"
                        type="email"
                        autoComplete="email"
                        required
                        maxLength={254}
                        value={form.email}
                        aria-describedby="install-email-desc"
                        onChange={(event) =>
                          setForm({ ...form, email: event.target.value })
                        }
                      />
                      <p id="install-email-desc">
                        Double-check your email address before continuing.
                      </p>
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">Search engine visibility</th>
                    <td>
                      <fieldset>
                        <legend className="screen-reader-text">
                          Search engine visibility
                        </legend>
                        <label>
                          <input
                            type="checkbox"
                            checked={form.discourageSearchEngines}
                            onChange={(event) =>
                              setForm({
                                ...form,
                                discourageSearchEngines: event.target.checked,
                              })
                            }
                          />{" "}
                          Discourage search engines from indexing this site
                        </label>
                        <p>It is up to search engines to honor this request.</p>
                      </fieldset>
                    </td>
                  </tr>
                </tbody>
              </table>
              <p className="step">
                <button
                  className="button button-large"
                  disabled={busy || (weak && !weakConfirmed)}
                >
                  {busy ? "Installing…" : "Install WorldAct"}
                </button>
                {busy && (
                  <span
                    className="spinner is-active"
                    role="status"
                    aria-label="Installing WorldAct"
                  />
                )}
              </p>
            </fieldset>
          </form>
        </>
      ) : (
        state.data &&
        !state.loading &&
        (state.data.available ? (
          <>
            <h1>Installation link required</h1>
            <p>
              Open the private installation link prepared on this server to
              continue. If the link has been removed from this page, reopen the
              original link.
            </p>
          </>
        ) : (
          <>
            <h1>Installation unavailable</h1>
            <p>
              Browser installation has not been prepared on this server. Contact
              the server administrator to continue.
            </p>
          </>
        ))
      )}
    </main>
  );
}
