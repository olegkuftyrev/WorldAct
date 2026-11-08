import test, { after } from "./isolated-test.js";
import "dotenv/config";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DOMParser } from "linkedom";
import { pool } from "../server/db.js";
import { hashPassword } from "../server/auth.js";
import { renderSiteDocument } from "../server/block-renderer.js";
import { cleanContent } from "../server/utils.js";
const base = process.env.TEST_API_URL || "http://127.0.0.1:3001";
const origin = new URL(process.env.APP_ORIGIN || "http://127.0.0.1:5173").origin;
const block = (attrs: Record<string, unknown> = {}) => `<!-- wp:loginout ${JSON.stringify(attrs)} /-->`;
const dom = (html: string) => new DOMParser().parseFromString(html, "text/html");
const cookieOf = (response: Response) => (response.headers.get("set-cookie") || "").split(";")[0];
after(async () => { await pool.end(); });

test("LoginOut uses source form/link controls and safe current URLs without duplicate form IDs", async () => {
  const path = "/news/?page=2#read", query = { search: "two words", postId: "9", requestPath: "/wrong", preview: "true" };
  const link = dom(await renderSiteDocument({ rawContent: block({redirectToCurrent:false}) }, { requestPath: path, query }));
  assert.equal(link.querySelector("a")?.getAttribute("href"), "/login");
  assert.ok(link.querySelector(".wp-block-loginout.logged-out"));
  const returnLink = dom(await renderSiteDocument({ rawContent: block({ redirectToCurrent: true }) }, { requestPath: path, query }));
  assert.equal(new URL(returnLink.querySelector("a")!.getAttribute("href")!, origin).searchParams.get("redirect_to"), "/news/?page=2&search=two+words#read");
  const defaultLink=dom(await renderSiteDocument({rawContent:block()},{requestPath:path,query}));
  assert.equal(defaultLink.querySelector("a")?.getAttribute("href"),returnLink.querySelector("a")?.getAttribute("href"));
  const forms = dom(await renderSiteDocument({ rawContent: block({ displayLoginAsForm: true }) + block({ displayLoginAsForm: true, redirectToCurrent: true }) }, { requestPath: path, query }));
  const elements = [...forms.querySelectorAll("form")]; assert.equal(elements.length, 2);
  assert.notEqual(elements[0].id, elements[1].id);
  for (const form of elements) {
    assert.equal(form.getAttribute("action"), "/public-login"); assert.equal(form.getAttribute("method"), "post");
    assert.equal(form.querySelector('[name="log"]')?.getAttribute("autocomplete"), "username");
    assert.equal(form.querySelector('[name="pwd"]')?.getAttribute("type"), "password");
    assert.equal(form.querySelector('[name="pwd"]')?.getAttribute("value") || "", "");
    assert.equal(form.querySelector('[name="rememberme"]')?.getAttribute("value"), "forever");
    assert.equal(form.querySelector('[name="rememberme"]')?.hasAttribute("checked"), false);
    assert.equal(form.querySelector('[name="redirect_to"]')?.getAttribute("value"), "/news/?page=2&search=two+words#read");
    for (const label of form.querySelectorAll("label")) assert.ok(forms.getElementById(label.getAttribute("for")!));
  }
  const escaped = await renderSiteDocument({ rawContent: block({ displayLoginAsForm: true }) }, { requestPath: "/%252f%252fevil.example", query: { search: '"><script>bad()</script>' } });
  assert.doesNotMatch(escaped, /<script|onerror/); assert.match(escaped, /action="\/public-login"/);
  const user = { id: 1, role: "subscriber", displayName: "Member" };
  for (const redirectToCurrent of [false, true]) {
    const html = dom(await renderSiteDocument({ rawContent: block({ displayLoginAsForm: true, redirectToCurrent }) }, { requestPath: path, user }));
    assert.ok(html.querySelector(".logged-in")); assert.equal(html.querySelector("form")?.getAttribute("action"), "/logout");
    assert.equal(html.querySelector('[name="redirect_to"]')?.getAttribute("value"), redirectToCurrent ? path : "/");
    assert.equal(html.querySelector('[name="pwd"]'), null);
  }
  const sanitized = dom(cleanContent('<form action="https://evil.invalid" method="post"><input name="pwd" type="password"></form><form action="/public-login" method="post"></form>', true));
  assert.deepEqual([...sanitized.querySelectorAll("form")].map(form => form.getAttribute("action")), ["/", "/public-login"]);
  assert.equal(dom(cleanContent('<form action="/public-login"><input name="pwd"></form>')).querySelector("form"), null);
});

test("native and JSON login share credentials, role/session protections, safe redirects and one attempt limiter", async t => {
  let attempts = 0, admin = "";
  const users: number[] = [], sessions: string[] = [], posts:number[]=[];
  const stamp = "loginout-" + Date.now().toString(36), password = "Native-safe-" + stamp + "-password";
  async function api(path: string, method = "GET", body?: unknown, cookie = "") {
    if (path === "/api/auth/login") attempts++;
    const response = await fetch(base + path, { method, headers: { Origin: origin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { response, data: await response.json() };
  }
  async function native(fields: Record<string, string>, options: { cookie?: string; requestOrigin?: string | null; referer?: string } = {}) {
    const requestOrigin = options.requestOrigin === undefined ? origin : options.requestOrigin;
    if (requestOrigin === origin || (requestOrigin === null && options.referer?.startsWith(origin + "/"))) attempts++;
    return fetch(base + "/public-login", { method: "POST", redirect: "manual", headers: { ...(requestOrigin === null ? {} : { Origin: requestOrigin }), ...(options.cookie ? { Cookie: options.cookie } : {}), ...(options.referer ? { Referer: options.referer } : {}) }, body: new URLSearchParams(fields) });
  }
  async function expiry(cookie: string, days: number) {
    const hash = createHash("sha256").update(cookie.slice(cookie.indexOf("=") + 1)).digest("hex");
    const row = (await pool.query("SELECT extract(epoch FROM expires_at-now())::float AS seconds FROM sessions WHERE token_hash=$1", [hash])).rows[0];
    assert.ok(row); assert.ok(Math.abs(row.seconds - days * 86400) < 60, "Expected " + days + " day session");
  }
  try {
    const signedIn = await api("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
    assert.equal(signedIn.response.status, 200); admin = cookieOf(signedIn.response);
    assert.match(signedIn.response.headers.get("set-cookie")!, /Max-Age=604800/); await expiry(admin, 7);
    const accounts: Record<string, any> = {};
    for (const role of ["subscriber", "editor"] as const) {
      const created = await api("/api/users", "POST", { username: stamp + "-" + role, email: stamp + "-" + role + "@example.test", password, role, displayName: "Native " + role }, admin);
      assert.equal(created.response.status, 201, JSON.stringify(created.data)); users.push(created.data.user.id); accounts[role] = created.data.user;
    }
    await t.test("same-origin form checks precede credentials and reject arrays or unrecognized fields", async () => {
      const fields = { log: accounts.subscriber.username, pwd: password };
      for (const options of [{ requestOrigin: "https://foreign.invalid" }, { requestOrigin: null }, { requestOrigin: null, referer: "https://foreign.invalid/x" }]) {
        const response = await native(fields, options); assert.equal(response.status, 403); assert.equal(response.headers.get("set-cookie"), null);
      }
      const invalid = await native({ ...fields, unexpected: "1" }); assert.equal(invalid.status, 400); assert.equal(invalid.headers.get("set-cookie"), null);
      const absent = await native({ log: fields.log }); assert.equal(absent.status, 400);
      const duplicated = new URLSearchParams(fields); duplicated.append("log", "another-account"); attempts++;
      const array = await fetch(base + "/public-login", { method: "POST", headers: { Origin: origin }, body: duplicated, redirect: "manual" });
      assert.equal(array.status, 400); assert.equal(array.headers.get("set-cookie"), null);
    });
    let member = "";
    await t.test("form login returns to a local public URL and preserves subscriber capabilities", async () => {
      const response = await native({ log: accounts.subscriber.email.toUpperCase(), pwd: password, redirect_to: origin + "/notes/?q=two%20words#part" }, { requestOrigin: null, referer: origin + "/notes/" });
      assert.equal(response.status, 303); assert.equal(response.headers.get("location"), "/notes/?q=two%20words#part");
      member = cookieOf(response); sessions.push(member);
      assert.match(response.headers.get("set-cookie")!, /HttpOnly/); assert.match(response.headers.get("set-cookie")!, /SameSite=Lax/);
      assert.doesNotMatch(response.headers.get("set-cookie")!, /Max-Age|Expires=/); await expiry(member, 2);
      const session = await api("/api/session", "GET", undefined, member); assert.equal(session.data.user.role, "subscriber");
      assert.equal(session.data.user.id, accounts.subscriber.id); assert.equal(session.data.user.password_hash, undefined);
      assert.equal((await api("/api/settings", "GET", undefined, member)).response.status, 403);
      assert.equal((await api("/api/posts", "POST", { title: stamp }, member)).response.status, 403);
    });
    await t.test("Remember Me persists for fourteen days and successful login rotates the old token", async () => {
      const response = await native({ log: accounts.subscriber.username, pwd: password, rememberme: "forever", redirect_to: "/notes/?page=2#read" }, { cookie: member });
      assert.equal(response.status, 303); assert.equal(response.headers.get("location"), "/notes/?page=2#read");
      assert.match(response.headers.get("set-cookie")!, /Max-Age=1209600/);
      const replacement = cookieOf(response); sessions.push(replacement); assert.notEqual(replacement, member); await expiry(replacement, 14);
      assert.equal((await api("/api/session", "GET", undefined, member)).data.user, null);
      assert.equal((await api("/api/session", "GET", undefined, replacement)).data.user.id, accounts.subscriber.id);
      member = replacement;
      const editor = await native({ log: accounts.editor.username, pwd: password });
      assert.equal(editor.status, 303); assert.equal(editor.headers.get("location"), "/admin");
      const cookie = cookieOf(editor); sessions.push(cookie);
      assert.equal((await api("/api/session", "GET", undefined, cookie)).data.user.role, "editor");
    });
    await t.test("unsafe return paths cannot redirect authentication off-site or into a login loop", async () => {
      for (const redirect_to of ["https://foreign.invalid/", "//foreign.invalid/", "/%252f%252fevil.invalid", "/%5cevil.invalid", "/%0d%0aLocation:evil", "/login?redirect_to=/", "/api/auth/logout"]) {
        const response = await native({ log: accounts.editor.username, pwd: password, redirect_to });
        assert.equal(response.status, 303); assert.equal(response.headers.get("location"), "/admin", redirect_to); sessions.push(cookieOf(response));
      }
      const long = await native({ log: accounts.editor.username, pwd: password, redirect_to: "/" + "a".repeat(2000) });
      assert.equal(long.status, 400);
    });
    await t.test("bad credentials reveal no identity/password and do not clear an existing authenticated session", async () => {
      const failure = await native({ log: "Unknown-" + stamp, pwd: "do-not-expose-password", redirect_to: "/notes/?page=3#more" }, { cookie: member });
      assert.equal(failure.status, 303); assert.equal(failure.headers.get("set-cookie"), null);
      const url = new URL(failure.headers.get("location")!, origin); assert.equal(url.pathname, "/login");
      assert.equal(url.searchParams.get("login_error"), "1"); assert.equal(url.searchParams.get("redirect_to"), "/notes/?page=3#more");
      assert.doesNotMatch(url.href, /Unknown-|do-not-expose-password/);
      assert.equal((await api("/api/session", "GET", undefined, member)).data.user.id, accounts.subscriber.id);
      for (const login of [accounts.subscriber.username, "Unknown-" + stamp]) {
        const json = await api("/api/auth/login", "POST", { login, password: "wrong-password" });
        assert.equal(json.response.status, 401); assert.deepEqual(json.data, { error: "The username or password is incorrect." }); assert.equal(json.response.headers.get("set-cookie"), null);
      }
    });
    await t.test("native logout clears the session and accepts only safe local returns", async () => {
      const response = await fetch(base + "/logout", { method: "POST", redirect: "manual", headers: { Origin: origin, Cookie: member }, body: new URLSearchParams({ redirect_to: origin + "/notes/?page=2#read" }) });
      assert.equal(response.status, 303); assert.equal(response.headers.get("location"), "/notes/?page=2#read");
      assert.match(response.headers.get("set-cookie")!, /worldact_session=;/);
      assert.equal((await api("/api/session", "GET", undefined, member)).data.user, null);
    });
    await t.test("public and WordPress post APIs render embedded LoginOut for the actual visitor and canonical return path", async () => {
      const content=block({redirectToCurrent:true})+block({displayLoginAsForm:true});
      const created=await api("/api/posts","POST",{title:stamp+" embedded",content,status:"publish"},admin);
      assert.equal(created.response.status,201,JSON.stringify(created.data));const post=created.data.post;posts.push(post.id);
      const canonical=post.permalink;
      for(const route of ["/api/public/posts/"+post.slug,"/wp-json/wp/v2/posts/"+post.id]){
        const anonymous=await api(route),anonymousHTML=dom(anonymous.data.post?.content ?? anonymous.data.content.rendered);
        assert.ok(anonymousHTML.querySelector(".logged-out"));
        const href=anonymousHTML.querySelector(".logged-out > a")?.getAttribute("href");assert.ok(href);
        assert.equal(new URL(href!,origin).searchParams.get("redirect_to"),canonical);
        assert.equal(anonymousHTML.querySelector('form[action="/public-login"] [name="redirect_to"]')?.getAttribute("value"),canonical);
        const authenticated=await api(route,"GET",undefined,admin),html=dom(authenticated.data.post?.content ?? authenticated.data.content.rendered);
        assert.ok(html.querySelector(".logged-in"));assert.equal(html.querySelector(".logged-out"),null);
        assert.equal(html.querySelector('form[action="/logout"] [name="redirect_to"]')?.getAttribute("value"),canonical);
        assert.equal(html.querySelector('[name="pwd"]'),null);
      }
    });
    await t.test("password revocation serializes with session issuance in both real database interleavings", {timeout:15_000}, async () => {
      const account=accounts.editor, originalHash=(await pool.query("SELECT password_hash FROM users WHERE id=$1",[account.id])).rows[0].password_hash;
      const changedHash=await hashPassword(password+"-changed");
      const credentialChange=await pool.connect(),sessionBarrier=await pool.connect();
      const blockingPID=async(db:typeof credentialChange)=>(await db.query("SELECT pg_backend_pid() AS id")).rows[0].id;
      const changePID=await blockingPID(credentialChange),barrierPID=await blockingPID(sessionBarrier);
      const waitForBlocker=async(blocker:number,queryIncludes:string)=>{
        const deadline=Date.now()+4000;
        do{
          const result=await pool.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid)) AND position($2 in query)>0",[blocker,queryIncludes]);
          if(result.rowCount)return result.rows[0].pid as number;
          await new Promise(resolve=>setTimeout(resolve,10));
        }while(Date.now()<deadline);
        assert.fail("Expected the authentication transaction to reach its database lock barrier: "+queryIncludes);
      };
      let pendingLogin:Promise<Response>|undefined,update:Promise<any>|undefined;
      try{
        // Reset wins after the nonlocking credential snapshot but before the
        // authentication transaction can lock/recheck the current user hash.
        await credentialChange.query("BEGIN");await credentialChange.query("SELECT id FROM users WHERE id=$1 FOR UPDATE",[account.id]);
        pendingLogin=native({log:account.username,pwd:password});
        await waitForBlocker(changePID,"FROM users WHERE id=$1 FOR SHARE");
        await credentialChange.query("UPDATE users SET password_hash=$1 WHERE id=$2",[changedHash,account.id]);
        await credentialChange.query("DELETE FROM sessions WHERE user_id=$1",[account.id]);await credentialChange.query("COMMIT");
        const rejected=await pendingLogin;pendingLogin=undefined;assert.equal(rejected.status,303);assert.match(rejected.headers.get("location")!,/^\/login\?login_error=1/);assert.equal(rejected.headers.get("set-cookie"),null);
        assert.equal((await pool.query("SELECT 1 FROM sessions WHERE user_id=$1",[account.id])).rowCount,0);
        await pool.query("UPDATE users SET password_hash=$1 WHERE id=$2",[originalHash,account.id]);
        const login=await api("/api/auth/login","POST",{login:account.username,password});assert.equal(login.response.status,200);const previous=cookieOf(login.response);sessions.push(previous);
        const tokenHash=createHash("sha256").update(previous.slice(previous.indexOf("=")+1)).digest("hex");
        // Login wins the user SHARE lock, then pauses while deleting its old
        // session. A credential UPDATE must remain blocked until issuance commits.
        await sessionBarrier.query("BEGIN");await sessionBarrier.query("SELECT token_hash FROM sessions WHERE token_hash=$1 FOR UPDATE",[tokenHash]);
        pendingLogin=native({log:account.username,pwd:password},{cookie:previous});
        const loginPID=await waitForBlocker(barrierPID,"DELETE FROM sessions WHERE token_hash = $1");
        await credentialChange.query("BEGIN");update=credentialChange.query("UPDATE users SET password_hash=$1 WHERE id=$2",[changedHash,account.id]);
        await waitForBlocker(loginPID,"UPDATE users SET password_hash=$1 WHERE id=$2");
        await sessionBarrier.query("COMMIT");const issued=await pendingLogin;pendingLogin=undefined;assert.equal(issued.status,303);const cookie=cookieOf(issued);assert.ok(cookie);sessions.push(cookie);
        await update;update=undefined;await credentialChange.query("DELETE FROM sessions WHERE user_id=$1",[account.id]);await credentialChange.query("COMMIT");
        assert.equal((await api("/api/session","GET",undefined,cookie)).data.user,null,"A reset committed after login must revoke its newly issued session");
        assert.equal((await pool.query("SELECT 1 FROM sessions WHERE user_id=$1",[account.id])).rowCount,0);
      }finally{
        await sessionBarrier.query("ROLLBACK");await credentialChange.query("ROLLBACK");
        if(pendingLogin)await pendingLogin.catch(()=>{});if(update)await update.catch(()=>{});
        await pool.query("UPDATE users SET password_hash=$1 WHERE id=$2",[originalHash,account.id]);
        credentialChange.release();sessionBarrier.release();
      }
    });
    await t.test("one thirty-attempt bucket covers native and JSON logins, including spoofed client IP headers", async () => {
      assert.ok(attempts < 30, "Fixture must leave room to prove the exact shared cap");
      while (attempts < 30) {
        const response = attempts % 2 ? await native({ log: "Unknown-" + stamp, pwd: "wrong-password" }) : (await api("/api/auth/login", "POST", { login: "Unknown-" + stamp, password: "wrong-password" })).response;
        assert.ok([303, 401].includes(response.status), "Requests through the thirtieth attempt are handled normally");
      }
      const nativeLimited = await native({ log: accounts.editor.username, pwd: password }); assert.equal(nativeLimited.status, 429); assert.ok(Number(nativeLimited.headers.get("retry-after")) > 0);
      const jsonLimited = await fetch(base + "/api/auth/login", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "X-Forwarded-For": "198.51.100.10" }, body: JSON.stringify({ login: accounts.editor.username, password }) });
      assert.equal(jsonLimited.status, 429); assert.ok(Number(jsonLimited.headers.get("retry-after")) > 0);
      assert.equal(nativeLimited.headers.get("set-cookie"), null); assert.equal(jsonLimited.headers.get("set-cookie"), null);
    });
  } finally {
    for(const id of posts){await api("/api/posts/"+id,"PUT",{status:"trash"},admin);const removed=await api("/api/posts/"+id,"DELETE",undefined,admin);assert.equal(removed.response.status,200);}
    for (const id of users.reverse()) {
      const removed = await api("/api/users/" + id, "DELETE", undefined, admin); assert.equal(removed.response.status, 200, JSON.stringify(removed.data));
    }
    for (const cookie of sessions) await api("/api/auth/logout", "POST", undefined, cookie);
    if (admin) await api("/api/auth/logout", "POST", undefined, admin);
  }
});
