import {pool} from "./db.js";
import type {BlockDatabase,RenderPost,RenderOptions} from "./block-renderer.js";
import {currentPublicPostPolicies,postHasPassword} from "./post-passwords.js";
import {HttpError} from "./utils.js";

type Reader=NonNullable<RenderOptions["canReadProtectedPost"]>;
type Observation={id:number;type:"post"|"page";authorId?:number;hasPassword?:boolean;locked?:boolean};
const observations=Symbol("complete-public-read");
const editorial=Symbol("authorized-editorial-post");
type ObservedReader=Reader & {[observations]?:Map<string,Observation>;[editorial]?:Map<number,string>};

/** REST's established authenticated editorial permission is independent of a
 * public password cookie. Only its already-authorized selected post gets this
 * scope; unrelated nested public query bodies retain their normal policy. */
export function editorialPostReader(reader:Reader,post:RenderPost):Reader{
  return Object.assign(((id:number,db:BlockDatabase)=>reader(id,db)) as ObservedReader,reader,
    {[editorial]:new Map([...(reader as ObservedReader)[editorial] || [],[post.id,post.status]])});
}

export async function settledPublicReads<T>(reads:Promise<T>[]):Promise<T[]>{
  const results=await Promise.allSettled(reads);
  for(const result of results)if(result.status==="rejected")throw result.reason;
  return results.map(result=>(result as PromiseFulfilledResult<T>).value);
}

/** Server-only request observations, never saved attributes or public DTO data.
 * Keep earlier observations even if the same post is read again differently. */
export function observePublicPost(reader:Reader|undefined,post:RenderPost,body=true){
  const set=(reader as ObservedReader|undefined)?.[observations];
  if(!set || !["post","page"].includes(post.type) || !Number.isSafeInteger(post.id))return;
  const editorialStatus=(reader as ObservedReader)[editorial]?.get(post.id);
  if(editorialStatus && editorialStatus!=="publish")return;
  if(editorialStatus)body=false;
  const authorId=Number(post.authorId ?? post.author_id);
  const item:Observation={id:post.id,type:post.type,...(Number.isSafeInteger(authorId)&&authorId>0?{authorId}:{}),
    ...(body?{hasPassword:postHasPassword(post),locked:Boolean(post.locked)}:{})};
  set.set(JSON.stringify(item),item);
}

/** One owner retries the entire result, including every nested body/template.
 * Nested services share its collector and never reset it or emit partial data. */
export async function completePublicRead<T>(reader:Reader,work:(reader:Reader)=>Promise<T>,db:BlockDatabase=pool):Promise<T>{
  if((reader as ObservedReader)[observations])return work(reader);
  for(let attempt=0;attempt<2;attempt++){
    const set=new Map<string,Observation>();
    const observed=Object.assign(((id:number,source:BlockDatabase)=>reader(id,source)) as ObservedReader,reader,{[observations]:set});
    let result:T|undefined,error:unknown;
    try{result=await work(observed);}catch(caught){error=caught;}
    if(error && !(error instanceof HttpError && error.status===404))throw error;
    const expected=[...set.values()],current=await currentPublicPostPolicies([...new Set(expected.map(item=>item.id))],reader,db);
    const stable=expected.every(item=>{
      const row=current.find(row=>row.id===item.id);
      return row && row.type===item.type && (item.authorId===undefined || row.authorId===item.authorId)
        && (item.hasPassword===undefined || row.hasPassword===item.hasPassword && row.locked===item.locked);
    });
    if(stable){if(error)throw error;return result as T;}
    if(attempt===1)throw new HttpError(409,"The public document changed while it was being rendered. Reload to continue.");
  }
  throw new HttpError(409,"The public document changed while it was being rendered. Reload to continue.");
}
