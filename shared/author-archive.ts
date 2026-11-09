export type AuthorArchiveSettings={permalinkStructure:string};
export type AuthorArchivePerson={id:number;nicename:string};
const validSlug=(s:string)=>s.length<=50 && /^[a-z0-9_-]+$/.test(s) && s!=="0";
/** Source query-context defaults within the persisted ASCII nicename domain.
 * Unicode query octets cannot identify an ASCII stored nicename; no accents are
 * removed in query context. Malformed/control/segment guards stay independent. */
export function normalizeAuthorArchiveSlug(value:string):string|null{
 if(/[\u0000-\u001f\u007f/\\]/.test(value))return null;
 value=value.replace(/<[^>]*>/g,"");
 if(/[^\x00-\x7f]/.test(value))return null;
 value=value.slice(0,200).replace(/%(?![a-f0-9]{2})/gi,"").toLowerCase().replace(/&.+?;/g,"").replace(/\./g,"-").replace(/[^%a-z0-9 _-]/g,"").replace(/\s+/g,"-").replace(/-+/g,"-").replace(/^-|-$/g,"");
 return validSlug(value)?value:null;
}
export function authorArchivePath(person:AuthorArchivePerson,settings:AuthorArchiveSettings):string{
 if(!Number.isInteger(person.id)||person.id<1||person.id>2147483647||!validSlug(person.nicename))throw new Error("The author archive identity is invalid.");
 const structure=settings.permalinkStructure;
 if(!structure)return `/?author=${person.id}`;
 const front=structure.slice(0,structure.indexOf("%"));
 return front+"author/"+encodeURIComponent(person.nicename)+(structure.endsWith("/")?"/":"");
}
/** null means another namespace; invalid means a reserved author route404. */
export function parseAuthorArchivePath(path:string,settings:AuthorArchiveSettings):{slug:string;page:number;paged:boolean;invalid:boolean}|null{
 if(!settings.permalinkStructure)return null;
 const front=settings.permalinkStructure.slice(0,settings.permalinkStructure.indexOf("%")),prefix=(front+"author").split("/").filter(Boolean);
 const pathname=path.split("?")[0];let segments:string[];
 try{segments=pathname.split("/").filter(Boolean).map(decodeURIComponent);}catch{throw new Error("The URL path is malformed.");}
 if(prefix.some((part,i)=>segments[i]!==part))return null;
 const tail=segments.slice(prefix.length),slug=normalizeAuthorArchiveSlug(tail[0] || "") || "";
 const page=tail.length===3&&tail[1]==="page"&&/^[1-9]\d{0,9}$/.test(tail[2])?Number(tail[2]):1;
 return {slug,page,paged:tail.length===3,invalid:!validSlug(slug)||!(tail.length===1 || tail.length===3&&tail[1]==="page"&&/^[1-9]\d{0,9}$/.test(tail[2])&&page<=2147483647)};
}

export function authorArchivePagePath(permalink:string,page:number):string{
 if(!Number.isInteger(page)||page<1||page>2147483647)throw new Error("The author archive page is invalid.");
 if(page===1)return permalink;
 if(permalink.includes("?")){const [path,raw]=permalink.split("?"),query=new URLSearchParams(raw);query.set("page",String(page));return path+"?"+query;}
 return permalink.replace(/\/$/,"")+"/page/"+page+(permalink.endsWith("/")?"/":"");
}
