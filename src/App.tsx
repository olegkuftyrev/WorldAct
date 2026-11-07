import Comments from "./screens/Comments";
import {
  Register,
  CheckEmail,
  PrivacyConfirmation,
  PrivacyRequests,
  RegistrationLink,
  DeleteUserDialog,
} from "./screens/Accounts";
import PublicSite, { PermalinkResolver } from "./screens/PublicSite";
import Dashboard from "./screens/Dashboard";
import MediaImageEditor from "./components/MediaImageEditor";
import {
  Profile,
  SettingsSuite,
  Menus,
  Plugins,
  SiteEditor,
  ToolsSuite,
  Themes,
  LostPassword,
  ResetPassword,
} from "./screens/Platform";
import PostList from "./screens/PostList";
import {
  Session,
  Icon,
  Brand,
  errorText,
  useResource,
  Notice,
  ResourceState,
  Panel,
  Modal,
  ScreenTabs,
} from "./components/AdminUI";
import Taxonomies from "./screens/Taxonomies";
import {
  useContext,
  useEffect,
  useRef,
  useState,
  lazy,
  Suspense,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Link,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import {
  api,
  json,
  date,
  type User,
  type Post,
  type Media,
  type Settings,
} from "./api";

const Editor = lazy(() => import("./screens/Editor"));

export default function App() {
  const [user, setUser] = useState<User | null>(null),
    [ready, setReady] = useState(false),
    [error, setError] = useState("");
  const location = useLocation();
  useEffect(() => {
    api<{ user: User | null }>("/session")
      .then((data) => setUser(data.user))
      .catch((e) => setError(errorText(e)))
      .finally(() => setReady(true));
  }, []);
  useEffect(() => {
    if (!user?.id) return;
    let active = true;
    api<{ user: User }>("/profile")
      .then(({ user: profile }) => {
        if (active)
          setUser((current) =>
            current?.id === profile.id ? { ...current, ...profile } : current,
          );
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [user?.id]);
  useEffect(() => {
    const schemes = [
      "modern",
      "fresh",
      "light",
      "blue",
      "coffee",
      "ectoplasm",
      "midnight",
      "ocean",
      "sunrise",
    ];
    const scheme = schemes.includes(user?.adminColor || "")
      ? user!.adminColor!
      : "modern";
    const login = [
      "/login",
      "/lost-password",
      "/reset-password",
      "/register",
      "/check-email",
      "/privacy/confirm",
    ].includes(location.pathname);
    const admin = location.pathname.startsWith("/admin");
    document.body.className = location.pathname.startsWith("/admin")
      ? `wp-admin wp-core-ui js admin-color-${scheme}`
      : login
        ? `login wp-core-ui admin-color-${scheme}`
        : "public-body";
    let link = document.querySelector<HTMLLinkElement>(
      "#worldact-admin-color-scheme",
    );
    if ((admin || login) && scheme !== "fresh") {
      if (!link) {
        link = document.createElement("link");
        link.id = "worldact-admin-color-scheme";
        link.rel = "stylesheet";
        document.head.appendChild(link);
      }
      link.href = `/vendor/wordpress/wp-admin/css/colors/${scheme}/colors.css`;
    } else link?.remove();
    const accents: Record<string, string> = {
      modern: "#3858e9",
      fresh: "#2271b1",
      light: "#04a4cc",
      blue: "#096484",
      coffee: "#c7a589",
      ectoplasm: "#a3b745",
      midnight: "#e14d43",
      ocean: "#9ebaa0",
      sunrise: "#dd823b",
    };
    if (admin || login)
      document.body.style.setProperty(
        "--wp-admin-theme-color",
        accents[scheme],
      );
    else document.body.style.removeProperty("--wp-admin-theme-color");
    window.scrollTo(0, 0);
  }, [location.pathname, user?.adminColor]);
  if (!ready)
    return (
      <div className="initial-loading">
        <Brand />
        <p>Loading WorldAct…</p>
      </div>
    );
  return (
    <Session.Provider value={{ user, setUser }}>
      <Suspense
        fallback={
          <div className="initial-loading">
            <Brand />
            <p>Loading editor…</p>
          </div>
        }
      >
        <Routes>
          <Route
            path="/wp-admin/*"
            element={<Navigate to="/admin" replace />}
          />
          <Route
            path="/wp-login.php"
            element={<Navigate to="/login" replace />}
          />
          <Route path="/login" element={<Login serverError={error} />} />
          <Route path="/register" element={<Register />} />
          <Route path="/check-email" element={<CheckEmail />} />
          <Route path="/privacy/confirm" element={<PrivacyConfirmation />} />
          <Route path="/lost-password" element={<LostPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route
            path="/admin"
            element={
              user ? (
                <AdminShell />
              ) : (
                <Navigate
                  to="/login"
                  replace
                  state={{ from: location.pathname + location.search }}
                />
              )
            }
          >
            <Route
              index
              element={
                user?.role === "subscriber" ? (
                  <Navigate to="/admin/profile" replace />
                ) : (
                  <Dashboard />
                )
              }
            />
            <Route path="posts" element={<PostList type="post" />} />
            <Route path="content/:id" element={<ContentEditorRedirect />} />
            <Route
              path="posts/categories"
              element={<Taxonomies taxonomy="category" />}
            />
            <Route path="posts/tags" element={<Taxonomies taxonomy="tag" />} />
            <Route path="pages" element={<PostList type="page" />} />
            <Route path="media" element={<MediaLibrary />} />
            <Route path="comments" element={<Comments />} />
            <Route path="users" element={<Users />} />
            <Route path="users/:id" element={<Profile />} />
            <Route path="profile" element={<Profile />} />
            <Route path="settings" element={<SettingsSuite />} />
            <Route path="appearance" element={<Themes />} />
            <Route path="appearance/editor" element={<SiteEditor />} />
            <Route path="appearance/menus" element={<Menus />} />
            <Route path="plugins" element={<Plugins />} />
            <Route path="tools" element={<ToolsRoute />} />
            <Route path="about" element={<About />} />
          </Route>
          <Route
            path="/admin/posts/new"
            element={
              user ? (
                <Editor type="post" />
              ) : (
                <Navigate
                  to="/login"
                  replace
                  state={{ from: location.pathname + location.search }}
                />
              )
            }
          />
          <Route
            path="/admin/posts/:id"
            element={
              user ? (
                <Editor type="post" />
              ) : (
                <Navigate
                  to="/login"
                  replace
                  state={{ from: location.pathname + location.search }}
                />
              )
            }
          />
          <Route
            path="/admin/pages/new"
            element={
              user ? (
                <Editor type="page" />
              ) : (
                <Navigate
                  to="/login"
                  replace
                  state={{ from: location.pathname + location.search }}
                />
              )
            }
          />
          <Route
            path="/admin/pages/:id"
            element={
              user ? (
                <Editor type="page" />
              ) : (
                <Navigate
                  to="/login"
                  replace
                  state={{ from: location.pathname + location.search }}
                />
              )
            }
          />
          <Route path="/" element={<PublicSite />} />
          <Route
            path="/preview/:id"
            element={
              user ? (
                <PublicSite detail preview />
              ) : (
                <Navigate
                  to="/login"
                  replace
                  state={{ from: location.pathname + location.search }}
                />
              )
            }
          />
          <Route path="/posts/:slug" element={<PublicSite detail />} />
          <Route path="/pages/:slug" element={<PublicSite detail page />} />
          <Route path="*" element={<PermalinkResolver />} />
        </Routes>
      </Suspense>
    </Session.Provider>
  );
}
function ContentEditorRedirect() {
  const { id } = useParams();
  const resource = useResource<{ post: Post }>(`/posts/${id}`);
  if (resource.data?.post)
    return (
      <Navigate
        to={`/admin/${resource.data.post.type === "page" ? "pages" : "posts"}/${resource.data.post.id}`}
        replace
      />
    );
  return (
    <main className="wrap">
      <ResourceState
        loading={resource.loading}
        error={resource.error}
        retry={resource.reload}
      />
    </main>
  );
}
function ToolsRoute() {
  const [params] = useSearchParams();
  const { user } = useContext(Session);
  const tab = params.get("tab");
  if (
    user?.role === "administrator" &&
    ["privacy", "privacy-export", "privacy-erase"].includes(tab || "")
  )
    return (
      <PrivacyRequests type={tab === "privacy-erase" ? "erase" : "export"} />
    );
  return <ToolsSuite />;
}
function safeLoginRedirect(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    !/^\/(?:admin(?:\/|[?#]|$)|preview\/)/.test(value) ||
    /[\\\u0000-\u0020]/.test(value)
  )
    return null;
  try {
    const url = new URL(value, window.location.origin);
    return url.origin === window.location.origin
      ? url.pathname + url.search + url.hash
      : null;
  } catch {
    return null;
  }
}
function Login({ serverError }: { serverError: string }) {
  const { user, setUser } = useContext(Session),
    navigate = useNavigate(),
    location = useLocation();
  const [login, setLogin] = useState(""),
    [password, setPassword] = useState(""),
    [visible, setVisible] = useState(false),
    [error, setError] = useState(serverError),
    [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const data = await api<{ user: User }>(
        "/auth/login",
        json("POST", { login, password }),
      );
      setUser(data.user);
      navigate(
        safeLoginRedirect(location.state?.from) ||
          safeLoginRedirect(
            new URLSearchParams(location.search).get("redirect_to"),
          ) ||
          "/admin",
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  if (user)
    return (
      <Navigate
        to={
          safeLoginRedirect(location.state?.from) ||
          safeLoginRedirect(
            new URLSearchParams(location.search).get("redirect_to"),
          ) ||
          "/admin"
        }
        replace
      />
    );
  return (
    <div id="login">
      <h1>
        <Link to="/" aria-label="WorldAct home">
          <Brand />
          <span className="screen-reader-text">WorldAct</span>
        </Link>
      </h1>
      {error && (
        <div id="login_error" role="alert">
          {error}
        </div>
      )}
      <form id="loginform" onSubmit={submit}>
        <p>
          <label htmlFor="user_login">Username or Email Address</label>
          <input
            type="text"
            id="user_login"
            className="input"
            autoComplete="username"
            value={login}
            onChange={(e) => setLogin(e.target.value)}
            required
            autoFocus
          />
        </p>
        <div className="user-pass-wrap">
          <label htmlFor="user_pass">Password</label>
          <div className="wp-pwd">
            <input
              id="user_pass"
              type={visible ? "text" : "password"}
              className="input password-input"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <button
              className="button button-secondary wp-hide-pw hide-if-no-js"
              type="button"
              aria-label={visible ? "Hide password" : "Show password"}
              onClick={() => setVisible(!visible)}
            >
              <Icon name={visible ? "hidden" : "visibility"} />
            </button>
          </div>
        </div>
        <p className="submit">
          <button
            className="button button-primary button-large"
            disabled={busy}
          >
            {busy ? "Logging in…" : "Log In"}
          </button>
        </p>
      </form>
      <p id="backtoblog">
        <Link to="/">← Go to WorldAct</Link>
      </p>
      <p id="nav">
        <RegistrationLink />
        <Link to="/lost-password">Lost your password?</Link>
      </p>
      <p className="login-help">
        Use the administrator account created during setup.
      </p>
    </div>
  );
}
function AdminShell() {
  const { user, setUser } = useContext(Session),
    location = useLocation(),
    navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(false),
    [mobileMenu, setMobileMenu] = useState(false),
    [menu, setMenu] = useState(false),
    [error, setError] = useState("");
  const settings = useResource<{ settings: Partial<Settings> }>("/public/site");
  const administrator = user?.role === "administrator",
    canPages = administrator || user?.role === "editor";
  useEffect(() => {
    api<{ preferences: { collapsedMenu?: boolean } }>("/profile")
      .then(({ preferences }) =>
        setCollapsed(Boolean(preferences?.collapsedMenu)),
      )
      .catch(() => {});
  }, [user?.id]);
  useEffect(() => {
    const refresh = () => {
      void settings.reload();
    };
    window.addEventListener("worldact-settings-updated", refresh);
    return () =>
      window.removeEventListener("worldact-settings-updated", refresh);
  }, [settings.reload]);
  const links = [
    {
      to: "/admin",
      label: "Dashboard",
      icon: "dashboard",
      sub: [
        ["Home", "/admin"],
        ["About WorldAct", "/admin/about"],
      ],
    },
    {
      to: "/admin/posts",
      label: "Posts",
      icon: "admin-post",
      sub: [
        ["All Posts", "/admin/posts"],
        ["Add New Post", "/admin/posts/new"],
        ...(canPages
          ? [
              ["Categories", "/admin/posts/categories"],
              ["Tags", "/admin/posts/tags"],
            ]
          : []),
      ],
    },
    {
      to: "/admin/media",
      label: "Media",
      icon: "admin-media",
      sub: [["Library", "/admin/media"]],
    },
    {
      to: "/admin/pages",
      label: "Pages",
      icon: "admin-page",
      sub: [
        ["All Pages", "/admin/pages"],
        ["Add New Page", "/admin/pages/new"],
      ],
    },
    { to: "/admin/comments", label: "Comments", icon: "admin-comments" },
    {
      to: "/admin/appearance",
      label: "Appearance",
      icon: "admin-appearance",
      sub: [
        ...(administrator ? [["Themes", "/admin/appearance"]] : []),
        ["Editor", "/admin/appearance/editor"],
        ["Menus", "/admin/appearance/menus"],
      ],
    },
    { to: "/admin/plugins", label: "Plugins", icon: "admin-plugins" },
    {
      to: "/admin/users",
      label: "Users",
      icon: "admin-users",
      sub: [
        ["All Users", "/admin/users"],
        ["Profile", "/admin/profile"],
      ],
    },
    { to: "/admin/profile", label: "Profile", icon: "admin-users" },
    {
      to: "/admin/tools",
      label: "Tools",
      icon: "admin-tools",
      sub: [
        ["Site Health", "/admin/tools"],
        ["Export", "/admin/tools?tab=export"],
        ["Import", "/admin/tools?tab=import"],
        ["Export Personal Data", "/admin/tools?tab=privacy-export"],
        ["Erase Personal Data", "/admin/tools?tab=privacy-erase"],
        ["Mail", "/admin/tools?tab=mail"],
      ],
    },
    {
      to: "/admin/settings",
      label: "Settings",
      icon: "admin-settings",
      sub: [
        ["General", "/admin/settings"],
        ["Writing", "/admin/settings?tab=writing"],
        ["Reading", "/admin/settings?tab=reading"],
        ["Discussion", "/admin/settings?tab=discussion"],
        ["Media", "/admin/settings?tab=media"],
        ["Permalinks", "/admin/settings?tab=permalinks"],
        ["Privacy", "/admin/settings?tab=privacy"],
      ],
    },
  ];
  async function logout() {
    try {
      await api("/auth/logout", json("POST"));
      setUser(null);
      navigate("/login");
    } catch (e) {
      setError(errorText(e));
    }
  }
  return (
    <div
      id="wpwrap"
      className={`${collapsed ? "folded" : ""} ${mobileMenu ? "mobile-open" : ""}`}
    >
      <div id="wpadminbar" className="nojq">
        <div
          className="quicklinks"
          id="wp-toolbar"
          role="navigation"
          aria-label="Admin toolbar"
        >
          <ul id="wp-admin-bar-root-default" className="ab-top-menu">
            <li className="mobile-menu-toggle">
              <button
                className="ab-item"
                aria-label="Toggle menu"
                onClick={() => setMobileMenu(!mobileMenu)}
              >
                <Icon name="menu" />
              </button>
            </li>
            <li id="wp-admin-bar-wp-logo">
              <Link
                className="ab-item"
                to="/admin/about"
                aria-label="About WorldAct"
              >
                <Brand />
              </Link>
            </li>
            <li id="wp-admin-bar-site-name">
              <Link className="ab-item" to="/">
                <Icon name="admin-home" />
                <span>{settings.data?.settings.siteTitle || "WorldAct"}</span>
              </Link>
            </li>
            {canPages && (
              <li>
                <Link
                  className="ab-item"
                  to="/admin/comments"
                  aria-label="Comments"
                >
                  <Icon name="admin-comments" />
                </Link>
              </li>
            )}
            <li className="menupop">
              <Link className="ab-item" to="/admin/posts/new">
                <Icon name="plus" />
                <span>New</span>
              </Link>
              <div className="ab-sub-wrapper">
                <ul className="ab-submenu">
                  <li>
                    <Link className="ab-item" to="/admin/posts/new">
                      Post
                    </Link>
                  </li>
                  {canPages && (
                    <li>
                      <Link className="ab-item" to="/admin/pages/new">
                        Page
                      </Link>
                    </li>
                  )}
                  <li>
                    <Link className="ab-item" to="/admin/media">
                      Media
                    </Link>
                  </li>
                </ul>
              </div>
            </li>
          </ul>
          <ul className="ab-top-secondary ab-top-menu">
            <li className={`menupop ${menu ? "hover" : ""}`}>
              <button
                className="ab-item user-menu"
                onClick={() => setMenu(!menu)}
              >
                Howdy, {user?.displayName}
                <span className="avatar">
                  <Icon name="admin-users" />
                </span>
              </button>
              <div className="ab-sub-wrapper">
                <ul className="ab-submenu">
                  <li>
                    <Link className="ab-item" to="/admin/profile">
                      {user?.displayName}
                    </Link>
                  </li>
                  <li>
                    <button className="ab-item" onClick={logout}>
                      Log Out
                    </button>
                  </li>
                </ul>
              </div>
            </li>
          </ul>
        </div>
      </div>
      <div id="adminmenumain">
        <div id="adminmenuback" />
        <div id="adminmenuwrap">
          <ul id="adminmenu">
            {links.map((item, index) => {
              if (
                (user?.role === "subscriber" && item.to !== "/admin/profile") ||
                (administrator && item.to === "/admin/profile") ||
                (!administrator &&
                  [
                    "/admin/users",
                    "/admin/settings",
                    "/admin/plugins",
                    "/admin/tools",
                  ].includes(item.to)) ||
                (!canPages && item.to === "/admin/appearance") ||
                (!canPages &&
                  ["/admin/pages", "/admin/comments"].includes(item.to)) ||
                (user?.role === "contributor" && item.to === "/admin/media")
              )
                return null;
              const active =
                item.to === "/admin"
                  ? location.pathname === "/admin" ||
                    location.pathname === "/admin/about"
                  : location.pathname.startsWith(item.to);
              return (
                <li
                  key={item.to}
                  className={`${active ? "wp-has-current-submenu wp-menu-open current" : "wp-not-current-submenu"} menu-top ${index === 1 || index === 5 ? "menu-section-start" : ""}`}
                >
                  <Link
                    to={
                      item.to === "/admin/appearance" && !administrator
                        ? "/admin/appearance/editor"
                        : item.to
                    }
                    onClick={() => setMobileMenu(false)}
                    className={`${active ? "wp-has-current-submenu wp-menu-open" : "wp-not-current-submenu"} menu-top`}
                  >
                    <div
                      className={`wp-menu-image dashicons-before dashicons-${item.icon}`}
                    />
                    <div className="wp-menu-name">{item.label}</div>
                  </Link>
                  {item.sub && (
                    <ul className="wp-submenu wp-submenu-wrap">
                      <li className="wp-submenu-head">{item.label}</li>
                      {item.sub.map(([label, to]) => (
                        <li
                          key={to}
                          className={
                            location.pathname + location.search === to
                              ? "current"
                              : ""
                          }
                        >
                          <Link to={to} onClick={() => setMobileMenu(false)}>
                            {label}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
            <li id="collapse-menu">
              <button
                id="collapse-button"
                type="button"
                aria-label={collapsed ? "Expand menu" : "Collapse menu"}
                onClick={() => {
                  const next = !collapsed;
                  setCollapsed(next);
                  void api(
                    "/preferences",
                    json("PUT", { collapsedMenu: next }),
                  ).catch((reason) => setError(errorText(reason)));
                }}
              >
                <span className="collapse-button-icon" />
                <span className="collapse-button-label">Collapse menu</span>
              </button>
            </li>
          </ul>
        </div>
      </div>
      <div id="wpcontent">
        <div id="wpbody">
          <div id="wpbody-content">
            {error && (
              <Notice error onDismiss={() => setError("")}>
                {error}
              </Notice>
            )}
            <Outlet />
          </div>
        </div>
      </div>
      <footer id="wpfooter">
        <p id="footer-left">
          Thank you for creating with <Link to="/admin/about">WorldAct</Link>.
        </p>
        <p id="footer-upgrade">Version 0.3.0</p>
      </footer>
    </div>
  );
}
function escapeHTML(value: string) {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
}
function MediaPreview({ item, full = false }: { item: Media; full?: boolean }) {
  if (item.mimeType.startsWith("image/"))
    return <img src={item.url} alt={item.alt || item.title} />;
  if (full && item.mimeType.startsWith("audio/"))
    return <audio controls preload="metadata" src={item.url} />;
  if (full && item.mimeType.startsWith("video/"))
    return <video controls preload="metadata" src={item.url} />;
  return (
    <div className={`media-type-preview ${full ? "full" : ""}`}>
      <Icon
        name={
          item.mimeType.startsWith("audio/")
            ? "media-audio"
            : item.mimeType.startsWith("video/")
              ? "media-video"
              : "media-document"
        }
      />
      {full && (
        <a href={item.url} target="_blank" rel="noreferrer">
          Open {item.filename}
        </a>
      )}
    </div>
  );
}
function MediaLibrary() {
  const resource = useResource<{ media: Media[] }>("/media");
  const [uploader, setUploader] = useState(false),
    [selected, setSelected] = useState<Media | null>(null),
    [query, setQuery] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [grid, setGrid] = useState(true),
    [filter, setFilter] = useState("all");
  const fileInput = useRef<HTMLInputElement>(null);
  async function upload(files: FileList | File[] | null) {
    if (!files?.length) return;
    setBusy(true);
    setError("");
    try {
      for (const file of Array.from(files)) {
        const body = new FormData();
        body.append("file", file);
        await api("/media", { method: "POST", body });
      }
      setNotice("Media uploaded.");
      await resource.reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      await api(
        `/media/${selected.id}`,
        json("PUT", {
          title: selected.title,
          alt: selected.alt,
          caption: selected.caption,
        }),
      );
      setNotice("Attachment details saved.");
      setSelected(null);
      await resource.reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (
      !selected ||
      !window.confirm(
        "You are about to permanently delete this item. Continue?",
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      await api(`/media/${selected.id}`, json("DELETE"));
      setSelected(null);
      setNotice("Media permanently deleted.");
      await resource.reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const items = (resource.data?.media || []).filter(
    (item) =>
      (item.title + item.filename)
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (filter === "all" ||
        (filter === "document"
          ? !/^(image|audio|video)\//.test(item.mimeType)
          : item.mimeType.startsWith(filter))),
  );
  return (
    <>
      <ScreenTabs />
      <main className="wrap">
        <h1 className="wp-heading-inline">Media Library</h1>{" "}
        <button
          className="page-title-action"
          onClick={() => setUploader(!uploader)}
        >
          Add New Media File
        </button>
        <hr className="wp-header-end" />
        {error && (
          <Notice error onDismiss={() => setError("")}>
            {error}
          </Notice>
        )}
        {notice && <Notice onDismiss={() => setNotice("")}>{notice}</Notice>}
        <input
          ref={fileInput}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp,image/gif,audio/mpeg,audio/wav,audio/ogg,video/mp4,video/webm,application/pdf,text/plain,text/csv,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          hidden
          onChange={(e) => upload(e.target.files)}
        />
        {uploader && (
          <div
            className="upload-ui"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              void upload(e.dataTransfer.files);
            }}
          >
            <h2>Drop files to upload</h2>
            <p>or</p>
            <button
              className="button button-large"
              onClick={() => fileInput.current?.click()}
              disabled={busy}
            >
              {busy ? "Uploading…" : "Select Files"}
            </button>
            <p>
              Upload images, audio, video, PDFs, and documents. The server
              checks file type and upload size.
            </p>
          </div>
        )}
        <div className="media-toolbar">
          <div className="view-switch">
            <button
              className={!grid ? "current" : ""}
              aria-label="List view"
              onClick={() => setGrid(false)}
            >
              <Icon name="list-view" />
            </button>
            <button
              className={grid ? "current" : ""}
              aria-label="Grid view"
              onClick={() => setGrid(true)}
            >
              <Icon name="grid-view" />
            </button>
          </div>
          <label className="screen-reader-text" htmlFor="media-filter">
            Filter media
          </label>
          <select
            id="media-filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="all">All media items</option>
            <option value="image/">Images</option>
            <option value="audio/">Audio</option>
            <option value="video/">Video</option>
            <option value="document">Documents</option>
          </select>
          <input
            type="search"
            placeholder="Search media"
            aria-label="Search media"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <ResourceState
          loading={resource.loading}
          error={resource.error}
          retry={resource.reload}
        />
        {!resource.loading && !items.length && (
          <div className="media-empty">
            <p>No media items found.</p>
            <button
              className="button button-primary"
              onClick={() => {
                setUploader(true);
                fileInput.current?.click();
              }}
            >
              Upload a file
            </button>
          </div>
        )}
        {grid ? (
          <div className="media-grid">
            {items.map((item) => (
              <button
                className="media-item"
                key={item.id}
                onClick={() => setSelected({ ...item })}
              >
                <MediaPreview item={item} />
                <span>{item.title}</span>
              </button>
            ))}
          </div>
        ) : (
          <table className="wp-list-table widefat striped">
            <thead>
              <tr>
                <th>File</th>
                <th>File type</th>
                <th>Uploaded on</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <button
                      className="media-file-button button-link"
                      onClick={() => setSelected({ ...item })}
                    >
                      <MediaPreview item={item} />
                      <strong>{item.title}</strong>
                      <small>{item.filename}</small>
                    </button>
                  </td>
                  <td>{item.mimeType}</td>
                  <td>{date(item.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {selected && (
          <Modal title="Attachment details" close={() => setSelected(null)}>
            <form onSubmit={save} className="attachment-details-layout">
              <div className="attachment-preview">
                <MediaPreview item={selected} full />
                <MediaImageEditor
                  media={selected}
                  onUpdate={(item) => {
                    setSelected(item);
                    void resource.reload();
                  }}
                />
              </div>
              <div className="attachment-fields">
                <p>
                  <strong>{selected.filename}</strong>
                  <br />
                  {date(selected.createdAt)}
                  <br />
                  {selected.mimeType} · {Math.ceil(selected.size / 1024)} KB
                </p>
                <hr />
                {selected.mimeType.startsWith("image/") && (
                  <>
                    <label>
                      Alternative Text
                      <textarea
                        rows={2}
                        value={selected.alt}
                        onChange={(e) =>
                          setSelected({ ...selected, alt: e.target.value })
                        }
                      />
                    </label>
                    <p className="description">
                      Describe the purpose of the image for people who cannot
                      see it.
                    </p>
                  </>
                )}
                <label>
                  Title
                  <input
                    type="text"
                    value={selected.title}
                    onChange={(e) =>
                      setSelected({ ...selected, title: e.target.value })
                    }
                  />
                </label>
                <label>
                  Caption
                  <textarea
                    rows={3}
                    value={selected.caption}
                    onChange={(e) =>
                      setSelected({ ...selected, caption: e.target.value })
                    }
                  />
                </label>
                <label>
                  File URL
                  <input type="text" readOnly value={selected.url} />
                </label>
                <p className="attachment-actions">
                  <button className="button button-primary" disabled={busy}>
                    Save changes
                  </button>
                  <button
                    className="button-link button-link-delete"
                    type="button"
                    onClick={remove}
                    disabled={busy}
                  >
                    Delete permanently
                  </button>
                </p>
                {error && <Notice error>{error}</Notice>}
              </div>
            </form>
          </Modal>
        )}
      </main>
    </>
  );
}
function Users() {
  const [userParams] = useSearchParams();
  const resource = useResource<{ users: User[] }>("/users"),
    { user } = useContext(Session);
  const [removingUser, setRemovingUser] = useState<User | null>(null);
  const [adding, setAdding] = useState(userParams.get("new") === "1"),
    [query, setQuery] = useState(""),
    [roleFilter, setRoleFilter] = useState("all"),
    [form, setForm] = useState({
      username: "",
      email: "",
      displayName: "",
      password: "",
      role: "subscriber",
    }),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [visible, setVisible] = useState(false);
  async function add(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      await api("/users", json("POST", form));
      setForm({
        username: "",
        email: "",
        displayName: "",
        password: "",
        role: "subscriber",
      });
      setAdding(false);
      setNotice("New user created.");
      await resource.reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  function remove(item: User) {
    setRemovingUser(item);
  }
  const users = (resource.data?.users || []).filter(
    (item) =>
      (roleFilter === "all" || item.role === roleFilter) &&
      `${item.username} ${item.displayName} ${item.email}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <>
      <ScreenTabs />
      <main className="wrap">
        <h1 className="wp-heading-inline">
          {adding ? "Add New User" : "Users"}
        </h1>{" "}
        <button
          className="page-title-action"
          onClick={() => setAdding(!adding)}
        >
          {adding ? "Back to Users" : "Add New User"}
        </button>
        <hr className="wp-header-end" />
        {error && <Notice error>{error}</Notice>}
        {notice && <Notice onDismiss={() => setNotice("")}>{notice}</Notice>}
        <ResourceState
          loading={resource.loading}
          error={resource.error}
          retry={resource.reload}
        />
        {adding ? (
          <form className="validate" onSubmit={add}>
            <p>Create a brand new user and add them to this site.</p>
            <table className="form-table">
              <tbody>
                {[
                  { key: "username", label: "Username", type: "text" },
                  { key: "email", label: "Email", type: "email" },
                  { key: "displayName", label: "Display Name", type: "text" },
                ].map((field) => (
                  <tr key={field.key}>
                    <th>
                      <label htmlFor={`new-${field.key}`}>
                        {field.label}{" "}
                        <span className="description">(required)</span>
                      </label>
                    </th>
                    <td>
                      <input
                        className="regular-text"
                        id={`new-${field.key}`}
                        type={field.type}
                        value={form[field.key as keyof typeof form]}
                        onChange={(e) =>
                          setForm({ ...form, [field.key]: e.target.value })
                        }
                        required
                        autoComplete="off"
                      />
                    </td>
                  </tr>
                ))}
                <tr>
                  <th>
                    <label htmlFor="new-password">
                      Password <span className="description">(required)</span>
                    </label>
                  </th>
                  <td>
                    <input
                      className="regular-text"
                      id="new-password"
                      type={visible ? "text" : "password"}
                      minLength={12}
                      value={form.password}
                      onChange={(e) =>
                        setForm({ ...form, password: e.target.value })
                      }
                      required
                      autoComplete="new-password"
                    />{" "}
                    <button
                      type="button"
                      className="button"
                      onClick={() => setVisible(!visible)}
                    >
                      {visible ? "Hide" : "Show"}
                    </button>
                    <p className="description">Use at least 12 characters.</p>
                  </td>
                </tr>
                <tr>
                  <th>
                    <label htmlFor="new-role">Role</label>
                  </th>
                  <td>
                    <select
                      id="new-role"
                      value={form.role}
                      onChange={(e) =>
                        setForm({ ...form, role: e.target.value })
                      }
                    >
                      {[
                        "subscriber",
                        "contributor",
                        "author",
                        "editor",
                        "administrator",
                      ].map((role) => (
                        <option key={role} value={role}>
                          {role[0].toUpperCase() + role.slice(1)}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              </tbody>
            </table>
            <p className="submit">
              <button className="button button-primary" disabled={busy}>
                {busy ? "Creating…" : "Add New User"}
              </button>
            </p>
          </form>
        ) : (
          <>
            <ul className="subsubsub">
              {[
                "all",
                "administrator",
                "editor",
                "author",
                "contributor",
                "subscriber",
              ].map((role, i) => (
                <li key={role}>
                  {i > 0 && " | "}
                  <button
                    className={`button-link ${roleFilter === role ? "current" : ""}`}
                    onClick={() => setRoleFilter(role)}
                  >
                    {role === "all"
                      ? "All"
                      : role[0].toUpperCase() + role.slice(1)}{" "}
                    <span className="count">
                      (
                      {
                        (resource.data?.users || []).filter(
                          (item) => role === "all" || item.role === role,
                        ).length
                      }
                      )
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="search-box">
              <input
                type="search"
                aria-label="Search users"
                placeholder="Search users"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="tablenav top">
              <div className="tablenav-pages">{users.length} items</div>
            </div>
            <table className="wp-list-table widefat fixed striped users">
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Role</th>
                </tr>
              </thead>
              <tbody>
                {users.map((item) => (
                  <tr key={item.id}>
                    <td className="username column-username">
                      <span className="user-avatar">
                        <Icon name="admin-users" />
                      </span>
                      <strong>
                        <Link to={`/admin/users/${item.id}`}>
                          {item.username}
                        </Link>
                      </strong>
                      {item.id === user?.id && " (you)"}
                      <div className="row-actions">
                        <Link to={`/admin/users/${item.id}`}>Edit</Link>
                        {" | "}
                        {item.id !== user?.id && (
                          <button
                            className="button-link button-link-delete"
                            disabled={busy}
                            onClick={() => remove(item)}
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </td>
                    <td>{item.displayName}</td>
                    <td>
                      <a href={`mailto:${item.email}`}>{item.email}</a>
                    </td>
                    <td className="capitalize">{item.role}</td>
                  </tr>
                ))}
                {!users.length && (
                  <tr>
                    <td colSpan={4}>No users found.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </>
        )}
        {removingUser && (
          <DeleteUserDialog
            target={removingUser}
            users={resource.data?.users || []}
            currentUserId={user!.id}
            onClose={() => setRemovingUser(null)}
            onDeleted={async () => {
              setRemovingUser(null);
              setNotice("User deleted.");
              await resource.reload();
            }}
          />
        )}
      </main>
    </>
  );
}
function About() {
  return (
    <main className="wrap about-page">
      <div className="about-header">
        <Brand />
        <div>
          <h1>WorldAct 0.3</h1>
          <p>Your words. Your site. Your world.</p>
        </div>
      </div>
      <h2>React. PostgreSQL. Your site.</h2>
      <p>
        WorldAct is a personal CMS study that recreates familiar WordPress
        administration workflows with React and a Node.js server backed by
        PostgreSQL.
      </p>
      <h2>Create and publish</h2>
      <ul className="ul-disc">
        <li>
          Write with the official Gutenberg React block editor, nested layouts,
          rich text, and saved patterns.
        </li>
        <li>
          Manage posts, pages, categories, tags, revisions, autosaves, private
          content, and scheduled publishing.
        </li>
        <li>
          Upload images, audio, video, and documents. Crop, rotate, resize, and
          restore your images.
        </li>
        <li>
          Moderate comments, manage five user roles, and customize your profile.
        </li>
      </ul>
      <h2>Make it your own</h2>
      <p>
        Choose a React theme, edit templates and template parts, customize
        global styles, and arrange navigation menus. Install JavaScript
        extensions from the local registry to add reading times, spam filtering,
        search metadata, and a custom footer.
      </p>
      <h2>Keep your content portable</h2>
      <p>
        Export and import WorldAct JSON or WordPress XML, publish RSS and Atom
        feeds, and manage site, reading, discussion, media, and permalink
        settings.
      </p>
      <p>
        WorldAct uses JavaScript extensions and React themes. PHP plugins and
        themes require JavaScript equivalents. It is an independent study
        project; exact parity with every WordPress feature and third-party
        extension is not claimed.
      </p>
      <p>
        WordPress assets and Gutenberg packages retain their original licenses.
        See the repository notices for attribution.
      </p>
      <p>
        <Link className="button button-primary" to="/admin">
          Go to Dashboard
        </Link>{" "}
        <Link className="button" to="/">
          Visit site
        </Link>
      </p>
    </main>
  );
}
