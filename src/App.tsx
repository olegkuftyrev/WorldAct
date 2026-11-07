import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
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
  type Comment,
  type Settings,
} from "./api";

const Session = createContext<{
  user: User | null;
  setUser: (user: User | null) => void;
}>({ user: null, setUser: () => {} });
const Icon = ({ name, ...props }: { name: string; className?: string }) => (
  <span
    {...props}
    aria-hidden="true"
    className={`dashicons dashicons-${name} ${props.className || ""}`}
  />
);
const Brand = () => (
  <span className="worldact-mark" aria-hidden="true">
    W
  </span>
);
const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
function useResource<T>(path: string) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setData(await api<T>(path));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, setData, error, loading, reload };
}
function Notice({
  children,
  error = false,
  onDismiss,
}: {
  children: ReactNode;
  error?: boolean;
  onDismiss?: () => void;
}) {
  return (
    <div
      role={error ? "alert" : "status"}
      className={`notice notice-${error ? "error" : "success"} ${onDismiss ? "is-dismissible" : ""}`}
    >
      <p>{children}</p>
      {onDismiss && (
        <button
          type="button"
          aria-label="Dismiss notice"
          className="notice-dismiss"
          onClick={onDismiss}
        >
          <span className="screen-reader-text">Dismiss</span>
        </button>
      )}
    </div>
  );
}
function ResourceState({
  loading,
  error,
  retry,
}: {
  loading: boolean;
  error: string;
  retry?: () => void;
}) {
  return error ? (
    <Notice error>
      {error}{" "}
      {retry && (
        <button className="button-link" onClick={retry}>
          Try again
        </button>
      )}
    </Notice>
  ) : loading ? (
    <p className="loading-state">
      <span className="spinner is-active" />
      Loading…
    </p>
  ) : null;
}
function Panel({
  title,
  id,
  children,
}: {
  title: string;
  id?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section id={id} className={`postbox ${open ? "" : "closed"}`}>
      <div className="postbox-header">
        <h2 className="hndle">{title}</h2>
        <div className="handle-actions">
          <button
            className="handlediv"
            aria-expanded={open}
            aria-label={`${open ? "Collapse" : "Expand"} ${title}`}
            onClick={() => setOpen(!open)}
          >
            <span className="toggle-indicator" />
          </button>
        </div>
      </div>
      {open && <div className="inside">{children}</div>}
    </section>
  );
}

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
    document.body.className = location.pathname.startsWith("/admin")
      ? "wp-admin wp-core-ui js admin-color-modern"
      : location.pathname === "/login"
        ? "login wp-core-ui admin-color-modern"
        : "public-body";
    window.scrollTo(0, 0);
  }, [location.pathname]);
  if (!ready)
    return (
      <div className="initial-loading">
        <Brand />
        <p>Loading WorldAct…</p>
      </div>
    );
  return (
    <Session.Provider value={{ user, setUser }}>
      <Routes>
        <Route path="/wp-admin/*" element={<Navigate to="/admin" replace />} />
        <Route
          path="/wp-login.php"
          element={<Navigate to="/login" replace />}
        />
        <Route path="/login" element={<Login serverError={error} />} />
        <Route
          path="/admin"
          element={
            user ? (
              user.role === "subscriber" ? (
                <Navigate to="/" replace />
              ) : (
                <AdminShell />
              )
            ) : (
              <Navigate
                to="/login"
                replace
                state={{ from: location.pathname }}
              />
            )
          }
        >
          <Route index element={<Dashboard />} />
          <Route path="posts" element={<PostList type="post" />} />
          <Route path="pages" element={<PostList type="page" />} />
          <Route path="media" element={<MediaLibrary />} />
          <Route path="comments" element={<Comments />} />
          <Route path="users" element={<Users />} />
          <Route path="settings" element={<SettingsScreen />} />
          <Route path="appearance" element={<Appearance />} />
          <Route path="tools" element={<Tools />} />
          <Route path="about" element={<About />} />
        </Route>
        <Route
          path="/admin/posts/new"
          element={
            user ? <Editor type="post" /> : <Navigate to="/login" replace />
          }
        />
        <Route
          path="/admin/posts/:id"
          element={
            user ? <Editor type="post" /> : <Navigate to="/login" replace />
          }
        />
        <Route
          path="/admin/pages/new"
          element={
            user ? <Editor type="page" /> : <Navigate to="/login" replace />
          }
        />
        <Route
          path="/admin/pages/:id"
          element={
            user ? <Editor type="page" /> : <Navigate to="/login" replace />
          }
        />
        <Route path="/" element={<PublicSite />} />
        <Route path="/posts/:slug" element={<PublicSite detail />} />
        <Route path="/pages/:slug" element={<PublicSite detail page />} />
        <Route
          path="*"
          element={
            <div className="not-found">
              <h1>Page not found</h1>
              <p>The page you requested could not be found.</p>
              <Link to="/">Return to site</Link>
            </div>
          }
        />
      </Routes>
    </Session.Provider>
  );
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
      navigate(location.state?.from || "/admin");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  if (user) return <Navigate to="/admin" replace />;
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
    { to: "/admin/appearance", label: "Appearance", icon: "admin-appearance" },
    { to: "/admin/users", label: "Users", icon: "admin-users" },
    { to: "/admin/tools", label: "Tools", icon: "admin-tools" },
    {
      to: "/admin/settings",
      label: "Settings",
      icon: "admin-settings",
      sub: [
        ["General", "/admin/settings"],
        ["Reading", "/admin/settings?tab=reading"],
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
                    <Link className="ab-item" to="/admin/users">
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
                (!administrator &&
                  [
                    "/admin/appearance",
                    "/admin/users",
                    "/admin/settings",
                  ].includes(item.to)) ||
                (!canPages &&
                  ["/admin/pages", "/admin/comments"].includes(item.to))
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
                    to={item.to}
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
                onClick={() => setCollapsed(!collapsed)}
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
        <p id="footer-upgrade">Version 0.1.0</p>
      </footer>
    </div>
  );
}
function ScreenTabs({ children }: { children?: ReactNode }) {
  const [help, setHelp] = useState(false),
    [options, setOptions] = useState(false);
  return (
    <>
      <div id="screen-meta-links">
        <button className="show-settings" onClick={() => setOptions(!options)}>
          Screen Options <Icon name="arrow-down-alt2" />
        </button>
        <button className="show-settings" onClick={() => setHelp(!help)}>
          Help <Icon name="arrow-down-alt2" />
        </button>
      </div>
      {(help || options) && (
        <div className="screen-help">
          {help ? (
            <>
              <strong>Overview</strong>
              <p>
                Manage your site using the menu on the left. Create posts and
                pages, manage media and comments, and adjust your site settings.
              </p>
              <Link to="/admin/about">About this study project</Link>
            </>
          ) : (
            children || (
              <p>
                Dashboard panels can be expanded or collapsed using the arrow in
                each panel heading.
              </p>
            )
          )}
        </div>
      )}
    </>
  );
}
function Dashboard() {
  const { user } = useContext(Session);
  const canPages = user?.role === "administrator" || user?.role === "editor";
  const site = useResource<{ settings: Partial<Settings> }>("/public/site");
  const { data, loading, error, reload } = useResource<{
    counts: Record<string, number>;
    recentPosts: Post[];
    recentComments: Comment[];
  }>("/dashboard");
  const [welcome, setWelcome] = useState(
      () => localStorage.getItem("worldact-hide-welcome") !== "1",
    ),
    [draftTitle, setDraftTitle] = useState(""),
    [draftContent, setDraftContent] = useState(""),
    [notice, setNotice] = useState(""),
    [saveError, setSaveError] = useState(""),
    [busy, setBusy] = useState(false);
  async function saveDraft(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setSaveError("");
    try {
      await api(
        "/posts",
        json("POST", {
          type: "post",
          title: draftTitle,
          content: `<p>${escapeHTML(draftContent).replace(/\n/g, "</p><p>")}</p>`,
          status: "draft",
          excerpt: "",
        }),
      );
      setNotice("Draft saved.");
      setDraftTitle("");
      setDraftContent("");
      await reload();
    } catch (e) {
      setSaveError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <ScreenTabs>
        <p>
          <label>
            <input
              type="checkbox"
              checked={welcome}
              onChange={(e) => {
                setWelcome(e.target.checked);
                localStorage.setItem(
                  "worldact-hide-welcome",
                  e.target.checked ? "0" : "1",
                );
              }}
            />{" "}
            Welcome
          </label>
        </p>
      </ScreenTabs>
      <main className="wrap dashboard-wrap">
        <h1>Dashboard</h1>
        <ResourceState loading={loading} error={error} retry={reload} />
        {notice && <Notice onDismiss={() => setNotice("")}>{notice}</Notice>}
        {saveError && <Notice error>{saveError}</Notice>}
        {welcome && (
          <div id="welcome-panel" className="welcome-panel">
            <button
              className="welcome-panel-close button-link"
              onClick={() => {
                setWelcome(false);
                localStorage.setItem("worldact-hide-welcome", "1");
              }}
              aria-label="Dismiss welcome panel"
            >
              Dismiss
            </button>
            <div className="welcome-panel-content">
              <div className="welcome-panel-header-wrap">
                <div className="welcome-panel-header">
                  <div className="welcome-panel-header-image">
                    <img
                      src="/vendor/wordpress/wp-admin/images/dashboard-background.svg"
                      alt=""
                    />
                  </div>
                  <h2>Welcome to WorldAct!</h2>
                  <p>
                    <Link to="/admin/about">
                      Learn more about the 0.1.0 version.
                    </Link>
                  </p>
                </div>
              </div>
              <div className="welcome-panel-column-container">
                {[
                  {
                    icon: "edit",
                    title: "Author rich content with blocks and patterns",
                    text: "Create pages and posts with paragraph, heading, list, quote, and image blocks.",
                    link: "Add a new page",
                    to: "/admin/pages/new",
                  },
                  {
                    icon: "layout",
                    title: "Customize your entire site with themes",
                    text: "Choose the appearance of your site and make it your own.",
                    link: "Open Appearance",
                    to: "/admin/appearance",
                  },
                  {
                    icon: "admin-settings",
                    title: "Make your site feel like home",
                    text: "Set your site title, tagline, and reading preferences for your visitors.",
                    link: "Edit site settings",
                    to: "/admin/settings",
                  },
                ]
                  .map((item) =>
                    !canPages && item.to === "/admin/pages/new"
                      ? {
                          ...item,
                          title: "Author rich content with blocks",
                          link: "Add a new post",
                          to: "/admin/posts/new",
                        }
                      : item,
                  )
                  .filter(
                    (item) =>
                      !["/admin/appearance", "/admin/settings"].includes(
                        item.to,
                      ) || user?.role === "administrator",
                  )
                  .map((item) => (
                    <div className="welcome-panel-column" key={item.title}>
                      <span className="welcome-square">
                        <Icon name={item.icon} />
                      </span>
                      <div className="welcome-panel-column-content">
                        <h3>{item.title}</h3>
                        <p>{item.text}</p>
                        <Link to={item.to}>{item.link}</Link>
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          </div>
        )}
        <div id="dashboard-widgets-wrap">
          <div
            id="dashboard-widgets"
            className="metabox-holder dashboard-columns"
          >
            <div className="postbox-container">
              <div className="meta-box-sortables">
                <Panel title="At a Glance" id="dashboard_right_now">
                  <div className="main">
                    <ul>
                      <li className="post-count">
                        <Link to="/admin/posts">
                          {data?.counts.posts ?? 0}{" "}
                          {data?.counts.posts === 1 ? "Post" : "Posts"}
                        </Link>
                      </li>
                      {canPages && (
                        <>
                          <li className="page-count">
                            <Link to="/admin/pages">
                              {data?.counts.pages ?? 0}{" "}
                              {data?.counts.pages === 1 ? "Page" : "Pages"}
                            </Link>
                          </li>
                          <li className="comment-count">
                            <Link to="/admin/comments">
                              {data?.counts.comments ?? 0}{" "}
                              {data?.counts.comments === 1
                                ? "Comment"
                                : "Comments"}
                            </Link>
                          </li>
                        </>
                      )}
                    </ul>
                    <p>
                      WorldAct 0.1.0 running{" "}
                      {user?.role === "administrator" ? (
                        <Link to="/admin/appearance">
                          {site.data?.settings.theme === "classic"
                            ? "WorldAct Classic"
                            : "Twenty Twenty-Five"}
                        </Link>
                      ) : (
                        <span>
                          {site.data?.settings.theme === "classic"
                            ? "WorldAct Classic"
                            : "Twenty Twenty-Five"}
                        </span>
                      )}{" "}
                      theme.
                    </p>
                  </div>
                </Panel>
                <Panel title="Activity" id="dashboard_activity">
                  <div id="activity-widget">
                    <h3>Recently Published</h3>
                    {data?.recentPosts.filter(
                      (post) =>
                        post.type === "post" && post.status === "publish",
                    ).length ? (
                      <ul className="activity-posts">
                        {data.recentPosts
                          .filter(
                            (post) =>
                              post.type === "post" && post.status === "publish",
                          )
                          .slice(0, 5)
                          .map((post) => (
                            <li key={post.id}>
                              <span>{date(post.publishedAt)}</span>{" "}
                              <Link to={`/admin/posts/${post.id}`}>
                                {post.title || "(no title)"}
                              </Link>
                            </li>
                          ))}
                      </ul>
                    ) : (
                      <p>No published posts yet.</p>
                    )}
                    {canPages && <h3>Recent Comments</h3>}
                    {canPages &&
                      (data?.recentComments.length ? (
                        data.recentComments.slice(0, 3).map((comment) => (
                          <div className="dashboard-comment" key={comment.id}>
                            <span className="comment-avatar">
                              <Icon name="admin-users" />
                            </span>
                            <div>
                              <p>
                                From <strong>{comment.authorName}</strong> on{" "}
                                <Link to={`/admin/posts/${comment.postId}`}>
                                  {comment.postTitle}
                                </Link>
                              </p>
                              <p>
                                {comment.content
                                  .replace(/<[^>]+>/g, "")
                                  .slice(0, 120)}
                              </p>
                              <Link to="/admin/comments">
                                Moderate comments
                              </Link>
                            </div>
                          </div>
                        ))
                      ) : (
                        <p>No comments yet.</p>
                      ))}
                  </div>
                </Panel>
              </div>
            </div>
            <div className="postbox-container">
              <div className="meta-box-sortables">
                <Panel title="Quick Draft" id="dashboard_quick_press">
                  <form onSubmit={saveDraft}>
                    <div className="input-text-wrap">
                      <label htmlFor="quick-title">Title</label>
                      <input
                        type="text"
                        id="quick-title"
                        value={draftTitle}
                        onChange={(e) => setDraftTitle(e.target.value)}
                        required
                      />
                    </div>
                    <div className="textarea-wrap">
                      <label
                        htmlFor="quick-content"
                        className="screen-reader-text"
                      >
                        Content
                      </label>
                      <textarea
                        id="quick-content"
                        placeholder="What’s on your mind?"
                        value={draftContent}
                        onChange={(e) => setDraftContent(e.target.value)}
                        rows={4}
                      />
                    </div>
                    <p className="submit">
                      <button className="button button-primary" disabled={busy}>
                        {busy ? "Saving…" : "Save Draft"}
                      </button>
                    </p>
                  </form>
                  {data?.recentPosts.some(
                    (post) => post.type === "post" && post.status === "draft",
                  ) && (
                    <div className="drafts">
                      <h2>Your Recent Drafts</h2>
                      <ul>
                        {data.recentPosts
                          .filter(
                            (post) =>
                              post.type === "post" && post.status === "draft",
                          )
                          .slice(0, 3)
                          .map((post) => (
                            <li key={post.id}>
                              <Link to={`/admin/posts/${post.id}`}>
                                {post.title || "(no title)"}
                              </Link>{" "}
                              <span>{date(post.updatedAt)}</span>
                            </li>
                          ))}
                      </ul>
                    </div>
                  )}
                </Panel>
                <Panel title="WorldAct Events and News">
                  <p>Welcome to your personal WorldAct site.</p>
                  <p>
                    This local study project runs on React and PostgreSQL.{" "}
                    <Link to="/admin/about">
                      See what is available in this version.
                    </Link>
                  </p>
                  <p>
                    <Link to="/">
                      View your site <span aria-hidden="true">↗</span>
                    </Link>
                  </p>
                </Panel>
              </div>
            </div>
            <div className="postbox-container empty-column">
              <div className="meta-box-sortables">
                <div className="empty-container" />
              </div>
            </div>
          </div>
        </div>
      </main>
    </>
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
function PostList({ type }: { type: "post" | "page" }) {
  const [params, setParams] = useSearchParams(),
    status = params.get("status") || "all",
    search = params.get("search") || "",
    label = type === "post" ? "Posts" : "Pages",
    singular = type === "post" ? "Post" : "Page",
    base = `/admin/${type === "post" ? "posts" : "pages"}`;
  const { data, loading, error, reload } = useResource<{
    posts: Post[];
    counts: Record<string, number>;
  }>(
    `/posts?type=${type}&status=${encodeURIComponent(status)}&search=${encodeURIComponent(search)}`,
  );
  const [query, setQuery] = useState(search),
    [selected, setSelected] = useState<number[]>([]),
    [bulk, setBulk] = useState(""),
    [notice, setNotice] = useState(""),
    [actionError, setActionError] = useState(""),
    [busy, setBusy] = useState(false),
    [month, setMonth] = useState("all");
  useEffect(() => {
    setQuery(search);
    setSelected([]);
  }, [search, status, type]);
  const posts = (data?.posts || []).filter(
    (post) => month === "all" || post.createdAt.slice(0, 7) === month,
  );
  async function action(ids: number[], operation: string) {
    if (!ids.length || !operation) return;
    setBusy(true);
    setActionError("");
    try {
      for (const id of ids)
        await api(
          `/posts/${id}`,
          operation === "delete"
            ? json("DELETE")
            : json("PUT", { status: operation }),
        );
      setSelected([]);
      setNotice(
        operation === "trash"
          ? "Item moved to the Trash."
          : operation === "delete"
            ? "Item permanently deleted."
            : "Item restored.",
      );
      await reload();
    } catch (e) {
      setActionError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const checkAll =
    posts.length > 0 && posts.every((post) => selected.includes(post.id));
  const tableHeader = (
    <tr>
      <td className="manage-column column-cb check-column">
        <input
          aria-label="Select all"
          type="checkbox"
          checked={checkAll}
          onChange={(e) =>
            setSelected(e.target.checked ? posts.map((post) => post.id) : [])
          }
        />
      </td>
      <th scope="col" className="manage-column column-title column-primary">
        Title
      </th>
      <th scope="col" className="manage-column column-author">
        Author
      </th>
      {type === "post" && (
        <>
          <th scope="col" className="manage-column column-categories">
            Categories
          </th>
          <th scope="col" className="manage-column column-tags">
            Tags
          </th>
        </>
      )}
      <th scope="col" className="manage-column column-comments">
        <Icon name="admin-comments" />
        <span className="screen-reader-text">Comments</span>
      </th>
      <th scope="col" className="manage-column column-date">
        Date
      </th>
    </tr>
  );
  return (
    <>
      <ScreenTabs />
      <main className="wrap">
        <h1 className="wp-heading-inline">{label}</h1>{" "}
        <Link className="page-title-action" to={`${base}/new`}>
          Add New {singular}
        </Link>
        <hr className="wp-header-end" />
        {notice && <Notice onDismiss={() => setNotice("")}>{notice}</Notice>}
        {actionError && <Notice error>{actionError}</Notice>}
        <ResourceState loading={loading} error={error} retry={reload} />
        <ul className="subsubsub">
          {[
            ["all", "All"],
            ["publish", "Published"],
            ["draft", "Drafts"],
            ["trash", "Trash"],
          ].map(([value, text], i) => (
            <li key={value}>
              {i > 0 && " | "}
              <Link
                className={status === value ? "current" : ""}
                to={`${base}?status=${value}${search ? `&search=${encodeURIComponent(search)}` : ""}`}
              >
                {text}{" "}
                <span className="count">({data?.counts[value] || 0})</span>
              </Link>
            </li>
          ))}
        </ul>
        <form
          className="search-box"
          onSubmit={(e) => {
            e.preventDefault();
            setParams({ status, search: query });
          }}
        >
          <label className="screen-reader-text" htmlFor="post-search-input">
            Search {label}
          </label>
          <input
            id="post-search-input"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button className="button">Search {label}</button>
        </form>
        <div className="tablenav top">
          <div className="alignleft actions bulkactions">
            <label
              className="screen-reader-text"
              htmlFor="bulk-action-selector"
            >
              Bulk actions
            </label>
            <select
              id="bulk-action-selector"
              value={bulk}
              onChange={(e) => setBulk(e.target.value)}
            >
              <option value="">Bulk actions</option>
              {status === "trash" ? (
                <>
                  <option value="draft">Restore</option>
                  <option value="delete">Delete permanently</option>
                </>
              ) : (
                <option value="trash">Move to Trash</option>
              )}
            </select>
            <button
              className="button action"
              onClick={() => action(selected, bulk)}
              disabled={busy || !selected.length || !bulk}
            >
              Apply
            </button>
          </div>
          <div className="alignleft actions">
            <label className="screen-reader-text" htmlFor="filter-month">
              Filter by date
            </label>
            <select
              id="filter-month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
            >
              <option value="all">All dates</option>
              {Array.from(
                new Set(
                  (data?.posts || []).map((post) => post.createdAt.slice(0, 7)),
                ),
              ).map((value) => (
                <option key={value} value={value}>
                  {new Date(`${value}-15`).toLocaleDateString(undefined, {
                    month: "long",
                    year: "numeric",
                  })}
                </option>
              ))}
            </select>
          </div>
          <div className="tablenav-pages">
            <span className="displaying-num">
              {posts.length} {posts.length === 1 ? "item" : "items"}
            </span>
          </div>
        </div>
        <table className="wp-list-table widefat fixed striped table-view-list posts">
          <thead>{tableHeader}</thead>
          <tbody>
            {posts.map((post) => (
              <tr key={post.id}>
                <th scope="row" className="check-column">
                  <input
                    type="checkbox"
                    aria-label={`Select ${post.title}`}
                    checked={selected.includes(post.id)}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? [...selected, post.id]
                          : selected.filter((id) => id !== post.id),
                      )
                    }
                  />
                </th>
                <td className="title column-title column-primary">
                  <strong>
                    <Link className="row-title" to={`${base}/${post.id}`}>
                      {post.title || "(no title)"}
                    </Link>
                    {post.status === "draft" && " — Draft"}
                  </strong>
                  <div className="row-actions">
                    {post.status === "trash" ? (
                      <>
                        <span>
                          <button
                            className="button-link"
                            onClick={() => action([post.id], "draft")}
                          >
                            Restore
                          </button>{" "}
                          |{" "}
                        </span>
                        <span className="trash">
                          <button
                            className="button-link button-link-delete"
                            onClick={() => action([post.id], "delete")}
                          >
                            Delete Permanently
                          </button>
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="edit">
                          <Link to={`${base}/${post.id}`}>Edit</Link> |{" "}
                        </span>
                        <span className="trash">
                          <button
                            className="button-link button-link-delete"
                            onClick={() => action([post.id], "trash")}
                          >
                            Trash
                          </button>{" "}
                          |{" "}
                        </span>
                        <span className="view">
                          {post.status === "publish" ? (
                            <Link
                              to={`/${type === "post" ? "posts" : "pages"}/${post.slug}`}
                            >
                              View
                            </Link>
                          ) : (
                            <Link to={`${base}/${post.id}`}>
                              Continue editing
                            </Link>
                          )}
                        </span>
                      </>
                    )}
                  </div>
                </td>
                <td className="author column-author">{post.authorName}</td>
                {type === "post" && (
                  <>
                    <td className="categories column-categories">
                      Uncategorized
                    </td>
                    <td className="tags column-tags">—</td>
                  </>
                )}
                <td className="comments column-comments">—</td>
                <td className="date column-date">
                  {post.status === "publish" ? "Published" : "Last Modified"}
                  <br />
                  {date(post.publishedAt || post.updatedAt)}
                </td>
              </tr>
            ))}
            {!loading && !posts.length && (
              <tr className="no-items">
                <td className="colspanchange" colSpan={type === "post" ? 7 : 5}>
                  No {label.toLowerCase()} found.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>{tableHeader}</tfoot>
        </table>
        <div className="tablenav bottom">
          <div className="tablenav-pages">
            <span className="displaying-num">{posts.length} items</span>
          </div>
        </div>
      </main>
    </>
  );
}
type Block = {
  id: string;
  kind: "paragraph" | "heading" | "list" | "quote" | "image";
  html: string;
  alt?: string;
};
const newBlock = (kind: Block["kind"] = "paragraph", html = ""): Block => ({
  id: crypto.randomUUID(),
  kind,
  html,
});
function htmlBlocks(content: string): Block[] {
  const document = new DOMParser().parseFromString(content, "text/html");
  const blocks = Array.from(document.body.children).map((element) => {
    if (element.tagName === "FIGURE" || element.tagName === "IMG") {
      const image =
        element.tagName === "IMG"
          ? (element as HTMLImageElement)
          : element.querySelector("img");
      return {
        ...newBlock("image", image?.getAttribute("src") || ""),
        alt: image?.getAttribute("alt") || "",
      };
    }
    if (/^H[1-6]$/.test(element.tagName))
      return newBlock("heading", element.innerHTML);
    if (element.tagName === "UL" || element.tagName === "OL")
      return newBlock("list", element.innerHTML);
    if (element.tagName === "BLOCKQUOTE")
      return newBlock("quote", element.innerHTML);
    return newBlock("paragraph", element.innerHTML);
  });
  return blocks.length ? blocks : [newBlock()];
}
function blocksHTML(blocks: Block[]) {
  return blocks
    .map((block) => {
      const tag = {
        paragraph: "p",
        heading: "h2",
        list: "ul",
        quote: "blockquote",
        image: "figure",
      }[block.kind];
      return block.kind === "image"
        ? block.html
          ? `<figure><img src="${escapeHTML(block.html)}" alt="${escapeHTML(block.alt || "")}" /></figure>`
          : ""
        : `<${tag}>${block.html}</${tag}>`;
    })
    .join("\n");
}
function EditableBlock({
  block,
  update,
  active,
  onFocus,
}: {
  block: Block;
  update: (value: Partial<Block>) => void;
  active: boolean;
  onFocus: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (
      ref.current &&
      ref.current.innerHTML !== block.html &&
      document.activeElement !== ref.current
    )
      ref.current.innerHTML = block.html;
  }, [block.html]);
  if (block.kind === "image")
    return (
      <div
        className={`editor-block image-block ${active ? "is-selected" : ""}`}
        onClick={onFocus}
      >
        {block.html ? (
          <>
            <img src={block.html} alt={block.alt || ""} />
            <label className="image-alt-label">
              Alternative text
              <input
                type="text"
                value={block.alt || ""}
                onChange={(e) => update({ alt: e.target.value })}
              />
            </label>
          </>
        ) : (
          <div className="image-placeholder">
            <Icon name="format-image" />
            <strong>Image</strong>
            <p>Select an image from your media library.</p>
          </div>
        )}
        <label className="image-url-label">
          Image URL
          <input
            type="url"
            placeholder="https://… or /uploads/…"
            value={block.html}
            onChange={(e) => update({ html: e.target.value })}
          />
        </label>
      </div>
    );
  return (
    <div
      ref={ref}
      className={`editor-block block-${block.kind} ${active ? "is-selected" : ""}`}
      role="textbox"
      aria-label={`${block.kind} block`}
      aria-multiline="true"
      contentEditable
      suppressContentEditableWarning
      data-placeholder={
        block.kind === "paragraph"
          ? "Type here to start writing…"
          : block.kind === "heading"
            ? "Heading"
            : block.kind === "list"
              ? "List item…"
              : "Add quote…"
      }
      onFocus={onFocus}
      onInput={(e) => update({ html: e.currentTarget.innerHTML })}
    />
  );
}
function Editor({ type }: { type: "post" | "page" }) {
  const { id } = useParams(),
    navigate = useNavigate();
  const [title, setTitle] = useState(""),
    [blocks, setBlocks] = useState<Block[]>([newBlock()]),
    [status, setStatus] = useState<Post["status"]>("draft"),
    [slug, setSlug] = useState(""),
    [excerpt, setExcerpt] = useState(""),
    [loading, setLoading] = useState(!!id),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false),
    [sidebar, setSidebar] = useState(
      () => window.matchMedia("(min-width: 783px)").matches,
    ),
    [inserter, setInserter] = useState(false),
    [active, setActive] = useState<string>(""),
    [listView, setListView] = useState(false),
    [mediaPicker, setMediaPicker] = useState(false);
  const media = useResource<{ media: Media[] }>("/media");
  const base = `/admin/${type === "post" ? "posts" : "pages"}`;
  useEffect(() => {
    const narrow = window.matchMedia("(max-width: 782px)");
    const closeOnNarrow = (event: MediaQueryListEvent) => {
      if (event.matches) setSidebar(false);
    };
    narrow.addEventListener("change", closeOnNarrow);
    return () => narrow.removeEventListener("change", closeOnNarrow);
  }, []);
  useEffect(() => {
    if (!id) {
      setTitle("");
      setBlocks([newBlock()]);
      setStatus("draft");
      setSlug("");
      setExcerpt("");
      setError("");
      setNotice("");
      setDirty(false);
      setActive("");
      setLoading(false);
      return;
    }
    setLoading(true);
    api<{ post: Post }>(`/posts/${id}`)
      .then(({ post }) => {
        if (post.type !== type) {
          navigate(
            `/admin/${post.type === "page" ? "pages" : "posts"}/${post.id}`,
            { replace: true },
          );
          return;
        }
        setTitle(post.title);
        setBlocks(htmlBlocks(post.content));
        setStatus(post.status);
        setSlug(post.slug);
        setExcerpt(post.excerpt);
        setDirty(false);
      })
      .catch((e) => setError(errorText(e)))
      .finally(() => setLoading(false));
  }, [id, type, navigate]);
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty]);
  const update = (blockId: string, value: Partial<Block>) => {
    setBlocks((current) =>
      current.map((block) =>
        block.id === blockId ? { ...block, ...value } : block,
      ),
    );
    setDirty(true);
  };
  async function save(nextStatus: Post["status"]) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const { post } = await api<{ post: Post }>(
        id ? `/posts/${id}` : "/posts",
        json(id ? "PUT" : "POST", {
          ...(!id ? { type } : {}),
          title,
          content: blocksHTML(blocks),
          excerpt,
          status: nextStatus,
          ...(slug ? { slug } : {}),
        }),
      );
      setStatus(post.status);
      setSlug(post.slug);
      setDirty(false);
      setNotice(
        post.status === "publish"
          ? `${type === "post" ? "Post" : "Page"} published.`
          : "Draft saved.",
      );
      if (!id) navigate(`${base}/${post.id}`, { replace: true });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  function add(kind: Block["kind"]) {
    const block = newBlock(kind, kind === "list" ? "<li></li>" : "");
    setBlocks((current) => [...current, block]);
    setActive(block.id);
    setDirty(true);
    setInserter(false);
  }
  function leave() {
    if (!dirty || window.confirm("You have unsaved changes. Leave the editor?"))
      navigate(base);
  }
  const selected = blocks.find((block) => block.id === active);
  const words = blocks
    .map((block) => block.html.replace(/<[^>]*>/g, " "))
    .join(" ")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  return (
    <div className={`block-editor-screen ${sidebar ? "with-sidebar" : ""}`}>
      <header className="editor-header">
        <button
          className="editor-home"
          aria-label={`Back to ${type === "post" ? "posts" : "pages"}`}
          onClick={leave}
        >
          <Brand />
        </button>
        <div className="editor-tools">
          <button
            className={`editor-add ${inserter ? "is-pressed" : ""}`}
            aria-label="Add block"
            aria-expanded={inserter}
            onClick={() => setInserter(!inserter)}
          >
            <Icon name={inserter ? "no-alt" : "plus"} />
          </button>
          <button
            className={`editor-icon-button ${listView ? "is-pressed" : ""}`}
            aria-label="List view"
            aria-pressed={listView}
            onClick={() => setListView(!listView)}
          >
            <Icon name="editor-ul" />
          </button>
          <span className="editor-document-name">
            {title || (type === "post" ? "New post" : "New page")}{" "}
            <span>· {type === "post" ? "Post" : "Page"}</span>
          </span>
        </div>
        <div className="editor-actions">
          {status !== "publish" && (
            <button
              className="button-link"
              onClick={() => save("draft")}
              disabled={busy}
            >
              Save draft
            </button>
          )}
          {status === "publish" && slug && (
            <Link
              className="editor-icon-button"
              to={`/${type === "post" ? "posts" : "pages"}/${slug}`}
              aria-label="View published content"
            >
              <Icon name="external" />
            </Link>
          )}
          <button
            className="editor-icon-button"
            aria-label="Settings"
            aria-pressed={sidebar}
            onClick={() => setSidebar(!sidebar)}
          >
            <Icon name="admin-settings" />
          </button>
          <button
            className="button button-primary"
            onClick={() => save("publish")}
            disabled={busy || loading}
          >
            {busy ? "Saving…" : status === "publish" ? "Save" : "Publish"}
          </button>
        </div>
      </header>
      {inserter && (
        <aside className="block-inserter">
          <h2>Blocks</h2>
          <p>Add a block to your content.</p>
          <div className="block-types">
            {(
              [
                "paragraph",
                "heading",
                "list",
                "quote",
                "image",
              ] as Block["kind"][]
            ).map((kind) => (
              <button key={kind} onClick={() => add(kind)}>
                <Icon
                  name={
                    {
                      paragraph: "editor-paragraph",
                      heading: "heading",
                      list: "editor-ul",
                      quote: "format-quote",
                      image: "format-image",
                    }[kind]
                  }
                />
                <span>{kind[0].toUpperCase() + kind.slice(1)}</span>
              </button>
            ))}
          </div>
        </aside>
      )}
      {listView && (
        <aside className="block-list-view">
          <h2>List View</h2>
          {blocks.map((block, i) => (
            <button
              className={active === block.id ? "active" : ""}
              key={block.id}
              onClick={() => {
                setActive(block.id);
                document
                  .getElementById(`block-${block.id}`)
                  ?.scrollIntoView({ block: "center" });
              }}
            >
              {i + 1}. {block.kind[0].toUpperCase() + block.kind.slice(1)}
            </button>
          ))}
        </aside>
      )}
      <main className="editor-main">
        {loading ? (
          <ResourceState loading error="" />
        ) : (
          <>
            {error && <Notice error>{error}</Notice>}
            {notice && (
              <Notice onDismiss={() => setNotice("")}>
                {notice}{" "}
                {status === "publish" && (
                  <Link to={`/${type === "post" ? "posts" : "pages"}/${slug}`}>
                    View {type}
                  </Link>
                )}
              </Notice>
            )}
            <div className="editor-canvas">
              <textarea
                className="editor-title"
                placeholder="Add title"
                aria-label="Add title"
                rows={1}
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  setDirty(true);
                  e.currentTarget.style.height = "auto";
                  e.currentTarget.style.height = `${e.currentTarget.scrollHeight}px`;
                }}
              />
              {blocks.map((block) => (
                <div
                  id={`block-${block.id}`}
                  className="block-wrapper"
                  key={block.id}
                >
                  <EditableBlock
                    block={block}
                    update={(value) => update(block.id, value)}
                    active={active === block.id}
                    onFocus={() => setActive(block.id)}
                  />
                  {active === block.id && (
                    <div className="block-actions">
                      <label>
                        <span className="screen-reader-text">Block type</span>
                        <select
                          value={block.kind}
                          onChange={(e) =>
                            update(block.id, {
                              kind: e.target.value as Block["kind"],
                            })
                          }
                        >
                          {(
                            [
                              "paragraph",
                              "heading",
                              "list",
                              "quote",
                              "image",
                            ] as Block["kind"][]
                          ).map((kind) => (
                            <option key={kind}>{kind}</option>
                          ))}
                        </select>
                      </label>
                      <button
                        className="editor-icon-button"
                        aria-label="Move block up"
                        disabled={blocks[0].id === block.id}
                        onClick={() => {
                          const i = blocks.findIndex(
                            (item) => item.id === block.id,
                          );
                          const next = [...blocks];
                          [next[i - 1], next[i]] = [next[i], next[i - 1]];
                          setBlocks(next);
                          setDirty(true);
                        }}
                      >
                        <Icon name="arrow-up-alt2" />
                      </button>
                      <button
                        className="editor-icon-button"
                        aria-label="Move block down"
                        disabled={blocks[blocks.length - 1].id === block.id}
                        onClick={() => {
                          const i = blocks.findIndex(
                            (item) => item.id === block.id,
                          );
                          const next = [...blocks];
                          [next[i + 1], next[i]] = [next[i], next[i + 1]];
                          setBlocks(next);
                          setDirty(true);
                        }}
                      >
                        <Icon name="arrow-down-alt2" />
                      </button>
                      {block.kind === "image" && (
                        <button
                          className="button-link"
                          onClick={() => setMediaPicker(true)}
                        >
                          Media Library
                        </button>
                      )}
                      <button
                        className="editor-icon-button"
                        aria-label="Remove block"
                        onClick={() => {
                          setBlocks((current) =>
                            current.filter((item) => item.id !== block.id),
                          );
                          setDirty(true);
                        }}
                      >
                        <Icon name="trash" />
                      </button>
                    </div>
                  )}
                </div>
              ))}
              <button
                className="editor-bottom-add"
                aria-label="Add a paragraph block"
                onClick={() => add("paragraph")}
              >
                <Icon name="plus" />
              </button>
            </div>
          </>
        )}
      </main>
      {sidebar && (
        <aside className="editor-settings">
          <div className="editor-settings-title">
            <strong>{type === "post" ? "Post" : "Page"}</strong>
            <button
              className="editor-icon-button"
              aria-label="Close settings"
              onClick={() => setSidebar(false)}
            >
              <Icon name="no-alt" />
            </button>
          </div>
          <div className="editor-summary">
            <h2>{title || (type === "post" ? "New post" : "New page")}</h2>
            <p>{words} words</p>
            <dl>
              <dt>Status</dt>
              <dd>
                {status === "publish"
                  ? "Published"
                  : status === "trash"
                    ? "Trash"
                    : "Draft"}
              </dd>
              <dt>Publish</dt>
              <dd>Immediately</dd>
              <dt>Template</dt>
              <dd>Default template</dd>
            </dl>
          </div>
          <details open>
            <summary>Link</summary>
            <label>
              Slug
              <input
                type="text"
                value={slug}
                onChange={(e) => {
                  setSlug(e.target.value);
                  setDirty(true);
                }}
                placeholder="Generated from title"
              />
            </label>
          </details>
          <details>
            <summary>Excerpt</summary>
            <label>
              Write an excerpt (optional)
              <textarea
                value={excerpt}
                onChange={(e) => {
                  setExcerpt(e.target.value);
                  setDirty(true);
                }}
                rows={5}
              />
            </label>
          </details>
          <details>
            <summary>Discussion</summary>
            <p>Reader comments are held for moderation.</p>
            <Link to="/admin/comments">Manage comments</Link>
          </details>
        </aside>
      )}
      <footer className="editor-status">
        <span>{type === "post" ? "Post" : "Page"}</span>
        <span>{selected ? selected.kind : "Document"}</span>
        <span className="save-indicator">
          {dirty
            ? "Unsaved changes"
            : status === "publish"
              ? "Published"
              : "Draft"}
        </span>
      </footer>
      {mediaPicker && (
        <Modal title="Select image" close={() => setMediaPicker(false)}>
          <ResourceState
            loading={media.loading}
            error={media.error}
            retry={media.reload}
          />
          <div className="media-grid picker-grid">
            {media.data?.media
              .filter((item) => item.mimeType.startsWith("image/"))
              .map((item) => (
                <button
                  className="media-item"
                  key={item.id}
                  onClick={() => {
                    update(active, { html: item.url, alt: item.alt });
                    setMediaPicker(false);
                  }}
                >
                  <img src={item.url} alt={item.alt || item.title} />
                </button>
              ))}
          </div>
          {!media.data?.media.length && (
            <p>
              No images available.{" "}
              <Link to="/admin/media">Upload an image</Link>, then return to the
              editor.
            </p>
          )}
        </Modal>
      )}
    </div>
  );
}
function Modal({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null),
    closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const keydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
      if (e.key === "Tab" && ref.current) {
        const focusable = Array.from(
          ref.current.querySelectorAll<HTMLElement>(
            'button,a,input,textarea,select,[tabindex="0"]',
          ),
        ).filter((item) => !item.hasAttribute("disabled"));
        const first = focusable[0],
          last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener("keydown", keydown);
    return () => {
      window.removeEventListener("keydown", keydown);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="wa-modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="wa-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
      >
        <header>
          <h1>{title}</h1>
          <button
            className="editor-icon-button"
            aria-label="Close dialog"
            onClick={close}
          >
            <Icon name="no-alt" />
          </button>
        </header>
        <div className="wa-modal-content">{children}</div>
      </div>
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
      (filter === "all" || item.mimeType.startsWith(filter)),
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
          accept="image/png,image/jpeg,image/webp,image/gif"
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
              Maximum upload file size: 8 MB. JPEG, PNG, GIF, and WebP images.
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
              Upload an image
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
                <img src={item.url} alt={item.alt || item.title} />
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
                      <img src={item.url} alt="" />
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
                <img src={selected.url} alt={selected.alt} />
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
                  Describe the purpose of the image for people who cannot see
                  it.
                </p>
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
function Comments() {
  const resource = useResource<{ comments: Comment[] }>("/comments");
  const [params, setParams] = useSearchParams(),
    status = params.get("status") || "all";
  const [search, setSearch] = useState(""),
    [selected, setSelected] = useState<number[]>([]),
    [bulk, setBulk] = useState(""),
    [notice, setNotice] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const comments = (resource.data?.comments || []).filter(
    (item) =>
      (status === "all"
        ? item.status !== "spam" && item.status !== "trash"
        : item.status === status) &&
      `${item.authorName} ${item.content} ${item.postTitle}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  async function action(ids: number[], nextStatus: string) {
    if (!ids.length || !nextStatus) return;
    setBusy(true);
    setError("");
    try {
      for (const id of ids)
        await api(
          `/comments/${id}`,
          nextStatus === "delete"
            ? json("DELETE")
            : json("PUT", { status: nextStatus }),
        );
      setSelected([]);
      setNotice("Comment updated.");
      await resource.reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <ScreenTabs />
      <main className="wrap">
        <h1>Comments</h1>
        {notice && <Notice onDismiss={() => setNotice("")}>{notice}</Notice>}
        {error && <Notice error>{error}</Notice>}
        <ResourceState
          loading={resource.loading}
          error={resource.error}
          retry={resource.reload}
        />
        <ul className="subsubsub">
          {[
            ["all", "All"],
            ["pending", "Pending"],
            ["approved", "Approved"],
            ["spam", "Spam"],
            ["trash", "Trash"],
          ].map(([value, label], i) => (
            <li key={value}>
              {i > 0 && " | "}
              <Link
                className={status === value ? "current" : ""}
                to={`?status=${value}`}
              >
                {label}{" "}
                <span className="count">
                  (
                  {
                    (resource.data?.comments || []).filter((item) =>
                      value === "all"
                        ? !["trash", "spam"].includes(item.status)
                        : item.status === value,
                    ).length
                  }
                  )
                </span>
              </Link>
            </li>
          ))}
        </ul>
        <div className="search-box">
          <input
            type="search"
            aria-label="Search comments"
            placeholder="Search comments"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="tablenav top">
          <div className="alignleft actions bulkactions">
            <select
              aria-label="Bulk actions"
              value={bulk}
              onChange={(e) => setBulk(e.target.value)}
            >
              <option value="">Bulk actions</option>
              <option value="approved">Approve</option>
              <option value="pending">Unapprove</option>
              <option value="spam">Mark as spam</option>
              <option value="trash">Move to Trash</option>
              {status === "trash" && (
                <option value="delete">Delete permanently</option>
              )}
            </select>
            <button
              className="button"
              disabled={busy || !selected.length || !bulk}
              onClick={() => action(selected, bulk)}
            >
              Apply
            </button>
          </div>
          <div className="tablenav-pages">{comments.length} comments</div>
        </div>
        <table className="wp-list-table widefat fixed striped comments">
          <thead>
            <tr>
              <td className="check-column">
                <input
                  type="checkbox"
                  aria-label="Select all comments"
                  checked={
                    comments.length > 0 &&
                    comments.every((item) => selected.includes(item.id))
                  }
                  onChange={(e) =>
                    setSelected(
                      e.target.checked ? comments.map((item) => item.id) : [],
                    )
                  }
                />
              </td>
              <th className="column-author">Author</th>
              <th>Comment</th>
              <th className="column-response">In response to</th>
              <th className="column-date">Submitted on</th>
            </tr>
          </thead>
          <tbody>
            {comments.map((comment) => (
              <tr
                className={comment.status === "pending" ? "unapproved" : ""}
                key={comment.id}
              >
                <th scope="row" className="check-column">
                  <input
                    type="checkbox"
                    aria-label={`Select comment by ${comment.authorName}`}
                    checked={selected.includes(comment.id)}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? [...selected, comment.id]
                          : selected.filter((id) => id !== comment.id),
                      )
                    }
                  />
                </th>
                <td className="author">
                  <strong>{comment.authorName}</strong>
                  <br />
                  <a href={`mailto:${comment.authorEmail}`}>
                    {comment.authorEmail}
                  </a>
                </td>
                <td className="comment column-comment">
                  <div
                    className="comment-content"
                    dangerouslySetInnerHTML={{ __html: comment.content }}
                  />
                  <div className="row-actions visible">
                    {comment.status === "approved" ? (
                      <button
                        className="button-link"
                        onClick={() => action([comment.id], "pending")}
                      >
                        Unapprove
                      </button>
                    ) : (
                      <button
                        className="button-link"
                        onClick={() => action([comment.id], "approved")}
                      >
                        Approve
                      </button>
                    )}
                    {" | "}
                    <button
                      className="button-link"
                      onClick={() => action([comment.id], "spam")}
                    >
                      Spam
                    </button>
                    {" | "}
                    {comment.status === "trash" ? (
                      <button
                        className="button-link button-link-delete"
                        onClick={() => action([comment.id], "delete")}
                      >
                        Delete permanently
                      </button>
                    ) : (
                      <button
                        className="button-link button-link-delete"
                        onClick={() => action([comment.id], "trash")}
                      >
                        Trash
                      </button>
                    )}
                  </div>
                </td>
                <td className="column-response">
                  <Link to={`/admin/posts/${comment.postId}`}>
                    {comment.postTitle}
                  </Link>
                </td>
                <td>
                  {date(comment.createdAt)}
                  <br />
                  <span className={`comment-status status-${comment.status}`}>
                    {comment.status}
                  </span>
                </td>
              </tr>
            ))}
            {!resource.loading && !comments.length && (
              <tr>
                <td colSpan={5}>No comments found.</td>
              </tr>
            )}
          </tbody>
        </table>
      </main>
    </>
  );
}
function Users() {
  const resource = useResource<{ users: User[] }>("/users"),
    { user } = useContext(Session);
  const [adding, setAdding] = useState(false),
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
  async function remove(item: User) {
    if (
      !window.confirm(
        `Delete user “${item.displayName}”? This action permanently removes the account.`,
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      await api(`/users/${item.id}`, json("DELETE"));
      setNotice("User deleted.");
      await resource.reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
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
                      {["subscriber", "author", "editor", "administrator"].map(
                        (role) => (
                          <option key={role} value={role}>
                            {role[0].toUpperCase() + role.slice(1)}
                          </option>
                        ),
                      )}
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
              {["all", "administrator", "editor", "author", "subscriber"].map(
                (role, i) => (
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
                ),
              )}
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
                      <strong>{item.username}</strong>
                      {item.id === user?.id && " (you)"}
                      <div className="row-actions">
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
      </main>
    </>
  );
}
function SettingsScreen() {
  const { data, loading, error, reload } = useResource<{ settings: Settings }>(
      "/settings",
    ),
    [params] = useSearchParams(),
    reading = params.get("tab") === "reading";
  const [form, setForm] = useState<Settings | null>(null),
    [notice, setNotice] = useState(""),
    [saveError, setSaveError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data) setForm(data.settings);
  }, [data]);
  function set<K extends keyof Settings>(key: K, value: Settings[K]) {
    setForm((current) => (current ? { ...current, [key]: value } : current));
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setSaveError("");
    try {
      const result = await api<{ settings: Settings }>(
        "/settings",
        json("PUT", form),
      );
      setForm(result.settings);
      window.dispatchEvent(new Event("worldact-settings-updated"));
      setNotice("Settings saved.");
    } catch (e) {
      setSaveError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <ScreenTabs />
      <main className="wrap">
        <h1>{reading ? "Reading Settings" : "General Settings"}</h1>
        {notice && <Notice onDismiss={() => setNotice("")}>{notice}</Notice>}
        {saveError && <Notice error>{saveError}</Notice>}
        <ResourceState loading={loading} error={error} retry={reload} />
        {form && (
          <form onSubmit={submit}>
            <table className="form-table">
              <tbody>
                {reading ? (
                  <>
                    <tr>
                      <th>
                        <label htmlFor="posts-per-page">
                          Blog pages show at most
                        </label>
                      </th>
                      <td>
                        <input
                          className="small-text"
                          id="posts-per-page"
                          type="number"
                          min={1}
                          max={100}
                          value={form.postsPerPage}
                          onChange={(e) =>
                            set("postsPerPage", Number(e.target.value))
                          }
                          required
                        />{" "}
                        posts
                      </td>
                    </tr>
                    <tr>
                      <th>Search engine visibility</th>
                      <td>
                        <label>
                          <input
                            type="checkbox"
                            checked={form.discourageSearchEngines}
                            onChange={(e) =>
                              set("discourageSearchEngines", e.target.checked)
                            }
                          />{" "}
                          Discourage search engines from indexing this site
                        </label>
                        <p className="description">
                          A noindex directive is sent with public pages when
                          enabled.
                        </p>
                      </td>
                    </tr>
                  </>
                ) : (
                  <>
                    {[
                      {
                        key: "siteTitle",
                        label: "Site Title",
                        type: "text",
                        description: "",
                      },
                      {
                        key: "tagline",
                        label: "Tagline",
                        type: "text",
                        description:
                          "In a few words, explain what this site is about.",
                      },
                      {
                        key: "siteUrl",
                        label: "Site Address (URL)",
                        type: "url",
                        description: "The public address used for this site.",
                      },
                      {
                        key: "adminEmail",
                        label: "Administration Email Address",
                        type: "email",
                        description:
                          "This address is used for administration purposes.",
                      },
                    ].map((field) => (
                      <tr key={field.key}>
                        <th>
                          <label htmlFor={`setting-${field.key}`}>
                            {field.label}
                          </label>
                        </th>
                        <td>
                          <input
                            id={`setting-${field.key}`}
                            className="regular-text"
                            type={field.type}
                            value={String(form[field.key as keyof Settings])}
                            onChange={(e) =>
                              set(field.key as keyof Settings, e.target.value)
                            }
                            required={field.key !== "tagline"}
                          />
                          {field.description && (
                            <p className="description">{field.description}</p>
                          )}
                        </td>
                      </tr>
                    ))}
                    <tr>
                      <th>
                        <label htmlFor="timezone">Timezone</label>
                      </th>
                      <td>
                        <select
                          id="timezone"
                          value={form.timezone}
                          onChange={(e) => set("timezone", e.target.value)}
                        >
                          {Array.from(
                            new Set([
                              form.timezone,
                              "UTC",
                              "America/Los_Angeles",
                              "America/Denver",
                              "America/Chicago",
                              "America/New_York",
                              "Europe/London",
                              "Europe/Paris",
                              "Asia/Tokyo",
                              "Australia/Sydney",
                            ]),
                          ).map((zone) => (
                            <option key={zone}>{zone}</option>
                          ))}
                        </select>
                        <p className="description">
                          Choose a city in the same timezone as you. Dates in
                          the admin are shown in your browser’s local time.
                        </p>
                      </td>
                    </tr>
                    <tr>
                      <th>Date Format</th>
                      <td>
                        {[
                          ["F j, Y", "November 6, 2026"],
                          ["Y-m-d", "2026-11-06"],
                          ["m/d/Y", "11/06/2026"],
                          ["d/m/Y", "06/11/2026"],
                        ].map(([format, label]) => (
                          <label className="format-option" key={format}>
                            <input
                              type="radio"
                              name="date-format"
                              checked={form.dateFormat === format}
                              onChange={() => set("dateFormat", format)}
                            />{" "}
                            {label} <code>{format}</code>
                          </label>
                        ))}
                      </td>
                    </tr>
                    <tr>
                      <th>Time Format</th>
                      <td>
                        {[
                          ["g:i a", "10:30 pm"],
                          ["g:i A", "10:30 PM"],
                          ["H:i", "22:30"],
                        ].map(([format, label]) => (
                          <label className="format-option" key={format}>
                            <input
                              type="radio"
                              name="time-format"
                              checked={form.timeFormat === format}
                              onChange={() => set("timeFormat", format)}
                            />{" "}
                            {label} <code>{format}</code>
                          </label>
                        ))}
                      </td>
                    </tr>
                  </>
                )}
              </tbody>
            </table>
            <p className="submit">
              <button className="button button-primary" disabled={busy}>
                {busy ? "Saving…" : "Save Changes"}
              </button>
            </p>
          </form>
        )}
      </main>
    </>
  );
}
function Appearance() {
  const resource = useResource<{ settings: Settings }>("/settings");
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  async function activate(theme: Settings["theme"]) {
    setBusy(true);
    setError("");
    try {
      await api("/settings", json("PUT", { theme }));
      setNotice("New theme activated.");
      window.dispatchEvent(new Event("worldact-settings-updated"));
      await resource.reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="wrap">
      <h1>
        Themes <span className="title-count">2</span>
      </h1>
      {notice && (
        <Notice>
          {notice} <Link to="/">Visit site</Link>
        </Notice>
      )}
      {error && <Notice error>{error}</Notice>}
      <ResourceState
        loading={resource.loading}
        error={resource.error}
        retry={resource.reload}
      />
      <p>
        Choose the presentation for your public site. These React themes
        reproduce the basic layouts; the full block theme and site editor
        systems are not yet implemented.
      </p>
      <div className="theme-browser rendered">
        <div className="themes">
          {[
            { id: "twentytwentyfive", name: "Twenty Twenty-Five" },
            { id: "classic", name: "WorldAct Classic" },
          ].map((theme) => (
            <article
              className={`theme ${resource.data?.settings.theme === theme.id ? "active" : ""}`}
              key={theme.id}
            >
              <div className="theme-screenshot">
                {theme.id === "twentytwentyfive" ? (
                  <img
                    src="/vendor/wordpress/wp-content/themes/twentytwentyfive/screenshot.png"
                    alt="Twenty Twenty-Five theme preview"
                  />
                ) : (
                  <div className="classic-theme-preview">
                    <b>WorldAct</b>
                    <hr />
                    <h2>Hello world!</h2>
                    <p>Welcome to your new home on the web.</p>
                    <div />
                    <p>Thoughts, stories, and ideas.</p>
                  </div>
                )}
              </div>
              <div className="theme-id-container">
                <h2 className="theme-name">
                  {resource.data?.settings.theme === theme.id && (
                    <span>Active: </span>
                  )}
                  {theme.name}
                </h2>
                <div className="theme-actions">
                  {resource.data?.settings.theme === theme.id ? (
                    <Link
                      className="button button-primary"
                      to="/admin/settings"
                    >
                      Customize
                    </Link>
                  ) : (
                    <button
                      className="button"
                      disabled={busy}
                      onClick={() => activate(theme.id as Settings["theme"])}
                    >
                      Activate
                    </button>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      </div>
    </main>
  );
}
function Tools() {
  const { user } = useContext(Session);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  async function download() {
    setBusy(true);
    setError("");
    try {
      const [posts, pages] = await Promise.all([
        api<{ posts: Post[] }>("/posts?type=post&status=all"),
        user?.role === "author"
          ? Promise.resolve({ posts: [] as Post[] })
          : api<{ posts: Post[] }>("/posts?type=page&status=all"),
      ]);
      const url = URL.createObjectURL(
        new Blob(
          [
            JSON.stringify(
              {
                application: "WorldAct",
                version: "0.1.0",
                exportedAt: new Date().toISOString(),
                posts: posts.posts,
                pages: pages.posts,
              },
              null,
              2,
            ),
          ],
          { type: "application/json" },
        ),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `worldact-export-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      setNotice("Export downloaded.");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="wrap">
      <h1>Tools</h1>
      {error && <Notice error>{error}</Notice>}
      {notice && <Notice>{notice}</Notice>}
      <h2 className="title">Export</h2>
      <p>
        Download your accessible posts and pages as a JSON file. Media files are
        referenced by URL and are not included in the download.
      </p>
      <p>
        <button
          className="button button-primary"
          disabled={busy}
          onClick={download}
        >
          {busy ? "Preparing…" : "Download Export File"}
        </button>
      </p>
      <hr />
      <h2>Available in this version</h2>
      <p>
        WorldAct supports posts, pages, basic blocks, image uploads, comments,
        users, site settings, and two public presentation themes.
      </p>
      <p>
        WordPress PHP plugins and themes, WordPress XML imports, the complete
        site editor, revisions, taxonomies, and plugin installation are not
        supported yet.
      </p>
      <Link to="/admin/about">About WorldAct</Link>
    </main>
  );
}
function About() {
  return (
    <main className="wrap about-wrap">
      <div className="worldact-about-banner">
        <Brand />
        <h1>WorldAct 0.1.0</h1>
        <p>A familiar home for your words.</p>
      </div>
      <h2>React. PostgreSQL. Your site.</h2>
      <p>
        WorldAct is a personal CMS study that recreates familiar WordPress
        administration screens with React and a Node.js server backed by
        PostgreSQL.
      </p>
      <p>
        This first version provides working content, image, comment, user, and
        settings workflows. It is an independent rewrite, not a complete
        replacement for the WordPress ecosystem.
      </p>
      <h2>What you can do</h2>
      <ul className="ul-disc">
        <li>Create, edit, publish, and trash posts and pages.</li>
        <li>
          Compose content with paragraph, heading, list, quote, and image
          blocks.
        </li>
        <li>Upload images and edit their attachment details.</li>
        <li>Moderate reader comments and manage site users.</li>
        <li>Adjust general and reading settings and choose a public theme.</li>
      </ul>
      <h2>Still to come</h2>
      <p>
        Full Gutenberg and site editor parity, plugin compatibility, custom post
        types, taxonomies, revisions, menus, multilingual features, and the
        complete WordPress settings and extension system.
      </p>
      <p>
        WordPress visual assets and styles are used under their original
        licenses. See the repository’s notices for attribution.
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
function PublicSite({
  detail = false,
  page = false,
}: {
  detail?: boolean;
  page?: boolean;
}) {
  const { slug } = useParams(),
    { user, setUser } = useContext(Session);
  const [params, setParams] = useSearchParams();
  const requestedPage = Math.max(1, Number(params.get("page")) || 1);
  const site = useResource<{
    settings: Partial<Settings>;
    posts: Post[];
    pages: Post[];
    pagination: { page: number; totalPosts: number; totalPages: number };
  }>(`/public/site?page=${detail ? 1 : requestedPage}`);
  const [post, setPost] = useState<Post | null>(null),
    [comments, setComments] = useState<Comment[]>([]),
    [loading, setLoading] = useState(detail),
    [error, setError] = useState(""),
    [comment, setComment] = useState({
      authorName: "",
      authorEmail: "",
      content: "",
    }),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!detail || !slug) return;
    setLoading(true);
    setError("");
    setNotice("");
    api<{ post: Post; comments: Comment[] }>(
      `/public/posts/${encodeURIComponent(slug)}`,
    )
      .then((data) => {
        if (data.post.type !== (page ? "page" : "post"))
          throw new Error("This page could not be found.");
        setPost(data.post);
        setComments(data.comments);
      })
      .catch((e) => {
        setPost(null);
        setError(errorText(e));
      })
      .finally(() => setLoading(false));
  }, [detail, slug, page]);
  const settings = site.data?.settings,
    title = settings?.siteTitle || "WorldAct",
    posts = site.data?.posts || [];
  const pagination = site.data?.pagination;
  const displayDate = (value: string | null) => publicDate(value, settings);
  useEffect(() => {
    document.title = `${post && detail ? post.title : title}${post && detail ? ` – ${title}` : ""}`;
    if (settings?.discourageSearchEngines) {
      const meta = document.createElement("meta");
      meta.name = "robots";
      meta.content = "noindex,nofollow";
      document.head.appendChild(meta);
      return () => meta.remove();
    }
  }, [title, detail, post, settings?.discourageSearchEngines]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(
        "/public/comments",
        json("POST", { ...comment, postId: post?.id }),
      );
      setNotice("Your comment is awaiting moderation.");
      setComment({ authorName: "", authorEmail: "", content: "" });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    try {
      await api("/auth/logout", json("POST"));
      setUser(null);
    } catch (e) {
      setError(errorText(e));
    }
  }
  const content = (item: Post) => (
    <div
      className="public-content"
      dangerouslySetInnerHTML={{ __html: item.content }}
    />
  );
  return (
    <div
      className={`public-site ${settings?.theme === "classic" ? "classic-site" : "twentytwentyfive-site"}`}
    >
      {user && (
        <div className="public-admin-bar">
          <Link to={user.role === "subscriber" ? "/" : "/admin"}>
            <Brand />
            WorldAct
          </Link>
          {user.role !== "subscriber" && <Link to="/admin">Dashboard</Link>}
          {detail &&
            post &&
            (user.role === "administrator" ||
              user.role === "editor" ||
              (user.role === "author" &&
                post.type === "post" &&
                post.authorId === user.id)) && (
              <Link
                to={`/admin/${post.type === "page" ? "pages" : "posts"}/${post.id}`}
              >
                Edit {post.type}
              </Link>
            )}
          <Link
            className="public-howdy"
            to={user.role === "subscriber" ? "/" : "/admin"}
          >
            Howdy, {user.displayName}
          </Link>
          <button type="button" className="public-logout" onClick={logout}>
            Log Out
          </button>
        </div>
      )}
      <header className="site-header">
        <Link className="site-title" to="/">
          {title}
        </Link>
        <nav aria-label="Primary navigation">
          {site.data?.pages.map((item) => (
            <Link key={item.id} to={`/pages/${item.slug}`}>
              {item.title}
            </Link>
          ))}
          {!site.data?.pages.length && <Link to="/">Home</Link>}
        </nav>
      </header>
      <main className="site-main">
        <ResourceState
          loading={site.loading || loading}
          error={site.error || error}
          retry={site.error ? site.reload : undefined}
        />
        {detail ? (
          post && (
            <>
              <article className="single-post">
                <h1>{post.title}</h1>
                {!page && (
                  <p className="post-meta">
                    {displayDate(post.publishedAt)}
                    <span>by {post.authorName}</span>
                  </p>
                )}
                {content(post)}
              </article>
              {!page && (
                <section className="public-comments">
                  <h2>
                    {comments.length
                      ? `${comments.length} ${comments.length === 1 ? "response" : "responses"} to “${post.title}”`
                      : "Comments"}
                  </h2>
                  {comments.map((item) => (
                    <article className="public-comment" key={item.id}>
                      <div className="public-comment-avatar">
                        <Icon name="admin-users" />
                      </div>
                      <div>
                        <strong>{item.authorName}</strong>
                        <p className="comment-date">
                          {displayDate(item.createdAt)}
                        </p>
                        <div
                          dangerouslySetInnerHTML={{ __html: item.content }}
                        />
                      </div>
                    </article>
                  ))}
                  <h2>Leave a Reply</h2>
                  <p>
                    Your email address will not be published. Required fields
                    are marked *
                  </p>
                  {notice && (
                    <p role="status" className="public-comment-notice">
                      {notice}
                    </p>
                  )}
                  <form className="public-comment-form" onSubmit={submit}>
                    <label htmlFor="comment-content">Comment *</label>
                    <textarea
                      id="comment-content"
                      rows={6}
                      value={comment.content}
                      onChange={(e) =>
                        setComment({ ...comment, content: e.target.value })
                      }
                      required
                    />
                    <label htmlFor="comment-name">Name *</label>
                    <input
                      type="text"
                      id="comment-name"
                      autoComplete="name"
                      value={comment.authorName}
                      onChange={(e) =>
                        setComment({ ...comment, authorName: e.target.value })
                      }
                      required
                    />
                    <label htmlFor="comment-email">Email *</label>
                    <input
                      type="email"
                      id="comment-email"
                      autoComplete="email"
                      value={comment.authorEmail}
                      onChange={(e) =>
                        setComment({ ...comment, authorEmail: e.target.value })
                      }
                      required
                    />
                    <button disabled={busy}>
                      {busy ? "Submitting…" : "Post Comment"}
                    </button>
                  </form>
                </section>
              )}
            </>
          )
        ) : (
          <>
            <h1 className="blog-heading">Blog</h1>
            <div className="public-posts">
              {posts.map((item) => (
                <article key={item.id}>
                  <h2>
                    <Link to={`/posts/${item.slug}`}>
                      {item.title || "(no title)"}
                    </Link>
                  </h2>
                  <p className="post-meta">{displayDate(item.publishedAt)}</p>
                  {item.excerpt ? <p>{item.excerpt}</p> : content(item)}
                </article>
              ))}
              {!site.loading && !site.error && !posts.length && (
                <p>No posts yet. Check back soon.</p>
              )}
            </div>
            {pagination && pagination.totalPages > 1 && (
              <nav className="public-pagination" aria-label="Posts pagination">
                <button
                  disabled={pagination.page <= 1}
                  onClick={() => {
                    setParams({ page: String(pagination.page - 1) });
                    window.scrollTo(0, 0);
                  }}
                >
                  ← Newer posts
                </button>
                <span>
                  {pagination.page} of {pagination.totalPages}
                </span>
                <button
                  disabled={pagination.page >= pagination.totalPages}
                  onClick={() => {
                    setParams({ page: String(pagination.page + 1) });
                    window.scrollTo(0, 0);
                  }}
                >
                  Older posts →
                </button>
              </nav>
            )}
          </>
        )}
      </main>
      <footer className="site-footer">
        <div>
          <Link className="site-title" to="/">
            {title}
          </Link>
          {settings?.tagline && <p>{settings.tagline}</p>}
        </div>
        <div>
          <Link to="/">Blog</Link>
          {site.data?.pages.slice(0, 4).map((item) => (
            <Link key={item.id} to={`/pages/${item.slug}`}>
              {item.title}
            </Link>
          ))}
        </div>
        <div className="site-credit">
          <p>Designed with WorldAct</p>
          <Link to="/login">Log in</Link>
        </div>
      </footer>
    </div>
  );
}

function publicDate(
  value: string | null,
  settings?: Partial<Settings>,
): string {
  if (!value) return "—";
  const dateValue = new Date(value);
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: settings?.timezone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(dateValue);
    const part = (kind: Intl.DateTimeFormatPartTypes) =>
      parts.find((item) => item.type === kind)?.value || "";
    const year = part("year"),
      month = part("month"),
      day = part("day");
    if (settings?.dateFormat === "Y-m-d") return `${year}-${month}-${day}`;
    if (settings?.dateFormat === "m/d/Y") return `${month}/${day}/${year}`;
    if (settings?.dateFormat === "d/m/Y") return `${day}/${month}/${year}`;
    return new Intl.DateTimeFormat("en-US", {
      timeZone: settings?.timezone || "UTC",
      year: "numeric",
      month: "long",
      day: "numeric",
    }).format(dateValue);
  } catch {
    return date(value);
  }
}
