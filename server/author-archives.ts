import {pool,getSettings} from "./db.js";
import {HttpError} from "./utils.js";
import {authorArchivePath,parseAuthorArchivePath} from "../shared/author-archive.js";
export {authorArchivePath} from "../shared/author-archive.js";
type Settings=Awaited<ReturnType<typeof getSettings>>;
type Database=Pick<typeof pool,"query">;
export type AuthorArchive={type:"author";name:string;authorId:number;slug:string;permalink:string;page?:number};
export async function resolvePrettyAuthorArchive(path:string,settings?:Settings,db:Database=pool):Promise<{recognized:boolean;archive:AuthorArchive|null}>{
 if(path.length>2000)throw new HttpError(414,"The URL exceeds the supported length.");
 if(!path.startsWith("/")||path.startsWith("//")||/[\u0000-\u001f\u007f#\\]/.test(path))throw new HttpError(400,"Use a site-relative path.");
 try{decodeURIComponent(path);}catch{throw new HttpError(400,"The URL path is malformed.");}
 const s=settings || await getSettings(db);let parsed;
 try{parsed=parseAuthorArchivePath(path,s);}catch(error){throw new HttpError(400,(error as Error).message);}
 if(!parsed)return {recognized:false,archive:null};
 // Existing configured taxonomy paths keep their established priority.
 const parts=path.split("?")[0].split("/").filter(Boolean).map(decodeURIComponent);
 if(parts.length===2 && [s.categoryBase,s.tagBase].includes(parts[0]))return {recognized:false,archive:null};
 if(parsed.invalid)return {recognized:true,archive:null};
 const query=new URLSearchParams(path.includes("?")?path.slice(path.indexOf("?")+1):"");
 for(const [key] of query)if(/^(?:page|author)(?:\[|$)/.test(key) && (key.includes("[")||query.getAll(key).length!==1))throw new HttpError(400,"Use a single scalar author archive counter.");
 if(query.has("page") && (!/^[1-9]\d{0,9}$/.test(query.get("page")!)||Number(query.get("page"))>2147483647))throw new HttpError(400,"Use a valid author archive page.");
 if(parsed.paged && query.has("page") && Number(query.get("page"))!==parsed.page)throw new HttpError(400,"The author archive page counters conflict.");
 const page=query.has("page")?Number(query.get("page")):parsed.page;
 const person=(await db.query('SELECT id,nicename,display_name AS name FROM users WHERE nicename=$1',[parsed.slug])).rows[0];
 if(!person)return {recognized:true,archive:null};
 if(query.has("author") && query.get("author")!==String(person.id))throw new HttpError(400,"The author archive identities conflict.");
 if(page>1){const count=Number((await db.query("SELECT count(*)::int AS n FROM posts WHERE author_id=$1 AND type='post' AND status='publish'",[person.id])).rows[0].n);if((page-1)*s.postsPerPage>=count)return {recognized:true,archive:null};}
 // Final persisted identity check after any count/expression wait. Read-only
 // caller transactions intentionally retain their coherent historical snapshot.
 const readonly=(await db.query("SHOW transaction_read_only")).rows[0].transaction_read_only==="on";
 try{if(!(await db.query('SELECT id FROM users WHERE id=$1 AND nicename=$2'+(readonly?'':' FOR SHARE NOWAIT'),[person.id,parsed.slug])).rowCount)return {recognized:true,archive:null};}
 catch(error){if(["55P03","40001"].includes((error as {code:string}).code))throw new HttpError(409,"The author archive changed while it was read.");throw error;}
 return {recognized:true,archive:{type:"author",name:person.name,authorId:person.id,slug:person.nicename,permalink:authorArchivePath(person,s),...(page>1?{page}:{})}};
}
