import { renderTemplate } from "../template";
import { parseVideoEmbed } from "../embeds";
import "@wordpress/block-library/build-style/style.css";
import "@wordpress/block-library/build-style/theme.css";
import {
  useContext,
  useEffect,
  useState,
  type FormEvent,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  Link,
  useLocation,
  useParams,
  useSearchParams,
} from "react-router-dom";
import {
  api,
  json,
  date,
  type Post,
  type Comment,
  type Settings,
  type NavigationMenu,
  type NavigationItem,
  type SiteStyle,
  type SiteTemplate,
} from "../api";
import "./public.css";
import { postLink } from "../publicLinks";
import {
  Session,
  Brand,
  Icon,
  errorText,
  useResource,
  ResourceState,
} from "../components/AdminUI";

export default function PublicSite({
  detail = false,
  page = false,
  preview = false,
  slugOverride,
  archive,
}: {
  detail?: boolean;
  page?: boolean;
  preview?: boolean;
  slugOverride?: string;
  archive?: { taxonomy: "category" | "tag"; slug: string; name?: string };
}) {
  const { slug: routeSlug, id: previewId } = useParams(),
    { user, setUser } = useContext(Session);
  const slug = slugOverride || routeSlug;
  const [params, setParams] = useSearchParams();
  const categoryFilter =
    archive?.taxonomy === "category" ? archive.slug : params.get("category");
  const tagFilter =
    archive?.taxonomy === "tag" ? archive.slug : params.get("tag");
  const requestedPage = Math.max(1, Number(params.get("page")) || 1);
  const commentPage = Math.max(1, Number(params.get("commentPage")) || 1);
  const blockQuery = new URLSearchParams(
    [...params.entries()].filter(([name]) => /^query-\d+-page$/.test(name)),
  ).toString();
  const publicQuery = new URLSearchParams({
    page: String(detail ? 1 : requestedPage),
  });
  for (const [key, value] of [
    ["search", params.get("search")],
    ["category", categoryFilter],
    ["tag", tagFilter],
    ["author", params.get("author")],
  ])
    if (value) publicQuery.set(key!, value);
  for (const [key, value] of new URLSearchParams(blockQuery))
    publicQuery.set(key, value);
  const design = useResource<PublicDesign>("/public/design");
  const site = useResource<{
    settings: Partial<Settings>;
    archive?: { type: "author"; name: string; authorId: number } | null;
    posts: Post[];
    pages: Post[];
    frontPage: Post | null;
    postsPage: Post | null;
    pagination: { page: number; totalPosts: number; totalPages: number };
  }>(`/public/site?${publicQuery}`);
  const [commentsPagination, setCommentsPagination] =
    useState<CommentPagination | null>(null);
  const [reply, setReply] = useState<{ id: number; name: string } | null>(null);
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
    [busy, setBusy] = useState(false),
    [password, setPassword] = useState(""),
    [publicSearch, setPublicSearch] = useState(params.get("search") || "");
  useEffect(() => {
    if (!detail || (!slug && !previewId)) return;
    setLoading(true);
    setError("");
    setNotice("");
    setPost(null);
    setPassword("");
    setReply(null);
    api<{
      post: Post;
      comments: Comment[];
      commentsPagination?: CommentPagination;
    }>(
      preview
        ? `/posts/${previewId}/preview${blockQuery ? "?" + blockQuery : ""}`
        : `/public/posts/${encodeURIComponent(slug!)}?commentPage=${commentPage}${blockQuery ? "&" + blockQuery : ""}`,
    )
      .then((data) => {
        if (!preview && data.post.type !== (page ? "page" : "post"))
          throw new Error("This page could not be found.");
        setPost(data.post);
        setComments(data.comments);
        setCommentsPagination(data.commentsPagination || null);
      })
      .catch((e) => {
        setPost(null);
        setError(errorText(e));
      })
      .finally(() => setLoading(false));
  }, [detail, slug, page, preview, previewId, commentPage, blockQuery]);
  const settings = site.data?.settings,
    title = settings?.siteTitle || "WorldAct",
    posts = site.data?.posts || [];
  useEffect(() => {
    const href = site.data?.settings.siteIconUrl;
    if (!href) return;
    let url: URL;
    try {
      url = new URL(href, window.location.origin);
    } catch {
      return;
    }
    if (!["http:", "https:"].includes(url.protocol)) return;
    const link = document.createElement("link");
    link.rel = "icon";
    link.href = url.href;
    link.dataset.worldactIcon = "true";
    document.head.appendChild(link);
    return () => link.remove();
  }, [site.data?.settings.siteIconUrl]);
  const pagination = site.data?.pagination;
  const hasArchiveFilter = Boolean(
    params.get("search") ||
    categoryFilter ||
    tagFilter ||
    params.get("author") ||
    params.get("page"),
  );
  const frontPage = !detail && !hasArchiveFilter ? site.data?.frontPage : null;
  const isPostsPage = detail && post?.id === site.data?.postsPage?.id;
  const displaySingle = (detail && !isPostsPage) || Boolean(frontPage);
  const displayedPost = frontPage || post;
  const primaryMenu = design.data?.menus.find(
    (menu) => menu.location === "primary",
  );
  const footerMenu = design.data?.menus.find(
    (menu) => menu.location === "footer",
  );
  const customHeader = customDocument(design.data?.parts, "header");
  const customFooter = customDocument(design.data?.parts, "footer");
  const customSingle = customDocument(
    design.data?.templates,
    displayedPost?.type === "page" ? "page" : "single",
  );
  const customIndex = customDocument(design.data?.templates, "index");
  const enabledPlugin = (slug: string) =>
    design.data?.plugins.find((plugin) => plugin.slug === slug);
  const readTime = (item: Post) => {
    const plugin = enabledPlugin("reading-time");
    if (!plugin || item.locked) return null;
    const words = item.content
      .replace(/<[^>]*>/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean).length;
    return Math.max(
      1,
      Math.ceil(
        words / Math.max(50, Number(plugin.settings.wordsPerMinute) || 200),
      ),
    );
  };
  const style = design.data?.styles;
  const globalStyle = {
    "--worldact-background": style?.backgroundColor,
    "--worldact-text": style?.textColor,
    "--worldact-accent": style?.accentColor,
    "--worldact-font": fontStack(style?.fontFamily),
    "--worldact-heading-font": fontStack(style?.headingFont),
    "--worldact-width": style?.contentWidth
      ? `${style.contentWidth}px`
      : undefined,
    "--worldact-spacing": style?.spacing ? `${style.spacing}px` : undefined,
  } as CSSProperties;
  const templateValues = (item?: Post) => ({
    siteTitle: title,
    tagline: settings?.tagline || "",
    navigation: primaryMenu
      ? navigationHTML(primaryMenu.items)
      : site.data?.pages
          .map(
            (page) =>
              `<a href="${escapeHTML(postLink(page))}">${escapeHTML(page.title)}</a>`,
          )
          .join("") || '<a href="/">Home</a>',
    postTitle: item?.title || "",
    postDate: item ? displayDate(item.publishedAt) : "",
    postAuthor: item?.authorName || "",
    content: item?.content || "",
    postList: posts
      .map(
        (post) =>
          `<article class="format-${escapeHTML(post.format || "standard")}"><h2><a href="${escapeHTML(postLink(post))}">${escapeHTML(post.title)}</a></h2><p class="post-meta">${escapeHTML(displayDate(post.publishedAt))}</p>${post.locked ? "<p>This content is password protected.</p>" : post.excerpt ? `<p>${escapeHTML(post.excerpt)}</p>` : post.content}</article>`,
      )
      .join(""),
  });
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
  useEffect(() => {
    const plugin = design.data?.plugins.find(
      (item) => item.slug === "site-seo",
    );
    if (!plugin) return;
    const text =
      post && !post.locked
        ? (
            post.excerpt ||
            new DOMParser().parseFromString(post.content, "text/html").body
              .textContent ||
            ""
          ).slice(0, 300)
        : String(plugin.settings.description || settings?.tagline || "");
    const image =
      post && !post.locked
        ? post.featuredMedia?.url || String(plugin.settings.siteImage || "")
        : String(plugin.settings.siteImage || "");
    const entries: [[string, string], ...Array<[string, string]>] = [
      ["description", text],
      ["og:title", post?.title || title],
      ["og:description", text],
      ["og:type", detail ? "article" : "website"],
      ["og:url", window.location.href],
    ];
    if (image)
      entries.push(["og:image", new URL(image, window.location.origin).href]);
    const nodes = entries.map(([name, content]) => {
      const node = document.createElement("meta");
      node.setAttribute(name.startsWith("og:") ? "property" : "name", name);
      node.content = content;
      node.dataset.worldact = "seo";
      document.head.appendChild(node);
      return node;
    });
    return () => nodes.forEach((node) => node.remove());
  }, [design.data, post, settings?.tagline, title, detail]);
  useEffect(() => {
    for (const wrapper of document.querySelectorAll<HTMLElement>(
      ".public-site .wp-block-embed__wrapper",
    )) {
      if (wrapper.querySelector("iframe")) continue;
      const embed = parseVideoEmbed((wrapper.textContent || "").trim());
      if (!embed) continue;
      const frame = document.createElement("iframe");
      frame.src = embed.src;
      frame.title = embed.title;
      frame.width = String(embed.width);
      frame.height = String(embed.height);
      frame.allowFullscreen = true;
      frame.loading = "lazy";
      frame.referrerPolicy = "strict-origin-when-cross-origin";
      frame.allow = "encrypted-media; picture-in-picture";
      wrapper.replaceChildren(frame);
    }
  }, [post, site.data, design.data]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api<{ comment: { id: number; status: string } }>(
        "/public/comments",
        json("POST", {
          ...comment,
          postId: post?.id,
          parentId: reply?.id || null,
        }),
      );
      setNotice(
        result.comment.status === "approved"
          ? "Your comment has been published."
          : "Your comment is awaiting moderation.",
      );
      setReply(null);
      if (result.comment.status === "approved" && post) {
        const data = await api<{
          comments: Comment[];
          commentsPagination: CommentPagination;
        }>(
          `/public/posts/${encodeURIComponent(post.slug)}?commentPage=${commentPage}${blockQuery ? "&" + blockQuery : ""}`,
        );
        setComments(data.comments);
        setCommentsPagination(data.commentsPagination);
      }
      setComment({ authorName: "", authorEmail: "", content: "" });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function unlock(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const data = await api<{
        post: Post;
        comments: Comment[];
        commentsPagination?: CommentPagination;
      }>(
        `/public/posts/${encodeURIComponent(post?.slug || slug || "")}/unlock${blockQuery ? "?" + blockQuery : ""}`,
        json("POST", { password }),
      );
      setPost(data.post);
      setComments(data.comments);
      setCommentsPagination(data.commentsPagination || null);
      setPassword("");
    } catch (error) {
      setError(errorText(error));
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
      className={`public-site ${settings?.theme === "classic" ? "classic-site" : `${settings?.theme || "twentytwentyfive"}-site`}`}
      style={globalStyle}
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
              (["author", "contributor"].includes(user.role) &&
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
      {customHeader ? (
        <RenderedTemplate
          document={customHeader}
          postId={displayedPost?.locked ? undefined : displayedPost?.id}
          query={publicQuery.toString()}
          className="custom-template-part"
          fallback={renderTemplate(customHeader.content, templateValues())}
          preview={preview}
        />
      ) : (
        <header className="site-header">
          <Link className="site-title" to="/">
            {title}
          </Link>
          <nav aria-label="Primary navigation">
            {primaryMenu ? (
              <Navigation items={primaryMenu.items} />
            ) : (
              site.data?.pages.map((item) => (
                <Link key={item.id} to={postLink(item)}>
                  {item.title}
                </Link>
              ))
            )}
            {!primaryMenu && !site.data?.pages.length && (
              <Link to="/">Home</Link>
            )}
          </nav>
        </header>
      )}
      <main className="site-main">
        <ResourceState
          loading={site.loading || loading}
          error={site.error || error}
          retry={site.error ? site.reload : undefined}
        />
        {displaySingle ? (
          displayedPost &&
          ((post) => (
            <>
              {customSingle && !post.locked ? (
                <RenderedTemplate
                  document={customSingle}
                  postId={post.id}
                  query={publicQuery.toString()}
                  className={`custom-post-template format-${post.format || "standard"}`}
                  fallback={renderTemplate(
                    customSingle.content,
                    templateValues(post),
                  )}
                  preview={preview}
                />
              ) : (
                <article
                  className={`single-post format-${post.format || "standard"}`}
                >
                  <h1>{post.title}</h1>
                  {post.type === "post" && (
                    <p className="post-meta">
                      {displayDate(post.publishedAt)}
                      <span>by {post.authorName}</span>
                      {readTime(post) && <span>{readTime(post)} min read</span>}
                    </p>
                  )}
                  {preview && (
                    <p className="public-comment-notice" role="status">
                      Preview ·{" "}
                      {post.status === "publish"
                        ? "Published"
                        : post.status === "future"
                          ? "Scheduled"
                          : "Unpublished"}{" "}
                      content
                    </p>
                  )}
                  {post.locked ? (
                    <form className="password-protected-form" onSubmit={unlock}>
                      <p>
                        This content is password protected. To view it please
                        enter your password below:
                      </p>
                      <label htmlFor="post-password">Password</label>
                      <input
                        type="password"
                        id="post-password"
                        autoComplete="current-password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        required
                      />
                      <button disabled={busy}>
                        {busy ? "Unlocking…" : "Enter"}
                      </button>
                    </form>
                  ) : (
                    <>
                      {post.featuredMedia && (
                        <img
                          className="public-featured-image"
                          src={post.featuredMedia.url}
                          alt={post.featuredMedia.alt || ""}
                        />
                      )}{" "}
                      {content(post)}
                      {post.terms?.length > 0 && (
                        <nav
                          className="public-term-links"
                          aria-label="Post categories and tags"
                        >
                          {post.terms.map((term) => (
                            <Link
                              key={term.id}
                              to={`/?${term.taxonomy}=${encodeURIComponent(term.slug)}`}
                            >
                              {term.name}
                            </Link>
                          ))}
                        </nav>
                      )}
                    </>
                  )}
                </article>
              )}
              {!post.locked && !preview && detail && (
                <section className="public-comments">
                  <h2>
                    {comments.length
                      ? `${comments.length} ${comments.length === 1 ? "response" : "responses"} to “${post.title}”`
                      : "Comments"}
                  </h2>
                  <CommentThread
                    comments={comments}
                    displayDate={displayDate}
                    threaded={settings?.threadComments !== false}
                    maxDepth={settings?.threadDepth || 5}
                    canReply={commentsOpen(post, settings)}
                    onReply={(item) => {
                      setReply({ id: item.id, name: item.authorName });
                      document
                        .getElementById("comment-reply-title")
                        ?.scrollIntoView({ block: "center" });
                    }}
                  />
                  {commentsPagination && commentsPagination.totalPages > 1 && (
                    <nav
                      className="public-pagination"
                      aria-label="Comments pagination"
                    >
                      <button
                        disabled={commentsPagination.page <= 1}
                        onClick={() => {
                          const next = new URLSearchParams(params);
                          next.set(
                            "commentPage",
                            String(commentsPagination.page - 1),
                          );
                          setParams(next);
                        }}
                      >
                        ← Previous comments
                      </button>
                      <span>
                        {commentsPagination.page} of{" "}
                        {commentsPagination.totalPages}
                      </span>
                      <button
                        disabled={
                          commentsPagination.page >=
                          commentsPagination.totalPages
                        }
                        onClick={() => {
                          const next = new URLSearchParams(params);
                          next.set(
                            "commentPage",
                            String(commentsPagination.page + 1),
                          );
                          setParams(next);
                        }}
                      >
                        Next comments →
                      </button>
                    </nav>
                  )}
                  {commentsOpen(post, settings) ? (
                    settings?.commentRegistration && !user ? (
                      <p>
                        You must be <Link to="/login">logged in</Link> to post a
                        comment.
                      </p>
                    ) : (
                      <>
                        <h2 id="comment-reply-title">
                          {reply
                            ? `Leave a Reply to ${reply.name}`
                            : "Leave a Reply"}
                        </h2>
                        {reply && (
                          <button
                            type="button"
                            className="button-link public-cancel-reply"
                            onClick={() => setReply(null)}
                          >
                            Cancel reply
                          </button>
                        )}
                        <p>
                          {user
                            ? `Logged in as ${user.displayName}.`
                            : settings?.requireCommentNameEmail !== false
                              ? "Your email address will not be published. Required fields are marked *"
                              : "Your email address will not be published."}
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
                              setComment({
                                ...comment,
                                content: e.target.value,
                              })
                            }
                            required
                          />
                          {!user && (
                            <>
                              <label htmlFor="comment-name">
                                Name{" "}
                                {settings?.requireCommentNameEmail !== false
                                  ? "*"
                                  : ""}
                              </label>
                              <input
                                type="text"
                                id="comment-name"
                                autoComplete="name"
                                value={comment.authorName}
                                onChange={(e) =>
                                  setComment({
                                    ...comment,
                                    authorName: e.target.value,
                                  })
                                }
                                required={
                                  settings?.requireCommentNameEmail !== false
                                }
                              />
                              <label htmlFor="comment-email">
                                Email{" "}
                                {settings?.requireCommentNameEmail !== false
                                  ? "*"
                                  : ""}
                              </label>
                              <input
                                type="email"
                                id="comment-email"
                                autoComplete="email"
                                value={comment.authorEmail}
                                onChange={(e) =>
                                  setComment({
                                    ...comment,
                                    authorEmail: e.target.value,
                                  })
                                }
                                required={
                                  settings?.requireCommentNameEmail !== false
                                }
                              />
                            </>
                          )}
                          <button disabled={busy}>
                            {busy ? "Submitting…" : "Post Comment"}
                          </button>
                        </form>
                      </>
                    )
                  ) : (
                    <p>Comments are closed.</p>
                  )}
                </section>
              )}
            </>
          ))(displayedPost)
        ) : (
          <>
            {customIndex ? (
              <RenderedTemplate
                document={customIndex}
                query={publicQuery.toString()}
                className="custom-index-template"
                fallback={renderTemplate(customIndex.content, templateValues())}
                preview={preview}
              />
            ) : (
              <>
                <h1 className="blog-heading">
                  {params.get("search")
                    ? `Search results for: ${params.get("search")}`
                    : categoryFilter
                      ? `Category: ${archive?.name || categoryFilter}`
                      : tagFilter
                        ? `Tag: ${archive?.name || tagFilter}`
                        : params.get("author")
                          ? `Author: ${site.data?.archive?.name || "Posts"}`
                          : isPostsPage
                            ? post?.title || "Blog"
                            : "Blog"}
                </h1>
                <form
                  className="public-search-form"
                  role="search"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const next = new URLSearchParams(params);
                    next.delete("page");
                    publicSearch.trim()
                      ? next.set("search", publicSearch.trim())
                      : next.delete("search");
                    setParams(next);
                  }}
                >
                  <label className="screen-reader-text" htmlFor="public-search">
                    Search posts
                  </label>
                  <input
                    id="public-search"
                    type="search"
                    placeholder="Search…"
                    value={publicSearch}
                    onChange={(e) => setPublicSearch(e.target.value)}
                  />
                  <button>Search</button>
                  {(params.get("search") ||
                    categoryFilter ||
                    tagFilter ||
                    params.get("author")) && <Link to="/">Show all posts</Link>}
                </form>
                <div className="public-posts">
                  {posts.map((item) => (
                    <article
                      className={`format-${item.format || "standard"}`}
                      key={item.id}
                    >
                      <h2>
                        <Link to={postLink(item)}>
                          {item.title || "(no title)"}
                        </Link>
                      </h2>
                      <p className="post-meta">
                        {displayDate(item.publishedAt)}
                        {readTime(item) && (
                          <span>{readTime(item)} min read</span>
                        )}
                      </p>
                      {item.featuredMedia && !item.locked && (
                        <img
                          className="public-featured-image"
                          src={item.featuredMedia.url}
                          alt={item.featuredMedia.alt || ""}
                        />
                      )}
                      {item.locked ? (
                        <p>
                          This content is password protected.{" "}
                          <Link to={postLink(item)}>
                            Enter the password to read it.
                          </Link>
                        </p>
                      ) : item.excerpt ? (
                        <p>{item.excerpt}</p>
                      ) : (
                        content(item)
                      )}
                    </article>
                  ))}
                  {!site.loading && !site.error && !posts.length && (
                    <p>No posts yet. Check back soon.</p>
                  )}
                </div>
              </>
            )}
            {pagination && pagination.totalPages > 1 && (
              <nav className="public-pagination" aria-label="Posts pagination">
                <button
                  disabled={pagination.page <= 1}
                  onClick={() => {
                    const next = new URLSearchParams(params);
                    next.set("page", String(pagination.page - 1));
                    setParams(next);
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
                    const next = new URLSearchParams(params);
                    next.set("page", String(pagination.page + 1));
                    setParams(next);
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
      {customFooter ? (
        <RenderedTemplate
          document={customFooter}
          postId={displayedPost?.locked ? undefined : displayedPost?.id}
          query={publicQuery.toString()}
          className="custom-template-part"
          fallback={renderTemplate(customFooter.content, {
            ...templateValues(),
            navigation: footerMenu ? navigationHTML(footerMenu.items) : "",
          })}
          preview={preview}
        />
      ) : (
        <footer className="site-footer">
          <div>
            <Link className="site-title" to="/">
              {title}
            </Link>
            {settings?.tagline && <p>{settings.tagline}</p>}
          </div>
          <div>
            {footerMenu ? (
              <nav aria-label="Footer navigation">
                <Navigation items={footerMenu.items} />
              </nav>
            ) : (
              <>
                <Link to="/">Blog</Link>
                {site.data?.pages.slice(0, 4).map((item) => (
                  <Link key={item.id} to={postLink(item)}>
                    {item.title}
                  </Link>
                ))}
              </>
            )}
          </div>
          <div className="site-credit">
            <p>Designed with WorldAct</p>
            <Link to="/login">Log in</Link>
          </div>
        </footer>
      )}
      {enabledPlugin("custom-footer") && (
        <div className="public-extension-footer">
          {String(enabledPlugin("custom-footer")?.settings.text || "")}
        </div>
      )}
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

type PublicDesign = {
  styles: Partial<SiteStyle>;
  templates: SiteTemplate[];
  parts: SiteTemplate[];
  patterns: SiteTemplate[];
  menus: NavigationMenu[];
  plugins: { slug: string; settings: Record<string, unknown> }[];
};
function RenderedTemplate({
  document,
  postId,
  query,
  className,
  fallback,
  preview = false,
}: {
  document: SiteTemplate;
  postId?: number;
  query: string;
  className: string;
  fallback: string;
  preview?: boolean;
}) {
  const location = useLocation();
  const [content, setContent] = useState<string | null>(null),
    [error, setError] = useState("");
  const requestQuery = new URLSearchParams(location.search);
  for (const [key, value] of new URLSearchParams(query))
    requestQuery.set(key, value);
  requestQuery.set("requestPath", location.pathname);
  if (postId) requestQuery.set("postId", String(postId));
  if (document.type === "template-part")
    requestQuery.set("type", "template-part");
  const request = `/public/templates/${encodeURIComponent(document.slug)}?${requestQuery}`;
  useEffect(() => {
    let active = true;
    setError("");
    setContent(null);
    if (preview) return;
    api<{ content: string }>(request)
      .then((result) => {
        if (active) setContent(result.content);
      })
      .catch((reason) => {
        if (active) setError(errorText(reason));
      });
    return () => {
      active = false;
    };
  }, [request, document.updatedAt, preview]);
  if (preview)
    return (
      <div
        className={className}
        dangerouslySetInnerHTML={{ __html: fallback }}
      />
    );
  if (error)
    return (
      <p className="public-comment-notice" role="alert">
        {error}
      </p>
    );
  if (content === null)
    return (
      <p className="public-template-loading" role="status">
        Loading…
      </p>
    );
  return (
    <div className={className} dangerouslySetInnerHTML={{ __html: content }} />
  );
}

const defaultDocuments: Record<string, string> = {
  header:
    '<header class="site-header"><div class="site-title">{{siteTitle}}</div><nav>{{navigation}}</nav></header>',
  footer:
    '<footer class="site-footer"><strong>{{siteTitle}}</strong><p>{{tagline}}</p><p>Designed with WorldAct</p></footer>',
  single:
    '<article class="single-post"><h1>{{postTitle}}</h1><p class="post-meta">{{postDate}} · {{postAuthor}}</p><div class="public-content">{{content}}</div></article>',
  page: '<article class="single-post"><h1>{{postTitle}}</h1><div class="public-content">{{content}}</div></article>',
  index: '<main class="site-main"><h1>Blog</h1>{{postList}}</main>',
};
function customDocument(items: SiteTemplate[] | undefined, slug: string) {
  const item = items?.find((item) => item.slug === slug);
  return item && item.content !== defaultDocuments[slug] ? item : null;
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
function fontStack(name: string | undefined) {
  if (!name) return undefined;
  return name === "System"
    ? "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    : name === "Georgia"
      ? "Georgia, Times New Roman, serif"
      : name === "Manrope" || name === "Inter"
        ? `${name}, sans-serif`
        : name;
}
function navigationHTML(
  items: NavigationItem[],
  parent: string | null = null,
  depth = 0,
): string {
  if (depth > 10) return "";
  return `<ul>${items
    .filter((item) => (item.parentId || null) === parent)
    .map(
      (item) =>
        `<li><a href="${escapeHTML(item.url)}"${item.target === "_blank" ? ' target="_blank" rel="noopener noreferrer"' : ""}>${escapeHTML(item.label)}</a>${items.some((child) => child.parentId === item.id) ? navigationHTML(items, item.id, depth + 1) : ""}</li>`,
    )
    .join("")}</ul>`;
}
function Navigation({
  items,
  parent = null,
  depth = 0,
}: {
  items: NavigationItem[];
  parent?: string | null;
  depth?: number;
}) {
  if (depth > 10) return null;
  return (
    <ul className="public-menu">
      {items
        .filter((item) => (item.parentId || null) === parent)
        .map((item) => (
          <li key={item.id}>
            <a
              href={item.url}
              target={item.target || "_self"}
              rel={item.target === "_blank" ? "noopener noreferrer" : undefined}
            >
              {item.label}
            </a>
            {items.some((child) => child.parentId === item.id) && (
              <Navigation items={items} parent={item.id} depth={depth + 1} />
            )}
          </li>
        ))}
    </ul>
  );
}

export function PermalinkResolver() {
  const location = useLocation();
  const resource = useResource<{
    post?: Post;
    archive?: { taxonomy: "category" | "tag"; slug: string; name?: string };
  }>(`/public/resolve?path=${encodeURIComponent(location.pathname)}`);
  if (resource.loading || resource.error)
    return (
      <div className="public-site">
        <main className="site-main">
          <ResourceState
            loading={resource.loading}
            error={resource.error}
            retry={resource.reload}
          />
          {resource.error && <Link to="/">Return to home</Link>}
        </main>
      </div>
    );
  if (resource.data?.archive)
    return <PublicSite archive={resource.data.archive} />;
  if (resource.data?.post)
    return (
      <PublicSite
        detail
        page={resource.data.post.type === "page"}
        slugOverride={resource.data.post.slug}
      />
    );
  return (
    <div className="public-site">
      <main className="site-main">
        <h1>Page not found</h1>
        <Link to="/">Return to home</Link>
      </main>
    </div>
  );
}

type CommentPagination = {
  page: number;
  perPage: number;
  totalComments: number;
  totalPages: number;
};
function commentsOpen(post: Post, settings: Partial<Settings> | undefined) {
  return (
    post.commentStatus !== "closed" &&
    !(
      settings?.closeCommentsDays &&
      post.publishedAt &&
      new Date(post.publishedAt).getTime() +
        settings.closeCommentsDays * 86400000 <
        Date.now()
    )
  );
}
function CommentThread({
  comments,
  displayDate,
  threaded,
  maxDepth,
  canReply,
  onReply,
}: {
  comments: Comment[];
  displayDate: (date: string | null) => string;
  threaded: boolean;
  maxDepth: number;
  canReply: boolean;
  onReply: (comment: Comment) => void;
}) {
  const ids = new Set(comments.map((item) => item.id));
  function render(item: Comment, depth = 0): ReactNode {
    return (
      <div className="public-comment-node" key={item.id}>
        <article id={`comment-${item.id}`} className="public-comment">
          <div className="public-comment-avatar">
            <Icon name="admin-users" />
          </div>
          <div>
            <strong>{item.authorName}</strong>
            <p className="comment-date">{displayDate(item.createdAt)}</p>
            <div dangerouslySetInnerHTML={{ __html: item.content }} />
            {threaded && canReply && depth < maxDepth - 1 && (
              <button
                className="button-link public-comment-reply"
                onClick={() => onReply(item)}
              >
                Reply
              </button>
            )}
          </div>
        </article>
        {threaded && depth < 10 && (
          <div className="public-comment-children">
            {comments
              .filter((child) => child.parentId === item.id)
              .map((child) => render(child, depth + 1))}
          </div>
        )}
      </div>
    );
  }
  return (
    <>
      {comments
        .filter(
          (item) => !threaded || !item.parentId || !ids.has(item.parentId),
        )
        .map((item) => render(item))}
    </>
  );
}
