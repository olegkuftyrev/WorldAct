import {
  useContext,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Link } from "react-router-dom";
import {
  api,
  json,
  date,
  type Post,
  type Comment,
  type Settings,
} from "../api";
import {
  Session,
  Icon,
  Notice,
  ResourceState,
  ScreenTabs,
  useResource,
  errorText,
} from "../components/AdminUI";

type WidgetId = "glance" | "activity" | "draft" | "news";
type DashboardPreferences = {
  welcome?: boolean;
  dashboardWidgets?: string[];
  hiddenWidgets?: string[];
};
const widgetIds: WidgetId[] = ["glance", "activity", "draft", "news"];
const widgetLabels: Record<WidgetId, string> = {
  glance: "At a Glance",
  activity: "Activity",
  draft: "Quick Draft",
  news: "WorldAct Events and News",
};
const widgetDOMIds: Record<WidgetId, string> = {
  glance: "dashboard_right_now",
  activity: "dashboard_activity",
  draft: "dashboard_quick_press",
  news: "dashboard_primary",
};
export default function Dashboard() {
  const { user } = useContext(Session);
  const canPages = user?.role === "administrator" || user?.role === "editor";
  const site = useResource<{ settings: Partial<Settings> }>("/public/site");
  const { data, loading, error, reload } = useResource<{
    counts: Record<string, number>;
    recentPosts: Post[];
    recentComments: Comment[];
  }>("/dashboard");
  const [welcome, setWelcome] = useState(true),
    [order, setOrder] = useState<WidgetId[]>(widgetIds),
    [hidden, setHidden] = useState<WidgetId[]>([]);
  const [draftTitle, setDraftTitle] = useState(""),
    [draftContent, setDraftContent] = useState(""),
    [notice, setNotice] = useState(""),
    [saveError, setSaveError] = useState(""),
    [busy, setBusy] = useState(false),
    [preferencesLoading, setPreferencesLoading] = useState(true);
  const preferenceQueue = useRef(Promise.resolve());
  useEffect(() => {
    let cancelled = false;
    api<{ preferences: DashboardPreferences }>("/profile")
      .then(({ preferences }) => {
        if (cancelled) return;
        setWelcome(preferences.welcome !== false);
        const saved = (preferences.dashboardWidgets || []).filter(
          (id): id is WidgetId => widgetIds.includes(id as WidgetId),
        );
        setOrder([
          ...Array.from(new Set(saved)),
          ...widgetIds.filter((id) => !saved.includes(id)),
        ]);
        setHidden(
          (preferences.hiddenWidgets || []).filter((id): id is WidgetId =>
            widgetIds.includes(id as WidgetId),
          ),
        );
      })
      .catch((e) => setSaveError(errorText(e)))
      .finally(() => {
        if (!cancelled) setPreferencesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  async function persist(patch: DashboardPreferences) {
    preferenceQueue.current = preferenceQueue.current.then(async () => {
      try {
        await api("/preferences", json("PUT", patch));
      } catch (e) {
        setSaveError(
          `Your dashboard preferences could not be saved: ${errorText(e)}`,
        );
      }
    });
    await preferenceQueue.current;
  }
  function toggle(id: WidgetId, visible: boolean) {
    const next = visible
      ? hidden.filter((item) => item !== id)
      : [...hidden, id];
    setHidden(next);
    void persist({ hiddenWidgets: next });
  }
  function move(id: WidgetId, direction: -1 | 1) {
    const next = [...order],
      index = next.indexOf(id),
      target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setOrder(next);
    void persist({ dashboardWidgets: next });
  }
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
  const widgetContent: Record<WidgetId, ReactNode> = {
    glance: (
      <>
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
                    {data?.counts.comments === 1 ? "Comment" : "Comments"}
                  </Link>
                </li>
              </>
            )}
          </ul>
          <p>
            WorldAct 0.2.0 running{" "}
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
      </>
    ),
    activity: (
      <>
        <div id="activity-widget">
          <h3>Recently Published</h3>
          {data?.recentPosts.filter(
            (post) => post.type === "post" && post.status === "publish",
          ).length ? (
            <ul className="activity-posts">
              {data.recentPosts
                .filter(
                  (post) => post.type === "post" && post.status === "publish",
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
                      {comment.content.replace(/<[^>]+>/g, "").slice(0, 120)}
                    </p>
                    <Link to="/admin/comments">Moderate comments</Link>
                  </div>
                </div>
              ))
            ) : (
              <p>No comments yet.</p>
            ))}
        </div>
      </>
    ),
    draft: (
      <>
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
            <label htmlFor="quick-content" className="screen-reader-text">
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
                  (post) => post.type === "post" && post.status === "draft",
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
      </>
    ),
    news: (
      <>
        <p>Welcome to your personal WorldAct site.</p>
        <p>
          This local study project runs on React and PostgreSQL.{" "}
          <Link to="/admin/about">See what is available in this version.</Link>
        </p>
        <p>
          <Link to="/">
            View your site <span aria-hidden="true">↗</span>
          </Link>
        </p>
      </>
    ),
  };
  const visible = order.filter((id) => !hidden.includes(id));
  const renderWidget = (id: WidgetId) => (
    <DashboardWidget
      key={id}
      id={widgetDOMIds[id]}
      title={widgetLabels[id]}
      userId={user?.id || 0}
      canMoveUp={order.indexOf(id) > 0}
      canMoveDown={order.indexOf(id) < order.length - 1}
      moveUp={() => move(id, -1)}
      moveDown={() => move(id, 1)}
    >
      {widgetContent[id]}
    </DashboardWidget>
  );
  return (
    <>
      <ScreenTabs>
        <fieldset
          className="dashboard-screen-options"
          disabled={preferencesLoading}
        >
          <legend>Screen elements</legend>
          {widgetIds.map((id) => (
            <label key={id}>
              <input
                type="checkbox"
                checked={!hidden.includes(id)}
                onChange={(e) => toggle(id, e.target.checked)}
              />{" "}
              {widgetLabels[id]}
            </label>
          ))}
          <label>
            <input
              type="checkbox"
              checked={welcome}
              onChange={(e) => {
                setWelcome(e.target.checked);
                void persist({ welcome: e.target.checked });
              }}
            />{" "}
            Welcome
          </label>
          <p>
            Use the arrow buttons in each widget heading to change its position.
          </p>
        </fieldset>
      </ScreenTabs>
      <main className="wrap dashboard-wrap">
        <h1>Dashboard</h1>
        <ResourceState loading={loading} error={error} retry={reload} />
        {notice && <Notice onDismiss={() => setNotice("")}>{notice}</Notice>}
        {saveError && (
          <Notice error onDismiss={() => setSaveError("")}>
            {saveError}
          </Notice>
        )}
        {welcome && (
          <div id="welcome-panel" className="welcome-panel">
            <button
              className="welcome-panel-close button-link"
              onClick={() => {
                setWelcome(false);
                void persist({ welcome: false });
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
                      Learn more about the 0.2.0 version.
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
                {visible.slice(0, 2).map(renderWidget)}
              </div>
            </div>
            <div className="postbox-container">
              <div className="meta-box-sortables">
                {visible.slice(2).map(renderWidget)}
              </div>
            </div>
            <div className="postbox-container empty-column">
              <div className="meta-box-sortables">
                <div className="empty-container" />
              </div>
            </div>
          </div>
          {!visible.length && (
            <p>
              No dashboard widgets selected. Choose widgets in Screen Options.
            </p>
          )}
        </div>
      </main>
    </>
  );
}
function DashboardWidget({
  id,
  title,
  userId,
  canMoveUp,
  canMoveDown,
  moveUp,
  moveDown,
  children,
}: {
  id: string;
  title: string;
  userId: number;
  canMoveUp: boolean;
  canMoveDown: boolean;
  moveUp: () => void;
  moveDown: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(
    () => localStorage.getItem(`worldact-widget-${userId}-${id}`) !== "closed",
  );
  return (
    <section id={id} className={`postbox ${open ? "" : "closed"}`}>
      <div className="postbox-header">
        <h2 className="hndle">{title}</h2>
        <div className="handle-actions">
          <button
            className="dashboard-move-widget"
            aria-label={`Move ${title} up`}
            disabled={!canMoveUp}
            onClick={moveUp}
          >
            <Icon name="arrow-up-alt2" />
          </button>
          <button
            className="dashboard-move-widget"
            aria-label={`Move ${title} down`}
            disabled={!canMoveDown}
            onClick={moveDown}
          >
            <Icon name="arrow-down-alt2" />
          </button>
          <button
            className="handlediv"
            aria-expanded={open}
            aria-label={`${open ? "Collapse" : "Expand"} ${title}`}
            onClick={() => {
              setOpen(!open);
              localStorage.setItem(
                `worldact-widget-${userId}-${id}`,
                open ? "closed" : "open",
              );
            }}
          >
            <span className="toggle-indicator" />
          </button>
        </div>
      </div>
      {open && <div className="inside">{children}</div>}
    </section>
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
