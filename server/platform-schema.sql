ALTER TABLE users ADD COLUMN IF NOT EXISTS profile jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferences jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE media ALTER COLUMN mime_type TYPE varchar(255);
ALTER TABLE media ADD COLUMN IF NOT EXISTS width integer;
ALTER TABLE media ADD COLUMN IF NOT EXISTS height integer;
ALTER TABLE media ADD COLUMN IF NOT EXISTS original_filename text;
ALTER TABLE media ADD COLUMN IF NOT EXISTS derivatives jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE TABLE IF NOT EXISTS navigation_menus (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 name varchar(160) NOT NULL,
 location varchar(40) NOT NULL DEFAULT '',
 items jsonb NOT NULL DEFAULT '[]'::jsonb,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS site_documents (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 slug varchar(160) NOT NULL,
 title varchar(200) NOT NULL,
 type varchar(20) NOT NULL CHECK (type IN ('template','template-part','pattern')),
 content text NOT NULL DEFAULT '',
 blocks jsonb,
 version integer NOT NULL DEFAULT 1,
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(type,slug)
);
CREATE TABLE IF NOT EXISTS site_styles (id integer PRIMARY KEY CHECK(id=1),data jsonb NOT NULL DEFAULT '{}'::jsonb);
ALTER TABLE site_documents ADD COLUMN IF NOT EXISTS raw_content text NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS extensions (
 slug varchar(100) PRIMARY KEY,
 enabled boolean NOT NULL DEFAULT false,
 settings jsonb NOT NULL DEFAULT '{}'::jsonb,
 installed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS password_resets (
 token_hash char(64) PRIMARY KEY,
 user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS mail_outbox (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 recipient varchar(254) NOT NULL,
 subject varchar(300) NOT NULL,
 body text NOT NULL,
 delivered boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO site_styles(id,data) VALUES(1,'{"backgroundColor":"#ffffff","textColor":"#111111","accentColor":"#3858e9","fontFamily":"Manrope","headingFont":"Manrope","contentWidth":1200,"spacing":24}') ON CONFLICT DO NOTHING;
UPDATE settings SET data='{"defaultCategoryId":null,"defaultPostFormat":"standard","frontPageMode":"posts","frontPageId":null,"postsPageId":null,"feedItems":10,"feedExcerpt":false,"defaultCommentStatus":"open","requireCommentNameEmail":true,"commentRegistration":false,"commentModeration":true,"commentsPerPage":50,"threadComments":true,"threadDepth":5,"closeCommentsDays":0,"commentOrder":"asc","permalinkStructure":"/posts/%postname%/","categoryBase":"category","tagBase":"tag","thumbnailWidth":150,"thumbnailHeight":150,"mediumWidth":300,"mediumHeight":300,"largeWidth":1024,"largeHeight":1024,"uploadsYearMonth":true,"privacyPageId":null}'::jsonb || data WHERE id=1;
INSERT INTO site_documents(slug,title,type,content) SELECT initial.slug,initial.title,initial.type,initial.content FROM (VALUES
('header','Header','template-part','<header class="site-header"><div class="site-title">{{siteTitle}}</div><nav>{{navigation}}</nav></header>'),
('footer','Footer','template-part','<footer class="site-footer"><strong>{{siteTitle}}</strong><p>{{tagline}}</p><p>Designed with WorldAct</p></footer>'),
('single','Single Posts','template','<article class="single-post"><h1>{{postTitle}}</h1><p class="post-meta">{{postDate}} · {{postAuthor}}</p><div class="public-content">{{content}}</div></article>'),
('page','Pages','template','<article class="single-post"><h1>{{postTitle}}</h1><div class="public-content">{{content}}</div></article>'),
('index','Blog Home','template','<main class="site-main"><h1>Blog</h1>{{postList}}</main>'),
('hero','Hero with heading and text','pattern','<div class="wp-block-group"><h2>Your next chapter starts here</h2><p>Share ideas, stories, and everything that matters to you.</p></div>'),
('call-to-action','Call to action','pattern','<div class="wp-block-group"><h2>Let’s build something together</h2><p>Write a message that connects with your readers.</p><p><a class="wp-element-button" href="/">Learn more</a></p></div>')
) AS initial(slug,title,type,content) WHERE NOT EXISTS (SELECT 1 FROM seed_markers WHERE name='platform-design-v1')
ON CONFLICT DO NOTHING;
INSERT INTO seed_markers(name) VALUES('platform-design-v1') ON CONFLICT DO NOTHING;

-- Canonical editor blocks for untouched built-in templates. Edited content is preserved.
UPDATE site_documents SET blocks='[{"name":"core/group","attributes":{"tagName":"header","className":"site-header","layout":{"type":"constrained"}},"innerBlocks":[{"name":"worldact/site-title","attributes":{},"innerBlocks":[]},{"name":"worldact/navigation","attributes":{},"innerBlocks":[]}]}]'::jsonb WHERE slug='header' AND blocks IS NULL AND content='<header class="site-header"><div class="site-title">{{siteTitle}}</div><nav>{{navigation}}</nav></header>';
UPDATE site_documents SET blocks='[{"name":"core/group","attributes":{"tagName":"footer","className":"site-footer","layout":{"type":"constrained"}},"innerBlocks":[{"name":"worldact/site-title","attributes":{},"innerBlocks":[]},{"name":"worldact/tagline","attributes":{},"innerBlocks":[]},{"name":"core/paragraph","attributes":{"content":"Designed with WorldAct"},"innerBlocks":[]}]}]'::jsonb WHERE slug='footer' AND blocks IS NULL AND content='<footer class="site-footer"><strong>{{siteTitle}}</strong><p>{{tagline}}</p><p>Designed with WorldAct</p></footer>';
UPDATE site_documents SET blocks='[{"name":"core/group","attributes":{"tagName":"article","className":"single-post","layout":{"type":"constrained"}},"innerBlocks":[{"name":"worldact/post-title","attributes":{},"innerBlocks":[]},{"name":"worldact/post-date","attributes":{},"innerBlocks":[]},{"name":"worldact/post-author","attributes":{},"innerBlocks":[]},{"name":"worldact/post-content","attributes":{},"innerBlocks":[]}]}]'::jsonb WHERE slug='single' AND blocks IS NULL AND content='<article class="single-post"><h1>{{postTitle}}</h1><p class="post-meta">{{postDate}} · {{postAuthor}}</p><div class="public-content">{{content}}</div></article>';
UPDATE site_documents SET blocks='[{"name":"core/group","attributes":{"tagName":"article","className":"single-post","layout":{"type":"constrained"}},"innerBlocks":[{"name":"worldact/post-title","attributes":{},"innerBlocks":[]},{"name":"worldact/post-content","attributes":{},"innerBlocks":[]}]}]'::jsonb WHERE slug='page' AND blocks IS NULL AND content='<article class="single-post"><h1>{{postTitle}}</h1><div class="public-content">{{content}}</div></article>';
UPDATE site_documents SET blocks='[{"name":"core/group","attributes":{"tagName":"main","className":"site-main","layout":{"type":"constrained"}},"innerBlocks":[{"name":"core/heading","attributes":{"level":1,"content":"Blog"},"innerBlocks":[]},{"name":"worldact/post-list","attributes":{},"innerBlocks":[]}]}]'::jsonb WHERE slug='index' AND blocks IS NULL AND content='<main class="site-main"><h1>Blog</h1>{{postList}}</main>';
ALTER TABLE media ADD COLUMN IF NOT EXISTS sizes jsonb NOT NULL DEFAULT '{}'::jsonb;
UPDATE settings SET data='{"thumbnailCrop":true}'::jsonb || data WHERE id=1;
-- A theme location has one assigned menu. Keep the most recently assigned one.
UPDATE navigation_menus m SET location='' WHERE location<>'' AND EXISTS (SELECT 1 FROM navigation_menus newer WHERE newer.location=m.location AND (newer.updated_at,newer.id)>(m.updated_at,m.id));
CREATE UNIQUE INDEX IF NOT EXISTS navigation_unique_location ON navigation_menus(location) WHERE location<>'';
