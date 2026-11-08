/** Singular body pagination is independent of archive and Query Loop paging. */
export function contentPageQuery(search: URLSearchParams, resolvedPage?: number) {
  const fromQuery=Number(search.get("page"));
  const requested=resolvedPage ?? fromQuery;
  const page=Number.isInteger(requested) && requested>0 && requested<=2147483647?requested:1;
  const query=new URLSearchParams();
  if(page>1)query.set("page",String(page));
  return {page,query};
}
