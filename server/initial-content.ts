import type { PoolClient } from "pg";
import { autop } from "@wordpress/autop";
import { getSettings } from "./db.js";
import { cleanContent, cleanRawContent } from "./utils.js";
import { buildPrivacyPolicyGuide, privacyPolicyRawContent } from "./privacy-guide.js";

// Supplied wp-admin/includes/upgrade.php wp_install_defaults(), single-site
// English content. PHP is reference data only; WorldAct uses local admin links.
export const initialHelloContent = `<!-- wp:paragraph -->
<p>Welcome to WorldAct. This is your first post. Edit or delete it, then start writing!</p>
<!-- /wp:paragraph -->`;
export const initialSamplePageContent = `<!-- wp:paragraph -->
<p>This is an example page. It's different from a blog post because it will stay in one place and will show up in your site navigation (in most themes). Most people start with an About page that introduces them to potential site visitors. It might say something like this:</p>
<!-- /wp:paragraph -->

<!-- wp:quote -->
<blockquote class="wp-block-quote">
<!-- wp:paragraph -->
<p>Hi there! I'm a bike messenger by day, aspiring actor by night, and this is my website. I live in Los Angeles, have a great dog named Jack, and I like pi&#241;a coladas. (And gettin' caught in the rain.)</p>
<!-- /wp:paragraph -->
</blockquote>
<!-- /wp:quote -->

<!-- wp:paragraph -->
<p>...or something like this:</p>
<!-- /wp:paragraph -->

<!-- wp:quote -->
<blockquote class="wp-block-quote">
<!-- wp:paragraph -->
<p>The XYZ Doohickey Company was founded in 1971, and has been providing quality doohickeys to the public ever since. Located in Gotham City, XYZ employs over 2,000 people and does all kinds of awesome things for the Gotham community.</p>
<!-- /wp:paragraph -->
</blockquote>
<!-- /wp:quote -->

<!-- wp:paragraph -->
<p>As a new WorldAct user, you should go to <a href="/admin">your dashboard</a> to delete this page and create new pages for your content. Have fun!</p>
<!-- /wp:paragraph -->`;
export const initialCommentContent = `Hi, this is a comment.
To get started with moderating, editing, and deleting comments, please visit the Comments screen in the dashboard.
Commenter avatars come from <a href="https://gravatar.com/">Gravatar</a>.`;

/** Shared once-only transaction for CLI and browser installation. No backfill. */
export async function seedInitialContent(client: PoolClient, adminId: number) {
  const marker = await client.query(
    "INSERT INTO seed_markers (name) VALUES ('initial-content-v1') ON CONFLICT DO NOTHING RETURNING name",
  );
  if (!marker.rowCount) return;
  const settings = await getSettings(client);
  const post = await client.query(
    `INSERT INTO posts (type,title,slug,content,raw_content,excerpt,status,author_id,published_at)
     VALUES ('post','Hello world!','hello-world',$1,$2,'','publish',$3,now())
     ON CONFLICT (slug) DO NOTHING RETURNING id`,
    [cleanContent(initialHelloContent), cleanRawContent(initialHelloContent), adminId],
  );
  await client.query(
    `INSERT INTO posts (type,title,slug,content,raw_content,excerpt,status,author_id,published_at,comment_status,template_slug)
     VALUES ('page','Sample Page','sample-page',$1,$2,'','publish',$3,now(),'closed','')
     ON CONFLICT (slug) DO NOTHING`,
    [cleanContent(initialSamplePageContent), cleanRawContent(initialSamplePageContent), adminId],
  );
  if (post.rows[0]) {
    await client.query(
      "INSERT INTO post_terms(post_id,term_id) SELECT $1,id FROM terms WHERE is_default ON CONFLICT DO NOTHING",
      [post.rows[0].id],
    );
    await client.query(
      `INSERT INTO comments (post_id,author_name,author_email,author_url,content,status)
       VALUES ($1,'A WorldAct Commenter','commenter@worldact.example','/',$2,'approved')`,
      [post.rows[0].id, cleanContent(autop(initialCommentContent))],
    );
  }
  const policyRaw = privacyPolicyRawContent(buildPrivacyPolicyGuide(settings));
  const policy = await client.query(
    `INSERT INTO posts(type,title,slug,content,raw_content,excerpt,status,author_id,comment_status,template_slug)
     VALUES('page','Privacy Policy','privacy-policy',$1,$2,'','draft',$3,'closed','')
     ON CONFLICT(slug) DO NOTHING RETURNING id`,
    [cleanContent(policyRaw), cleanRawContent(policyRaw), adminId],
  );
  const policyId = policy.rows[0]?.id ?? (await client.query("SELECT id FROM posts WHERE slug='privacy-policy' AND type='page'")).rows[0]?.id;
  if (policyId && !settings.privacyPageId) await client.query(
    "UPDATE settings SET data=data || $1::jsonb WHERE id=1", [JSON.stringify({ privacyPageId: policyId })],
  );
  // Source ships both bundled plugins, with active_plugins empty. Extra catalog
  // entries remain uninstalled. Never create credentials or contact Akismet.
  await client.query(
    `INSERT INTO extensions(slug,enabled,settings) VALUES
     ('hello-dolly',false,'{}'::jsonb),('akismet',false,'{"sendComments":false}'::jsonb)
     ON CONFLICT(slug) DO NOTHING`,
  );
}
