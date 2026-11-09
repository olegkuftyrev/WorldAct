import {authorArchivePath,authorArchiveRequestPath,resolvePrettyAuthorArchive,type AuthorArchive} from "./author-archives.js";
import { z } from "zod";
import { pool, getSettings, postFields, type User } from "./db.js";
import { withPermalink } from "./permalinks.js";
import { enhancePublicPost } from "./design.js";
import { renderPublicContent, type RenderOptions } from "./block-renderer.js";
import { contentPagination, parseContentPage } from "./legacy-content.js";
import { publicCommentWindow } from "./comment-window.js";
import { renderedCommentContent } from "./comment-policy.js";
import { avatarURL } from "./avatars.js";
import { appendPostDateArchiveSQL, dateArchiveDTO, parseDateArchiveQuery } from "./date-archives.js";
import { HttpError } from "./utils.js";
import {completePublicRead,observePublicPost,observePublicAuthor,settledPublicReads} from "./public-read-attempt.js";
import {listingRequestPath,hasNamedAuthorQuery,listingFilterValues,publicListingWhere,normalizeListingQuery,type PublicListingContext,type NamedAuthorPin} from "./author-query.js";
import {readPublicPath} from "./public-path.js";
import {resolvePublicDocumentRoute} from "./public-documents.js";
import {ordinaryListingPageRequested} from "./public-listing-page.js";

export type PublicReadContext = {
  query: Record<string, unknown>; requestPath?: string; user?: User;authorArchive?:AuthorArchive;
  listing?:PublicListingContext;
  canReadProtectedPost: NonNullable<RenderOptions["canReadProtectedPost"]>;
};
function decoratePost(post: any) {
  const terms=post.terms || [];
  return {...post,terms,categories:terms.filter((term:any)=>term.taxonomy==="category"),tags:terms.filter((term:any)=>term.taxonomy==="tag"),categoryIds:terms.filter((term:any)=>term.taxonomy==="category").map((term:any)=>term.id),tagIds:terms.filter((term:any)=>term.taxonomy==="tag").map((term:any)=>term.id)};
}
export async function publicPost(post:any,locked=false,options:RenderOptions={}){
  if(options.preview || !options.canReadProtectedPost)return publicPostOnce(post,locked,options);
  return completePublicRead(options.canReadProtectedPost,reader=>publicPostOnce(post,locked,{...options,canReadProtectedPost:reader}),options.db || pool);
}
async function publicPostOnce(post: any, locked = false, options: RenderOptions = {}) {
  if(!options.preview)observePublicPost(options.canReadProtectedPost,{...post,locked});
  const {
    blocks: _blocks,
    rawContent: _rawContent,
    raw_content: _raw,
    pendingCommentCount: _pendingCommentCount,
    ...safe
  } = decoratePost(post);
  const db=options.db || pool,settings=await getSettings(db),linked = await withPermalink(safe,settings,db);
  // Author structures add an asynchronous metadata read after body selection.
  // Recheck current public identity and password access after that wait, before
  // returning or rendering any selected body. Preview keeps its editor policy.
  if(!options.preview && post.type==="post" && settings.permalinkStructure.includes("%author%")){
    const current=(await db.query(`SELECT password_hash IS NOT NULL AS "hasPassword" FROM posts
      WHERE id=$1 AND type='post' AND status='publish'`,[post.id])).rows[0];
    if(!current)throw new HttpError(404,"Post not found.");
    linked.hasPassword=current.hasPassword;
    locked=Boolean(current.hasPassword) && !(options.canReadProtectedPost && await options.canReadProtectedPost(post.id,db));
  }
  if(!options.preview)observePublicPost(options.canReadProtectedPost,{...linked,locked});
  const result = {
    ...linked,
    commentCount: safe.approvedCommentCount ?? safe.commentCount ?? 0,
    locked,
    footnotes: locked ? [] : safe.footnotes ?? [],
    ...(!locked ? { contentPagination: contentPagination(post, linked.permalink, options.contentPage || 1, options.preview,settings.permalinkStructure) } : {}),
    content: locked ? "" : await renderPublicContent({ ...post, locked }, { requestPath: linked.permalink, ...options }),
    excerpt: locked ? "" : safe.excerpt,
  };
  return locked ? result : enhancePublicPost(result);
}
export async function commentResponse(postId: number, context: PublicReadContext, locked = false) {
  const requestedPage = z.coerce
    .number()
    .int()
    .positive()
    .max(2_147_483_647)
    .optional()
    .parse(context.query.commentPage);
  const settings = await getSettings();
  const window = locked
    ? { comments: [], total: 0, totalTopLevelComments: 0, totalPages: 1, page: 1, perPage: settings.paginateComments ? settings.commentsPerPage : 1 }
    : await publicCommentWindow(postId, requestedPage, settings);
  return {
    comments: window.comments.map(({ _avatarEmail, _accountAvatarEmail, ...comment }) => ({
      ...comment, content: renderedCommentContent(comment.content,comment.type),
      avatarUrl: comment.type === "comment" ? avatarURL(_accountAvatarEmail ?? _avatarEmail, settings) : null,
    })),
    commentsPagination: {
      page: window.page,
      perPage: window.perPage,
      totalComments: window.total,
      totalTopLevelComments: window.totalTopLevelComments,
      totalPages: window.totalPages,
    },
  };
}
export function readPublicSite(context:PublicReadContext){
  const selection:{author?:AuthorArchive;named:NamedAuthorPin}={author:context.authorArchive,named:{value:context.listing?.namedAuthor}};
  return completePublicRead(context.canReadProtectedPost,reader=>readPublicSiteOnce({...context,canReadProtectedPost:reader},selection));
}
async function readPublicSiteOnce(context: PublicReadContext,selection:{author?:AuthorArchive;named:NamedAuthorPin}) {
  const selectedAuthor=context.authorArchive || selection.author;
  if(selectedAuthor)observePublicAuthor(context.canReadProtectedPost,selectedAuthor);
  if(selection.named.value?.selected)observePublicAuthor(context.canReadProtectedPost,selection.named.value.selected);
  const settings=await getSettings();
  let listing=context.listing;
  const nameVisible=hasNamedAuthorQuery(context.query,context.requestPath);
  if(!listing&&(nameVisible||ordinaryListingPageRequested(context.query,context.requestPath))){
    const path=listingRequestPath(context.requestPath,context.query),resolved=await resolvePublicDocumentRoute(path,{namedPin:selection.named,authenticated:Boolean(context.user)});
    if(resolved.status===404)throw new HttpError(404,"Public listing page not found.");
    listing=resolved.listing;
    if(listing||nameVisible){
      const query=normalizeListingQuery(readPublicPath(path).query,{singular:["singular","front-page"].includes(resolved.kind),archive:resolved.archive,namedAuthor:listing?.namedAuthor});
      context={...context,query:{...query.values,page:query.archivePage}};
    }
  }
  const named=listing?.namedAuthor;
  if(named?.selected)observePublicAuthor(context.canReadProtectedPost,named.selected);
  const pretty=!named&&context.requestPath?await resolvePrettyAuthorArchive(authorArchiveRequestPath(context.requestPath,context.query,settings),settings):null;
  if(pretty?.recognized && !pretty.archive)throw new HttpError(404,"Author archive not found.");
  if(!named&&selectedAuthor && (!pretty?.archive || pretty.archive.authorId!==selectedAuthor.authorId || pretty.archive.slug!==selectedAuthor.slug))throw new HttpError(404,"The author archive identity changed.");
  if(pretty?.archive){selection.author ||= pretty.archive;observePublicAuthor(context.canReadProtectedPost,pretty.archive);}
  const filter = z
    .object({
      page: z.coerce.number().int().positive().max(2_147_483_647).default(1),
      search: z.string().trim().max(200).optional(),
      category: z.string().min(1).max(220).optional(),
      tag: z.string().min(1).max(220).optional(),
      author: z.coerce.number().int().positive().max(2147483647).optional(),
    })
    .parse({...listingFilterValues(context.query,listing?.archive || null),...(pretty?.archive?{author:pretty.archive.authorId,page:pretty.archive.page || context.query.page}: {})});
  let args: unknown[] = [];
  const dateArchive = parseDateArchiveQuery(listingFilterValues(context.query,listing?.archive || null));
  let where = "p.type='post' AND p.status='publish'";
  if (filter.author) { args.push(filter.author); where += ` AND p.author_id=$${args.length}`; }
  if (filter.search) {
    args.push(`%${filter.search}%`);
    where += ` AND (p.title ILIKE $${args.length} OR p.content ILIKE $${args.length} OR p.excerpt ILIKE $${args.length})`;
    if (!context.user) where += " AND p.password_hash IS NULL";
  }
  for (const taxonomy of ["category", "tag"] as const)
    if (filter[taxonomy]) {
      args.push(filter[taxonomy]);
      where += ` AND EXISTS(SELECT 1 FROM post_terms pt JOIN terms t ON t.id=pt.term_id WHERE pt.post_id=p.id AND t.taxonomy='${taxonomy}' AND t.slug=$${args.length})`;
    }
  const dateWhere: string[] = [];
  appendPostDateArchiveSQL(dateWhere, args, "p.post_date::timestamp without time zone", dateArchive, settings.timezone, settings.weekStartsOn);
  if (dateWhere.length) where += " AND " + dateWhere.map((clause) => `(${clause})`).join(" AND ");
  if(listing){const predicate=publicListingWhere(listingFilterValues(context.query,listing.archive),settings,named,Boolean(context.user));where=predicate.where.join(" AND ");args=predicate.args;}
  if(listing?.kind==="not-found")where+=" AND FALSE";
  const count = await pool.query(
    `SELECT count(*)::int AS total FROM posts p WHERE ${where}`,
    args,
  );
  if(named&&context.requestPath&&filter.page>1&&(filter.page-1)*settings.postsPerPage>=Number(count.rows[0].total))throw new HttpError(404,"Named author archive page not found.");
  args.push(settings.postsPerPage, (filter.page - 1) * settings.postsPerPage);
  const [posts, pages] = await Promise.all([
    pool.query(
      `SELECT ${postFields},p.password_hash AS "_passwordHash" FROM posts p JOIN users u ON u.id=p.author_id WHERE ${where} ORDER BY ${named || dateArchive || filter.search || filter.author || filter.category || filter.tag ? "" : "p.sticky DESC,"}p.published_at DESC,p.id DESC LIMIT $${args.length - 1} OFFSET $${args.length}`,
      args,
    ),
    pool.query(
      `SELECT ${postFields},p.password_hash AS "_passwordHash" FROM posts p JOIN users u ON u.id=p.author_id WHERE p.type='page' AND p.status='publish' ORDER BY p.menu_order,p.title,p.id`,
    ),
  ]);
  const sanitize = async (post: any, contentMode: "singular" | "archive" = "singular") => {
    const { _passwordHash, ...safe } = post;
    return publicPost(
      safe,
      Boolean(_passwordHash) && !(await context.canReadProtectedPost(post.id, pool)),
      { query: context.query, listing, requestPath: "/", user: context.user, contentMode, canReadProtectedPost: context.canReadProtectedPost },
    );
  };
  const { defaultPingbackFlag: _outgoingFlag, pingServices: _pingServices, adminEmail: _adminEmail, commentModerationKeys: _moderationKeys, disallowedCommentKeys: _disallowedKeys, ...safeSettings } = settings;
  const author = !named&&listing?.kind!=="not-found"&&filter.author ? (await pool.query("SELECT id,nicename,display_name AS name FROM users WHERE id=$1 AND EXISTS(SELECT 1 FROM posts WHERE author_id=$1 AND type='post' AND status='publish')", [filter.author])).rows[0] : null;
  const icon = settings.siteIconId
    ? (
        await pool.query(
          "SELECT filename,sizes FROM media WHERE id=$1 AND mime_type LIKE 'image/%'",
          [settings.siteIconId],
        )
      ).rows[0]
    : null;
  const totalPosts = count.rows[0].total;
  const safePages = await settledPublicReads(pages.rows.map(post => sanitize(post)));
  const frontPage =
    settings.frontPageMode === "page"
      ? (safePages.find((page) => page.id === settings.frontPageId) ?? null)
      : null;
  const postsPage =
    safePages.find((page) => page.id === settings.postsPageId) ?? null;
  return {
    settings: {
      ...safeSettings,
      siteIconUrl: icon ? `/uploads/${icon.filename}` : null,
      siteIconSizes:icon?.sizes || {},
    },
    archive: listing?.kind==="not-found"?listing.archive:named?listing!.archive:pretty?.archive || (dateArchive ? dateArchiveDTO(dateArchive) : author ? { type: "author", name: author.name, authorId: filter.author!,slug:author.nicename,permalink:authorArchivePath(author,settings) } : null),
    posts: await settledPublicReads(posts.rows.map(post => sanitize(post, "archive"))),
    pages: safePages,
    frontPage,
    postsPage,
    pagination: {
      page: filter.page,
      totalPosts,
      totalPages: Math.max(1, Math.ceil(totalPosts / settings.postsPerPage)),
    },
  };
}

/** Body acquisition is independently fenced to the already resolved immutable
 * identity/type and current publication. A later slug reassignment cannot win. */
export function readPublishedPostById(id:number,type:"post"|"page",context:PublicReadContext){
  return completePublicRead(context.canReadProtectedPost,reader=>readPublishedPostByIdOnce(id,type,{...context,canReadProtectedPost:reader}));
}
async function readPublishedPostByIdOnce(id: number, type: "post" | "page", context: PublicReadContext) {
  const row=(await pool.query(`SELECT ${postFields},p.password_hash AS "_passwordHash" FROM posts p JOIN users u ON u.id=p.author_id WHERE p.id=$1 AND p.type=$2 AND p.status='publish'`,[id,type])).rows[0];
  if(!row) throw new HttpError(404,"Post not found.");
  const {_passwordHash,...post}=row;
  const locked=Boolean(_passwordHash) && !(await context.canReadProtectedPost(id,pool));
  const visible=await publicPost(post,locked,{query:context.query,user:context.user,requestPath:context.requestPath,contentPage:parseContentPage(context.query.page),canReadProtectedPost:context.canReadProtectedPost});
  return {post:visible,...(await commentResponse(id,context,visible.locked)),rawPost:{...post,hasPassword:visible.hasPassword,locked:visible.locked,...(visible.locked?{content:"",rawContent:"",raw_content:"",blocks:[],excerpt:"",footnotes:[]}: {})}};
}
