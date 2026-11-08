import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import { pool } from "../server/db.js";
const base=process.env.TEST_API_URL || "http://127.0.0.1:3001",origin=process.env.APP_ORIGIN || "http://127.0.0.1:5173";
test("comment capabilities follow parent ownership and restore retains approval and reply hierarchy",async()=>{
  const stamp="comment-caps-"+Date.now().toString(36),password="Temporary-"+stamp;
  let admin="";const users:number[]=[],posts:number[]=[],sessions:string[]=[];
  const api=async(path:string,method="GET",body?:unknown,cookie=admin)=>{
    const response=await fetch(base+path,{method,headers:{Origin:origin,"Content-Type":"application/json",Cookie:cookie},...(body===undefined?{}:{body:JSON.stringify(body)})});return {response,data:await response.json()};
  };
  const ok=async(path:string,method="GET",body?:unknown,cookie=admin)=>{const result=await api(path,method,body,cookie);assert.ok(result.response.ok,`${path}: ${result.response.status} ${JSON.stringify(result.data)}`);return result.data;};
  const createPost=async(authorId:number,status="publish",extra:Record<string,unknown>={})=>{const post=(await ok("/api/posts","POST",{title:stamp,authorId,status,...extra})).post;posts.push(post.id);return post;};
  const comment=async(postId:number,status="approved",extra:Record<string,unknown>={})=>(await ok("/api/comments","POST",{postId,status,authorEmail:stamp+"@example.invalid",content:"<p>Comment body</p>",...extra})).comment;
  try{
    const signed=await api("/api/auth/login","POST",{login:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD},"");assert.equal(signed.response.status,200);admin=signed.response.headers.get("set-cookie")!.split(";")[0];
    const people:Record<string,{id:number;cookie:string}>={};
    for(const role of ["author","contributor","subscriber"]){
      const user=(await ok("/api/users","POST",{username:stamp+role,email:stamp+role+"@example.invalid",displayName:role,role,password})).user;users.push(user.id);
      const login=await api("/api/auth/login","POST",{login:user.username,password},"");assert.equal(login.response.status,200);const cookie=login.response.headers.get("set-cookie")!.split(";")[0];sessions.push(cookie);people[role]={id:user.id,cookie};
    }
    const own=await createPost(people.author.id),other=await createPost(signed.data.user.id),hidden=await createPost(signed.data.user.id,"draft"),protectedPost=await createPost(signed.data.user.id,"publish",{password:"Protected-for-comments"});
    const draft=await createPost(people.contributor.id,"draft"),published=await createPost(people.contributor.id);
    const ownComment=await comment(own.id),otherComment=await comment(other.id),secret=await comment(hidden.id),protectedComment=await comment(protectedPost.id),draftComment=await comment(draft.id),publishedComment=await comment(published.id);
    assert.equal((await api("/api/comments","GET",undefined,people.subscriber.cookie)).response.status,403);
    const list=await ok("/api/comments?search="+stamp,"GET",undefined,people.author.cookie);
    assert.equal(list.permissions.bulk,false);assert.equal(list.permissions.empty,false);
    assert.equal(list.comments.find((c:any)=>c.id===ownComment.id).permissions.edit,true);
    const readonly=list.comments.find((c:any)=>c.id===otherComment.id);assert.equal(readonly.permissions.edit,false);assert.equal(readonly.authorEmail,undefined);assert.equal(readonly.userId,undefined);
    assert.ok(!list.comments.some((c:any)=>[secret.id,protectedComment.id,draftComment.id].includes(c.id)));
    assert.equal((await ok("/api/comments?postId="+hidden.id,"GET",undefined,people.author.cookie)).pagination.total,0);
    assert.equal((await ok("/api/comments?postId="+other.id+"&search="+encodeURIComponent(stamp+"@example.invalid"),"GET",undefined,people.author.cookie)).pagination.total,0);
    assert.equal((await api("/api/comments/"+otherComment.id,"PUT",{content:"Forbidden"},people.author.cookie)).response.status,403);
    assert.equal((await api("/api/comments/"+otherComment.id,"DELETE",undefined,people.author.cookie)).response.status,403);
    assert.equal((await api("/api/comments","POST",{postId:other.id,content:"Forbidden"},people.author.cookie)).response.status,403);
    assert.equal((await api("/api/comments/"+draftComment.id,"PUT",{content:"Contributor edited"},people.contributor.cookie)).response.status,200);
    assert.equal((await api("/api/comments/"+publishedComment.id,"PUT",{content:"Forbidden"},people.contributor.cookie)).response.status,403);
    assert.equal((await ok("/api/comments?postId="+published.id,"GET",undefined,people.contributor.cookie)).comments[0].permissions.edit,false);
    const mine=(await ok("/api/comments","POST",{postId:own.id,content:"Author reply",parentId:ownComment.id},people.author.cookie)).comment;
    const mineList=await ok("/api/comments?mine=true","GET",undefined,people.author.cookie);assert.ok(mineList.comments.some((c:any)=>c.id===mine.id));assert.ok(!mineList.comments.some((c:any)=>c.id===ownComment.id));assert.ok(mineList.counts.mine>=1);
    assert.equal((await api("/wp-json/wp/v2/comments?context=edit&post="+own.id,"GET",undefined,people.author.cookie)).response.status,403);
    assert.equal((await api("/wp-json/wp/v2/comments/"+ownComment.id+"?context=edit","GET",undefined,people.author.cookie)).response.status,403);
    assert.equal((await api("/wp-json/wp/v2/comments/"+otherComment.id+"?context=edit","GET",undefined,people.author.cookie)).response.status,403);
    assert.equal((await api("/wp-json/wp/v2/comments","POST",{post:own.id,content:"Guest REST comment"},"")).response.status,401);
    const restComment=(await ok("/api/comments","POST",{postId:own.id,content:"REST trash fixture"},people.author.cookie)).comment;
    assert.equal((await api("/wp-json/wp/v2/comments/"+restComment.id,"DELETE",undefined,people.subscriber.cookie)).response.status,403);
    const trashed=await ok("/wp-json/wp/v2/comments/"+restComment.id,"DELETE",undefined,people.author.cookie);assert.equal(trashed.status,"trash");assert.equal(trashed.id,restComment.id);
    assert.equal((await pool.query("SELECT status FROM comments WHERE id=$1",[restComment.id])).rows[0].status,"trash");
    assert.equal((await api("/wp-json/wp/v2/comments/"+restComment.id,"DELETE",undefined,people.author.cookie)).response.status,410);
    const removed=await ok("/wp-json/wp/v2/comments/"+restComment.id+"?force=true","DELETE",undefined,people.author.cookie);assert.equal(removed.deleted,true);assert.equal(removed.previous.id,restComment.id);assert.equal(removed.previous.status,"trash");
    assert.equal((await pool.query("SELECT 1 FROM comments WHERE id=$1",[restComment.id])).rowCount,0);
    await ok("/api/comments/"+ownComment.id,"PUT",{status:"trash"},people.author.cookie);
    assert.equal((await ok("/api/comments/"+ownComment.id,"PUT",{restore:true},people.author.cookie)).comment.status,"approved");
    await ok("/api/comments/"+ownComment.id,"PUT",{status:"pending"},people.author.cookie);
    await ok("/api/comments/"+ownComment.id,"PUT",{status:"spam"},people.author.cookie);
    await ok("/api/comments/"+ownComment.id,"PUT",{status:"spam"},people.author.cookie);
    assert.equal((await ok("/api/comments/"+ownComment.id,"PUT",{restore:true},people.author.cookie)).comment.status,"pending");
    await ok("/api/comments/"+ownComment.id,"PUT",{status:"spam"},people.author.cookie);await ok("/api/comments/"+ownComment.id,"PUT",{status:"trash"},people.author.cookie);
    assert.equal((await ok("/api/comments/"+ownComment.id,"PUT",{restore:true},people.author.cookie)).comment.status,"spam");
    assert.equal((await api("/api/comments/"+mine.id,"PUT",{restore:true},people.author.cookie)).response.status,400);
    const grandchild=(await ok("/api/comments","POST",{postId:own.id,content:"Grandchild",parentId:mine.id},people.author.cookie)).comment;
    await ok("/api/comments/"+mine.id,"DELETE",undefined,people.author.cookie);
    assert.equal((await pool.query("SELECT parent_id FROM comments WHERE id=$1",[grandchild.id])).rows[0].parent_id,ownComment.id);
    assert.equal((await api("/api/comments/empty","POST",{status:"spam"},people.author.cookie)).response.status,403);
    const spamParent=await comment(other.id,"spam",{parentId:otherComment.id});
    const survivor=await comment(other.id,"approved",{parentId:spamParent.id});
    await pool.query("INSERT INTO comments(post_id,author_name,author_email,content,status) SELECT $1,'Temporary batch','','Batch spam','spam' FROM generate_series(1,501)",[other.id]);
    const first=await ok("/api/comments/empty","POST",{status:"spam",postId:other.id});assert.equal(first.deleted,500);assert.equal(first.hasMore,true);
    const last=await ok("/api/comments/empty","POST",{status:"spam",postId:other.id});assert.equal(last.deleted,2);assert.equal(last.hasMore,false);
    assert.equal((await pool.query("SELECT parent_id FROM comments WHERE id=$1",[survivor.id])).rows[0].parent_id,otherComment.id);
    assert.equal((await pool.query("SELECT status FROM comments WHERE id=$1",[ownComment.id])).rows[0].status,"spam");
  }finally{
    await pool.query("DELETE FROM posts WHERE id=ANY($1::int[])",[posts]);
    for(const cookie of sessions)await api("/api/auth/logout","POST",{},cookie);
    for(const id of users)await api("/api/users/"+id,"DELETE");
    if(admin)await api("/api/auth/logout","POST",{});
    await pool.end();
  }
});
