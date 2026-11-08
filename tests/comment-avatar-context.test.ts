import test, { after } from "./isolated-test.js";
import assert from "node:assert/strict";
import { DOMParser } from "linkedom";
import type { PoolClient } from "pg";
import { pool, postFields } from "../server/db.js";
import { renderSiteDocument } from "../server/block-renderer.js";
import { avatarURL } from "../server/avatars.js";

const block = (name: string, attrs: Record<string, unknown> = {}, body = "") => `<!-- wp:${name} ${JSON.stringify(attrs)}${body ? " -->" + body + `<!-- /wp:${name} -->` : " /-->"}`;
const dom = (html: string) => new DOMParser().parseFromString(html, "text/html");
const settings = {theme: "twentytwentyfive", showAvatars: true, defaultAvatar: "identicon", avatarRating: "PG", paginateComments: false, threadComments: false, closeCommentsDays: 0};
type Database = PoolClient | typeof pool;
async function fixture(db: Database) {
  const stamp = "avatar-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  const users: number[] = [];
  async function user(label: string) {
    const email = `${stamp}-${label}-private@example.test`;
    const record = (await db.query("INSERT INTO users(username,email,display_name,password_hash,role) VALUES($1,$2,$3,'PRIVATE-AVATAR-PASSWORD-HASH','author') RETURNING id,email,display_name AS name", [stamp + "-" + label, email, label + " account name"])).rows[0];
    users.push(record.id); return record;
  }
  const owner = await user("PostOwner"), member = await user("Member"), departed = await user("Departed");
  const id = (await db.query("INSERT INTO posts(type,title,slug,status,author_id,published_at,content) VALUES('post',$1,$1,'publish',$2,now(),'<p>Avatar context proof.</p>') RETURNING id", [stamp, owner.id])).rows[0].id;
  const post = (await db.query(`SELECT ${postFields} FROM posts p JOIN users u ON u.id=p.author_id WHERE p.id=$1`, [id])).rows[0];
  async function comment(type: string, name: string, email: string, url: string, userId: number | null = null) {
    return (await db.query("INSERT INTO comments(post_id,type,author_name,author_email,author_url,user_id,content,status) VALUES($1,$2,$3,$4,$5,$6,'<p>Comment context body.</p>','approved') RETURNING id,type,author_name AS name,author_email AS email,author_url AS url,user_id AS \"userId\"", [id, type, name, email, url, userId])).rows[0];
  }
  const anonymous = await comment("comment", "Anonymous stored name", `${stamp}-anonymous-private@example.test`, "https://reader.example.test/website/");
  const registered = await comment("comment", "Registered stored comment name", `${stamp}-stored-private@example.test`, "https://member.example.test/comment-website/", member.id);
  const deleted = await comment("comment", "Deleted account stored name", `${stamp}-deleted-private@example.test`, "/former-reader/", departed.id);
  const noEmail = await comment("comment", "Email-less reader", "", "");
  const pingback = await comment("pingback", "Claimed pingback site", "FORGED-PRIVATE-EMAIL@example.test", "https://pingback.example.test/source/", owner.id);
  const trackback = await comment("trackback", "Claimed trackback site", "FORGED-PRIVATE-EMAIL@example.test", "https://trackback.example.test/source/", owner.id);
  await db.query("DELETE FROM users WHERE id=$1", [departed.id]);
  return {post, owner, member, anonymous, registered, deleted, noEmail, pingback, trackback, users};
}
const commentTemplate = (attrs: Record<string, unknown>) => block("comments", {}, block("comment-template", {}, block("avatar", attrs) + block("comment-author-name", {isLink: false})));
after(() => pool.end());

test("real comment-template avatars use human identity and never inherit post/explicit account identity for pings", async () => {
  const db = await pool.connect(); await db.query("BEGIN");
  try {
    await db.query("UPDATE settings SET data=data || $1::jsonb WHERE id=1", [JSON.stringify(settings)]);
    const f = await fixture(db);
    const html = await renderSiteDocument({rawContent: commentTemplate({userId: f.owner.id, isLink: true, linkTarget: "_blank", size: 48})}, {db, post: f.post});
    const document = dom(html);
    for (const [comment, email] of [[f.anonymous, f.anonymous.email], [f.registered, f.member.email], [f.deleted, f.deleted.email], [f.noEmail, ""]]) {
      const avatar = document.querySelector(`#comment-${comment.id} .wp-block-avatar`)!;
      const image = avatar.querySelector("img")!;
      assert.ok(image); assert.equal(image.getAttribute("src"), avatarURL(email, settings, 48));
      assert.equal(image.getAttribute("alt"), comment.name + " Avatar");
      assert.ok(image.classList.contains("wp-block-avatar__image"));
      const link = avatar.querySelector("a");
      if (comment.url) {
        assert.equal(link?.getAttribute("href"), comment.url);
        assert.equal(link?.getAttribute("aria-label"), `(${comment.name} website link, opens in a new tab)`);
        assert.equal(link?.getAttribute("target"), "_blank");
        assert.match(link?.getAttribute("rel") || "", /noopener/);
      } else assert.equal(link, null);
    }
    for (const ping of [f.pingback, f.trackback]) {
      assert.equal(ping.email, ""); assert.equal(ping.userId, null);
      const row = document.querySelector(`#comment-${ping.id}`)!;
      const avatar = row.querySelector(".wp-block-avatar");
      assert.equal(avatar?.querySelector("img,a"), null);
      assert.doesNotMatch(row.innerHTML, /PostOwner|author=|secure\.gravatar/);
    }
    assert.doesNotMatch(html, /PRIVATE-AVATAR-PASSWORD-HASH|FORGED-PRIVATE-EMAIL|PostOwner account name|anonymous-private@|stored-private@|deleted-private@/);
    assert.equal(html.includes(f.owner.email), false); assert.equal(html.includes(f.member.email), false);
  } finally {await db.query("ROLLBACK"); db.release();}
});

test("comment avatar links reject unsafe websites, while ordinary post/user avatars retain their own context and global suppression", async () => {
  const db = await pool.connect(); await db.query("BEGIN");
  try {
    await db.query("UPDATE settings SET data=data || $1::jsonb WHERE id=1", [JSON.stringify(settings)]);
    const f = await fixture(db);
    const render = (rawContent: string, options: Record<string, unknown> = {}) => renderSiteDocument({rawContent}, {db, post: f.post, ...options});
    for (const unsafe of ["javascript:alert(1)", "//untrusted.example.test/", "data:text/html,attack", "https://reader.example.test/\nattack"]) {
      await db.query("UPDATE comments SET author_url=$2 WHERE id=$1", [f.anonymous.id, unsafe]);
      const avatar = dom(await render(commentTemplate({isLink: true}))).querySelector(`#comment-${f.anonymous.id} .wp-block-avatar`)!;
      assert.ok(avatar.querySelector("img")); assert.equal(avatar.querySelector("a"), null);
    }
    const postAvatar = dom(await render(block("avatar", {isLink: true, linkTarget: "_blank"})));
    assert.equal(postAvatar.querySelector("img")?.getAttribute("src"), avatarURL(f.owner.email, settings));
    assert.equal(postAvatar.querySelector("img")?.getAttribute("alt"), f.owner.name + " Avatar");
    assert.equal(postAvatar.querySelector("a")?.getAttribute("href"), "/?author=" + f.owner.id);
    assert.equal(postAvatar.querySelector("a")?.getAttribute("aria-label"), `(${f.owner.name} author archive, opens in a new tab)`);
    assert.equal(dom(await render(block("avatar", {userId: f.member.id}))).querySelector("img")?.getAttribute("src"), avatarURL(f.member.email, settings));
    assert.equal(await render(block("avatar", {userId: 0})), "");
    assert.equal(dom(await render(block("avatar", {userId: null}))).querySelector("img")?.getAttribute("src"), avatarURL(f.owner.email, settings));
    assert.equal(await render(block("avatar", {userId: 2147483647})), "");
    assert.equal(await render(block("avatar"), {post: null}), "");
    assert.equal(dom(await render(block("avatar"), {post: null, query: {author: String(f.member.id)}})).querySelector("img")?.getAttribute("src"), avatarURL(f.member.email, settings));
    await db.query("UPDATE settings SET data=data || '{\"showAvatars\":false}'::jsonb WHERE id=1");
    assert.equal(await render(block("avatar", {isLink: true})), "");
    assert.equal(dom(await render(commentTemplate({isLink: true}))).querySelector(".wp-block-avatar"), null);
  } finally {await db.query("ROLLBACK"); db.release();}
});

test("an account deleted after the real comment loop loads falls back to the stored comment email rather than the post author", async () => {
  const db = await pool.connect(); await db.query("BEGIN");
  try {
    await db.query("UPDATE settings SET data=data || $1::jsonb WHERE id=1", [JSON.stringify(settings)]);
    const f = await fixture(db); let deletedBetweenReads = false;
    const query = (async (sql: string, values?: unknown[]) => {
      if (!deletedBetweenReads && sql.includes("FROM users WHERE id=$1") && values?.[0] === f.member.id) {
        await db.query("DELETE FROM users WHERE id=$1", [f.member.id]); deletedBetweenReads = true;
      }
      return db.query(sql, values);
    }) as PoolClient["query"];
    const html = await renderSiteDocument({rawContent: commentTemplate({userId: f.owner.id, isLink: true})}, {db: {query}, post: f.post});
    assert.equal(deletedBetweenReads, true);
    const avatar = dom(html).querySelector(`#comment-${f.registered.id} .wp-block-avatar`)!;
    assert.equal(avatar.querySelector("img")?.getAttribute("src"), avatarURL(f.registered.email, settings));
    assert.equal(avatar.querySelector("img")?.getAttribute("alt"), f.registered.name + " Avatar");
    assert.equal(avatar.querySelector("a")?.getAttribute("href"), f.registered.url);
    assert.equal(html.includes(f.registered.email), false); assert.equal(html.includes(f.owner.email), false);
  } finally {await db.query("ROLLBACK"); db.release();}
});

test("actual bundled Twenty Twenty-Five HTTP template gives neither notification an account avatar or author link", async () => {
  const previous = (await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data;
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    await pool.query("UPDATE settings SET data=data || $1::jsonb WHERE id=1", [JSON.stringify(settings)]);
    f = await fixture(pool);
    const route = `${process.env.TEST_API_URL}/api/public/templates/single?postId=${f.post.id}&requestPath=${encodeURIComponent('/posts/' + f.post.slug + '/')}`;
    const response = await fetch(route); assert.equal(response.status, 200);
    const {content: html} = await response.json(); const document = dom(html);
    for (const ping of [f.pingback, f.trackback]) {
      const row = document.querySelector(`#comment-${ping.id}`)!; assert.ok(row);
      assert.equal(row.querySelector(".wp-block-avatar img,.wp-block-avatar a"), null);
      assert.doesNotMatch(row.innerHTML, /PostOwner|author=|secure\.gravatar/);
    }
    for (const [comment, email] of [[f.anonymous, f.anonymous.email], [f.registered, f.member.email], [f.deleted, f.deleted.email]]) {
      const image = document.querySelector(`#comment-${comment.id} .wp-block-avatar img`)!; assert.ok(image);
      assert.equal(image.getAttribute("src"), avatarURL(email, settings, Number(image.getAttribute("width"))));
      assert.equal(image.getAttribute("alt"), comment.name + " Avatar");
    }
    for (const email of [f.owner.email, f.member.email, f.anonymous.email, f.registered.email, f.deleted.email]) assert.equal(html.includes(email), false);
    assert.doesNotMatch(html, /PRIVATE-AVATAR-PASSWORD-HASH|FORGED-PRIVATE-EMAIL/);
    await pool.query("UPDATE settings SET data=data || '{\"showAvatars\":false}'::jsonb WHERE id=1");
    const hidden = dom((await (await fetch(route)).json()).content);
    for (const comment of [f.anonymous, f.registered, f.deleted, f.pingback, f.trackback]) assert.equal(hidden.querySelector(`#comment-${comment.id} .wp-block-avatar`), null);
  } finally {
    if (f) {await pool.query("DELETE FROM posts WHERE id=$1", [f.post.id]); await pool.query("DELETE FROM users WHERE id=ANY($1::int[])", [f.users]);}
    await pool.query("UPDATE settings SET data=$1::jsonb WHERE id=1", [JSON.stringify(previous)]);
  }
});

test("Classic public comment responses use current account avatar identity, stored-email fallback, and no notification avatar", async () => {
  const previous = (await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data;
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    await pool.query("UPDATE settings SET data=data || $1::jsonb WHERE id=1", [JSON.stringify({...settings, theme: "classic"})]);
    f = await fixture(pool);
    const route = `${process.env.TEST_API_URL}/api/public/posts/${f.post.slug}`;
    const read = async () => {
      const response = await fetch(route); assert.equal(response.status, 200);
      const data = await response.json();
      for (const comment of data.comments) {
        for (const key of ["authorEmail", "_authorEmail", "_avatarEmail", "email", "password_hash"]) assert.equal(Object.hasOwn(comment, key), false);
      }
      for (const email of [f!.owner.email, f!.member.email, f!.anonymous.email, f!.registered.email, f!.deleted.email]) assert.equal(JSON.stringify(data.comments).includes(email), false);
      assert.doesNotMatch(JSON.stringify(data.comments), /PRIVATE-AVATAR-PASSWORD-HASH|FORGED-PRIVATE-EMAIL/);
      return new Map<number, {avatarUrl: string | null; authorName: string}>(data.comments.map((comment: {id: number; avatarUrl: string | null; authorName: string}) => [comment.id, comment]));
    };
    const initial = await read();
    for (const [comment, email] of [[f.anonymous, f.anonymous.email], [f.registered, f.member.email], [f.deleted, f.deleted.email], [f.noEmail, ""]]) {
      assert.equal(initial.get(comment.id)?.avatarUrl, avatarURL(email, settings));
      assert.equal(initial.get(comment.id)?.authorName, comment.name);
    }
    for (const notification of [f.pingback, f.trackback]) assert.equal(initial.get(notification.id)?.avatarUrl, null);
    const currentEmail = f.member.email + ".changed";
    await pool.query("UPDATE users SET email=$2 WHERE id=$1", [f.member.id, currentEmail]);
    assert.equal((await read()).get(f.registered.id)?.avatarUrl, avatarURL(currentEmail, settings));
    assert.equal((await pool.query("SELECT author_email FROM comments WHERE id=$1", [f.registered.id])).rows[0].author_email, f.registered.email);
    await pool.query("DELETE FROM users WHERE id=$1", [f.member.id]);
    assert.equal((await read()).get(f.registered.id)?.avatarUrl, avatarURL(f.registered.email, settings));
    await pool.query("UPDATE settings SET data=data || '{\"showAvatars\":false}'::jsonb WHERE id=1");
    assert.ok([...(await read()).values()].every(comment => comment.avatarUrl === null));
  } finally {
    if (f) {await pool.query("DELETE FROM posts WHERE id=$1", [f.post.id]); await pool.query("DELETE FROM users WHERE id=ANY($1::int[])", [f.users]);}
    await pool.query("UPDATE settings SET data=$1::jsonb WHERE id=1", [JSON.stringify(previous)]);
  }
});
