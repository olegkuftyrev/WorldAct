import {selectPublicSourceTemplate,sourceTemplateCandidates} from "../shared/public-routing";
import type {PublicTemplateRef,NamedAuthorSelection,PublicArchive} from "../shared/public-document";

/** Inspect decoded keys, without selecting an account or normalizing its name.
 * Even malformed recognized keys must reach the server's scalar validation. */
export function hasNamedAuthorParameter(query:URLSearchParams):boolean {
 return [...query.keys()].some(key=>/^author_name(?:\[|$)/.test(key));
}

export function shouldResolveNamedAuthorQuery(query:URLSearchParams):boolean {
 return [...query.keys()].some(key=>/^author_name\[/.test(key)) ||
  query.getAll("author_name").length>1 ||
  query.has("author_name") && query.get("author_name")!=="";
}

/** Name presentation is never a replacement for the original numeric filter.
 * Preserve original scalar spelling, duplicates and nesting for validation. */
export function legacyPublicAuthorQuery(query:URLSearchParams,archive?:PublicArchive):URLSearchParams {
 if(hasNamedAuthorParameter(query))return new URLSearchParams([...query].filter(([key])=>/^author(?:_name)?(?:\[|$)/.test(key)));
 const author=archive && "type" in archive && archive.type==="author"?String(archive.authorId):query.get("author");
 return new URLSearchParams(author?{author}:{});
}

export type PublicResolvedListing={archive?:PublicArchive|null;namedAuthor?:NamedAuthorSelection;kind?:"posts-page"};
/** A selected-null descriptor is a resolved safe-empty listing, not a miss. */
export function isNamedAuthorListing(result:PublicResolvedListing|null):boolean {
 return result?.namedAuthor!==undefined;
}


/** Select the legacy template from resolved presentation while retaining the
 * pre-existing numeric-only query priority outside named listings. */
export function selectLegacyPublicSourceTemplate<T extends PublicTemplateRef>(documents:T[]|undefined,context:Parameters<typeof sourceTemplateCandidates>[0]&{postsPage:boolean;namedAuthor?:NamedAuthorSelection}):T|null {
 const {postsPage,namedAuthor,...source}=context;
 return selectPublicSourceTemplate(documents || [],{...source,author:namedAuthor?source.author&&!source.single&&!postsPage&&!source.date:source.author});
}

/** Named requests retain the visible query, including contradictory path
 * filters and malformed scalar shapes. The server applies path priority. */
export function legacyPublicListingQuery(visible:URLSearchParams,normalized:URLSearchParams):URLSearchParams {
 return new URLSearchParams(hasNamedAuthorParameter(visible)?visible:normalized);
}
