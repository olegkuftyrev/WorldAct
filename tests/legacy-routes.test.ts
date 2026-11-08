import test from "./isolated-test.js";
import assert from "node:assert/strict";
const base=process.env.TEST_API_URL!;
async function redirected(path:string){
  const response=await fetch(base+path,{redirect:"manual"});assert.equal(response.status,302);
  const target=new URL(response.headers.get("location")!,base);assert.equal(target.origin,new URL(base).origin);return target;
}
test("supported source admin aliases preserve the actual connector, font, upload and creation destinations",async()=>{
  for(const [source,path,query] of [
    ["options-connectors.php","/admin/settings/connectors",{}],
    ["font-library.php","/admin/appearance/fonts",{}],
    ["media-new.php","/admin/media",{upload:"1"}],
    ["plugin-install.php","/admin/plugins",{tab:"add"}],
    ["user-new.php","/admin/users",{new:"1"}],
    ["upload.php?item=33","/admin/media/33",{}],
  ] as const){
    const target=await redirected("/wp-admin/"+source);assert.equal(target.pathname,path);assert.deepEqual(Object.fromEntries(target.searchParams),query);
  }
  assert.equal((await redirected("/wp-admin/options-connectors.php?redirect_to=https://other.example.test/")).pathname,"/admin/settings/connectors");
});
test("source comment aliases preserve grouped type, moderation and search without accepting unknown type shapes",async()=>{
  const grouped=await redirected("/wp-admin/edit-comments.php?comment_type=pings&comment_status=moderated&s=first%20ping");
  assert.equal(grouped.pathname,"/admin/comments");assert.deepEqual(Object.fromEntries(grouped.searchParams),{status:"pending",search:"first ping",type:"pings"});
  for(const query of ["comment_type=unsupported","comment_type%5B0%5D=pings"]){const target=await redirected("/wp-admin/edit-comments.php?"+query);assert.equal(target.searchParams.has("type"),false);}
});
