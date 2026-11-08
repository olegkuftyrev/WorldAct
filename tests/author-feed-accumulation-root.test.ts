import test, { after } from './isolated-test.js';
import assert from 'node:assert/strict';
import { pool } from '../server/db.js';
import { hashPassword } from '../server/auth.js';

const base = process.env.TEST_API_URL!, origin = process.env.APP_ORIGIN!;
const secret = 'ROOT-FEED-EXPIRED-GRANT-SECRET';
after(() => pool.end());

async function observe(sql: string) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if ((await pool.query(sql)).rows[0].ok) return;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  assert.fail('Expected actual feed author-expression wait and completed earlier body');
}

test('RSS and Atom retire an earlier granted body after another post author wait', { timeout: 90000 }, async t => {
  const settings = (await pool.query('SELECT data FROM settings WHERE id=1')).rows[0].data;
  const oldPosts = (await pool.query('SELECT id,status FROM posts')).rows;
  const users: number[] = [], posts: number[] = [];
  let view = false;
  async function api(path: string, method = 'GET', body?: unknown, cookie = '') {
    const response = await fetch(base + path, {
      method, headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000),
    });
    return { response, text: await response.text() };
  }
  try {
    await pool.query("UPDATE posts SET status='draft'");
    await pool.query('UPDATE settings SET data=data || $1::jsonb WHERE id=1', [JSON.stringify({ permalinkStructure: '/%author%/%post_id%/%postname%/', feedItems: 2, feedExcerpt: false, pingServices: [] })]);
    for (const name of ['root_feed_a', 'root_feed_b']) users.push((await pool.query("INSERT INTO users(username,email,display_name,password_hash,role,nicename) VALUES($1,$2,$1,'inert-fixture-password','author',$1) RETURNING id", [name, name + '@example.test'])).rows[0].id);
    const columns = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='users' ORDER BY ordinal_position")).rows.map(row => row.column_name);
    const setup = await pool.connect();
    try {
      await setup.query('BEGIN');
      await setup.query('CREATE SEQUENCE worldact_root_feed_body_rendered');
      await setup.query('CREATE TABLE worldact_root_feed_gate(enabled boolean NOT NULL)');
      await setup.query('INSERT INTO worldact_root_feed_gate VALUES(false)');
      await setup.query(`CREATE FUNCTION worldact_root_feed_nicename(value varchar) RETURNS varchar LANGUAGE plpgsql STABLE AS $$ BEGIN
        IF (SELECT enabled FROM worldact_root_feed_gate) THEN
          IF value='root_feed_a' THEN PERFORM nextval('worldact_root_feed_body_rendered');
          ELSIF value='root_feed_b' THEN PERFORM pg_advisory_xact_lock(hashtext('worldact-root-feed-body-wait')); END IF;
        END IF; RETURN value; END $$`);
      await setup.query('ALTER TABLE users RENAME TO worldact_root_feed_actual_users');
      await setup.query('CREATE VIEW users AS SELECT ' + columns.map(column => column === 'nicename' ? 'worldact_root_feed_nicename(nicename) AS nicename' : '"' + column + '"').join(',') + ' FROM worldact_root_feed_actual_users');
      await setup.query('COMMIT'); view = true;
    } catch (error) { await setup.query('ROLLBACK'); throw error; }
    finally { setup.release(); }
    for (const [index, path] of ['/feed/', '/feed/atom/'].entries()) await t.test(path + ' expires the earlier grant after body rendering', async () => {
      const own: number[] = [];
      async function make(author: number, suffix: string, password: boolean) {
        const content = suffix === 'a' ? '<p>' + secret + '</p>' : '<p>Public sibling</p>';
        const post = (await pool.query("INSERT INTO posts(type,title,slug,content,raw_content,excerpt,status,author_id,password_hash,published_at,post_date,post_date_gmt) VALUES('post',$1,$1,$2,$2,$3,'publish',$4,$5,clock_timestamp()+interval '1 day',to_char(CASE WHEN coalesce((SELECT data->>'timezone' FROM settings WHERE id=1),'America/Los_Angeles')~'^[+-]' THEN timezone(coalesce((SELECT data->>'timezone' FROM settings WHERE id=1),'America/Los_Angeles')::interval,coalesce(CASE WHEN 'publish'='future' THEN NULL::timestamptz END,(clock_timestamp()+interval '1 day')::timestamptz,NULL::timestamptz,clock_timestamp())) ELSE timezone(coalesce((SELECT data->>'timezone' FROM settings WHERE id=1),'America/Los_Angeles'),coalesce(CASE WHEN 'publish'='future' THEN NULL::timestamptz END,(clock_timestamp()+interval '1 day')::timestamptz,NULL::timestamptz,clock_timestamp())) END,'YYYY-MM-DD\"T\"HH24:MI:SS'),coalesce(CASE WHEN 'publish'='future' THEN NULL::timestamptz END,(clock_timestamp()+interval '1 day')::timestamptz,NULL::timestamptz,clock_timestamp())) RETURNING id,slug", ['root-feed-' + index + '-' + suffix, content, suffix === 'a' ? secret : 'Public sibling', author, password ? await hashPassword('Root-feed-password') : null])).rows[0];
        own.push(post.id); posts.push(post.id); return post;
      }
      const a = await make(users[0], 'a', true); await make(users[1], 'b', false);
      const unlock = await api('/api/public/posts/' + a.slug + '/unlock', 'POST', { password: 'Root-feed-password' });
      assert.equal(unlock.response.status, 200, unlock.text);
      const cookie = unlock.response.headers.get('set-cookie')!.split(';')[0];
      const before = await api(path, 'GET', undefined, cookie);
      assert.equal(before.response.status, 200, before.text);
      assert.ok(before.text.includes(secret), 'Before fixture must actually show the granted feed body');
      const control = await pool.connect(); let pending: ReturnType<typeof api> | undefined;
      try {
        await pool.query('ALTER SEQUENCE worldact_root_feed_body_rendered RESTART WITH 1');
        await pool.query('UPDATE worldact_root_feed_gate SET enabled=true');
        await control.query('BEGIN');
        await control.query("SELECT pg_advisory_xact_lock(hashtext('worldact-root-feed-body-wait'))");
        pending = api(path, 'GET', undefined, cookie);
        await observe("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND position('SELECT u.nicename FROM posts p JOIN users u' in query)>0) AS ok");
        // Plain content contains no author blocks. feedPosts calls withPermalink
        // only after its grant check AND awaited renderPublicContent complete.
        // Thus A's projected nicename marks a real completed body, not a sleep.
        await observe('SELECT is_called AS ok FROM worldact_root_feed_body_rendered');
        await pool.query("UPDATE post_access_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE post_id=$1", [a.id]);
        await control.query('COMMIT');
        const result = await pending;
        console.log('ROOT_FEED_OBSERVATION', JSON.stringify({ path, status: result.response.status, secretPresent: result.text.includes(secret) }));
        assert.equal(result.text.includes(secret), false, 'Expired earlier feed body/excerpt must not survive a later different-author wait');
      } finally {
        await control.query('ROLLBACK'); control.release();
        if (pending) await pending.catch(() => {});
        await pool.query('UPDATE worldact_root_feed_gate SET enabled=false');
        await pool.query('DELETE FROM posts WHERE id=ANY($1::int[])', [own]);
      }
    });
  } finally {
    if (view) {
      const restore = await pool.connect();
      try {
        await restore.query('BEGIN'); await restore.query('DROP VIEW users');
        await restore.query('ALTER TABLE worldact_root_feed_actual_users RENAME TO users');
        await restore.query('DROP FUNCTION worldact_root_feed_nicename(varchar)');
        await restore.query('DROP TABLE worldact_root_feed_gate'); await restore.query('DROP SEQUENCE worldact_root_feed_body_rendered');
        await restore.query('COMMIT');
      } catch (error) { await restore.query('ROLLBACK'); throw error; }
      finally { restore.release(); }
    }
    await pool.query('UPDATE settings SET data=$1 WHERE id=1', [settings]);
    if (posts.length) await pool.query('DELETE FROM posts WHERE id=ANY($1::int[])', [posts]);
    if (users.length) await pool.query('DELETE FROM users WHERE id=ANY($1::int[])', [users]);
    for (const post of oldPosts) await pool.query('UPDATE posts SET status=$2 WHERE id=$1', [post.id, post.status]);
  }
});
