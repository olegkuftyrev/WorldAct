import {postFormats} from "../../shared/post-formats";
import AkismetSettings from "../components/AkismetSettings";
import OutgoingNotifications from "../components/OutgoingNotifications";
import { ConnectorOperation, pingServiceLines } from "../connectors";
import ApplicationPasswords from "./ApplicationPasswords";
import ExportContent from "./ExportContent";
import { ProfileEmailNotice, deliveryMessage, type PendingProfileEmail } from "./ProfileEmail";
import { HealthDetails, PrivacyPolicyGuide } from "./ToolsExtras";
import { SiteIconControl, PendingEmailNotice, DateFormatControl, type PendingAdminEmail } from "./SiteIdentity";
import { compileThemeStyles, type ThemeJSON } from "../themeStyles";
import "../themeAdmin.css";
import { themeDocument, resolveThemeValue } from "../themeCatalog";
import {
  lazy,
  Suspense,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Link, Navigate, useParams, useSearchParams } from "react-router-dom";
import {
  api,
  json,
  date,
  type Media,
  type NavigationItem,
  type NavigationMenu,
  type Post,
  type Settings,
  type SiteStyle,
  type SiteTemplate,
  type ThemeId,
  type User,
} from "../api";
import {
  Brand,
  Session,
  Notice,
  ResourceState,
  ScreenTabs,
  errorText,
  useResource,
} from "../components/AdminUI";
import type { GutenbergEditorHandle } from "../editor/GutenbergEditor";
import { siteDocumentEntity } from "../editor/entityContext";
import "../platform.css";

const BlockEditor = lazy(() => import("../editor/GutenbergEditor"));
const FontLibrary = lazy(() => import("../components/FontLibrary"));

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function run<T>(
    work: () => Promise<T>,
    message = "",
    isCurrent: () => boolean = () => true,
  ): Promise<T | undefined> {
    if (!isCurrent()) return undefined;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await work();
      if (!isCurrent()) return undefined;
      setNotice(message);
      return result;
    } catch (reason) {
      if (isCurrent()) setError(errorText(reason));
      return undefined;
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }
  const reset = () => {
    setBusy(false);
    setError("");
    setNotice("");
  };
  return { busy, error, notice, run, setError, setNotice, reset };
}

function Feedback({ action }: { action: ReturnType<typeof useAction> }) {
  return (
    <>
      {action.error && (
        <Notice error onDismiss={() => action.setError("")}>
          {action.error}
        </Notice>
      )}
      {action.notice && (
        <Notice onDismiss={() => action.setNotice("")}>{action.notice}</Notice>
      )}
    </>
  );
}

function Screen({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <>
      <ScreenTabs />
      <main className="wrap worldact-platform">
        <div className="worldact-screen-heading">
          <h1>{title}</h1>
          {action}
        </div>
        {children}
      </main>
    </>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td>
        {children}
        {hint && <p className="description">{hint}</p>}
      </td>
    </tr>
  );
}

function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadJSON(name: string, data: unknown) {
  downloadBlob(
    name,
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
  );
}

export function Profile() {
  const { id } = useParams();
  const endpoint = id ? `/users/${id}` : "/profile";
  const resource = useResource<{
    user: User;
    preferences: Record<string, unknown>;
  }>(endpoint);
  const { user, setUser } = useContext(Session);
  const self = !id || Number(id) === user?.id;
  const pendingResource = useResource<{ pending: PendingProfileEmail | null }>(
    self ? "/profile/email" : null,
  );
  const [form, setForm] = useState<User | null>(null);
  const [password, setPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const action = useAction();
  const activeEndpoint = useRef(endpoint),
    generation = useRef(0),
    mounted = useRef(true);
  if (activeEndpoint.current !== endpoint) {
    activeEndpoint.current = endpoint;
    generation.current++;
  }
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);
  function captureTarget() {
    const currentGeneration = generation.current,
      currentEndpoint = endpoint;
    return () =>
      mounted.current &&
      generation.current === currentGeneration &&
      activeEndpoint.current === currentEndpoint;
  }
  const targetId = id ? Number(id) : user?.id;
  const currentForm = form?.id === targetId && !resource.loading;
  useEffect(() => {
    setForm(null);
    setPassword("");
    setCurrentPassword("");
    action.reset();
  }, [endpoint]);
  useEffect(() => {
    if (resource.data) setForm(resource.data.user);
  }, [resource.data]);
  const set = (key: keyof User, value: string | boolean) =>
    setForm((current) => (current ? { ...current, [key]: value } : current));
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form || !currentForm) return;
    const isCurrent = captureTarget();
    const message = await action.run(
      async () => {
        const {
          email,
          displayName,
          firstName = "",
          lastName = "",
          nickname = "",
          bio = "",
          website = "",
          adminColor = "modern",
          locale = "en_US",
          showAdminBar = true,
          commentShortcuts = false,
        } = form;
        const result = await api<{
          user: User;
          pendingEmail: PendingProfileEmail | null;
          delivery?: string;
        }>(
          endpoint,
          json("PUT", {
            email,
            displayName,
            firstName,
            lastName,
            nickname,
            bio,
            website,
            adminColor,
            locale,
            showAdminBar,
            commentShortcuts,
            ...(password
              ? {
                  password,
                  ...(form.id === user?.id ? { currentPassword } : {}),
                }
              : {}),
            ...(form.id !== user?.id ? { role: form.role } : {}),
          }),
        );
        if (!isCurrent()) return;
        setForm(result.user);
        if (form.id === user?.id) setUser({ ...user, ...result.user });
        if (self) pendingResource.setData({ pending: result.pendingEmail });
        setPassword("");
        setCurrentPassword("");
        return result.pendingEmail && result.delivery
          ? `Profile updated. ${deliveryMessage(result.delivery)}`
          : "Profile updated.";
      },
      "",
      isCurrent,
    );
    if (message && isCurrent()) action.setNotice(message);
  }
  return (
    <Screen title={id && targetId !== user?.id ? "Edit User" : "Profile"}>
      <Feedback action={action} />
      <ResourceState {...resource} retry={resource.reload} />
      {form && currentForm && (
        <form onSubmit={submit}>
          <h2>Personal Options</h2>
          <table className="form-table">
            <tbody>
              <Field label="Admin Color Scheme">
                <div className="worldact-color-schemes">
                  {[
                    "modern",
                    "fresh",
                    "light",
                    "blue",
                    "coffee",
                    "ectoplasm",
                    "midnight",
                    "ocean",
                    "sunrise",
                  ].map((scheme) => (
                    <label key={scheme}>
                      <input
                        type="radio"
                        name="adminColor"
                        value={scheme}
                        checked={(form.adminColor || "modern") === scheme}
                        onChange={() => set("adminColor", scheme)}
                      />
                      <span className={`color-scheme-swatch ${scheme}`} />
                      {scheme[0].toUpperCase() + scheme.slice(1)}
                    </label>
                  ))}
                </div>
              </Field>
              <Field label="Toolbar">
                <label>
                  <input
                    type="checkbox"
                    checked={form.showAdminBar !== false}
                    onChange={(event) =>
                      set("showAdminBar", event.target.checked)
                    }
                  />{" "}
                  Show Toolbar when viewing site
                </label>
              </Field>
              {(!self || form.role !== "subscriber") && (
                <Field label="Keyboard Shortcuts">
                  <label>
                    <input
                      type="checkbox"
                      checked={form.commentShortcuts === true}
                      onChange={(event) =>
                        set("commentShortcuts", event.target.checked)
                      }
                    />{" "}
                    Enable keyboard shortcuts for comment moderation.
                  </label>
                  <p className="description">
                    <a href="https://wordpress.org/documentation/article/keyboard-shortcuts-classic-editor/#keyboard-shortcuts-for-comments">
                      Documentation on Keyboard Shortcuts
                    </a>
                  </p>
                </Field>
              )}
              <Field label="Language">
                <select
                  aria-label="Language"
                  value={form.locale || "en_US"}
                  onChange={(e) => set("locale", e.target.value)}
                >
                  <option value="en_US">English (United States)</option>
                  <option value="en_GB">English (United Kingdom)</option>
                </select>
                <p className="description">
                  The interface language is English.
                </p>
              </Field>
            </tbody>
          </table>
          <h2>Name</h2>
          <table className="form-table">
            <tbody>
              <Field label="Username" hint="Usernames cannot be changed.">
                <input
                  aria-label="Username"
                  value={form.username}
                  className="regular-text"
                  disabled
                />
              </Field>
              {[
                ["firstName", "First Name"],
                ["lastName", "Last Name"],
                ["nickname", "Nickname"],
              ].map(([key, label]) => (
                <Field key={key} label={label}>
                  <input
                    aria-label={label}
                    className="regular-text"
                    value={String(form[key as keyof User] || "")}
                    onChange={(e) => set(key as keyof User, e.target.value)}
                  />
                </Field>
              ))}
              <Field label="Display name publicly as">
                <input
                  aria-label="Display name"
                  className="regular-text"
                  value={form.displayName}
                  required
                  maxLength={160}
                  onChange={(e) => set("displayName", e.target.value)}
                />
              </Field>
              {form.id !== user?.id && (
                <Field label="Role">
                  <select
                    aria-label="Role"
                    value={form.role}
                    onChange={(e) => set("role", e.target.value)}
                  >
                    {[
                      "administrator",
                      "editor",
                      "author",
                      "contributor",
                      "subscriber",
                    ].map((role) => (
                      <option value={role} key={role}>
                        {role[0].toUpperCase() + role.slice(1)}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
            </tbody>
          </table>
          <h2>Contact Info</h2>
          <table className="form-table">
            <tbody>
              <Field label="Email (required)">
                <input
                  aria-label="Email"
                  className="regular-text"
                  type="email"
                  required
                  value={form.email}
                  onChange={(e) => set("email", e.target.value)}
                />
                {self && (
                  <>
                    <p className="description">
                      If you change this, an email will be sent to your new
                      address to confirm it. The new address will not become
                      active until confirmed.
                    </p>
                    <ResourceState
                      loading={pendingResource.loading}
                      error={pendingResource.error}
                      retry={pendingResource.reload}
                    />
                    <ProfileEmailNotice
                      pending={pendingResource.data?.pending || null}
                      currentEmail={
                        resource.data?.user.email || user?.email || ""
                      }
                      onChanged={(pending) =>
                        pendingResource.setData({ pending })
                      }
                    />
                  </>
                )}
              </Field>
              <Field label="Website">
                <input
                  aria-label="Website"
                  className="regular-text"
                  type="url"
                  value={form.website || ""}
                  onChange={(e) => set("website", e.target.value)}
                />
              </Field>
            </tbody>
          </table>
          <h2>About Yourself</h2>
          <table className="form-table">
            <tbody>
              <Field
                label="Biographical Info"
                hint="Share a little biographical information to fill out your profile."
              >
                <textarea
                  aria-label="Biographical Info"
                  rows={5}
                  className="large-text"
                  maxLength={5000}
                  value={form.bio || ""}
                  onChange={(e) => set("bio", e.target.value)}
                />
              </Field>
            </tbody>
          </table>
          <h2>Account Management</h2>
          <table className="form-table">
            <tbody>
              <Field
                label="New Password"
                hint="Use at least 12 characters. Leave blank to keep your current password."
              >
                <input
                  aria-label="New Password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  minLength={12}
                  className="regular-text"
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
              {password && form.id === user?.id && (
                <Field label="Current Password">
                  <input
                    aria-label="Current Password"
                    type="password"
                    autoComplete="current-password"
                    required
                    value={currentPassword}
                    className="regular-text"
                    onChange={(e) => setCurrentPassword(e.target.value)}
                  />
                </Field>
              )}
              {form.id === user?.id && (
                <Field label="Sessions">
                  <button
                    type="button"
                    className="button"
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(
                        () =>
                          api("/profile/logout-other-sessions", json("POST")),
                        "All other sessions have been logged out.",
                        captureTarget(),
                      )
                    }
                  >
                    Log Out Everywhere Else
                  </button>
                  <p className="description">
                    Keep this browser session and sign out your other devices.
                  </p>
                </Field>
              )}
            </tbody>
          </table>
          <p className="submit">
            <button className="button button-primary" disabled={action.busy}>
              {action.busy ? "Saving…" : "Update Profile"}
            </button>
          </p>
        </form>
      )}
      {form && currentForm && (
        <ApplicationPasswords userId={form.id} self={form.id === user?.id} />
      )}
    </Screen>
  );
}

type SettingValues = Record<
  string,
  string | string[] | number | boolean | null | undefined
>;
const settingTabs = [
  "general",
  "writing",
  "reading",
  "discussion",
  "media",
  "permalinks",
  "privacy",
];
const settingKeys: Record<string, string[]> = {
  general: [
    "siteTitle",
    "tagline",
    "siteUrl",
    "adminEmail",
    "usersCanRegister",
    "defaultRole",
    "timezone",
    "dateFormat",
    "timeFormat",
    "weekStartsOn",
    "siteIconId",
  ],
  writing: ["defaultCategoryId", "defaultPostFormat", "pingServices"],
  reading: [
    "frontPageMode",
    "frontPageId",
    "postsPageId",
    "postsPerPage",
    "feedItems",
    "feedExcerpt",
    "discourageSearchEngines",
  ],
  discussion: [
    "defaultPingbackFlag",
    "defaultCommentStatus",
    "requireCommentNameEmail",
    "commentRegistration",
    "commentModeration",
    "commentsPerPage",
    "threadComments",
    "threadDepth",
    "closeCommentsDays",
    "commentOrder",
    "commentMaxLinks",
    "commentModerationKeys",
    "disallowedCommentKeys",
    "commentPreviouslyApproved",
    "notifyComments",
    "notifyModeration",
    "showAvatars",
    "avatarRating",
    "defaultAvatar",
    "commentCookieConsent",
    "paginateComments",
    "defaultCommentPage",
  ],
  media: [
    "thumbnailWidth",
    "thumbnailHeight",
    "thumbnailCrop",
    "mediumWidth",
    "mediumHeight",
    "largeWidth",
    "largeHeight",
    "uploadsYearMonth",
  ],
  permalinks: ["permalinkStructure", "categoryBase", "tagBase"],
  privacy: ["privacyPageId"],
};

export function SettingsSuite() {
  const [params, setParams] = useSearchParams();
  const tab = settingTabs.includes(params.get("tab") || "")
    ? params.get("tab")!
    : "general";
  const resource = useResource<{ settings: Settings; pendingAdminEmail?: PendingAdminEmail | null }>("/settings");
  const pages = useResource<{ pages: Post[] }>("/public/site");
  const policyPages = useResource<{ posts: Post[] }>(tab === "privacy" ? "/posts?type=page&status=all&perPage=100" : null);
  const terms = useResource<{ terms: { id: number; name: string }[] }>(
    "/terms?taxonomy=category",
  );
  const [form, setForm] = useState<SettingValues>({});
  const [pingText, setPingText] = useState("");
  const formRef = useRef(form), pingTextRef = useRef(pingText);
  formRef.current = form; pingTextRef.current = pingText;
  const settingsOperation = useRef(new ConnectorOperation());
  const currentPolicyPage = useResource<{ post: Post }>(
    tab === "privacy" && Number(form.privacyPageId) > 0
      ? `/posts/${Number(form.privacyPageId)}`
      : null,
  );
  const [pendingAdminEmail, setPendingAdminEmail] = useState<PendingAdminEmail | null>(null);
  const action = useAction();
  useEffect(() => {
    if (resource.data) {
      setForm(resource.data.settings as unknown as SettingValues);
      setPingText((resource.data.settings.pingServices || []).join("\n"));
      setPendingAdminEmail(resource.data.pendingAdminEmail || null);
    }
  }, [resource.data]);
  useEffect(() => {
    action.reset();
    return () => settingsOperation.current.cancel();
  }, [tab]);
  const set = (key: string, value: SettingValues[string]) =>
    setForm((current) => ({ ...current, [key]: value }));
  const text = (
    key: string,
    label: string,
    type = "text",
    required = false,
  ) => (
    <input
      aria-label={label}
      className="regular-text"
      type={type}
      value={String(form[key] ?? "")}
      required={required}
      onChange={(e) => set(key, e.target.value)}
    />
  );
  const number = (key: string, label: string, min = 1, max = 8192) => (
    <input
      aria-label={label}
      className="small-text"
      type="number"
      min={min}
      max={max}
      value={Number(form[key] ?? min)}
      onChange={(e) => set(key, Number(e.target.value))}
    />
  );
  const check = (key: string, label: string) => (
    <label>
      <input
        type="checkbox"
        checked={Boolean(form[key])}
        onChange={(e) => set(key, e.target.checked)}
      />{" "}
      {label}
    </label>
  );
  const select = (key: string, label: string, values: [string, string][]) => (
    <select
      aria-label={label}
      value={String(form[key] ?? "")}
      onChange={(e) => set(key, e.target.value)}
    >
      {values.map(([value, name]) => (
        <option key={value} value={value}>
          {name}
        </option>
      ))}
    </select>
  );
  const policyChoices = [...(policyPages.data?.posts || [])];
  if (currentPolicyPage.data?.post && !policyChoices.some((page) => page.id === currentPolicyPage.data!.post.id)) {
    policyChoices.push(currentPolicyPage.data.post);
  }
  const pageSelect = (key: string, label: string) => (
    <select
      aria-label={label}
      value={String(form[key] ?? "")}
      onChange={(e) => set(key, e.target.value ? Number(e.target.value) : null)}
    >
      <option value="">— Select —</option>
      {(key === "privacyPageId" ? policyChoices : pages.data?.pages)?.map((page) => (
        <option value={page.id} key={page.id}>
          {page.title || "(no title)"}{key === "privacyPageId" && page.status !== "publish" ? ` — ${page.status}` : ""}
        </option>
      ))}
    </select>
  );
  async function save(event: FormEvent) {
    event.preventDefault();
    const owner = settingsOperation.current.start(), savedForm = form, savedText = pingText;
    await action.run(async () => {
      const input = Object.fromEntries(
        settingKeys[tab]
          .filter((key) => form[key] !== undefined)
          .map((key) => [key, form[key]]),
      );
      if (tab === "writing") {
        if (!form.discourageSearchEngines) input.pingServices = pingServiceLines(savedText);
        else delete input.pingServices;
      }
      const result = await api<{ settings: Settings; pendingAdminEmail?: PendingAdminEmail | null }>(
        "/settings",
        { ...json("PUT", input), signal: owner.signal },
      );
      if (!owner.current()) return;
      if (formRef.current === savedForm && pingTextRef.current === savedText) resource.setData(result);
      window.dispatchEvent(new Event("worldact-settings-updated"));
    }, "Settings saved.", owner.current);
  }
  return (
    <Screen title={`${tab[0].toUpperCase() + tab.slice(1)} Settings`}>
      <Feedback action={action} />
      <nav className="nav-tab-wrapper" aria-label="Settings">
        {settingTabs.map((name) => (
          <button
            type="button"
            key={name}
            className={`nav-tab ${tab === name ? "nav-tab-active" : ""}`}
            onClick={() => {
              setParams(name === "general" ? {} : { tab: name });
              action.setNotice("");
            }}
          >
            {name[0].toUpperCase() + name.slice(1)}
          </button>
        ))}
      </nav>
      <ResourceState {...resource} retry={resource.reload} />
      {resource.data && (
        <form onSubmit={save}>
          <table className="form-table">
            <tbody>
              {tab === "general" && (
                <>
                  <Field label="Site Title">
                    {text("siteTitle", "Site Title", "text", true)}
                  </Field>
                  <Field
                    label="Tagline"
                    hint="In a few words, explain what this site is about."
                  >
                    {text("tagline", "Tagline")}
                  </Field>
                  <Field label="Site Icon">
                    <SiteIconControl id={Number(form.siteIconId || 0)} url={String(form.siteIconUrl || "") || null} onChange={(id,url)=>setForm(current=>({...current,siteIconId:id,siteIconUrl:url}))} />
                  </Field>
                  <Field label="Site Address (URL)">
                    {text("siteUrl", "Site Address", "url", true)}
                  </Field>
                  <Field label="Administration Email Address">
                    {text(
                      "adminEmail",
                      "Administration Email Address",
                      "email",
                      true,
                    )}
                    <p className="description">This address is used for site administration. A change requires confirmation at the new email address before it takes effect.</p>
                    <PendingEmailNotice pending={pendingAdminEmail} currentEmail={resource.data.settings.adminEmail} onChanged={setPendingAdminEmail} />
                  </Field>
                  <Field label="Membership">
                    {check("usersCanRegister", "Anyone can register")}
                  </Field>
                  <Field label="New User Default Role">
                    {select("defaultRole", "New User Default Role", [
                      ["subscriber", "Subscriber"],
                      ["contributor", "Contributor"],
                      ["author", "Author"],
                      ["editor", "Editor"],
                      ["administrator", "Administrator"],
                    ])}
                    <p className="description">
                      This role is assigned to new accounts registered through
                      the public registration form.
                    </p>
                  </Field>
                  <Field
                    label="Timezone"
                    hint={`Local time: ${new Date().toLocaleString("en-US", { timeZone: String(form.timezone || "UTC") })}`}
                  >
                    {select(
                      "timezone",
                      "Timezone",
                      [
                        ...new Set([
                          String(form.timezone || "UTC"),
                          "UTC",
                          ...Intl.supportedValuesOf("timeZone"),
                        ]),
                      ].map((zone) => [zone, zone.replaceAll("_", " ")]),
                    )}
                  </Field>
                  <Field label="Date Format">
                    <DateFormatControl kind="date" value={String(form.dateFormat || "F j, Y")} timezone={String(form.timezone || "UTC")} onChange={value=>set("dateFormat",value)} />
                  </Field>
                  <Field label="Time Format">
                    <DateFormatControl kind="time" value={String(form.timeFormat || "g:i a")} timezone={String(form.timezone || "UTC")} onChange={value=>set("timeFormat",value)} />
                  </Field>
                  <Field label="Week Starts On"><select aria-label="Week Starts On" value={Number(form.weekStartsOn ?? 1)} onChange={event=>set("weekStartsOn",Number(event.target.value))}>{["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"].map((day,index)=><option value={index} key={day}>{day}</option>)}</select></Field>
                </>
              )}
              {tab === "writing" && (
                <>
                  <Field label="Default Post Category">
                    <select
                      aria-label="Default Post Category"
                      value={String(form.defaultCategoryId || "")}
                      onChange={(e) =>
                        set(
                          "defaultCategoryId",
                          e.target.value ? Number(e.target.value) : null,
                        )
                      }
                    >
                      <option value="">Uncategorized</option>
                      {terms.data?.terms.map((term) => (
                        <option key={term.id} value={term.id}>
                          {term.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Default Post Format">
                    {select(
                      "defaultPostFormat",
                      "Default Post Format",
                      postFormats.map((name) => [
                        name,
                        name[0].toUpperCase() + name.slice(1),
                      ]),
                    )}
                  </Field>
                </>
              )}
              {tab === "reading" && (
                <>
                  <Field label="Your homepage displays">
                    <fieldset>
                      {[
                        ["posts", "Your latest posts"],
                        ["page", "A static page"],
                      ].map(([value, label]) => (
                        <p key={value}>
                          <label>
                            <input
                              type="radio"
                              name="frontPageMode"
                              checked={form.frontPageMode === value}
                              onChange={() => set("frontPageMode", value)}
                            />{" "}
                            {label}
                          </label>
                        </p>
                      ))}
                      {form.frontPageMode === "page" && (
                        <div className="worldact-stacked-fields">
                          <label>
                            Homepage: {pageSelect("frontPageId", "Homepage")}
                          </label>
                          <label>
                            Posts page:{" "}
                            {pageSelect("postsPageId", "Posts page")}
                          </label>
                        </div>
                      )}
                    </fieldset>
                  </Field>
                  <Field label="Blog pages show at most">
                    {number("postsPerPage", "Posts per page", 1, 100)} posts
                  </Field>
                  <Field label="Syndication feeds show the most recent">
                    {number("feedItems", "Feed items", 1, 100)} items
                  </Field>
                  <Field label="For each post in a feed, include">
                    {check("feedExcerpt", "Excerpt instead of full text")}
                  </Field>
                  <Field label="Search engine visibility">
                    {check(
                      "discourageSearchEngines",
                      "Discourage search engines from indexing this site",
                    )}
                  </Field>
                </>
              )}
              {tab === "discussion" && (
                <>
                  <Field label="Default post settings">
                    <div className="worldact-stacked-fields">
                    {check("defaultPingbackFlag", "Attempt to notify any blogs linked to from the post")}
                    <label>
                      <input
                        type="checkbox"
                        checked={form.defaultCommentStatus !== "closed"}
                        onChange={(e) =>
                          set(
                            "defaultCommentStatus",
                            e.target.checked ? "open" : "closed",
                          )
                        }
                      />{" "}
                      Allow people to submit comments on new posts
                    </label>
                    </div>
                  </Field>
                  <Field label="Other comment settings">
                    <div className="worldact-stacked-fields">
                      {check(
                        "requireCommentNameEmail",
                        "Comment author must fill out name and email",
                      )}
                      {check(
                        "commentRegistration",
                        "Users must be registered and logged in to comment",
                      )}
                      {check(
                        "threadComments",
                        "Enable threaded (nested) comments",
                      )}
                      <label>
                        Levels deep:{" "}
                        {number("threadDepth", "Thread depth", 1, 10)}
                      </label>
                      <label>
                        Automatically close comments on posts older than{" "}
                        {number(
                          "closeCommentsDays",
                          "Close comments after days",
                          0,
                          3650,
                        )}{" "}
                        days (0 keeps comments open)
                      </label>
                    </div>
                  </Field>
                  <Field label="Email me whenever">
                    <div className="worldact-stacked-fields">
                      {check("notifyComments","Anyone posts a comment")}
                      {check("notifyModeration","A comment is held for moderation")}
                    </div>
                    <p className="description">Notifications are sent to the administration email address. <Link to="/admin/tools?tab=mail">View outgoing mail</Link>.</p>
                  </Field>
                  <Field label="Before a comment appears">
                    <div className="worldact-stacked-fields">
                      {check("commentModeration","Comment must be manually approved")}
                      {check("commentPreviouslyApproved","Comment author must have a previously approved comment")}
                    </div>
                  </Field>
                  <Field label="Comment pagination">
                    <div className="worldact-stacked-fields">
                      {check("paginateComments","Break comments into pages")}
                      <label>{number("commentsPerPage","Comments per page",1,200)} comments per page</label>
                      <label>Display by default {select("defaultCommentPage","Default comment page",[["oldest","First page"],["newest","Last page"]])}</label>
                    </div>
                  </Field>
                  <Field label="Comments should be displayed with">
                    {select("commentOrder","Comment order",[["asc","Older comments first"],["desc","Newer comments first"]])}
                  </Field>
                  <Field label="Comment Moderation">
                    <p>Hold a comment in the queue if it contains {number("commentMaxLinks","Maximum comment links",0,100)} or more links. Set 0 to disable the link limit.</p>
                    <p>Hold comments matching any word, name, URL, or email address below. Enter one item per line.</p>
                    <textarea aria-label="Comment moderation keys" className="large-text" rows={8} maxLength={20000} value={String(form.commentModerationKeys || "")} onChange={(event) => set("commentModerationKeys",event.target.value)}/>
                  </Field>
                  <Field label="Disallowed Comment Keys">
                    <p>Comments matching these words, names, URLs, or email addresses are sent to Trash. Enter one item per line.</p>
                    <textarea aria-label="Disallowed comment keys" className="large-text" rows={8} maxLength={20000} value={String(form.disallowedCommentKeys || "")} onChange={(event) => set("disallowedCommentKeys",event.target.value)}/>
                  </Field>
                  <Field label="Comment cookies">
                    {check("commentCookieConsent","Show the option to save the comment author’s name, email, and website for next time")}
                  </Field>
                  <Field label="Avatar Display">{check("showAvatars","Show Avatars")}</Field>
                  <Field label="Maximum Rating">
                    {select("avatarRating","Avatar rating",[["G","G — Suitable for all audiences"],["PG","PG — Possibly offensive, usually for ages 13 and above"],["R","R — Intended for adult audiences above 17"],["X","X — More mature than above"]])}
                  </Field>
                  <Field label="Default Avatar">
                    {select("defaultAvatar","Default avatar",[["mystery","Mystery Person"],["blank","Blank"],["identicon","Identicon (Generated)"],["wavatar","Wavatar (Generated)"],["monsterid","MonsterID (Generated)"],["retro","Retro (Generated)"]])}
                  </Field>
                </>
              )}
              {tab === "media" && (
                <>
                  <Field label="Thumbnail size">
                    <label>
                      Width{" "}
                      {number("thumbnailWidth", "Thumbnail width", 0, 4096)}
                    </label>{" "}
                    <label>
                      Height{" "}
                      {number("thumbnailHeight", "Thumbnail height", 0, 4096)}
                    </label>
                    <p>
                      {check(
                        "thumbnailCrop",
                        "Crop thumbnails to exact dimensions",
                      )}
                    </p>
                  </Field>
                  <Field label="Medium size">
                    <label>
                      Max width {number("mediumWidth", "Medium width", 0, 8192)}
                    </label>{" "}
                    <label>
                      Max height {number("mediumHeight", "Medium height", 0, 8192)}
                    </label>
                  </Field>
                  <Field label="Large size">
                    <label>
                      Max width {number("largeWidth", "Large width", 0, 8192)}
                    </label>{" "}
                    <label>
                      Max height {number("largeHeight", "Large height", 0, 8192)}
                    </label>
                    <p className="description">Set both dimensions to 0 to disable a size. A single zero leaves that dimension unconstrained.</p>
                  </Field>
                  <Field label="Uploading Files">
                    {check(
                      "uploadsYearMonth",
                      "Organize my uploads into month- and year-based folders",
                    )}
                  </Field>
                </>
              )}
              {tab === "permalinks" && (
                <>
                  <Field label="Common Settings">
                    <fieldset className="worldact-stacked-fields">
                      {[
                        ["/posts/%postname%/", "Post name"],
                        [
                          "/%year%/%monthnum%/%day%/%postname%/",
                          "Day and name",
                        ],
                        ["/%year%/%monthnum%/%postname%/", "Month and name"],
                        ["/archives/%post_id%/", "Numeric"],
                      ].map(([value, label]) => (
                        <label key={value}>
                          <input
                            name="permalink"
                            type="radio"
                            checked={form.permalinkStructure === value}
                            onChange={() => set("permalinkStructure", value)}
                          />{" "}
                          {label} <code>{value}</code>
                        </label>
                      ))}
                    </fieldset>
                  </Field>
                  <Field
                    label="Custom Structure"
                    hint="Available tags: %postname%, %post_id%, %year%, %monthnum%, %day%."
                  >
                    {text(
                      "permalinkStructure",
                      "Custom Structure",
                      "text",
                      true,
                    )}
                  </Field>
                  <Field label="Category base">
                    {text("categoryBase", "Category base", "text", true)}
                  </Field>
                  <Field label="Tag base">
                    {text("tagBase", "Tag base", "text", true)}
                  </Field>
                </>
              )}
              {tab === "privacy" && (
                <>
                <Field label="Create your Privacy Policy page">
                  <PrivacyPolicyGuide onCreated={async (post) => {set("privacyPageId", post.id); await policyPages.reload();}} />
                </Field>
                <Field
                  label="Change your Privacy Policy page"
                  hint="This page can explain how your site collects and handles personal information."
                >
                  {pageSelect("privacyPageId", "Privacy Policy page")}{" "}
                  <Link className="button" to="/admin/pages/new">
                    Create a new page
                  </Link>
                  <ResourceState loading={policyPages.loading} error={policyPages.error} retry={policyPages.reload} />
                </Field>
                </>
              )}
            </tbody>
          </table>
          {tab === "writing" && <OutgoingNotifications hidden={Boolean(form.discourageSearchEngines)} value={pingText} onChange={setPingText} />}
          <p className="submit">
            <button className="button button-primary" disabled={action.busy}>
              {action.busy ? "Saving…" : "Save Changes"}
            </button>
          </p>
        </form>
      )}
    </Screen>
  );
}

const emptyMenu = (): Pick<NavigationMenu, "name" | "location" | "items"> => ({
  name: "",
  location: "primary",
  items: [],
});

export function Menus() {
  const resource = useResource<{ menus: NavigationMenu[] }>("/menus");
  const pages = useResource<{ pages: Post[] }>("/public/site");
  const [selected, setSelected] = useState<number | null>(null);
  const [form, setForm] = useState(emptyMenu);
  const [custom, setCustom] = useState({ label: "", url: "" });
  const action = useAction();
  useEffect(() => {
    if (resource.data?.menus.length && selected === null && !form.name)
      choose(resource.data.menus[0]);
  }, [resource.data]);
  function choose(menu: NavigationMenu) {
    setSelected(menu.id);
    setForm({ name: menu.name, location: menu.location, items: menu.items });
  }
  const updateItem = (id: string, input: Partial<NavigationItem>) =>
    setForm((current) => ({
      ...current,
      items: current.items.map((item) =>
        item.id === id ? { ...item, ...input } : item,
      ),
    }));
  function add(label: string, url: string) {
    if (!label.trim() || !url.trim()) return;
    setForm((current) => ({
      ...current,
      items: [
        ...current.items,
        {
          id: crypto.randomUUID(),
          label,
          url,
          parentId: null,
          target: "_self",
        },
      ],
    }));
    setCustom({ label: "", url: "" });
  }
  function move(index: number, direction: -1 | 1) {
    setForm((current) => {
      const items = [...current.items];
      const other = index + direction;
      if (other >= 0 && other < items.length)
        [items[index], items[other]] = [items[other], items[index]];
      return { ...current, items };
    });
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    await action.run(async () => {
      const result = await api<{ menu: NavigationMenu }>(
        selected ? `/menus/${selected}` : "/menus",
        json(selected ? "PUT" : "POST", form),
      );
      choose(result.menu);
      await resource.reload();
    }, "Menu saved.");
  }
  return (
    <Screen title="Menus">
      <Feedback action={action} />
      <ResourceState {...resource} retry={resource.reload} />
      <nav className="nav-tab-wrapper">
        <Link className="nav-tab nav-tab-active" to="/admin/appearance/menus">
          Edit Menus
        </Link>
        <Link className="nav-tab" to="/admin/appearance/editor">
          Open Site Editor
        </Link>
      </nav>
      <div className="worldact-menu-select">
        <label>
          Select a menu to edit:{" "}
          <select
            value={selected || ""}
            onChange={(e) => {
              const item = resource.data?.menus.find(
                (menu) => menu.id === Number(e.target.value),
              );
              if (item) choose(item);
            }}
          >
            <option value="">New menu</option>
            {resource.data?.menus.map((menu) => (
              <option value={menu.id} key={menu.id}>
                {menu.name}
              </option>
            ))}
          </select>
        </label>
        <button
          className="button-link"
          onClick={() => {
            setSelected(null);
            setForm(emptyMenu());
          }}
        >
          create a new menu
        </button>
      </div>
      <div className="worldact-menu-layout">
        <aside className="worldact-menu-add">
          <h2>Add menu items</h2>
          <details open>
            <summary>Pages</summary>
            <div>
              {pages.data?.pages.map((page) => (
                <p key={page.id}>
                  <button
                    className="button-link"
                    onClick={() =>
                      add(page.title || "(no title)", `/pages/${page.slug}`)
                    }
                  >
                    ＋ {page.title || "(no title)"}
                  </button>
                </p>
              ))}
              {!pages.data?.pages.length && <p>No published pages yet.</p>}
            </div>
          </details>
          <details open>
            <summary>Custom Links</summary>
            <div className="worldact-stacked-fields">
              <label>
                URL
                <input
                  value={custom.url}
                  placeholder="https://"
                  onChange={(e) =>
                    setCustom({ ...custom, url: e.target.value })
                  }
                />
              </label>
              <label>
                Link Text
                <input
                  value={custom.label}
                  onChange={(e) =>
                    setCustom({ ...custom, label: e.target.value })
                  }
                />
              </label>
              <button
                className="button"
                disabled={!custom.url || !custom.label}
                onClick={() => add(custom.label, custom.url)}
              >
                Add to Menu
              </button>
            </div>
          </details>
        </aside>
        <form className="worldact-menu-structure" onSubmit={save}>
          <div className="worldact-menu-bar">
            <label>
              Menu Name{" "}
              <input
                required
                maxLength={160}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>
            <button className="button button-primary" disabled={action.busy}>
              Save Menu
            </button>
          </div>
          <div className="worldact-menu-items">
            <h2>Menu structure</h2>
            <p>
              Arrange items with the move controls. Choose a parent to create a
              submenu.
            </p>
            {form.items.map((item, index) => (
              <details
                key={item.id}
                className={`worldact-menu-item ${item.parentId ? "is-child" : ""}`}
              >
                <summary>
                  {item.label}
                  <span>{item.parentId ? "sub item" : "Custom Link"}</span>
                </summary>
                <div className="worldact-stacked-fields">
                  <label>
                    Navigation Label
                    <input
                      value={item.label}
                      required
                      maxLength={200}
                      onChange={(e) =>
                        updateItem(item.id, { label: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    URL
                    <input
                      value={item.url}
                      required
                      onChange={(e) =>
                        updateItem(item.id, { url: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    Parent
                    <select
                      value={item.parentId || ""}
                      onChange={(e) =>
                        updateItem(item.id, {
                          parentId: e.target.value || null,
                        })
                      }
                    >
                      <option value="">No parent</option>
                      {form.items
                        .filter((candidate) => candidate.id !== item.id)
                        .map((candidate) => (
                          <option value={candidate.id} key={candidate.id}>
                            {candidate.label}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={item.target === "_blank"}
                      onChange={(e) =>
                        updateItem(item.id, {
                          target: e.target.checked ? "_blank" : "_self",
                        })
                      }
                    />{" "}
                    Open link in a new tab
                  </label>
                  <div className="worldact-inline-actions">
                    <button
                      className="button"
                      type="button"
                      disabled={!index}
                      onClick={() => move(index, -1)}
                    >
                      Move up
                    </button>
                    <button
                      className="button"
                      type="button"
                      disabled={index === form.items.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      Move down
                    </button>
                    <button
                      className="button-link button-link-delete"
                      type="button"
                      onClick={() =>
                        setForm((current) => ({
                          ...current,
                          items: current.items
                            .filter((candidate) => candidate.id !== item.id)
                            .map((candidate) =>
                              candidate.parentId === item.id
                                ? { ...candidate, parentId: null }
                                : candidate,
                            ),
                        }))
                      }
                    >
                      Remove
                    </button>
                  </div>
                </div>
              </details>
            ))}
            {!form.items.length && (
              <p>Add your first item from the panel on the left.</p>
            )}
            <h3>Menu Settings</h3>
            <label>
              Display location{" "}
              <select
                value={form.location}
                onChange={(e) => setForm({ ...form, location: e.target.value })}
              >
                <option value="">No location</option>
                <option value="primary">Primary navigation</option>
                <option value="footer">Footer navigation</option>
              </select>
            </label>
          </div>
          <div className="worldact-menu-bar">
            {selected && (
              <button
                type="button"
                className="button-link button-link-delete"
                disabled={action.busy}
                onClick={() => {
                  if (confirm("Delete this menu?"))
                    void action.run(async () => {
                      await api(`/menus/${selected}`, json("DELETE"));
                      setSelected(null);
                      setForm(emptyMenu());
                      await resource.reload();
                    }, "Menu deleted.");
                }}
              >
                Delete Menu
              </button>
            )}
            <button className="button button-primary" disabled={action.busy}>
              Save Menu
            </button>
          </div>
        </form>
      </div>
    </Screen>
  );
}

type Plugin = {
  slug: string;
  name: string;
  description: string;
  version: string;
  author: string;
  installed: boolean;
  enabled?: boolean;
  settings: Record<string, unknown>;
  apiKeyConfigured?:boolean;apiKeyHint?:string;keyVerified?:boolean;verifiedAt?:string|null;lastServiceError?:string|null;
};

function PluginSettings({
  plugin,
  onSave,
  busy,
  onVerify,
}: {
  plugin: Plugin;
  onSave: (settings: Record<string, unknown>,credentials?:{apiKey?:string;clearApiKey?:boolean}) => void;
  onVerify:()=>void;
  busy: boolean;
}) {
  const [form, setForm] = useState(plugin.settings);
  useEffect(() => setForm(plugin.settings), [plugin.settings]);
  if(plugin.slug==="akismet")return <AkismetSettings plugin={plugin} busy={busy} onSave={onSave} onVerify={onVerify}/>;
  if(plugin.slug==="hello-dolly")return <p className="description">Activate Hello Dolly to display a random song lyric in the upper right of administration pages. No settings are needed.</p>;
  return (
    <form
      className="worldact-plugin-settings"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(form);
      }}
    >
      {plugin.slug === "reading-time" && (
        <label>
          Words per minute{" "}
          <input
            type="number"
            min={50}
            max={1000}
            value={Number(form.wordsPerMinute || 200)}
            onChange={(e) =>
              setForm({ wordsPerMinute: Number(e.target.value) })
            }
          />
        </label>
      )}
      {plugin.slug === "spam-shield" && (
        <label>
          Maximum comment links{" "}
          <input
            type="number"
            min={0}
            max={30}
            value={Number(form.maxLinks ?? 3)}
            onChange={(e) => setForm({ maxLinks: Number(e.target.value) })}
          />
        </label>
      )}
      {plugin.slug === "site-seo" && (
        <>
          <label>
            Site description
            <textarea
              rows={3}
              maxLength={500}
              value={String(form.description || "")}
              onChange={(e) =>
                setForm({ ...form, description: e.target.value })
              }
            />
          </label>
          <label>
            Social sharing image URL
            <input
              value={String(form.siteImage || "")}
              onChange={(e) => setForm({ ...form, siteImage: e.target.value })}
            />
          </label>
        </>
      )}
      {plugin.slug === "custom-footer" && (
        <label>
          Footer text
          <textarea
            rows={3}
            maxLength={2000}
            value={String(form.text || "")}
            onChange={(e) => setForm({ text: e.target.value })}
          />
        </label>
      )}
      <button className="button" disabled={busy}>
        Save settings
      </button>
    </form>
  );
}

export function Plugins() {
  const resource = useResource<{ plugins: Plugin[] }>("/plugins");
  const [params, setParams] = useSearchParams();
  const view = params.get("tab") === "add" ? "catalog" :
    ["active", "inactive"].includes(params.get("plugin_status") || "") ? params.get("plugin_status")! : "all";
  function setView(value: string) {
    const next = new URLSearchParams(params);
    if (value === "catalog") { next.set("tab", "add"); next.delete("plugin_status"); }
    else { next.delete("tab"); value === "all" ? next.delete("plugin_status") : next.set("plugin_status", value); }
    setParams(next);
  }
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState("");
  const action = useAction();
  const plugins = (resource.data?.plugins || []).filter(
    (plugin) =>
      (view === "catalog" || plugin.installed) &&
      (view !== "active" || plugin.enabled) &&
      (view !== "inactive" || !plugin.enabled) &&
      `${plugin.name} ${plugin.description}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  async function operate(
    plugin: Plugin,
    operation: "install" | "activate" | "deactivate" | "delete",
    settings?: Record<string, unknown>,
    credentials?:{apiKey?:string;clearApiKey?:boolean},
  ) {
    await action.run(
      async () => {
        await api(
          `/plugins/${plugin.slug}${operation === "install" ? "/install" : ""}`,
          json(
            operation === "install"
              ? "POST"
              : operation === "delete"
                ? "DELETE"
                : "PUT",
            settings
              ? { settings,...credentials }
              : ["activate", "deactivate"].includes(operation)
                ? { enabled: operation === "activate" }
                : undefined,
          ),
        );
        await resource.reload();
        window.dispatchEvent(new Event("worldact-plugins-updated"));
      },
      settings
        ? "Plugin settings saved."
        : `Plugin ${operation === "install" ? "installed" : operation === "activate" ? "activated" : operation === "deactivate" ? "deactivated" : "deleted"}.`,
    );
  }
  return (
    <Screen
      title={view === "catalog" ? "Add Plugins" : "Plugins"}
      action={
        <button
          className="page-title-action"
          onClick={() => setView(view === "catalog" ? "all" : "catalog")}
        >
          {view === "catalog" ? "Installed Plugins" : "Add New Plugin"}
        </button>
      }
    >
      <Feedback action={action} />
      <ResourceState {...resource} retry={resource.reload} />
      {view === "catalog" && (
        <p>Install JavaScript extensions from your WorldAct registry.</p>
      )}
      <div className="worldact-list-tools">
        {view === "catalog" ? (
          <span>{plugins.length} available extensions</span>
        ) : (
          <ul className="subsubsub">
            {[
              ["all", "All"],
              ["active", "Active"],
              ["inactive", "Inactive"],
            ].map(([value, label], index) => (
              <li key={value}>
                {index > 0 && " | "}
                <button
                  className={`button-link ${view === value ? "current" : ""}`}
                  onClick={() => setView(value)}
                >
                  {label} (
                  {
                    (resource.data?.plugins || []).filter(
                      (p) =>
                        p.installed &&
                        (value === "all" ||
                          (value === "active" ? p.enabled : !p.enabled)),
                    ).length
                  }
                  )
                </button>
              </li>
            ))}
          </ul>
        )}
        <input
          type="search"
          aria-label="Search plugins"
          placeholder="Search plugins"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <table className="wp-list-table widefat plugins">
        <thead>
          <tr>
            <th>Plugin</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          {plugins.map((plugin) => (
            <tr
              className={plugin.enabled ? "active" : "inactive"}
              key={plugin.slug}
            >
              <td className="plugin-title">
                <strong>{plugin.name}</strong>
                <div className="row-actions visible">
                  {!plugin.installed ? (
                    <button
                      className="button-link"
                      disabled={action.busy}
                      onClick={() => void operate(plugin, "install")}
                    >
                      Install Now
                    </button>
                  ) : (
                    <>
                      <button
                        className="button-link"
                        disabled={action.busy}
                        onClick={() =>
                          void operate(
                            plugin,
                            plugin.enabled ? "deactivate" : "activate",
                          )
                        }
                      >
                        {plugin.enabled ? "Deactivate" : "Activate"}
                      </button>
                      {" | "}
                      <button
                        className="button-link"
                        onClick={() =>
                          setExpanded(
                            expanded === plugin.slug ? "" : plugin.slug,
                          )
                        }
                      >
                        Settings
                      </button>
                      {!plugin.enabled && (
                        <>
                          {" "}
                          |{" "}
                          <button
                            className="button-link button-link-delete"
                            disabled={action.busy}
                            onClick={() => {
                              if (confirm(`Delete ${plugin.name}?`))
                                void operate(plugin, "delete");
                            }}
                          >
                            Delete
                          </button>
                        </>
                      )}
                    </>
                  )}
                </div>
              </td>
              <td>
                <p>{plugin.description}</p>
                <div className="plugin-version-author-uri">
                  Version {plugin.version} | By {plugin.author}
                </div>
                {expanded === plugin.slug && plugin.installed && (
                  <PluginSettings
                    plugin={plugin}
                    busy={action.busy}
                    onVerify={()=>void action.run(async()=>{const result=await api<{result:string}>("/plugins/akismet/verify",json("POST",{}));await resource.reload();if(result.result!=="valid")throw new Error(result.result==="invalid"?"Akismet could not verify this key. Check the key and site address.":"Akismet is unavailable. Please try again later.");},"Akismet API key verified.")}
                    onSave={(settings,credentials) =>
                      void operate(
                        plugin,
                        plugin.enabled ? "activate" : "deactivate",
                        settings,credentials,
                      )
                    }
                  />
                )}
              </td>
            </tr>
          ))}
          {!plugins.length && (
            <tr>
              <td colSpan={2}>
                No plugins found.{" "}
                <button
                  className="button-link"
                  onClick={() => setView("catalog")}
                >
                  Browse available extensions
                </button>
                .
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Screen>
  );
}

export function Fonts() {
  const resource = useResource<{ settings: Settings }>("/settings");
  const { user } = useContext(Session);
  if (user?.role !== "administrator") return <Navigate to="/admin" replace />;
  return <Screen title="Fonts">
    <ResourceState {...resource} retry={resource.reload} />
    {resource.data && <Suspense fallback={<p>Loading Font Library…</p>}>
      <FontLibrary embedded theme={resource.data.settings.theme} onClose={() => {}} onChange={() => { void resource.reload(); window.dispatchEvent(new Event("worldact-settings-updated")); }} />
    </Suspense>}
  </Screen>;
}

type Theme = {
  id: ThemeId;
  name: string;
  description: string;
  version: string;
};

export function Themes() {
  const resource = useResource<{ themes: Theme[]; active: ThemeId }>("/themes");
  const [query, setQuery] = useState("");
  const action = useAction();
  return (
    <Screen
      title="Themes"
      action={
        <input
          type="search"
          aria-label="Search themes"
          placeholder="Search installed themes…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      }
    >
      <Feedback action={action} />
      <ResourceState {...resource} retry={resource.reload} />
      <p>
        Choose an installed React theme, then customize its templates and styles
        in the Site Editor.
      </p>
      <div className="worldact-theme-grid">
        {resource.data?.themes
          .filter((theme) =>
            theme.name.toLowerCase().includes(query.toLowerCase()),
          )
          .map((theme) => (
            <article
              className={`worldact-theme-card ${resource.data?.active === theme.id ? "is-active" : ""}`}
              key={theme.id}
            >
              {theme.id === "classic" ? (
                <div className="worldact-theme-classic-preview">
                  <span>WorldAct Classic</span>
                  <h3>Stories worth sharing.</h3>
                  <p>A place for your ideas.</p>
                  <hr />
                  <h4>Hello world!</h4>
                  <p>Welcome to your new chapter.</p>
                </div>
              ) : (
                <img
                  src={`/vendor/wordpress/wp-content/themes/${theme.id}/screenshot.png`}
                  alt={`${theme.name} theme preview`}
                />
              )}
              <div className="worldact-theme-meta">
                <h2>
                  {resource.data?.active === theme.id ? "Active: " : ""}
                  {theme.name}
                </h2>
                <div>
                  {resource.data?.active === theme.id ? (
                    <Link
                      className="button button-primary"
                      to="/admin/appearance/editor"
                    >
                      Customize
                    </Link>
                  ) : (
                    <button
                      className="button button-primary"
                      disabled={action.busy}
                      onClick={() =>
                        void action.run(async () => {
                          await api(
                            "/settings",
                            json("PUT", { theme: theme.id }),
                          );
                          await resource.reload();
                          window.dispatchEvent(
                            new Event("worldact-settings-updated"),
                          );
                        }, "New theme activated.")
                      }
                    >
                      Activate
                    </button>
                  )}{" "}
                  <Link className="button" to="/" target="_blank">
                    View site
                  </Link>
                </div>
              </div>
              <p>{theme.description}</p>
            </article>
          ))}
      </div>
    </Screen>
  );
}

type Design = {
  theme?: { id: string; name: string; version: string; variation: string; variations: {slug:string;title:string}[]; css:string; fonts?: ThemeJSON[] };
  styles: Partial<SiteStyle>;
  templates: SiteDocument[];
  parts: SiteDocument[];
  patterns: SiteDocument[];
  menus: NavigationMenu[];
  plugins: unknown[];
};
type SiteDocument = SiteTemplate & { version?: number; sourceMetadata?: {source?:string;description?:string;inserter?:boolean} };
const defaultStyle: SiteStyle = {
  backgroundColor: "#ffffff",
  textColor: "#111111",
  accentColor: "#3858e9",
  fontFamily: "Manrope",
  headingFont: "Manrope",
  contentWidth: 1200,
  spacing: 24,
};
const fontFamily = (font: string) =>
  font === "System"
    ? "-apple-system, BlinkMacSystemFont, sans-serif"
    : font === "Georgia"
      ? "Georgia, serif"
      : `${JSON.stringify(font)}, sans-serif`;

const templatePartAreas = [
  ["uncategorized", "General"],
  ["header", "Header"],
  ["footer", "Footer"],
  ["navigation-overlay", "Navigation Overlay"],
] as const;
type TemplatePartArea = NonNullable<SiteTemplate["area"]>;
function TemplatePartAreaSelect({ value, onChange }: { value: TemplatePartArea; onChange: (area: TemplatePartArea) => void }) {
  return <label>Area <select value={value} onChange={event => onChange(event.target.value as TemplatePartArea)}>
    {templatePartAreas.map(([area,label]) => <option value={area} key={area}>{label}</option>)}
  </select></label>;
}

export function SiteEditor() {
  const resource = useResource<Design>("/site-editor");
  const media = useResource<{ media: Media[] }>("/media");
  const { user } = useContext(Session);
  const [view, setView] = useState("templates");
  const [designSearch, setDesignSearch] = useState("");
  const [fontLibraryOpen,setFontLibraryOpen] = useState(false);
  const [selected, setSelected] = useState<SiteDocument | null>(null);
  const [styles, setStyles] = useState<Partial<SiteStyle>>({});
  const [variation, setVariation] = useState("");
  const [code, setCode] = useState(false);
  const [inspector, setInspector] = useState(false);
  const [inserter, setInserter] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newType, setNewType] = useState<SiteTemplate["type"]>("pattern");
  const [newArea,setNewArea] = useState<NonNullable<SiteTemplate["area"]>>("uncategorized");
  const editor = useRef<GutenbergEditorHandle>(null);
  const action = useAction();
  useEffect(() => {
    if (resource.data) {
      setStyles(resource.data.styles);
      setVariation(resource.data.theme?.variation || "");
    }
  }, [resource.data]);
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty]);
  function choose(document: SiteDocument) {
    if (dirty && !confirm("Discard unsaved template changes?")) return;
    setSelected({ ...document, content: document.rawContent || document.content });
    setResetKey((current) => current + 1);
    setDirty(false);
    action.setNotice("");
  }
  async function save() {
    if (!selected) return;
    await action.run(async () => {
      await editor.current?.flushEntities();
      const { slug, title, type, version } = selected;
      const result = await api<{ document: SiteDocument }>(
        `/site-editor/documents/${selected.id}`,
        json("PUT", {
          slug,
          title,
          type,
          ...(type==="template-part"?{area:selected.area || "uncategorized"}:{}),
          content: code
            ? selected.content
            : (editor.current?.getHTML() ?? selected.content),
          blocks: code
            ? null
            : (editor.current?.getBlocks() ?? selected.blocks),
          ...(version ? { version } : {}),
        }),
      );
      setSelected({ ...result.document, content: result.document.rawContent || result.document.content });
      setDirty(false);
      await resource.reload();
    }, "Design saved. Your public site now uses these changes.");
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    await action.run(async () => {
      const slug =
        newTitle
          .toLowerCase()
          .normalize("NFKD")
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "") || `design-${Date.now()}`;
      const result = await api<{ document: SiteDocument }>(
        "/site-editor/documents",
        json("POST", {
          slug,
          title: newTitle,
          type: newType,
          ...(newType==="template-part"?{area:newArea}:{}),
          content: "",
          blocks: [],
        }),
      );
      await resource.reload();
      choose(result.document);
      setCreating(false);
      setNewTitle("");
    }, "Design created.");
  }
  const docs =
    view === "patterns"
      ? resource.data?.patterns
      : view === "parts"
        ? resource.data?.parts
        : resource.data?.templates;
  const baseTheme = themeDocument(resource.data?.theme?.id || "classic", variation);
  const libraryFonts = resource.data?.theme?.fonts || [];
  const sourceTheme: ThemeJSON | null = baseTheme ? {...baseTheme,settings:{...baseTheme.settings,typography:{...baseTheme.settings?.typography,fontFamilies:[...(baseTheme.settings?.typography?.fontFamilies || []),...libraryFonts]}}} : null;
  const fontChoices = [...new Set(["Manrope","Inter","Georgia","System","serif","sans-serif",...libraryFonts.map((font)=>String(font.name))])];
  const sourceValue = (value: unknown) => resolveThemeValue(value, sourceTheme);
  const sourceColor = (value: unknown, fallback: string) => /^#[a-f\d]{3,8}$/i.test(sourceValue(value)) ? sourceValue(value) : fallback;
  const defaults = {
    ...defaultStyle,
    backgroundColor: sourceColor(sourceTheme?.styles?.color?.background, "#ffffff"),
    textColor: sourceColor(sourceTheme?.styles?.color?.text, "#111111"),
    accentColor: sourceColor(sourceTheme?.styles?.elements?.link?.color?.text, sourceColor(sourceTheme?.styles?.color?.text, "#111111")),
    fontFamily: sourceValue(sourceTheme?.styles?.typography?.fontFamily) || fontFamily("Manrope"),
    headingFont: sourceValue(sourceTheme?.styles?.elements?.heading?.typography?.fontFamily) || sourceValue(sourceTheme?.styles?.typography?.fontFamily) || fontFamily("Manrope"),
    contentWidth: Number.parseFloat(sourceTheme?.settings?.layout?.wideSize) || 1200,
    spacing: sourceTheme?.styles?.spacing?.blockGap?.endsWith("rem") ? Math.round(Number.parseFloat(sourceTheme.styles.spacing.blockGap) * 16) : Number.parseFloat(sourceTheme?.styles?.spacing?.blockGap) || 24,
  };
  const displayStyles = {...defaults,...styles};
  const clearStyle = (key: keyof SiteStyle) => setStyles((previous) => {const next={...previous};delete next[key];return next;});
  const canvasCSS = sourceTheme
    ? compileThemeStyles(sourceTheme,"body.editor-styles-wrapper",styles)
    : compileThemeStyles({settings:{typography:{fontFamilies:libraryFonts}}},"body.editor-styles-wrapper",displayStyles);
  return (
    <Screen
      title="Site Editor"
      action={
        <Link className="button" to="/" target="_blank">
          View site ↗
        </Link>
      }
    >
      <Feedback action={action} />
      <ResourceState {...resource} retry={resource.reload} />
      {fontLibraryOpen && <Suspense fallback={<p>Loading Font Library…</p>}><FontLibrary theme={resource.data?.theme?.id || "classic"} onClose={()=>setFontLibraryOpen(false)} onChange={()=>{void resource.reload();setResetKey((value)=>value+1);}}/></Suspense>}
      <div className="worldact-site-editor">
        <aside className="worldact-design-navigation">
          <div className="worldact-design-brand">
            <Brand />
            <strong>Design</strong>
          </div>
          {[
            ["templates", "Templates"],
            ["parts", "Template Parts"],
            ["patterns", "Patterns"],
            ["styles", "Styles"],
          ].map(([value, label]) => (
            <button
              className={view === value ? "is-active" : ""}
              key={value}
              onClick={() => {setView(value);setDesignSearch("");}}
            >
              {label}
              <span>›</span>
            </button>
          ))}
          <Link to="/admin/appearance/menus">
            Navigation <span>›</span>
          </Link>
          <Link to="/admin/appearance">
            Themes <span>›</span>
          </Link>
        </aside>
        <div className="worldact-design-content">
          {view === "styles" ? (
            <>
              <div className="worldact-screen-heading"><h2>Styles</h2>{user?.role === "administrator" && <button className="button" onClick={()=>setFontLibraryOpen(true)}>Manage fonts</button>}</div>
              <p>Customize the colors, typography, and layout of {resource.data?.theme?.name || "your site"}.</p>
              {user?.role === "administrator" ? (
                <form onSubmit={(event) => {
                  event.preventDefault();
                  void action.run(async () => {
                    if (resource.data?.theme?.id === "classic") await api("/site-editor/styles",json("PUT",{...defaultStyle,...styles}));
                    else await api("/site-editor/theme",json("PUT",{variation,styles}));
                    await resource.reload();
                  },"Global styles saved.");
                }}>
                  {sourceTheme && <fieldset className="worldact-theme-variations">
                    <legend>Browse styles</legend>
                    <label>Style variation
                      <select value={variation} onChange={(event) => {setVariation(event.target.value);setStyles({});}}>
                        <option value="">Default</option>
                        {resource.data?.theme?.variations.map((item) => <option key={item.slug} value={item.slug}>{item.title}</option>)}
                      </select>
                    </label>
                    <p className="description">Each variation uses the theme’s original palette and typography. Save to apply it to your site.</p>
                  </fieldset>}
                  <div className="worldact-style-fields">
                    <fieldset><legend>Colors</legend>
                      {([["backgroundColor","Background"],["textColor","Text"],["accentColor","Links"]] as const).map(([key,label]) => <label key={key}>
                        {label}<div><input type="color" aria-label={label} value={displayStyles[key]} onChange={(event) => setStyles({...styles,[key]:event.target.value})}/><code>{displayStyles[key]}</code>
                        {styles[key] && <button type="button" className="button-link" onClick={() => clearStyle(key)}>Reset</button>}</div>
                      </label>)}
                    </fieldset>
                    <fieldset><legend>Typography</legend>
                      {([["fontFamily","Text"],["headingFont","Headings"]] as const).map(([key,label]) => <label key={key}>
                        {label}<select value={styles[key] || ""} onChange={(event) => event.target.value ? setStyles({...styles,[key]:event.target.value}) : clearStyle(key)}>
                          <option value="">Theme default</option>
                          {fontChoices.map((font) => <option key={font}>{font}</option>)}
                        </select><span className="description">Default: {defaults[key].replace(/['"]/g,"")}</span>
                      </label>)}
                    </fieldset>
                    <fieldset><legend>Layout</legend>
                      <label>Wide width<input type="number" min={480} max={1800} value={displayStyles.contentWidth} onChange={(event) => setStyles({...styles,contentWidth:Number(event.target.value)})}/>
                        {styles.contentWidth && <button type="button" className="button-link" onClick={() => clearStyle("contentWidth")}>Reset width</button>}
                      </label>
                      <label>Block spacing<input type="number" min={8} max={80} value={displayStyles.spacing} onChange={(event) => setStyles({...styles,spacing:Number(event.target.value)})}/>
                        {styles.spacing && <button type="button" className="button-link" onClick={() => clearStyle("spacing")}>Reset spacing</button>}
                      </label>
                    </fieldset>
                  </div>
                  <style>{compileThemeStyles(sourceTheme || {settings:{typography:{fontFamilies:libraryFonts}}},".worldact-theme-style-preview",styles)}</style>
                  <div className="worldact-style-preview worldact-theme-style-preview" style={sourceTheme ? {padding:32} : {background:displayStyles.backgroundColor,color:displayStyles.textColor,fontFamily:fontFamily(displayStyles.fontFamily),padding:32}}>
                    <h2>Make it yours.</h2><p>Every story begins with a little inspiration. Your words, your colors, your world.</p>
                    <a href="#style-preview" onClick={(event) => event.preventDefault()}>A preview of your links →</a>
                  </div>
                  <p className="worldact-inline-actions"><button className="button button-primary" disabled={action.busy}>Save Styles</button>
                    {sourceTheme && <button type="button" className="button" disabled={action.busy} onClick={() => {setVariation("");setStyles({});}}>Reset to theme defaults</button>}
                  </p>
                </form>
              ) : <p>Global style changes require an administrator.</p>}
            </>
          ) : (
            <>
              <div className="worldact-screen-heading">
                <h2>
                  {view === "patterns"
                    ? "Patterns"
                    : view === "parts"
                      ? "Template Parts"
                      : "Templates"}
                </h2>
                <button
                  className="button"
                  onClick={() => {
                    setCreating(!creating);
                    setNewType(
                      view === "patterns"
                        ? "pattern"
                        : view === "parts"
                          ? "template-part"
                          : "template",
                    );
                  }}
                >
                  Add New
                </button>
              </div>
              {creating && (
                <form className="worldact-design-create" onSubmit={create}>
                  <label>
                    Name{" "}
                    <input
                      required
                      maxLength={200}
                      value={newTitle}
                      type="text"
                      onChange={(e) => setNewTitle(e.target.value)}
                    />
                  </label>
                  <label>
                    Type{" "}
                    <select
                      value={newType}
                      onChange={(e) =>
                        setNewType(e.target.value as SiteTemplate["type"])
                      }
                    >
                      <option value="template">Template</option>
                      <option value="template-part">Template Part</option>
                      <option value="pattern">Pattern</option>
                    </select>
                  </label>
                  {newType==="template-part" && <TemplatePartAreaSelect value={newArea} onChange={setNewArea}/>}
                  <button
                    className="button button-primary"
                    disabled={action.busy}
                  >
                    Create
                  </button>
                </form>
              )}
              <input className="worldact-design-filter" type="search" aria-label="Search designs" placeholder="Search designs…" value={designSearch} onChange={(event) => setDesignSearch(event.target.value)}/>
              <div className="worldact-document-list">
                {docs?.filter((document) => `${document.title} ${document.slug}`.toLowerCase().includes(designSearch.toLowerCase())).map((document) => (
                  <button
                    key={document.id}
                    className={
                      selected?.id === document.id ? "is-selected" : ""
                    }
                    onClick={() => choose(document)}
                  >
                    <strong>{document.title}</strong>
                    <span>{document.slug}</span>
                    {document.type==="template-part" && <small>{templatePartAreas.find(([area])=>area===(document.area || "uncategorized"))?.[1]}</small>}
                  </button>
                ))}
              </div>
              {selected ? (
                <>
                  <div className="worldact-template-toolbar">
                    <label>
                      Title{" "}
                      <input
                        type="text"
                        value={selected.title}
                        onChange={(e) => {
                          setSelected({ ...selected, title: e.target.value });
                          setDirty(true);
                        }}
                      />
                    </label>
                    {selected.type==="template-part" && <TemplatePartAreaSelect value={selected.area || "uncategorized"} onChange={area=>{setSelected({...selected,area});setDirty(true);}}/>}
                    <div className="worldact-inline-actions">
                      <button
                        className={`button ${inserter ? "is-pressed" : ""}`}
                        onClick={() => setInserter(!inserter)}
                      >
                        Add block
                      </button>
                      <button
                        className="button"
                        onClick={() => setInspector(!inspector)}
                      >
                        Block settings
                      </button>
                      <button
                        className="button"
                        onClick={() => {
                          if (!code)
                            setSelected({
                              ...selected,
                              content:
                                editor.current?.getHTML() ?? selected.content,
                              blocks:
                                editor.current?.getBlocks() ?? selected.blocks,
                            });
                          else {
                            setSelected({ ...selected, blocks: null });
                            setResetKey((key) => key + 1);
                          }
                          setCode(!code);
                        }}
                      >
                        {code ? "Visual editor" : "Code editor"}
                      </button>
                      <button
                        className="button button-primary"
                        disabled={action.busy || !selected.title.trim()}
                        onClick={() => void save()}
                      >
                        {action.busy ? "Saving…" : "Save"}
                      </button>
                    </div>
                  </div>
                  {selected.type !== "pattern" && <details className="worldact-template-tokens">
                    <summary>Template blocks</summary><p>Add live site and post content to your template.</p>
                    <div>{[["core/site-title","Site title"],["core/navigation","Navigation"],["core/post-title","Post title"],["core/post-content","Content"],["core/comments","Comments"]].map(([name,label]) => <button type="button" className="button" key={name} onClick={() => {
                      if(code){setSelected({...selected,content:selected.content+`\n<!-- wp:${name.replace("core/","")} /-->`});setDirty(true);}
                      else editor.current?.insertBlocks([{name,attributes:{},innerBlocks:[]}]);
                    }}>{label}</button>)}</div>
                  </details>}
                  {code ? (
                    <textarea
                      className="worldact-template-code"
                      aria-label="Template HTML"
                      spellCheck={false}
                      value={selected.content}
                      onChange={(e) => {
                        setSelected({
                          ...selected,
                          content: e.target.value,
                          blocks: null,
                        });
                        setDirty(true);
                      }}
                    />
                  ) : (
                    <Suspense fallback={<p>Loading block editor…</p>}>
                      <BlockEditor
                        context="site"
                        entityContext={siteDocumentEntity(selected,resource.data?.theme?.id || "twentytwentyfive")}
                        onEntitySaved={()=>void resource.reload()}
                        ref={editor}
                        initialBlocks={selected.blocks}
                        initialHTML={selected.content}
                        resetKey={`${selected.id}-${resetKey}`}
                        onChange={(blocks, content) => {
                          setSelected((current) =>
                            current ? { ...current, blocks, content } : current,
                          );
                          setDirty(true);
                        }}
                        media={media.data?.media || []}
                        inserterOpen={inserter}
                        onInserterClose={() => setInserter(false)}
                        inspectorOpen={inspector}
                        canvasCSS={canvasCSS}
                        onError={action.setError}
                      />
                    </Suspense>
                  )}
                  <div className="worldact-template-status">
                    <span>
                      {dirty
                        ? "Unsaved changes"
                        : `Last saved ${date(selected.updatedAt)}`}
                    </span>
                    {selected.sourceMetadata?.source && <button type="button" className="button-link" disabled={action.busy} onClick={() => {
                      if(!confirm(`Reset ${selected.title} to the theme’s original design?`))return;
                      void action.run(async () => {
                        const result=await api<{document:SiteDocument}>(`/site-editor/documents/${selected.id}/reset`,json("POST"));
                        setSelected({...result.document,content:result.document.rawContent || result.document.content});setResetKey((key)=>key+1);setDirty(false);await resource.reload();
                      },"Original theme design restored.");
                    }}>Reset to original</button>}
                    {!selected.sourceMetadata?.source && !["header", "footer", "single", "page", "index"].includes(
                      selected.slug,
                    ) && (
                      <button
                        className="button-link button-link-delete"
                        disabled={action.busy}
                        onClick={() => {
                          if (confirm(`Delete ${selected.title}?`))
                            void action.run(async () => {
                              await api(
                                `/site-editor/documents/${selected.id}`,
                                json("DELETE"),
                              );
                              setSelected(null);
                              setDirty(false);
                              await resource.reload();
                            }, "Design deleted.");
                        }}
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <p className="worldact-design-empty">
                  Select a design to edit its blocks.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </Screen>
  );
}

type Health = {
  status: string;
  checks: { label: string; status: string; detail: string }[];
  counts: Record<string, number>;
};
type Mail = {
  id: number;
  recipient: string;
  subject: string;
  body: string;
  delivered: boolean;
  createdAt: string;
};

export function ToolsSuite() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") || "health";
  const { user } = useContext(Session);
  const admin = user?.role === "administrator";
  const resource = useResource<Health | { messages: Mail[] }>(
    tab === "mail" && admin
      ? "/tools/mail"
      : admin
        ? "/tools/health"
        : "/profile",
  );
  const [importData, setImportData] = useState<Record<string, unknown> | null>(
    null,
  );
  const [fileName, setFileName] = useState("");
  const [replaceDesign, setReplaceDesign] = useState(false);
  const [importCount, setImportCount] = useState(0);
  const action = useAction();
  const tabs = admin
    ? [
        ["health", "Site Health"],
        ["export", "Export"],
        ["import", "Import"],
        ["privacy-export", "Export Personal Data"],
        ["privacy-erase", "Erase Personal Data"],
        ["mail", "Mail"],
      ]
    : [["privacy", "Personal Data"]];
  const active = admin ? tab : "privacy";
  return (
    <Screen title={active === "export" ? "Export" : active === "import" ? "Import" : "Tools"}>
      <Feedback action={action} />
      <nav className="nav-tab-wrapper">
        {tabs.map(([value, label]) => (
          <button
            type="button"
            key={value}
            className={`nav-tab ${active === value ? "nav-tab-active" : ""}`}
            onClick={() => setParams({ tab: value })}
          >
            {label}
          </button>
        ))}
      </nav>
      <ResourceState {...resource} retry={resource.reload} />
      {active === "health" && resource.data && "checks" in resource.data && (
        <HealthDetails>
          <div className="worldact-health-heading">
            <span className="worldact-health-ring" />{" "}
            <div>
              <h2>Your site is working</h2>
              <p>
                Review configuration recommendations and runtime details below.
              </p>
            </div>
          </div>
          {resource.data.checks.map((check) => (
            <details className="worldact-health-check" key={check.label}>
              <summary>
                <strong>{check.label}</strong>
                <span className={`worldact-status ${check.status}`}>
                  {check.status === "good" ? "Good" : "Recommended"}
                </span>
              </summary>
              <p>{check.detail}</p>
            </details>
          ))}
          <h2>At a glance</h2>
          <ul className="ul-disc">
            {Object.entries(resource.data.counts).map(([key, value]) => (
              <li key={key}>
                {value} {key}
              </li>
            ))}
          </ul>
        </HealthDetails>
      )}
      {active === "export" && <ExportContent />}
      {active === "import" && (
        <div className="worldact-tool-panel">
          <h2>Import content</h2>
          <p>
            Upload a WorldAct JSON export or WordPress XML (WXR) file to import
            your content. JSON archives support up to 96 MiB, including up to 64
            MiB of decoded media files; WordPress XML files support up to 8 MiB.
            Imported content is assigned to your account.
          </p>
          <input
            type="file"
            accept="application/json,application/xml,text/xml,.json,.xml"
            aria-label="Choose import file"
            disabled={action.busy}
            onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              e.currentTarget.value = "";
              if (file) {
                setImportData(null);
                setFileName("");
                setReplaceDesign(false);
              }
              if (file)
                void action.run(async () => {
                  if (file.size > 96 * 1024 * 1024)
                    throw new Error(
                      "Choose a JSON archive no larger than 96 MiB.",
                    );
                  const contents = await file.text();
                  if (contents.trimStart().startsWith("<")) {
                    if (file.size > 8 * 1024 * 1024)
                      throw new Error(
                        "Choose a WordPress XML file no larger than 8 MiB.",
                      );
                    const document = new DOMParser().parseFromString(
                      contents,
                      "application/xml",
                    );
                    if (
                      document.querySelector("parsererror") ||
                      !document.getElementsByTagName("wp:wxr_version").length
                    )
                      throw new Error(
                        "This file is not a valid WordPress XML export.",
                      );
                    setImportData({ format: "wxr", xml: contents });
                    setImportCount(
                      document.getElementsByTagName("item").length,
                    );
                  } else {
                    const parsed = JSON.parse(contents) as Record<
                      string,
                      unknown
                    >;
                    if (
                      parsed.application !== "WorldAct" ||
                      !Array.isArray(parsed.posts)
                    )
                      throw new Error(
                        "This file is not a WorldAct content export.",
                      );
                    setImportData(parsed);
                    setImportCount(parsed.posts.length);
                  }
                  setFileName(file.name);
                });
            }}
          />
          {importData && (
            <>
              <p>
                <strong>{fileName}</strong> contains {importCount} content
                items.
              </p>
              {importData.format !== "wxr" && (
                <div className="privacy-admin-verification">
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={replaceDesign}
                      onChange={(event) =>
                        setReplaceDesign(event.target.checked)
                      }
                    />
                    Replace site design and settings
                  </label>
                  <p>
                    When selected, imported templates, styles, settings, menu
                    locations, and extensions become active. The destination
                    site address and administration email are kept. Leave this
                    unchecked to import content while preserving your live
                    design and settings.
                  </p>
                </div>
              )}
              <button
                className="button button-primary"
                disabled={action.busy}
                onClick={() =>
                  void action
                    .run(async () => {
                      const result = await api<{
                        imported: number;
                        warnings?: string[];
                      }>(
                        "/tools/import",
                        json(
                          "POST",
                          importData.format === "wxr"
                            ? importData
                            : { ...importData, replaceDesign },
                        ),
                      );
                      setImportData(null);
                      setFileName("");
                      setReplaceDesign(false);
                      return result;
                    })
                    .then((result) => {
                      if (result)
                        action.setNotice(
                          [
                            `${result.imported} items imported.`,
                            ...new Set(result.warnings || []),
                          ].join(" "),
                        );
                    })
                }
              >
                Import Content
              </button>
            </>
          )}
        </div>
      )}
      {active === "privacy" && (
        <div className="worldact-tool-panel">
          <h2>Export Personal Data</h2>
          <p>
            Download your account details and comments associated with your
            email address.
          </p>
          <button
            className="button button-primary"
            disabled={action.busy}
            onClick={() =>
              void action.run(
                async () =>
                  downloadJSON(
                    "worldact-personal-data.json",
                    await api("/tools/privacy/export", json("POST")),
                  ),
                "Personal data downloaded.",
              )
            }
          >
            Export My Personal Data
          </button>
        </div>
      )}
      {active === "mail" && resource.data && "messages" in resource.data && (
        <>
          <p>
            Messages generated by WorldAct. Without SMTP, password reset links
            are available here for local development.
          </p>
          {resource.data.messages.length ? (
            resource.data.messages.map((message) => (
              <details className="worldact-mail-item" key={message.id}>
                <summary>
                  <strong>{message.subject}</strong>
                  <span>
                    {message.recipient} · {date(message.createdAt)} ·{" "}
                    {message.delivered ? "Sent" : "Local outbox"}
                  </span>
                </summary>
                <pre>{message.body}</pre>
                <button
                  className="button-link button-link-delete"
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(async () => {
                      await api(`/tools/mail/${message.id}`, json("DELETE"));
                      await resource.reload();
                    }, "Message deleted.")
                  }
                >
                  Delete message
                </button>
              </details>
            ))
          ) : (
            <p>No messages in the outbox.</p>
          )}
        </>
      )}
    </Screen>
  );
}

function PasswordLayout({ children }: { children: ReactNode }) {
  return (
    <div id="login">
      <h1>
        <Link to="/" aria-label="WorldAct home">
          <Brand />
          <span className="screen-reader-text">WorldAct</span>
        </Link>
      </h1>
      {children}
      <p id="nav">
        <Link to="/login">Log in</Link>
      </p>
      <p id="backtoblog">
        <Link to="/">← Go to WorldAct</Link>
      </p>
    </div>
  );
}

export function LostPassword() {
  const [login, setLogin] = useState("");
  const action = useAction();
  return (
    <PasswordLayout>
      <p className="message">
        Enter your username or email address. You will receive a link to create
        a new password.
      </p>
      <Feedback action={action} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            const result = await api<{ message: string }>(
              "/auth/forgot-password",
              json("POST", { login }),
            );
            action.setNotice(result.message);
          }, "Password reset requested. If your account exists, check your email or the local mail outbox.");
        }}
      >
        <label htmlFor="lost-login">Username or Email Address</label>
        <input
          id="lost-login"
          className="input"
          required
          autoComplete="username"
          value={login}
          onChange={(e) => setLogin(e.target.value)}
        />
        <p className="submit">
          <button
            className="button button-primary button-large"
            disabled={action.busy}
          >
            Get New Password
          </button>
        </p>
      </form>
    </PasswordLayout>
  );
}

export function ResetPassword() {
  const [params] = useSearchParams();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [complete, setComplete] = useState(false);
  const action = useAction();
  return (
    <PasswordLayout>
      <Feedback action={action} />
      {complete ? (
        <p className="message">
          Your password has been reset. <Link to="/login">Log in</Link>
        </p>
      ) : (
        <>
          <p className="message">Enter your new password below.</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (password !== confirmPassword) {
                action.setError("The passwords do not match.");
                return;
              }
              void action.run(async () => {
                await api(
                  "/auth/reset-password",
                  json("POST", { token: params.get("token") || "", password }),
                );
                setComplete(true);
              });
            }}
          >
            <label htmlFor="reset-password">New Password</label>
            <input
              id="reset-password"
              className="input"
              type="password"
              minLength={12}
              required
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <label htmlFor="reset-confirm">Confirm New Password</label>
            <input
              id="reset-confirm"
              className="input"
              type="password"
              minLength={12}
              required
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
            <p>Use at least 12 characters.</p>
            <p className="submit">
              <button
                className="button button-primary button-large"
                disabled={action.busy}
              >
                Save Password
              </button>
            </p>
          </form>
        </>
      )}
    </PasswordLayout>
  );
}
