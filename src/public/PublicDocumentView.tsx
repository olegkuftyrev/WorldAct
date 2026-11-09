import type { CSSProperties, FormEvent, MouseEvent, ReactNode, RefObject } from "react";
import type { PublicDocumentModel, PublicPost } from "../../shared/public-document";
import type { NavigationItem, Settings } from "../api";
import ClassicCommentThread from "../components/ClassicCommentThread";
import { Brand, ResourceState } from "../components/PublicPrimitives";
import { postLink } from "../publicLinks";
import { commentReturnPath } from "../../shared/comment-links";
import { postPublicationKey } from "../../shared/post-civil-date";
import { publicArchivePageLocation, publicArchiveSearchPath } from "../publicArchiveLinks";
import type { PublicArchive, PublicSettings } from "../../shared/public-document";

export type PublicInteractionState = {
 error:string; errorLocal?:boolean; notice:string; busy:boolean; password:string; publicSearch:string;
 reply:{id:number;name:string}|null; rememberAuthor:boolean;
 comment:{authorName:string;authorEmail:string;authorUrl:string;content:string};
};
export type PublicDocumentActions = {
 submit?:(event:FormEvent<HTMLFormElement>)=>void; unlock?:(event:FormEvent<HTMLFormElement>)=>void;
 logout?:(event:FormEvent<HTMLFormElement>)=>void; search?:(event:FormEvent<HTMLFormElement>)=>void;
 reply?:(reply:PublicInteractionState["reply"])=>void;
 comment?:(comment:PublicInteractionState["comment"])=>void; password?:(value:string)=>void;
 rememberAuthor?:(value:boolean)=>void; publicSearch?:(value:string)=>void;
 sourceSubmit?:(event:FormEvent<HTMLDivElement>)=>void; sourceClick?:(event:MouseEvent<HTMLDivElement>)=>void;
 navigate?:(event:MouseEvent<HTMLAnchorElement>)=>void;
 sourceRoot?:RefObject<HTMLDivElement|null>;
};
export function initialPublicInteraction(model:PublicDocumentModel):PublicInteractionState {
 return {error:"",notice:model.presentation.kind==="source" && model.controls.replyParentId ? `Replying to ${model.controls.replyParentName || "comment"}.` : new URL(model.requestPath,"https://worldact.invalid").searchParams.get("comment-status")==="pending" ? "Your comment is awaiting moderation." : "",busy:false,password:"",publicSearch:model.route.query.search,
 reply:model.controls.replyParentId ? {id:model.controls.replyParentId,name:model.controls.replyParentName || "comment"}:null,
 rememberAuthor:false,comment:{authorName:"",authorEmail:"",authorUrl:"",content:""}};
}
export function PublicDocumentView({model,state=initialPublicInteraction(model),actions={}}:{model:PublicDocumentModel;state?:PublicInteractionState;actions?:PublicDocumentActions}) {
 const {error,notice,busy,password,publicSearch,reply,rememberAuthor,comment}=state;
 const {viewer:user,post,comments,commentsPagination}=model;
 const settings=model.site.settings,title=settings.siteTitle || "WorldAct",posts=model.site.posts;
 const site={data:model.site,loading:false,error:"",reload:undefined},design={data:model.design};
 const detail=model.route.detail,notFound=model.status===404,missingPost=false,preview=false,loading=false;
 const isPostsPage=model.route.kind==="posts-page",displaySingle=["singular","front-page"].includes(model.route.kind),displayedPost=post;
 const requestLocation=new URL(model.requestPath,"https://worldact.invalid"),params=requestLocation.searchParams;
 const {search:searchTerm,category:categoryFilter,tag:tagFilter,author:authorFilter,date:dateArchive,namedAuthor}=model.route.query;
 const archive=model.route.archive,hasDateFilter=Boolean(dateArchive),pagination=model.site.pagination;
 const replyReturn=model.controls.commentReturnPath;
 const passwordReturn=commentReturnPath(model.requestPath,model.route.query.values,Number(model.route.query.values.replytocom)).split("#")[0];
 const primaryMenu=model.design.menus.find(menu=>menu.location==="primary"),footerMenu=model.design.menus.find(menu=>menu.location==="footer");
 const slots=model.presentation.kind==="classic" ? model.presentation.slots : {};
 const customHeader=slots.header,customFooter=slots.footer,customSingle=slots.single,customIndex=slots.index;
 const enabledPlugin=(slug:string)=>model.design.plugins.find(plugin=>plugin.slug===slug);
 const readTime=(item:PublicPost)=>{const plugin=enabledPlugin("reading-time");return !plugin || item.locked ? null : Math.max(1,Math.ceil(item.content.replace(/<[^>]*>/g," ").trim().split(/\s+/).filter(Boolean).length/Math.max(50,Number(plugin.settings.wordsPerMinute)||200)));};
 const style=model.design.styles;
 const globalStyle={"--worldact-background":style.backgroundColor,"--worldact-text":style.textColor,"--worldact-accent":style.accentColor,"--worldact-font":fontStack(style.fontFamily),"--worldact-heading-font":fontStack(style.headingFont),"--worldact-width":style.contentWidth ? `${style.contentWidth}px`:undefined,"--worldact-spacing":style.spacing ? `${style.spacing}px`:undefined} as CSSProperties;
 const displayDate=(item:PublicPost)=>model.controls.dates[postPublicationKey(item)] || "—";
  const adminBar = (user && user.showAdminBar !== false && (
        <div className="public-admin-bar">
          <a onClick={actions.navigate} href={user.role === "subscriber" ? "/" : "/admin"}>
            <Brand />
            WorldAct
          </a>
          {user.role !== "subscriber" && <a onClick={actions.navigate} href="/admin">Dashboard</a>}
          {detail &&
            post &&
            (user.role === "administrator" ||
              user.role === "editor" ||
              (["author", "contributor"].includes(user.role) &&
                post.type === "post" &&
                post.authorId === user.id)) && (
              <a onClick={actions.navigate}
                href={`/admin/${post.type === "page" ? "pages" : "posts"}/${post.id}`}
              >
                Edit {post.type}
              </a>
            )}
          <a onClick={actions.navigate}
            className="public-howdy"
            href={user.role === "subscriber" ? "/" : "/admin"}
          >
            Howdy, {user.displayName}
          </a>
          <form className="public-logout-form" action="/logout" method="post" onSubmit={actions.logout}><input type="hidden" name="redirect_to" value={model.requestPath} /><button type="submit" className="public-logout">
            Log Out
          </button></form>
        </div>
      ));
  const content = (item: PublicPost) => (
    <div
      className="public-content" data-worldact-public-island="true"
      dangerouslySetInnerHTML={{ __html: item.content }}
    />
  );
  if (model.presentation.kind === "source") {
    return (
      <div className="public-site worldact-theme" data-theme={design.data.theme?.id}>
        <style>{design.data.theme?.css}</style>
        {adminBar}
        <ResourceState loading={site.loading || loading} error={site.error} retry={site.error ? site.reload : undefined} />
        <SourceDocument model={model} state={state} actions={actions} />
        {enabledPlugin("custom-footer") && <div className="public-extension-footer">{String(enabledPlugin("custom-footer")?.settings.text || "")}</div>}
      </div>
    );
  }
  return (
    <div
      className={`public-site worldact-theme ${settings?.theme === "classic" ? "classic-site" : `${settings?.theme || "twentytwentyfive"}-site`}`}
      style={globalStyle}
    >
      {design.data?.theme?.css && <style>{design.data.theme?.css}</style>}
      {adminBar}
      {customHeader ? (
        <Slot html={customHeader.html} className="custom-template-part" />
      ) : (
        <header className="site-header">
          <a onClick={actions.navigate} className="site-title" href="/">
            {title}
          </a>
          <nav aria-label="Primary navigation">
            {primaryMenu ? (
              <Navigation items={primaryMenu.items} onNavigate={actions.navigate} />
            ) : (
              site.data?.pages.map((item) => (
                <a onClick={actions.navigate} key={item.id} href={postLink(item)}>
                  {item.title}
                </a>
              ))
            )}
            {!primaryMenu && !site.data?.pages.length && (
              <a onClick={actions.navigate} href="/">Home</a>
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
            <a onClick={actions.navigate} href="/">Return to home</a>
          </section>
        ) : displaySingle ? (
          displayedPost &&
          ((post: PublicPost) => (
            <>
              {customSingle && !post.locked ? (
                <Slot html={customSingle.html} className={`custom-post-template format-${post.format || "standard"}`} />
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
                    <form className="password-protected-form" action="/post-password" method="post" onSubmit={actions.unlock}>
                      <p>
                        This content is password protected. To view it please
                        enter your password below:
                      </p>
                      <label htmlFor="post-password">Password</label>
                      <input type="hidden" name="postSlug" value={post.slug} />
                      <input type="hidden" name="redirect_to" value={passwordReturn} />
                      <input
                        name="password"
                        type="password"
                        id="post-password"
                        autoComplete="current-password"
                        value={password}
                        onChange={(e) => actions.password?.(e.target.value)}
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
                            <a onClick={actions.navigate}
                              key={term.id}
                              href={`/?${term.taxonomy}=${encodeURIComponent(term.slug)}`}
                            >
                              {term.name}
                            </a>
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
                    onNavigate={actions.navigate}
                    displayDate={value => value ? model.controls.dates[value] || "—" : "—"}
                    threaded={settings?.threadComments !== false}
                    maxDepth={settings?.threadDepth || 5}
                    canReply={model.controls.commentsOpen}
                    loginHref={settings?.commentRegistration && !user ? model.controls.loginHref : undefined}
                    replyHref={id => commentReturnPath(requestLocation.pathname + requestLocation.search, {}, id)}
                    onReply={item => actions.reply?.({id:item.id,name:item.authorName})}

                  />
                  {commentsPagination && commentsPagination.totalPages > 1 && (
                    <nav
                      className="public-pagination"
                      aria-label="Comments pagination"
                    >
                      <PageLink onNavigate={actions.navigate} path={model.requestPath} field="commentPage" page={commentsPagination.page - 1} disabled={commentsPagination.page <= 1}>← Previous comments</PageLink>
                      <span>
                        {commentsPagination.page} of{" "}
                        {commentsPagination.totalPages}
                      </span>
                      <PageLink onNavigate={actions.navigate} path={model.requestPath} field="commentPage" page={commentsPagination.page + 1} disabled={commentsPagination.page >= commentsPagination.totalPages}>Next comments →</PageLink>
                    </nav>
                  )}
                  {model.controls.commentsOpen ? (
                    settings?.commentRegistration && !user ? (
                      <p>
                        You must be <a onClick={actions.navigate} href={model.controls.loginHref}>logged in</a> to post a
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
                            onClick={() => actions.reply?.(null)}
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
                        <form className="public-comment-form" action="/wp-comments-post.php" method="post" onSubmit={actions.submit}>
                          <input type="hidden" name="postId" value={post.id} />
                          <input type="hidden" name="parentId" value={reply?.id || 0} />
                          <input type="hidden" name="redirect_to" value={replyReturn} />
                          <label htmlFor="comment-content">Comment *</label>
                          <textarea
                            id="comment-content" name="content"
                            rows={6}
                            value={comment.content}
                            onChange={(e) =>
                              actions.comment?.({
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
                                id="comment-name" name="authorName"
                                autoComplete="name"
                                value={comment.authorName}
                                onChange={(e) =>
                                  actions.comment?.({
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
                                id="comment-email" name="authorEmail"
                                autoComplete="email"
                                value={comment.authorEmail}
                                onChange={(e) =>
                                  actions.comment?.({
                                    ...comment,
                                    authorEmail: e.target.value,
                                  })
                                }
                                required={
                                  settings?.requireCommentNameEmail !== false
                                }
                              />
                              <label htmlFor="comment-url">Website</label>
                              <input type="url" id="comment-url" name="authorUrl" autoComplete="url" value={comment.authorUrl} onChange={(event)=>actions.comment?.({...comment,authorUrl:event.target.value})}/>
                              {(settings as Partial<Settings> & {commentCookieConsent?:boolean})?.commentCookieConsent !== false && <label className="public-comment-consent"><input type="checkbox" name="rememberAuthor" checked={rememberAuthor} onChange={(event)=>actions.rememberAuthor?.(event.target.checked)}/> Save my name, email, and website in this browser for the next time I comment.</label>}
                            </>
                          )}
                          {enabledPlugin("akismet")?.settings.sendComments === true && <p className="akismet_comment_form_privacy_notice">This site uses Akismet to reduce spam. <a onClick={actions.navigate} href="https://akismet.com/privacy/" target="_blank" rel="noreferrer">Learn how your comment data is processed.</a></p>}
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
              <Slot html={customIndex.html} className="custom-index-template" />
            ) : (
              <>
                <h1 className="blog-heading">
                  {searchTerm
                    ? `Search results for: ${searchTerm}`
                    : categoryFilter
                      ? `Category: ${archive?.name || categoryFilter}`
                      : tagFilter
                        ? `Tag: ${archive?.name || tagFilter}`
                        : authorFilter && (!namedAuthor || !hasDateFilter && !isPostsPage)
                          ? `Author: ${archive?.name || "Posts"}`
                          : hasDateFilter
                            ? site.data?.archive?.name || dateArchive?.name || "Archives"
                          : isPostsPage
                            ? post?.title || (namedAuthor ? site.data.postsPage?.title : undefined) || "Blog"
                            : "Blog"}
                </h1>
                <form
                  className="public-search-form"
                  role="search"
                  action={publicArchiveSearchPath(model.requestPath,archive,settings)} method="get" onSubmit={actions.search}

                >
                  <label className="screen-reader-text" htmlFor="public-search">
                    Search posts
                  </label>
                  {[...params].filter(([key])=>!["search","s","page","replytocom"].includes(key)).map(([key,value],index)=><input key={`${key}:${index}`} type="hidden" name={key} value={value}/>)}
                  <input
                    name="search" id="public-search"
                    type="search"
                    placeholder="Search…"
                    value={publicSearch}
                    onChange={(e) => actions.publicSearch?.(e.target.value)}
                  />
                  <button>Search</button>
                  {(searchTerm ||
                    categoryFilter ||
                    tagFilter ||
                    authorFilter || namedAuthor || hasDateFilter) && <a onClick={actions.navigate} href="/">Show all posts</a>}
                </form>
                <div className="public-posts">
                  {posts.map((item) => (
                    <article
                      className={`format-${item.format || "standard"}`}
                      key={item.id}
                    >
                      <h2>
                        <a onClick={actions.navigate} href={postLink(item)}>
                          {item.title || "(no title)"}
                        </a>
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
                          <a onClick={actions.navigate} href={postLink(item)}>
                            Enter the password to read it.
                          </a>
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
                <PageLink onNavigate={actions.navigate} path={model.requestPath} archive={archive} settings={settings} field="page" page={pagination.page - 1} disabled={pagination.page <= 1}>← Newer posts</PageLink>
                <span>
                  {pagination.page} of {pagination.totalPages}
                </span>
                <PageLink onNavigate={actions.navigate} path={model.requestPath} archive={archive} settings={settings} field="page" page={pagination.page + 1} disabled={pagination.page >= pagination.totalPages}>Older posts →</PageLink>
              </nav>
            )}
          </>
        )}
      </main>
      {customFooter ? (
        <Slot html={customFooter.html} className="custom-template-part" />
      ) : (
        <footer className="site-footer">
          <div>
            <a onClick={actions.navigate} className="site-title" href="/">
              {title}
            </a>
            {settings?.tagline && <p>{settings.tagline}</p>}
          </div>
          <div>
            {footerMenu ? (
              <nav aria-label="Footer navigation">
                <Navigation items={footerMenu.items} onNavigate={actions.navigate} />
              </nav>
            ) : (
              <>
                <a onClick={actions.navigate} href="/">Blog</a>
                {site.data?.pages.slice(0, 4).map((item) => (
                  <a onClick={actions.navigate} key={item.id} href={postLink(item)}>
                    {item.title}
                  </a>
                ))}
              </>
            )}
          </div>
          <div className="site-credit">
            <p>Designed with WorldAct</p>
            <a onClick={actions.navigate} href="/login">Log in</a>
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

function SourceDocument({model,state,actions}:{model:PublicDocumentModel;state:PublicInteractionState;actions:PublicDocumentActions}) {
 if(model.presentation.kind!=="source")return null;
 return <>
  {(!state.errorLocal && state.error || state.notice && !state.error) && <div className="worldact-public-notice" role={state.error ? "alert":"status"}>{state.error || state.notice}</div>}
  <div className="wp-site-blocks" data-worldact-public-island="true" ref={actions.sourceRoot} aria-busy={state.busy || undefined} onSubmit={actions.sourceSubmit} onClick={actions.sourceClick} dangerouslySetInnerHTML={{__html:model.presentation.html}} />
  {state.busy && <p className="worldact-public-loading" role="status">Submitting…</p>}
  {model.viewer && <span className="screen-reader-text">Logged in as {model.viewer.displayName}.</span>}
 </>;
}
function Slot({html,className}:{html:string;className:string}) {return <div className={className} data-worldact-public-island="true" dangerouslySetInnerHTML={{__html:html}}/>;}
function PageLink({path,field,page,disabled,children,onNavigate,archive,settings}:{path:string;field:string;page:number;disabled:boolean;children:ReactNode;onNavigate?:PublicDocumentActions["navigate"];archive?:PublicArchive|null;settings?:PublicSettings}) {
 const target=new URL(path,"https://worldact.invalid");target.searchParams.set(field,String(Math.max(1,page)));
 return disabled ? <button disabled>{children}</button> : <a onClick={onNavigate} className="public-page-link" href={field==="page"?publicArchivePageLocation(path,archive,settings,page):target.pathname+target.search}>{children}</a>;
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
function Navigation({
  items,
  parent = null,
  depth = 0,
  onNavigate,
}: {
  onNavigate?:PublicDocumentActions["navigate"];
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
            <a onClick={onNavigate}
              href={item.url}
              target={item.target || "_self"}
              rel={item.target === "_blank" ? "noopener noreferrer" : undefined}
            >
              {item.label}
            </a>
            {items.some((child) => child.parentId === item.id) && (
              <Navigation items={items} parent={item.id} depth={depth + 1} onNavigate={onNavigate} />
            )}
          </li>
        ))}
    </ul>
  );
}
