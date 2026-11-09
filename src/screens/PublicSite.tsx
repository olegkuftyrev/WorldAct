import { createPortal } from "react-dom";
import { renderTemplate } from "../template";
import ClassicCommentThread from "../components/ClassicCommentThread";
import { parseVideoEmbed } from "../embeds";
import { enhanceInteractiveBlocks } from "../interactiveBlocks";
import { enhanceNavigationOverlays } from "../navigationOverlays";
import { contentPageQuery } from "../contentPages";
import { commentsOpen } from "../../shared/comment-open";
import { commentReturnPath, commentLoginHref } from "../../shared/comment-links";
import { readPlainPermalinkQuery } from "../../shared/plain-permalink-query";
import { shouldResolveStaticFrontPage } from "../plainPermalinkRouting";
import { publicArchivePageLocation, publicArchiveSearchPath } from "../publicArchiveLinks";
import { selectPublicSourceTemplate } from "../../shared/public-routing";
import type { PublicArchive } from "../../shared/public-document";
import { scrollToMoreFragment } from "../contentFragments";
import {enhancePlaylists} from "../playlists";
import "@wordpress/block-library/build-style/style.css";
import "@wordpress/block-library/build-style/theme.css";
import {
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  useRef,
  type FormEvent,
  type CSSProperties,
} from "react";
import {
  Link,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import {
  api,
  ApiError,
  json,
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
import { formatPostCivil } from "../../shared/post-civil-date";
import { date as formatDate } from "@wordpress/date";
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
  notFound = false,
  contentPage,
  resolvedPostId,
}: {
  detail?: boolean;
  page?: boolean;
  preview?: boolean;
  slugOverride?: string;
  archive?: PublicArchive;
  notFound?: boolean;
  contentPage?: number;
  resolvedPostId?: number;
}) {
  const { slug: routeSlug, id: previewId } = useParams(),
    { user, setUser } = useContext(Session);
  const slug = slugOverride || routeSlug;
  const requestLocation = useLocation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const searchTerm = params.get("search") || params.get("s") || "";
  const categoryFilter =
    archive && "taxonomy" in archive && archive.taxonomy === "category" ? archive.slug : params.get("category");
  const tagFilter =
    archive && "taxonomy" in archive && archive.taxonomy === "tag" ? archive.slug : params.get("tag");
  const dateArchive = archive && "type" in archive && archive.type === "date" ? archive : null;
  const routeAuthor = archive && "type" in archive && archive.type === "author" ? archive : null;
  const authorFilter = routeAuthor?.authorId || params.get("author");
  const dateQuery = new URLSearchParams();
  for (const key of ["year", "monthnum", "day", "m", "w"])
    if (params.get(key)) dateQuery.set(key, params.get(key)!);
  if (dateArchive) {
    // The resolved path is authoritative; unrelated search parameters cannot
    // silently replace the date represented by /YYYY/MM/DD/.
    dateQuery.delete("m");
    dateQuery.set("year", String(dateArchive.year));
    for (const [key, value] of [["monthnum", dateArchive.month], ["day", dateArchive.day], ["w", dateArchive.week]] as const)
      if (value !== undefined) dateQuery.set(key, String(value));
      else dateQuery.delete(key);
  }
  const hasDateFilter = Boolean(dateArchive || dateQuery.size);
  const requestedPage = routeAuthor?.page || Math.max(1, Number(params.get("page")) || 1);
  const commentPageParam = params.get("commentPage");
  const commentPage = Math.max(1, Number(commentPageParam) || 1);
  const blockQuery = new URLSearchParams(
    [...params.entries()].filter(([name]) => /^query-\d+-page$/.test(name)),
  ).toString();
  const bodyPagination=contentPageQuery(params,contentPage);
  const commentQuery = [commentPageParam ? `commentPage=${commentPage}` : "",blockQuery,detail?bodyPagination.query.toString():""].filter(Boolean).join("&");
  const publicQuery = new URLSearchParams({
    page: String(detail ? 1 : requestedPage),
  });
  for (const [key, value] of [
    ["search", searchTerm],
    ["category", categoryFilter],
    ["tag", tagFilter],
    ["author", authorFilter ? String(authorFilter) : null],
  ])
    if (value) publicQuery.set(key!, value);
  for (const [key, value] of new URLSearchParams(blockQuery))
    publicQuery.set(key, value);
  for (const [key, value] of dateQuery) publicQuery.set(key, value);
  const templateQuery=new URLSearchParams(publicQuery);
  if(detail){
    templateQuery.delete("page");
    if(params.has("page"))templateQuery.set("page",String(bodyPagination.page));
    templateQuery.set("contentPage",String(bodyPagination.page));
  }
  const siteQuery = new URLSearchParams(publicQuery);
  if (routeAuthor) siteQuery.set("requestPath", requestLocation.pathname + requestLocation.search);
  const design = useResource<PublicDesign>("/public/design");
  const site = useResource<{
    settings: Partial<Settings>;
    archive?: PublicArchive | null;
    posts: Post[];
    pages: Post[];
    frontPage: Post | null;
    postsPage: Post | null;
    pagination: { page: number; totalPosts: number; totalPages: number };
  }>(`/public/site?${siteQuery}`);
  const [missingPost,setMissingPost] = useState(false);
  const [commentsPagination, setCommentsPagination] =
    useState<CommentPagination | null>(null);
  const [reply, setReply] = useState<{ id: number; name: string } | null>(null);
  const [rememberAuthor,setRememberAuthor] = useState(false);
  const [post, setPost] = useState<Post | null>(null),
    [comments, setComments] = useState<Comment[]>([]),
    [loading, setLoading] = useState(detail),
    [error, setError] = useState(""),
    [comment, setComment] = useState({
      authorName: "",
      authorEmail: "",
      authorUrl: "",
      content: "",
    }),
    [notice, setNotice] = useState(params.get("comment-status") === "pending" ? "Your comment is awaiting moderation." : ""),
    [busy, setBusy] = useState(false),
    [password, setPassword] = useState(""),
    [publicSearch, setPublicSearch] = useState(searchTerm || "");
  useEffect(() => {
    if (!detail || (!slug && !previewId)) return;
    let active = true;
    setLoading(true);
    setMissingPost(false);
    setError("");
    setNotice(params.get("comment-status") === "pending" ? "Your comment is awaiting moderation." : "");
    setPost(null);
    setPassword("");
    setReply(null);
    api<{
      post: Post;
      comments: Comment[];
      commentsPagination?: CommentPagination;
    }>(
      preview
        ? `/posts/${previewId}/preview${commentQuery ? "?" + commentQuery : ""}`
        : `/public/posts/${encodeURIComponent(slug!)}${commentQuery ? "?" + commentQuery : ""}`,
    )
      .then((data) => {
        if (!active) return;
        if (resolvedPostId && data.post.id !== resolvedPostId)
          throw new ApiError("Post not found.", 404);
        if (!preview && data.post.type !== (page ? "page" : "post"))
          throw new Error("This page could not be found.");
        setPost(data.post);
        setComments(data.comments);
        setCommentsPagination(data.commentsPagination || null);
      })
      .catch((e) => {
        if (!active) return;
        setPost(null);
        setMissingPost(e instanceof ApiError && e.status === 404);
        setError(errorText(e));
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [detail, slug, page, preview, previewId, commentQuery, blockQuery, resolvedPostId]);
  const settings = site.data?.settings,
    title = settings?.siteTitle || "WorldAct",
    posts = site.data?.posts || [];
  const resolvedArchive = archive || site.data?.archive;
  const authorArchive = resolvedArchive && "type" in resolvedArchive && resolvedArchive.type === "author" ? resolvedArchive : null;
  const replyReturn = commentReturnPath(requestLocation.pathname + requestLocation.search);
  const replyLocation = useRef({key:"",applied:false});
  useEffect(() => {
    const key = requestLocation.pathname + requestLocation.search + ":" + (user?.id || 0);
    if(replyLocation.current.key!==key){replyLocation.current={key,applied:false};setReply(null);}
    if(replyLocation.current.applied || !post || loading || post.locked || !commentsOpen(post,settings) || settings?.commentRegistration && !user)return;
    const id=Number(params.get("replytocom")),item=comments.find(comment=>comment.id===id);
    if(!item || !document.querySelector(`[data-classic-comment-reply="${id}"]`))return;
    replyLocation.current.applied=true;setReply({id:item.id,name:item.authorName});document.getElementById("comment-content")?.focus();
  }, [post,comments,loading,settings,user?.id,requestLocation.pathname,requestLocation.search]);
  useEffect(() => {
    const icons=site.data?.settings.siteIconSizes || {}, fallback=site.data?.settings.siteIconUrl;
    const nodes: HTMLElement[]=[];
    const safe=(href:string|null|undefined)=>{if(!href)return "";try{const url=new URL(href,location.origin);return ["http:","https:"].includes(url.protocol)?url.href:"";}catch{return "";}};
    const add=(rel:string,href:string|null|undefined,size?:number)=>{const url=safe(href);if(!url)return;const link=document.createElement("link");link.rel=rel;link.href=url;if(size)link.sizes=`${size}x${size}`;link.dataset.worldactIcon="true";document.head.appendChild(link);nodes.push(link);};
    add("icon",icons["icon-16"]?.url || fallback,16);
    if(icons["icon-32"])add("icon",icons["icon-32"].url,32);
    if(icons["icon-192"])add("icon",icons["icon-192"].url,192);
    if(icons["icon-180"])add("apple-touch-icon",icons["icon-180"].url,180);
    const tile=safe(icons["icon-270"]?.url);
    if(tile){const meta=document.createElement("meta");meta.name="msapplication-TileImage";meta.content=tile;meta.dataset.worldactIcon="true";document.head.appendChild(meta);nodes.push(meta);}
    return()=>{for(const node of nodes)node.remove();};
  }, [site.data?.settings.siteIconUrl,JSON.stringify(site.data?.settings.siteIconSizes)]);
  useEffect(() => {
    if (user || (settings as Partial<Settings> & {commentCookieConsent?:boolean})?.commentCookieConsent === false) return;
    let active = true;
    api<{author:{authorName:string;authorEmail:string;authorUrl:string}|null}>("/public/comment-author")
      .then(({author}) => {if(active && author){setComment((current)=>({...current,...author}));setRememberAuthor(true);}}).catch(()=>{});
    return () => {active=false;};
  },[user?.id,(settings as Partial<Settings> & {commentCookieConsent?:boolean})?.commentCookieConsent]);
  const pagination = site.data?.pagination;
  const hasArchiveFilter = Boolean(
    searchTerm ||
    categoryFilter ||
    tagFilter ||
    authorFilter ||
    hasDateFilter ||
    params.get("page"),
  );
  const frontPage = !detail && !notFound && !hasArchiveFilter ? site.data?.frontPage : null;
  const isFrontPage = Boolean(frontPage || (detail && post && settings?.frontPageMode === "page" && post.id === site.data?.frontPage?.id));
  const isPostsPage = detail && settings?.frontPageMode === "page" && post?.id === site.data?.postsPage?.id;
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
    postDate: item ? displayDate(item) : "",
    postAuthor: item?.authorName || "",
    content: item?.content || "",
    postList: posts
      .map(
        (post) =>
          `<article class="format-${escapeHTML(post.format || "standard")}"><h2><a href="${escapeHTML(postLink(post))}">${escapeHTML(post.title)}</a></h2><p class="post-meta">${escapeHTML(displayDate(post))}</p>${post.locked ? "<p>This content is password protected.</p>" : post.excerpt ? `<p>${escapeHTML(post.excerpt)}</p>` : post.content}</article>`,
      )
      .join(""),
  });
  const displayDate = (value: Post) => publicDate(value, settings);
  useEffect(() => {
    document.title = `${post && detail ? post.title : title}${post && detail ? ` – ${title}` : ""}`;
    if (preview || settings?.discourageSearchEngines) {
      const meta = document.createElement("meta");
      meta.name = "robots";
      meta.content = "noindex,nofollow";
      document.head.appendChild(meta);
      return () => meta.remove();
    }
  }, [title, detail, post, preview, settings?.discourageSearchEngines]);
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
  useEffect(() => {
    const cleanups = [...document.querySelectorAll(".public-site .public-content")].map(enhanceArchives);
    cleanups.push(...[...document.querySelectorAll(".public-site .public-content")].map(enhanceInteractiveBlocks));
    cleanups.push(...[...document.querySelectorAll(".public-site .public-content")].map(enhanceNavigationOverlays));
    cleanups.push(...[...document.querySelectorAll(".public-site .public-content")].map(scrollToMoreFragment));
    cleanups.push(...[...document.querySelectorAll(".public-site .public-content")].map(root=>enhancePlaylists(root)));
    return () => {for (const cleanup of cleanups) cleanup?.();};
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
          ...((settings as Partial<Settings> & {commentCookieConsent?:boolean})?.commentCookieConsent !== false ? {rememberAuthor} : {}),
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
          `/public/posts/${encodeURIComponent(post.slug)}${commentQuery ? "?" + commentQuery : ""}`,
        );
        setComments(data.comments);
        setCommentsPagination(data.commentsPagination);
      }
      setComment((current) => rememberAuthor ? {...current,content:""} : { authorName: "", authorEmail: "", authorUrl:"", content: "" });
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
        `/public/posts/${encodeURIComponent(displayedPost?.slug || slug || "")}/unlock${commentQuery ? "?" + commentQuery : ""}`,
        json("POST", { password }),
      );
      if (data.post.id !== displayedPost?.id) throw new ApiError("Post not found.", 404);
      setPost(data.post);
      setComments(data.comments);
      setCommentsPagination(data.commentsPagination || null);
      setPassword("");
      if (frontPage) await site.reload();
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) setMissingPost(true);
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
  const adminBar = (user && user.showAdminBar !== false && (
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
      ));
  const content = (item: Post) => (
    <div
      className="public-content"
      dangerouslySetInnerHTML={{ __html: item.content }}
    />
  );
  const sourceTemplate = selectSourceTemplate(design.data?.templates, {
    notFound: notFound || missingPost,
    single: displaySingle,
    post: displayedPost,
    frontPage: isFrontPage || (!detail && !hasArchiveFilter && settings?.frontPageMode !== "page"),
    search: Boolean(searchTerm),
    category: categoryFilter || undefined,
    tag: tagFilter || undefined,
    author: Boolean(authorFilter),
    authorSlug: authorArchive?.slug,
    authorId: authorArchive?.authorId,
    date: hasDateFilter,
  });
  if (!detail && !notFound && shouldResolveStaticFrontPage(requestLocation.pathname, params, site.data))
    return <PermalinkResolver />;
  if (design.data?.theme?.themeJSON && sourceTemplate) {
    return (
      <div className="public-site worldact-theme" data-theme={design.data.theme.id}>
        <style>{design.data.theme.css}</style>
        {adminBar}
        <ResourceState loading={site.loading || loading} error={site.error || (missingPost ? "" : error)} retry={site.error ? site.reload : undefined} />
        {!loading && !site.loading && !site.error && (!error || missingPost) && <SourceThemeDocument
          key={`${sourceTemplate.slug}:${displayedPost?.id || 0}:${user?.id || 0}:${user?.role || ""}`}
          document={sourceTemplate}
          postId={displaySingle ? displayedPost?.id : undefined}
          query={templateQuery.toString()}
          commentPage={commentPageParam ? commentPage : undefined}
          userName={user?.displayName}
          preview={preview}
        />}
        {enabledPlugin("custom-footer") && <div className="public-extension-footer">{String(enabledPlugin("custom-footer")?.settings.text || "")}</div>}
      </div>
    );
  }
  return (
    <div
      className={`public-site worldact-theme ${settings?.theme === "classic" ? "classic-site" : `${settings?.theme || "twentytwentyfive"}-site`}`}
      style={globalStyle}
    >
      {design.data?.theme?.css && <style>{design.data.theme.css}</style>}
      {adminBar}
      {customHeader ? (
        <RenderedTemplate
          document={customHeader}
          postId={displayedPost?.locked ? undefined : displayedPost?.id}
          query={templateQuery.toString()}
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
        {notFound || missingPost ? (
          <section className="public-not-found">
            <h1>Page not found</h1>
            <p>It looks like nothing was found at this location.</p>
            <Link to="/">Return to home</Link>
          </section>
        ) : displaySingle ? (
          displayedPost &&
          ((post) => (
            <>
              {customSingle && !post.locked ? (
                <RenderedTemplate
                  document={customSingle}
                  postId={post.id}
                  query={templateQuery.toString()}
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
                      {displayDate(post)}
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
                    {(commentsPagination?.totalComments ?? comments.length)
                      ? `${commentsPagination?.totalComments ?? comments.length} ${(commentsPagination?.totalComments ?? comments.length) === 1 ? "response" : "responses"} to “${post.title}”`
                      : "Comments"}
                  </h2>
                  <ClassicCommentThread
                    comments={comments}
                    displayDate={value => {
                      if (!value) return "—";
                      try { return formatDate(settings?.dateFormat || "F j, Y", value, settings?.timezone || "UTC"); }
                      catch { return "—"; }
                    }}
                    threaded={settings?.threadComments !== false}
                    maxDepth={settings?.threadDepth || 5}
                    canReply={commentsOpen(post, settings)}
                    loginHref={settings?.commentRegistration && !user ? commentLoginHref(replyReturn) : undefined}
                    replyHref={id => commentReturnPath(requestLocation.pathname + requestLocation.search, {}, id)}
                    onReply={(item) => {
                      setReply({ id: item.id, name: item.authorName });
                      document
                        .getElementById("comment-reply-title")
                        ?.scrollIntoView({ block: "center" });
                      document.getElementById("comment-content")?.focus({ preventScroll: true });
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
                        You must be <Link to={commentLoginHref(replyReturn)}>logged in</Link> to post a
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
                              <label htmlFor="comment-url">Website</label>
                              <input type="url" id="comment-url" autoComplete="url" value={comment.authorUrl} onChange={(event)=>setComment({...comment,authorUrl:event.target.value})}/>
                              {(settings as Partial<Settings> & {commentCookieConsent?:boolean})?.commentCookieConsent !== false && <label className="public-comment-consent"><input type="checkbox" checked={rememberAuthor} onChange={(event)=>setRememberAuthor(event.target.checked)}/> Save my name, email, and website in this browser for the next time I comment.</label>}
                            </>
                          )}
                          {enabledPlugin("akismet")?.settings.sendComments === true && <p className="akismet_comment_form_privacy_notice">This site uses Akismet to reduce spam. <a href="https://akismet.com/privacy/" target="_blank" rel="noreferrer">Learn how your comment data is processed.</a></p>}
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
                query={templateQuery.toString()}
                className="custom-index-template"
                fallback={renderTemplate(customIndex.content, templateValues())}
                preview={preview}
              />
            ) : (
              <>
                <h1 className="blog-heading">
                  {searchTerm
                    ? `Search results for: ${searchTerm}`
                    : categoryFilter
                      ? `Category: ${archive?.name || categoryFilter}`
                      : tagFilter
                        ? `Tag: ${archive?.name || tagFilter}`
                        : authorFilter
                          ? `Author: ${authorArchive?.name || "Posts"}`
                          : hasDateFilter
                            ? site.data?.archive?.name || dateArchive?.name || "Archives"
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
                    const pathname = publicArchiveSearchPath(requestLocation.pathname + requestLocation.search, resolvedArchive, settings);
                    navigate(pathname + (next.size ? "?" + next : ""));
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
                  {(searchTerm ||
                    categoryFilter ||
                    tagFilter ||
                    authorFilter || hasDateFilter) && <Link to="/">Show all posts</Link>}
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
                        {displayDate(item)}
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
                    navigate(publicArchivePageLocation(requestLocation.pathname + requestLocation.search, resolvedArchive, settings, pagination.page - 1));
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
                    navigate(publicArchivePageLocation(requestLocation.pathname + requestLocation.search, resolvedArchive, settings, pagination.page + 1));
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
          query={templateQuery.toString()}
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

function publicDate(post: Pick<Post, "postDate">, settings?: Partial<Settings>): string {
  try { return formatPostCivil(post.postDate, settings?.dateFormat || "F j, Y", settings?.timezone || "UTC"); }
  catch { return "—"; }
}

type PublicDesign = {
  theme?: {id:string; name:string; version:string; css:string; themeJSON:Record<string,unknown>|null; variation:string};
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
  const location = useLocation(), root = useRef<HTMLDivElement>(null);
  const [response, setResponse] = useState<{ request: string; content: string } | null>(null),
    [error, setError] = useState("");
  const requestQuery = new URLSearchParams(location.search);
  for (const [key, value] of new URLSearchParams(query))
    requestQuery.set(key, value);
  requestQuery.set("requestPath", location.pathname + location.search);
  if (preview) requestQuery.set("preview", "true");
  if (postId) requestQuery.set("postId", String(postId));
  if (document.type === "template-part")
    requestQuery.set("type", "template-part");
  const request = `/public/templates/${encodeURIComponent(document.slug)}?${requestQuery}`;
  const content = response?.request === request ? response.content : null;
  useEffect(() => {
    let active = true;
    setError("");
    setResponse(null);
    api<{ content: string }>(request)
      .then((result) => {
        if (active) setResponse({ request, content: result.content });
      })
      .catch((reason) => {
        if (active) setError(errorText(reason));
      });
    return () => {
      active = false;
    };
  }, [request, document.updatedAt, preview]);
  useEffect(() => {
    const archive = enhanceArchives(root.current), interactive = enhanceInteractiveBlocks(root.current), navigation=enhanceNavigationOverlays(root.current), fragment=scrollToMoreFragment(root.current), playlist=enhancePlaylists(root.current);
    return () => { archive?.(); interactive(); navigation(); fragment(); playlist(); };
  }, [content, fallback, preview]);
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
    <div ref={root} className={className} dangerouslySetInnerHTML={{ __html: content }} />
  );
}

function selectSourceTemplate(documents: SiteTemplate[] | undefined, context: {
  notFound: boolean; single: boolean; post: Post | null | undefined;
  frontPage: boolean; search: boolean;
  category?: string; tag?: string; author: boolean; authorSlug?: string; authorId?: number; date: boolean;
}) {
  return selectPublicSourceTemplate(documents || [], {...context, post:context.post || null});
}
function enhanceEmbeds(root: ParentNode) {
  for (const wrapper of root.querySelectorAll<HTMLElement>(".wp-block-embed__wrapper")) {
    if (wrapper.querySelector("iframe")) continue;
    const embed = parseVideoEmbed((wrapper.textContent || "").trim());
    if (!embed) continue;
    const frame = document.createElement("iframe");
    frame.src = embed.src; frame.title = embed.title;
    frame.width = String(embed.width); frame.height = String(embed.height);
    frame.allowFullscreen = true; frame.loading = "lazy";
    frame.referrerPolicy = "strict-origin-when-cross-origin";
    frame.allow = "encrypted-media; picture-in-picture";
    wrapper.replaceChildren(frame);
  }
}
function enhanceArchives(root: ParentNode | null) {
  if (!root) return;
  const cleanups = [...root.querySelectorAll<HTMLSelectElement>('.wp-block-archives-dropdown select[name="archive-dropdown"]')].map((select) => {
    let escapePressed = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const keyup = (event: KeyboardEvent) => {escapePressed = event.key === "Escape";};
    const click = () => {escapePressed = false;};
    const change = () => {
      // Match the source dropdown's delay so Escape can cancel the native
      // select's pending change before a navigation starts.
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (escapePressed || !select.value.startsWith("/") || select.value.startsWith("//")) return;
        try {
          const target = new URL(select.value, window.location.origin);
          if (target.origin === window.location.origin && ["http:", "https:"].includes(target.protocol)) window.location.assign(target.pathname + target.search + target.hash);
        } catch { /* Ignore malformed archive option URLs. */ }
      }, 250);
      timers.add(timer);
    };
    select.addEventListener("keyup", keyup);
    select.addEventListener("click", click);
    select.addEventListener("change", change);
    return () => {select.removeEventListener("keyup", keyup);select.removeEventListener("click", click);select.removeEventListener("change", change);for (const timer of timers) clearTimeout(timer);};
  });
  return () => {for (const cleanup of cleanups) cleanup();};
}
function SourceThemeDocument({ document: template, postId, query, commentPage, userName, preview = false }: {
  document: SiteTemplate; postId?: number; query: string; commentPage?: number; userName?: string; preview?: boolean;
}) {
  const location = useLocation(), root = useRef<HTMLDivElement>(null);
  const [response, setResponse] = useState<{request:string;content:string} | null>(null), [error, setError] = useState("");
  const requestedReply = useRef({key:"",applied:false});
  const [notice, setNotice] = useState(new URLSearchParams(location.search).get("comment-status") === "pending" ? "Your comment is awaiting moderation." : ""), [revision, setRevision] = useState(0), [busy, setBusy] = useState(false);
  const requestQuery = new URLSearchParams(location.search);
  for (const [key, value] of new URLSearchParams(query)) requestQuery.set(key, value);
  requestQuery.set("requestPath", location.pathname + location.search);
  if(preview) requestQuery.set("preview","true");
  if(commentPage) requestQuery.set("commentPage", String(commentPage));
  if (postId) requestQuery.set("postId", String(postId));
  const request = `/public/templates/${encodeURIComponent(template.slug)}?${requestQuery}`;
  const html=response?.request===request?response.content:null;
  const [feedbackForm, setFeedbackForm] = useState<HTMLFormElement | null>(null);
  const localError = error && feedbackForm?.isConnected ? feedbackForm : null;
  useLayoutEffect(() => {
    localError?.querySelector<HTMLElement>('[data-worldact-comment-error]')?.scrollIntoView({block:"nearest"});
  }, [error, localError]);
  useEffect(() => {
    setNotice(new URLSearchParams(location.search).get("comment-status")==="pending" ? "Your comment is awaiting moderation." : "");
  }, [location.pathname,location.search]);
  useEffect(() => {
    let active = true;
    setError("");
    api<{content:string}>(request).then((result) => { if (active) setResponse({request,content:result.content}); })
      .catch((reason) => { if (active) setError(errorText(reason)); });
    return () => { active = false; };
  }, [request, template.updatedAt, revision]);
  useEffect(() => {
    if (!root.current) return;
    enhanceEmbeds(root.current);
    const cleanup = enhanceNavigationOverlays(root.current);
    const cleanupArchives = enhanceArchives(root.current);
    const cleanupInteractive = enhanceInteractiveBlocks(root.current);
    const cleanupFragment = scrollToMoreFragment(root.current);
    const cleanupPlaylist = enhancePlaylists(root.current);
    const requested=Number(new URLSearchParams(location.search).get("replytocom")),reply=root.current.querySelector<HTMLAnchorElement>(`[data-comment-reply="${requested}"]`);
    const replyKey=location.pathname+location.search;
    if(requestedReply.current.key!==replyKey)requestedReply.current={key:replyKey,applied:false};
    if(reply && !requestedReply.current.applied){
      const form=root.current.querySelector<HTMLFormElement>("form.worldact-native-comment-form"),parent=form?.querySelector<HTMLInputElement>('[name="parentId"]');
      if(parent){parent.value=String(requested);setNotice(`Replying to ${reply.dataset.commentAuthor || "comment"}.`);form?.querySelector<HTMLTextAreaElement>("textarea")?.focus();requestedReply.current.applied=true;}
    }
    let active=true;
    if(!userName)api<{author:{authorName:string;authorEmail:string;authorUrl:string}|null}>("/public/comment-author").then(({author})=>{
      if(!active || !author || !root.current)return;
      const checkbox=root.current.querySelector<HTMLInputElement>('input[name="rememberAuthor"],input[name="wp-comment-cookies-consent"]');
      if(!checkbox)return;
      for(const key of ["authorName","authorEmail","authorUrl"] as const){const field=root.current.querySelector<HTMLInputElement>(`input[name="${key}"]`);if(field && !field.value)field.value=author[key] || "";}
      checkbox.checked=true;
    }).catch(()=>{});
    return ()=>{active=false;cleanup();cleanupArchives?.();cleanupInteractive();cleanupFragment();cleanupPlaylist();};
  }, [html,request]);
  async function submitComment(event: FormEvent<HTMLDivElement>) {
    const form = event.target as HTMLFormElement;
    if(form.matches("form.worldact-native-password-form")){
      event.preventDefault();if(busy)return;const data=new FormData(form);
      setBusy(true);setError("");
      const unlockQuery = new URLSearchParams([...requestQuery].filter(([key]) => key === "commentPage" || /^query-\d+-page$/.test(key)));
      const body = contentPageQuery(new URLSearchParams(location.search), Number(requestQuery.get("contentPage")) || undefined);
      for (const [key,value] of body.query) unlockQuery.set(key,value);
      try{const unlocked=await api<{post:Post}>(`/public/posts/${encodeURIComponent(String(data.get("postSlug") || ""))}/unlock${unlockQuery.size ? "?"+unlockQuery : ""}`,json("POST",{password:String(data.get("password") || "")}));if(postId && unlocked.post.id!==postId)throw new ApiError("Post not found.",404);setRevision((value)=>value+1);}catch(reason){setError(errorText(reason));}finally{setBusy(false);}return;
    }
    if (!form.matches("form.worldact-native-comment-form, .wp-block-post-comments-form form, form.comment-form")) return;
    event.preventDefault();
    if (busy) return;
    const data = new FormData(form);
    const value = (...names: string[]) => names.map((name) => data.get(name)).find((item) => typeof item === "string" && item) || "";
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await api<{comment:{id:number;status:string}}>("/public/comments", json("POST", {
        postId: Number(value("postId", "comment_post_ID") || postId),
        parentId: Number(value("parentId", "comment_parent")) || null,
        authorName: String(value("authorName", "author")),
        authorEmail: String(value("authorEmail", "email")),
        authorUrl: String(value("authorUrl", "url")),
        ...(form.querySelector('input[name="rememberAuthor"],input[name="wp-comment-cookies-consent"]') ? {rememberAuthor: data.has("rememberAuthor") || data.has("wp-comment-cookies-consent")} : {}),
        content: String(value("content", "comment")),
      }));
      setNotice(result.comment.status === "approved" ? "Your comment has been published." : "Your comment is awaiting moderation.");
      if(data.has("rememberAuthor") || data.has("wp-comment-cookies-consent")) {const field=form.querySelector<HTMLTextAreaElement>("textarea");if(field)field.value="";}
      else form.reset();
      const parent = form.querySelector<HTMLInputElement>('[name="parentId"],[name="comment_parent"]');
      if (parent) parent.value = "0";
      if (result.comment.status === "approved") setRevision((value) => value + 1);
    } catch (reason) { setFeedbackForm(form); setError(errorText(reason)); }
    finally { setBusy(false); }
  }
  return <>
    {localError && createPortal(<div className="worldact-public-notice" role="alert" data-worldact-comment-error="true">{error}</div>, localError)}
    {(!localError && error || notice && !error) && <div className="worldact-public-notice" role={error ? "alert" : "status"}>{error || notice}</div>}
    {html === null && !error && <p className="worldact-public-loading" role="status">Loading…</p>}
    <div className="wp-site-blocks" ref={root} aria-busy={busy || undefined}
      onSubmit={submitComment}
      onClick={(event) => {
        if(event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)return;
        const target = event.target as HTMLElement;
        const reply = target.closest<HTMLAnchorElement>("[data-comment-reply]");
        const cancel = target.closest<HTMLElement>("[data-comment-cancel]");
        if (!reply && !cancel) return;
        const form = root.current?.querySelector<HTMLFormElement>("form.worldact-native-comment-form, .wp-block-post-comments-form form, form.comment-form");
        if (!form) return;
        event.preventDefault();
        let parent = form.querySelector<HTMLInputElement>('[name="parentId"],[name="comment_parent"]');
        if (!parent) { parent = document.createElement("input"); parent.type = "hidden"; parent.name = "parentId"; form.appendChild(parent); }
        parent.value = reply?.dataset.commentReply || "0";
        setNotice(reply ? `Replying to ${reply.dataset.commentAuthor || "comment"}.` : "");
        form.querySelector<HTMLTextAreaElement>("textarea")?.focus();
        form.scrollIntoView({behavior:"smooth",block:"center"});
      }} dangerouslySetInnerHTML={{__html:html || ""}} />
    {busy && <p className="worldact-public-loading" role="status">Submitting…</p>}
    {userName && <span className="screen-reader-text">Logged in as {userName}.</span>}
  </>;
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
    archive?: PublicArchive;
    contentPage?: number;
  }>(`/public/resolve?path=${encodeURIComponent(location.pathname + location.search)}`);
  if (resource.error === "This page could not be found." || resource.error === "Page not found." || resource.error === "Post not found.") return <PublicSite notFound />;
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
        contentPage={resource.data.contentPage}
        resolvedPostId={resource.data.post.id}
      />
    );
  return <PublicSite notFound />;
}

export function PublicRoot() {
  const location = useLocation();
  const identity = readPlainPermalinkQuery(new URLSearchParams(location.search));
  return identity.kind === "none" ? <PublicSite /> : <PermalinkResolver />;
}

type CommentPagination = {
  page: number;
  perPage: number;
  totalComments: number;
  totalPages: number;
};
