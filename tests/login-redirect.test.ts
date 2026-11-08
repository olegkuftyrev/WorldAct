import { test } from "./isolated-test.js";
import assert from "node:assert/strict";
import { normalizeLoginRedirect } from "../src/loginRedirect.js";
test("public login returns stay on this site and reject encoded external prefixes and auth loops",()=>{
  const origin="https://worldact.example";
  for(const [input,expected] of [["/","/"],["/2024/03/?page=2#posts","/2024/03/?page=2#posts"],["/admin/posts/1","/admin/posts/1"],[origin+"/notes?q=two%20words#part","/notes?q=two%20words#part"]])assert.equal(normalizeLoginRedirect(input,origin),expected);
  for(const input of ["https://elsewhere.example/","//elsewhere.example/","/%2f%2fevil.example","/%252f%252fevil.example","/\\evil.example","/%5cevil.example","/%0alogin","/login?redirect_to=/login","/logout","/public-login","/api/auth/login","/wp-login.php","https://user@worldact.example/"])assert.equal(normalizeLoginRedirect(input,origin),null,input);
  assert.equal(normalizeLoginRedirect("/"+"a".repeat(2000),origin),null);
});
