import {
  lazy,
  Suspense,
  useContext,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
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
import "../platform.css";

const BlockEditor = lazy(() => import("../editor/GutenbergEditor"));

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function run<T>(
    work: () => Promise<T>,
    message = "",
  ): Promise<T | undefined> {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await work();
      setNotice(message);
      return result;
    } catch (reason) {
      setError(errorText(reason));
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, notice, run, setError, setNotice };
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
  const [form, setForm] = useState<User | null>(null);
  const [password, setPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const action = useAction();
  useEffect(() => {
    if (resource.data) setForm(resource.data.user);
  }, [resource.data]);
  const set = (key: keyof User, value: string) =>
    setForm((current) => (current ? { ...current, [key]: value } : current));
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form) return;
    await action.run(async () => {
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
      } = form;
      const result = await api<{ user: User }>(
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
          ...(password
            ? { password, ...(form.id === user?.id ? { currentPassword } : {}) }
            : {}),
          ...(form.id !== user?.id ? { role: form.role } : {}),
        }),
      );
      setForm(result.user);
      if (form.id === user?.id) setUser({ ...user, ...result.user });
      setPassword("");
      setCurrentPassword("");
    }, "Profile updated.");
  }
  return (
    <Screen title={id && form?.id !== user?.id ? "Edit User" : "Profile"}>
      <Feedback action={action} />
      <ResourceState {...resource} retry={resource.reload} />
      {form && (
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
    </Screen>
  );
}

type SettingValues = Record<
  string,
  string | number | boolean | null | undefined
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
  ],
  writing: ["defaultCategoryId", "defaultPostFormat"],
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
    "defaultCommentStatus",
    "requireCommentNameEmail",
    "commentRegistration",
    "commentModeration",
    "commentsPerPage",
    "threadComments",
    "threadDepth",
    "closeCommentsDays",
    "commentOrder",
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
  const resource = useResource<{ settings: Settings }>("/settings");
  const pages = useResource<{ pages: Post[] }>("/public/site");
  const terms = useResource<{ terms: { id: number; name: string }[] }>(
    "/terms?taxonomy=category",
  );
  const [form, setForm] = useState<SettingValues>({});
  const action = useAction();
  useEffect(() => {
    if (resource.data)
      setForm(resource.data.settings as unknown as SettingValues);
  }, [resource.data]);
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
  const pageSelect = (key: string, label: string) => (
    <select
      aria-label={label}
      value={String(form[key] ?? "")}
      onChange={(e) => set(key, e.target.value ? Number(e.target.value) : null)}
    >
      <option value="">— Select —</option>
      {pages.data?.pages.map((page) => (
        <option value={page.id} key={page.id}>
          {page.title || "(no title)"}
        </option>
      ))}
    </select>
  );
  async function save(event: FormEvent) {
    event.preventDefault();
    await action.run(async () => {
      const input = Object.fromEntries(
        settingKeys[tab]
          .filter((key) => form[key] !== undefined)
          .map((key) => [key, form[key]]),
      );
      const result = await api<{ settings: Settings }>(
        "/settings",
        json("PUT", input),
      );
      resource.setData(result);
      window.dispatchEvent(new Event("worldact-settings-updated"));
    }, "Settings saved.");
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
                          "America/Los_Angeles",
                          "America/New_York",
                          "Europe/London",
                          "Europe/Berlin",
                          "Asia/Tokyo",
                          "Australia/Sydney",
                        ]),
                      ].map((zone) => [zone, zone.replaceAll("_", " ")]),
                    )}
                  </Field>
                  <Field label="Date Format">
                    {select("dateFormat", "Date Format", [
                      ["F j, Y", "November 6, 2026"],
                      ["Y-m-d", "2026-11-06"],
                      ["m/d/Y", "11/06/2026"],
                      ["d/m/Y", "06/11/2026"],
                    ])}
                  </Field>
                  <Field label="Time Format">
                    {select("timeFormat", "Time Format", [
                      ["g:i a", "1:30 pm"],
                      ["g:i A", "1:30 PM"],
                      ["H:i", "13:30"],
                    ])}
                  </Field>
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
                      [
                        "standard",
                        "aside",
                        "image",
                        "video",
                        "quote",
                        "link",
                        "gallery",
                        "audio",
                      ].map((name) => [
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
                  <Field label="Before a comment appears">
                    {check(
                      "commentModeration",
                      "Comment must be manually approved",
                    )}
                  </Field>
                  <Field label="Comment pagination">
                    {number("commentsPerPage", "Comments per page", 1, 200)}{" "}
                    comments per page
                  </Field>
                  <Field label="Comments should be displayed with">
                    {select("commentOrder", "Comment order", [
                      ["asc", "Older comments first"],
                      ["desc", "Newer comments first"],
                    ])}
                  </Field>
                </>
              )}
              {tab === "media" && (
                <>
                  <Field label="Thumbnail size">
                    <label>
                      Width{" "}
                      {number("thumbnailWidth", "Thumbnail width", 1, 4096)}
                    </label>{" "}
                    <label>
                      Height{" "}
                      {number("thumbnailHeight", "Thumbnail height", 1, 4096)}
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
                      Max width {number("mediumWidth", "Medium width")}
                    </label>{" "}
                    <label>
                      Max height {number("mediumHeight", "Medium height")}
                    </label>
                  </Field>
                  <Field label="Large size">
                    <label>
                      Max width {number("largeWidth", "Large width")}
                    </label>{" "}
                    <label>
                      Max height {number("largeHeight", "Large height")}
                    </label>
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
                <Field
                  label="Change your Privacy Policy page"
                  hint="This page can explain how your site collects and handles personal information."
                >
                  {pageSelect("privacyPageId", "Privacy Policy page")}{" "}
                  <Link className="button" to="/admin/pages/new">
                    Create a new page
                  </Link>
                </Field>
              )}
            </tbody>
          </table>
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
};

function PluginSettings({
  plugin,
  onSave,
  busy,
}: {
  plugin: Plugin;
  onSave: (settings: Record<string, unknown>) => void;
  busy: boolean;
}) {
  const [form, setForm] = useState(plugin.settings);
  useEffect(() => setForm(plugin.settings), [plugin.settings]);
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
  const [view, setView] = useState("all");
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
              ? { settings }
              : ["activate", "deactivate"].includes(operation)
                ? { enabled: operation === "activate" }
                : undefined,
          ),
        );
        await resource.reload();
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
                    onSave={(settings) =>
                      void operate(
                        plugin,
                        plugin.enabled ? "activate" : "deactivate",
                        settings,
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
  styles: SiteStyle;
  templates: SiteDocument[];
  parts: SiteDocument[];
  patterns: SiteDocument[];
  menus: NavigationMenu[];
  plugins: unknown[];
};
type SiteDocument = SiteTemplate & { version?: number };
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
      : `"${font}", sans-serif`;

export function SiteEditor() {
  const resource = useResource<Design>("/site-editor");
  const media = useResource<{ media: Media[] }>("/media");
  const { user } = useContext(Session);
  const [view, setView] = useState("templates");
  const [selected, setSelected] = useState<SiteDocument | null>(null);
  const [styles, setStyles] = useState<SiteStyle>(defaultStyle);
  const [code, setCode] = useState(false);
  const [inspector, setInspector] = useState(false);
  const [inserter, setInserter] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newType, setNewType] = useState<SiteTemplate["type"]>("pattern");
  const editor = useRef<GutenbergEditorHandle>(null);
  const action = useAction();
  useEffect(() => {
    if (resource.data) setStyles({ ...defaultStyle, ...resource.data.styles });
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
  const canvasCSS = `body.editor-styles-wrapper{background:${styles.backgroundColor};color:${styles.textColor};font-family:${fontFamily(styles.fontFamily)};} .editor-styles-wrapper :where(h1,h2,h3,h4,h5,h6){font-family:${fontFamily(styles.headingFont)};} :root{--wp--style--global--content-size:${Math.min(styles.contentWidth, 1200)}px;--wp--style--global--wide-size:${styles.contentWidth}px;} .editor-styles-wrapper a{color:${styles.accentColor}}`;
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
              onClick={() => setView(value)}
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
              <h2>Styles</h2>
              <p>
                Customize the colors, typography, and layout of your entire
                site.
              </p>
              {user?.role === "administrator" ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void action.run(async () => {
                      await api("/site-editor/styles", json("PUT", styles));
                      await resource.reload();
                    }, "Global styles saved.");
                  }}
                >
                  <div className="worldact-style-fields">
                    <fieldset>
                      <legend>Colors</legend>
                      {[
                        ["backgroundColor", "Background"],
                        ["textColor", "Text"],
                        ["accentColor", "Links and accents"],
                      ].map(([key, label]) => (
                        <label key={key}>
                          {label}
                          <div>
                            <input
                              type="color"
                              aria-label={label}
                              value={styles[key as keyof SiteStyle] as string}
                              onChange={(e) =>
                                setStyles({ ...styles, [key]: e.target.value })
                              }
                            />
                            <code>{styles[key as keyof SiteStyle]}</code>
                          </div>
                        </label>
                      ))}
                    </fieldset>
                    <fieldset>
                      <legend>Typography</legend>
                      {[
                        ["fontFamily", "Text"],
                        ["headingFont", "Headings"],
                      ].map(([key, label]) => (
                        <label key={key}>
                          {label}
                          <select
                            value={styles[key as keyof SiteStyle]}
                            onChange={(e) =>
                              setStyles({ ...styles, [key]: e.target.value })
                            }
                          >
                            {[
                              "Manrope",
                              "Inter",
                              "Georgia",
                              "System",
                              "serif",
                              "sans-serif",
                            ].map((font) => (
                              <option key={font}>{font}</option>
                            ))}
                          </select>
                        </label>
                      ))}
                    </fieldset>
                    <fieldset>
                      <legend>Layout</legend>
                      <label>
                        Content width
                        <input
                          type="number"
                          min={480}
                          max={1800}
                          value={styles.contentWidth}
                          onChange={(e) =>
                            setStyles({
                              ...styles,
                              contentWidth: Number(e.target.value),
                            })
                          }
                        />
                      </label>
                      <label>
                        Block spacing
                        <input
                          type="number"
                          min={8}
                          max={80}
                          value={styles.spacing}
                          onChange={(e) =>
                            setStyles({
                              ...styles,
                              spacing: Number(e.target.value),
                            })
                          }
                        />
                      </label>
                    </fieldset>
                  </div>
                  <div
                    className="worldact-style-preview"
                    style={{
                      background: styles.backgroundColor,
                      color: styles.textColor,
                      fontFamily: fontFamily(styles.fontFamily),
                      padding: styles.spacing,
                    }}
                  >
                    <h2 style={{ fontFamily: fontFamily(styles.headingFont) }}>
                      Make it yours.
                    </h2>
                    <p>
                      Every story begins with a little inspiration. Your words,
                      your colors, your world.
                    </p>
                    <a
                      style={{ color: styles.accentColor }}
                      href="#style-preview"
                      onClick={(e) => e.preventDefault()}
                    >
                      A preview of your links →
                    </a>
                  </div>
                  <p>
                    <button
                      className="button button-primary"
                      disabled={action.busy}
                    >
                      Save Styles
                    </button>
                  </p>
                </form>
              ) : (
                <p>Global style changes require an administrator.</p>
              )}
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
                  <button
                    className="button button-primary"
                    disabled={action.busy}
                  >
                    Create
                  </button>
                </form>
              )}
              <div className="worldact-document-list">
                {docs?.map((document) => (
                  <button
                    key={document.id}
                    className={
                      selected?.id === document.id ? "is-selected" : ""
                    }
                    onClick={() => choose(document)}
                  >
                    <strong>{document.title}</strong>
                    <span>{document.slug}</span>
                  </button>
                ))}
              </div>
              {selected ? (
                <>
                  <div className="worldact-template-toolbar">
                    <label>
                      Title{" "}
                      <input
                        value={selected.title}
                        onChange={(e) => {
                          setSelected({ ...selected, title: e.target.value });
                          setDirty(true);
                        }}
                      />
                    </label>
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
                  {selected.type !== "pattern" && (
                    <details className="worldact-template-tokens">
                      <summary>Dynamic content</summary>
                      <p>
                        Keep these tokens in your template to display live site
                        and post content.
                      </p>
                      <div>
                        {[
                          "siteTitle",
                          "tagline",
                          "navigation",
                          "postTitle",
                          "postDate",
                          "postAuthor",
                          "content",
                          "postList",
                        ].map((token) => (
                          <button
                            className="button"
                            key={token}
                            onClick={() => {
                              const value = `{{${token}}}`;
                              if (code) {
                                setSelected({
                                  ...selected,
                                  content: selected.content + value,
                                });
                                setDirty(true);
                              } else
                                editor.current?.insertBlocks([
                                  {
                                    name: "core/paragraph",
                                    attributes: { content: value },
                                    innerBlocks: [],
                                  },
                                ]);
                            }}
                          >{`{{${token}}}`}</button>
                        ))}
                      </div>
                    </details>
                  )}
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
                    {!["header", "footer", "single", "page", "index"].includes(
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
  const [exportFormat, setExportFormat] = useState("json");
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
    <Screen title="Tools">
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
        <>
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
        </>
      )}
      {active === "export" && (
        <div className="worldact-tool-panel">
          <h2>Export your content</h2>
          <p>
            Download a WorldAct JSON archive of posts, pages, terms, comments,
            navigation, templates, styles, and settings. Media file references
            are included; media files, passwords, and session data are excluded.
          </p>
          <p>
            <label>
              Format{" "}
              <select
                aria-label="Export format"
                value={exportFormat}
                onChange={(e) => setExportFormat(e.target.value)}
              >
                <option value="json">WorldAct JSON</option>
                <option value="wxr">WordPress XML (WXR)</option>
              </select>
            </label>
          </p>
          <button
            className="button button-primary"
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                if (exportFormat === "wxr") {
                  const response = await fetch("/api/tools/export?format=wxr", {
                    credentials: "same-origin",
                  });
                  if (!response.ok)
                    throw new Error("The XML export could not be generated.");
                  downloadBlob("worldact-export.xml", await response.blob());
                } else
                  downloadJSON(
                    `worldact-export-${new Date().toISOString().slice(0, 10)}.json`,
                    await api("/tools/export"),
                  );
              }, "Export downloaded.")
            }
          >
            Download Export File
          </button>
        </div>
      )}
      {active === "import" && (
        <div className="worldact-tool-panel">
          <h2>Import content</h2>
          <p>
            Upload a WorldAct JSON export or WordPress XML (WXR) file to import
            your content. Imported content is assigned to your account. Existing
            URLs are preserved when available.
          </p>
          <input
            type="file"
            accept="application/json,application/xml,text/xml,.json,.xml"
            aria-label="Choose import file"
            onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              if (file)
                void action.run(async () => {
                  if (file.size > 8_000_000)
                    throw new Error("Choose an export file smaller than 8 MB.");
                  const contents = await file.text();
                  if (contents.trimStart().startsWith("<")) {
                    if (file.size > 8_000_000)
                      throw new Error(
                        "Choose a WordPress XML file smaller than 8 MB.",
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
                        json("POST", importData),
                      );
                      setImportData(null);
                      setFileName("");
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
