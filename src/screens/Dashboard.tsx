import {
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Link, useLocation } from "react-router-dom";
import {
  api,
  json,
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
import { dashboardActivityDate, dashboardDraftDate } from "../dashboardDates";
import { decodeEntities } from "@wordpress/html-entities";

type DashboardEntry = Pick<Post, "id" | "title" | "publishedAt" | "createdAt" | "updatedAt" | "scheduledAt"> & { permalink: string; canEdit: boolean; preview?: string };
type DashboardComment = Comment & { type?: "comment" | "pingback" | "trackback"; canEdit: boolean; postPermalink: string };
type DashboardData = {
  counts: Record<string, number>;
  recentPublished: DashboardEntry[];
  publishingSoon: DashboardEntry[];
  recentDrafts: DashboardEntry[];
  recentComments: DashboardComment[];
  application: { name: string; version: string };
  theme: { id: string; name: string; version: string };
};

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
  const route = useLocation();
  const actor = user ? `${user.id}:${user.role}` : "anonymous";
  const scopeRef = useRef({ actor, key: route.key, active: true });
  if (scopeRef.current.actor !== actor || scopeRef.current.key !== route.key) {
    scopeRef.current.active = false;
    scopeRef.current = { actor, key: route.key, active: true };
  }
  const scope = scopeRef.current;
  const isCurrent = () => scope.active && scopeRef.current === scope;
  const canPages = user?.role === "administrator" || user?.role === "editor";
  const site = useResource<{ settings: Partial<Settings> & { showAvatars?: boolean } }>("/public/site");
  const { data, loading, error, reload, setData } = useResource<DashboardData>("/dashboard");
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
  const draftRevision = useRef(0);
  const draftOperation = useRef<symbol | null>(null);
  const draftActor = useRef(actor);
  const resourceScope = useRef(scope);
  const moveFocus = useRef<{ id: WidgetId; direction: -1 | 1 } | null>(null);
  useLayoutEffect(() => {
    scope.active = true;
    draftOperation.current = null;
    setBusy(false); setNotice(""); setSaveError("");
    if (draftActor.current !== actor) {
      draftActor.current = actor; draftRevision.current++;
      setDraftTitle(""); setDraftContent("");
      setData(null); site.setData(null);
    }
    if (resourceScope.current !== scope) {
      resourceScope.current = scope;
      // Retire an already-started dashboard reload when history changes while
      // this screen stays mounted; its old response cannot win a new opening.
      void reload(); void site.reload();
    }
    return () => { scope.active = false; };
  }, [scope]);
  useEffect(() => {
    let cancelled = false;
    setPreferencesLoading(true);
    api<{ preferences: DashboardPreferences }>("/profile")
      .then(({ preferences }) => {
        if (cancelled || !isCurrent()) return;
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
      .catch((e) => { if (!cancelled && isCurrent()) setSaveError(errorText(e)); })
      .finally(() => {
        if (!cancelled) setPreferencesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scope]);
  async function persist(patch: DashboardPreferences) {
    preferenceQueue.current = preferenceQueue.current.then(async () => {
      if (!isCurrent()) return;
      try {
        await api("/preferences", json("PUT", patch));
      } catch (e) {
        if (isCurrent()) setSaveError(
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
    moveFocus.current = { id, direction };
    setOrder(next);
    void persist({ dashboardWidgets: next });
  }
  useLayoutEffect(() => {
    const moved = moveFocus.current;
    if (!moved) return;
    const widget = document.getElementById(widgetDOMIds[moved.id]);
    const buttons = widget?.querySelectorAll<HTMLButtonElement>(".dashboard-move-widget");
    const preferred = buttons?.[moved.direction === -1 ? 0 : 1], fallback = buttons?.[moved.direction === -1 ? 1 : 0];
    (preferred && !preferred.disabled ? preferred : fallback)?.focus();
    moveFocus.current = null;
  }, [order]);
  async function saveDraft(event: FormEvent) {
    event.preventDefault();
    if (draftOperation.current || !isCurrent()) return;
    const operation = Symbol("quick-draft");
    draftOperation.current = operation;
    const submittedRevision = draftRevision.current;
    setBusy(true);
    setSaveError("");
    setNotice("");
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
      if (!isCurrent()) return;
      setNotice("Draft saved.");
      if (draftRevision.current === submittedRevision) {
        draftRevision.current++;
        setDraftTitle("");
        setDraftContent("");
      }
      await reload();
    } catch (e) {
      if (isCurrent()) setSaveError(errorText(e));
    } finally {
      if (isCurrent() && draftOperation.current === operation) {
        draftOperation.current = null;
        setBusy(false);
      }
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
            {data?.application.name || "WorldAct"}{data ? ` ${data.application.version} running ` : ""}
            {user?.role === "administrator" ? (
              <Link to="/admin/appearance">
                {data?.theme.name}
              </Link>
            ) : (
              <span>{data?.theme.name}</span>
            )}{" "}
            {data ? "theme." : ""}
          </p>
        </div>
      </>
    ),
    activity: (
      <>
        <div id="activity-widget">
          <ActivityPosts id="future-posts" title="Publishing Soon" posts={data?.publishingSoon || []} future settings={site.data?.settings} />
          <ActivityPosts id="published-posts" title="Recently Published" posts={data?.recentPublished || []} settings={site.data?.settings} />
          {Boolean(data?.recentComments.length) && <div id="latest-comments" className="activity-block table-view-list">
            <h3>Recent Comments</h3>
            <ul id="the-comment-list">
              {data!.recentComments.map(comment => {
                const human = !comment.type || comment.type === "comment";
                return <li className={`dashboard-comment comment-item ${human ? "comment" : comment.type} ${comment.status === "pending" ? "unapproved" : comment.status}`} key={comment.id}>
                  {human && site.data?.settings.showAvatars !== false && <span className="comment-avatar"><Icon name="admin-users" /></span>}
                  <div className="dashboard-comment-wrap">
                    <p className="comment-meta">
                      {human ? <>From <strong>{comment.authorName}</strong></> : <strong>{comment.type === "pingback" ? "Pingback" : "Trackback"}</strong>} on{" "}
                      <Link to={comment.postPermalink}>{comment.postTitle || "(no title)"}</Link>
                      {comment.status === "pending" && <span className="approve"> [Pending]</span>}
                    </p>
                    {!human && <p className="comment-author">{comment.authorName}</p>}
                    <blockquote><p>{decodeEntities(comment.content.replace(/<[^>]+>/g, "")).slice(0, 120)}</p></blockquote>
                    {comment.canEdit && <p className="row-actions"><Link to={`/admin/comments?postId=${comment.postId}${human ? "" : "&type=pings"}`}>Moderate comments</Link></p>}
                  </div>
                </li>;
              })}
            </ul>
          </div>}
          {data && !data.publishingSoon.length && !data.recentPublished.length && !data.recentComments.length && <div className="no-activity"><p>No activity yet!</p></div>}
        </div>
      </>
    ),
    draft: (
      <>
        <form id="quick-press" onSubmit={saveDraft}>
          <div className="input-text-wrap">
            <label htmlFor="quick-title">Title</label>
            <input
              type="text"
              id="quick-title"
              value={draftTitle}
              onChange={(e) => { draftRevision.current++; setDraftTitle(e.target.value); }}
              required
            />
          </div>
          <div className="textarea-wrap" id="description-wrap">
            <label htmlFor="quick-content">
              Content
            </label>
            <textarea
              id="quick-content"
              placeholder="What’s on your mind?"
              value={draftContent}
              onChange={(e) => { draftRevision.current++; setDraftContent(e.target.value); }}
              rows={4}
            />
          </div>
          <p className="submit">
            <button className="button button-primary" disabled={busy}>
              {busy ? "Saving…" : "Save Draft"}
            </button>
          </p>
        </form>
        {Boolean(data?.recentDrafts.length) && (
          <div className="drafts">
            {data!.recentDrafts.length > 3 && <p className="view-all"><Link to={`/admin/posts?status=draft&author=${user!.id}`}>View all drafts</Link></p>}
            <h2>Your Recent Drafts</h2>
            <ul>
              {data!.recentDrafts
                .slice(0, 3)
                .map((post) => (
                  <li key={post.id}>
                    <div className="draft-title"><Link to={`/admin/posts/${post.id}`} aria-label={`Edit “${post.title || "(no title)"}”`}>
                      {post.title || "(no title)"}
                    </Link>{" "}
                    <time dateTime={post.updatedAt}>{site.data && dashboardDraftDate(post.updatedAt, site.data.settings.timezone)}</time></div>
                    {post.preview && <p className="draft-content">{post.preview}</p>}
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
                      {data ? `Learn more about the ${data.application.version} version.` : "Learn more about WorldAct."}
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
function ActivityPosts({ id, title, posts, future = false, settings }: { id: string; title: string; posts: DashboardEntry[]; future?: boolean; settings?: Partial<Settings> }) {
  if (!posts.length) return null;
  return <div id={id} className="activity-block">
    <h3>{title}</h3>
    <ul>{posts.map(post => <li key={post.id}>
      <span>{settings && dashboardActivityDate(future ? post.scheduledAt : post.publishedAt || post.createdAt, settings)}</span>{" "}
      <Link to={post.canEdit ? `/admin/posts/${post.id}` : post.permalink} aria-label={`${post.canEdit ? "Edit" : "View"} “${post.title || "(no title)"}”`}>{post.title || "(no title)"}</Link>
    </li>)}</ul>
  </div>;
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
