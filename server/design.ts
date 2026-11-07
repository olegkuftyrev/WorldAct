import { pool } from "./db.js";
export const pluginRegistry = [
  {
    slug: "reading-time",
    name: "Reading Time",
    version: "1.0.0",
    description: "Show an estimated reading time on published posts.",
    author: "WorldAct",
    settings: { wordsPerMinute: 200 },
  },
  {
    slug: "spam-shield",
    name: "Spam Shield",
    version: "1.0.0",
    description:
      "Hold repetitive comments and comments with excessive links as spam.",
    author: "WorldAct",
    settings: { maxLinks: 3 },
  },
  {
    slug: "site-seo",
    name: "Site SEO",
    version: "1.0.0",
    description:
      "Add search descriptions and social sharing metadata to your site.",
    author: "WorldAct",
    settings: { description: "", siteImage: "" },
  },
  {
    slug: "custom-footer",
    name: "Custom Footer",
    version: "1.0.0",
    description: "Add a custom footer message across your public site.",
    author: "WorldAct",
    settings: { text: "Thanks for reading." },
  },
] as const;
export const themes = [
  {
    id: "twentytwentyfive",
    name: "Twenty Twenty-Five",
    description:
      "A flexible, spacious publishing theme with Manrope typography.",
    version: "1.0.0",
  },
  {
    id: "twentytwentyfour",
    name: "Twenty Twenty-Four",
    description:
      "Warm editorial pages with serif headlines and a soft neutral palette.",
    version: "1.0.0",
  },
  {
    id: "twentytwentythree",
    name: "Twenty Twenty-Three",
    description:
      "Minimal typography, generous spacing, and an energetic lime accent.",
    version: "1.0.0",
  },
  {
    id: "classic",
    name: "WorldAct Classic",
    description: "A traditional serif blog presentation.",
    version: "1.0.0",
  },
];
export async function readDesign() {
  const [styles, documents, menus, plugins] = await Promise.all([
    pool.query("SELECT data FROM site_styles WHERE id=1"),
    pool.query(
      'SELECT id,slug,title,type,content,blocks,version,updated_at AS "updatedAt" FROM site_documents ORDER BY type,title',
    ),
    pool.query(
      'SELECT id,name,location,items,updated_at AS "updatedAt" FROM navigation_menus ORDER BY id',
    ),
    pool.query("SELECT slug,settings FROM extensions WHERE enabled=true"),
  ]);
  return {
    styles: styles.rows[0]?.data || {},
    templates: documents.rows.filter((d) => d.type === "template"),
    parts: documents.rows.filter((d) => d.type === "template-part"),
    patterns: documents.rows.filter((d) => d.type === "pattern"),
    menus: menus.rows,
    plugins: plugins.rows,
  };
}
export async function extensionEnabled(slug: string) {
  const r = await pool.query(
    "SELECT settings FROM extensions WHERE slug=$1 AND enabled=true",
    [slug],
  );
  return r.rows[0]?.settings || null;
}
export async function enhancePublicPost(post: Record<string, any>) {
  const settings = await extensionEnabled("reading-time");
  if (settings) {
    const words = String(post.content || "")
      .replace(/<[^>]*>/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean).length;
    return {
      ...post,
      readingTime: Math.max(
        1,
        Math.ceil(words / Math.max(50, Number(settings.wordsPerMinute) || 200)),
      ),
    };
  }
  return post;
}
export async function classifySpam(content: string) {
  const settings = await extensionEnabled("spam-shield");
  if (!settings) return false;
  const text = content.replace(/<[^>]*>/g, " ");
  return (
    (content.match(/https?:\/\//g) || []).length >
      Number(settings.maxLinks ?? 3) || /(.)\1{15,}/.test(text)
  );
}
