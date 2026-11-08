import { renderSiteDocument, type RenderOptions } from "./block-renderer.js";

/** Shared direct rendering operation for the template API and document loader.
 * Callers supply already authorized request context, never saved/query grants. */
export function renderPublicTemplateDocument(document: Parameters<typeof renderSiteDocument>[0], options: RenderOptions) {
  return renderSiteDocument(document, {...options,placeholderBindings:false});
}

export const classicDefaultDocuments: Record<string,string> = {
  header: '<header class="site-header"><div class="site-title">{{siteTitle}}</div><nav>{{navigation}}</nav></header>',
  footer: '<footer class="site-footer"><strong>{{siteTitle}}</strong><p>{{tagline}}</p><p>Designed with WorldAct</p></footer>',
  single: '<article class="single-post"><h1>{{postTitle}}</h1><p class="post-meta">{{postDate}} · {{postAuthor}}</p><div class="public-content">{{content}}</div></article>',
  page: '<article class="single-post"><h1>{{postTitle}}</h1><div class="public-content">{{content}}</div></article>',
  index: '<main class="site-main"><h1>Blog</h1>{{postList}}</main>',
};
