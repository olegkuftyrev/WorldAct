import test, { after } from "./isolated-test.js";
import "dotenv/config";
after(async () => {
  await pool.end();
});
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import path from "node:path";
import {
  bundledFontCollection,
  inspectFont,
  injectFontLibrary,
  validateFontChoices,
} from "../server/fonts.js";
import { compileThemeStyles } from "../src/themeStyles.js";
import { pool, rootDir, uploadsDir } from "../server/db.js";
import { cleanContent } from "../server/utils.js";
const base = process.env.TEST_API_URL || "http://127.0.0.1:3001",
  origin = process.env.APP_ORIGIN || "http://127.0.0.1:5173";
async function api(route: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(base + "/api" + route, {
    method,
    headers: {
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
    },
    ...(body === undefined
      ? {}
      : { body: body instanceof FormData ? body : JSON.stringify(body) }),
  });
  return { response, data: await response.json() };
}
const source =
  bundledFontCollection.find((family) => family.name === "Fira Code") ||
  bundledFontCollection[0];

test("font verifier reads actual metadata and rejects malformed, expanded, and foreign files", async () => {
  const bytes = await readFile(
      path.join(rootDir, "public", source.faces[0].url),
    ),
    verified = await inspectFont(bytes);
  assert.equal(verified.format, "woff2");
  assert.ok(verified.metadata.family.length);
  assert.ok(verified.metadata.numGlyphs > 1);
  assert.ok(verified.metadata.characterCount > 1);
  assert.match(verified.metadata.license, /license/i);
  const ttf = await inspectFont(
    await readFile(
      path.join(
        rootDir,
        "public/vendor/wordpress/wp-content/themes/twentytwentythree/assets/fonts/inter/Inter-VariableFont_slnt,wght.ttf",
      ),
    ),
  );
  assert.equal(ttf.format, "truetype");
  assert.equal(ttf.metadata.family, "Inter");
  await assert.rejects(
    inspectFont(Buffer.from("<html>not a font at all</html>")),
  );
  await assert.rejects(inspectFont(bytes.subarray(0, 48)));
  const expanded = Buffer.from(bytes);
  expanded.writeUInt32BE(64 * 1024 * 1024, 16);
  await assert.rejects(inspectFont(expanded), /expanded-size/);
  const invalidReserved = Buffer.from(bytes);
  invalidReserved.writeUInt16BE(1, 14);
  await assert.rejects(inspectFont(invalidReserved), /header/);
  const broken = Buffer.from(bytes);
  broken.fill(0, 48);
  await assert.rejects(
    inspectFont(broken),
    /metadata|verified|duplicate tables/,
  );
  const bomb = Buffer.alloc(64);
  bomb.write("wOF2");
  bomb.writeUInt32BE(0x00010000, 4);
  bomb.writeUInt32BE(bomb.length, 8);
  bomb.writeUInt16BE(1, 12);
  bomb.writeUInt32BE(32, 16);
  bomb.writeUInt32BE(1, 20);
  bomb[48] = 10;
  bomb[49] = 1;
  bomb.set([0xa0, 0x80, 0x80, 0], 50);
  await assert.rejects(inspectFont(bomb), /expanded font exceeds/);
  await assert.rejects(inspectFont(Buffer.alloc(8 * 1024 * 1024 + 1)), /8 MiB/);
});

test("font names are safely quoted and rich text supports bounded Unicode font stacks", () => {
  const css = compileThemeStyles({ settings: {} }, ".scope", {
    fontFamily: "O'Connor (École)",
    headingFont: "日本語 Font",
  });
  assert.match(css, /font-family:"O'Connor \(École\)"/);
  assert.match(css, /font-family:"日本語 Font"/);
  const html = cleanContent(
    `<p style="font-family:&quot;O'Connor (École)&quot;, serif">Safe font</p>`,
  );
  assert.match(html, /font-family:/);
  assert.match(html, /École/);
  for (const value of [
    "url(javascript:alert(1))",
    "Font\\3bcolor:red",
    "expression(alert(1))",
    "Font\nName",
  ]) {
    const clean = cleanContent(`<p style='font-family:${value}'>Text</p>`);
    assert.doesNotMatch(clean, /font-family:/);
  }
});

test("admin Font Library uploads verified bytes, scopes activation, and removes font files", async (t) => {
  const login = await api("/auth/login", "POST", {
    login: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_PASSWORD,
  });
  assert.equal(login.response.status, 200);
  const cookie = (login.response.headers.get("set-cookie") || "").split(";")[0];
  const familyIds: number[] = [];
  let uploadedFile: string | undefined;
  let editorId: number | undefined;
  try {
    await t.test(
      "authentication and browser MIME cannot bypass validation",
      async () => {
        assert.equal((await api("/fonts")).response.status, 401);
        const oversized = new FormData();
        oversized.append(
          "file",
          new Blob([Buffer.alloc(8 * 1024 * 1024 + 1)]),
          "oversized.woff2",
        );
        const rejected = await api("/fonts/upload", "POST", oversized, cookie);
        assert.equal(rejected.response.status, 413);
        assert.match(rejected.data.error, /8 MiB/);
        const stamp = "font-editor-" + Date.now().toString(36),
          password = "Temporary-font-test-" + stamp;
        const editor = await api(
          "/users",
          "POST",
          {
            username: stamp,
            email: stamp + "@example.test",
            displayName: "Font editor test",
            role: "editor",
            password,
          },
          cookie,
        );
        assert.equal(editor.response.status, 201);
        editorId = editor.data.user.id;
        const editorLogin = await api("/auth/login", "POST", {
          login: stamp,
          password,
        });
        assert.equal(editorLogin.response.status, 200);
        const editorCookie = (
          editorLogin.response.headers.get("set-cookie") || ""
        ).split(";")[0];
        assert.equal(
          (await api("/fonts", "GET", undefined, editorCookie)).response.status,
          403,
        );
        assert.equal(
          (
            await api(
              "/fonts/install",
              "POST",
              { collectionKey: source.key },
              editorCookie,
            )
          ).response.status,
          403,
        );
        await api("/auth/logout", "POST", {}, editorCookie);
        const invalid = new FormData();
        invalid.append(
          "file",
          new Blob(["This is not a font"], { type: "font/woff2" }),
          "fake.woff2",
        );
        assert.equal(
          (await api("/fonts/upload", "POST", invalid, cookie)).response.status,
          400,
        );
        const bytes = await readFile(
          path.join(rootDir, "public", source.faces[0].url),
        );
        const form = new FormData();
        form.append(
          "file",
          new Blob([bytes], { type: "image/png" }),
          "misleading-name.exe",
        );
        const upload = await api("/fonts/upload", "POST", form, cookie);
        assert.equal(upload.response.status, 201, JSON.stringify(upload.data));
        const family = upload.data.family;
        familyIds.push(family.id);
        assert.equal(family.active, false);
        assert.notEqual(family.name, "misleading-name");
        assert.match(
          family.faces[0].url,
          /^\/uploads\/fonts\/[a-f0-9]{48}\.woff2$/,
        );
        uploadedFile = family.faces[0].url.replace(/^\/uploads\//, "");
        await access(path.join(uploadsDir, uploadedFile!));
        const duplicate = new FormData();
        duplicate.append("file", new Blob([bytes]), "same.woff2");
        assert.equal(
          (await api("/fonts/upload", "POST", duplicate, cookie)).response
            .status,
          409,
        );
      },
    );
    await t.test(
      "activation produces real scoped CSS and theme-specific native presets",
      async () => {
        const family = (
          await api("/fonts?theme=twentytwentyfive", "GET", undefined, cookie)
        ).data.families.find((item: any) => item.id === familyIds[0]);
        await assert.rejects(
          validateFontChoices({ fontFamily: family.name }, "twentytwentyfive"),
          /Activate/,
        );
        assert.equal(
          (
            await api(
              `/fonts/${family.id}/activation`,
              "PUT",
              { theme: "twentytwentyfive", active: true },
              cookie,
            )
          ).response.status,
          200,
        );
        await validateFontChoices(
          { fontFamily: family.name },
          "twentytwentyfive",
        );
        await assert.rejects(
          validateFontChoices({ fontFamily: family.name }, "twentytwentyfour"),
        );
        const document = await injectFontLibrary(
          { settings: {} },
          "twentytwentyfive",
        );
        const preset = document.settings.typography.fontFamilies.find(
          (item: any) => item.slug === `worldact-font-${family.id}`,
        );
        assert.equal(preset.name, family.name);
        const css = compileThemeStyles(document, ".font-test", {
          fontFamily: family.name,
        });
        assert.match(css, /@font-face/);
        assert.ok(css.includes(family.faces[0].url));
        assert.ok(css.includes(JSON.stringify(family.name)));
        assert.deepEqual(
          await injectFontLibrary({ settings: {} }, "twentytwentyfour"),
          { settings: {} },
        );
        assert.equal(
          (
            await api(
              `/fonts/${family.id}/activation`,
              "PUT",
              { theme: "unknown", active: true },
              cookie,
            )
          ).response.status,
          400,
        );
        assert.equal(
          (
            await api(
              `/fonts/${family.id}/activation`,
              "PUT",
              { theme: "twentytwentyfive", active: false },
              cookie,
            )
          ).response.status,
          200,
        );
        await assert.rejects(
          validateFontChoices({ fontFamily: family.name }, "twentytwentyfive"),
        );
      },
    );
    await t.test(
      "bundled installation uses local verified collection entries",
      async () => {
        assert.equal(
          (
            await api(
              "/fonts/install",
              "POST",
              { collectionKey: "../../outside" },
              cookie,
            )
          ).response.status,
          404,
        );
        const bundled = bundledFontCollection.find(
          (item) => item.name !== source.name,
        )!;
        const install = await api(
          "/fonts/install",
          "POST",
          { collectionKey: bundled.key },
          cookie,
        );
        assert.equal(
          install.response.status,
          201,
          JSON.stringify(install.data),
        );
        familyIds.push(install.data.family.id);
        assert.equal(install.data.family.source, "bundled");
        assert.ok(install.data.family.faces.length);
        assert.match(
          install.data.family.faces[0].url,
          /^\/vendor\/wordpress\/wp-content\/themes\//,
        );
        const rows = await pool.query(
          "SELECT filename FROM font_faces WHERE family_id=$1",
          [install.data.family.id],
        );
        assert.ok(rows.rows.every((item) => item.filename === null));
      },
    );
    await t.test(
      "removal deletes uploaded bytes and all theme activations",
      async () => {
        assert.equal(
          (await api(`/fonts/${familyIds[0]}`, "DELETE", undefined, cookie))
            .response.status,
          200,
        );
        await assert.rejects(access(path.join(uploadsDir, uploadedFile!)));
        assert.equal(
          (
            await pool.query("SELECT id FROM font_faces WHERE family_id=$1", [
              familyIds[0],
            ])
          ).rowCount,
          0,
        );
        assert.equal(
          (
            await pool.query(
              "SELECT family_id FROM theme_fonts WHERE family_id=$1",
              [familyIds[0]],
            )
          ).rowCount,
          0,
        );
        familyIds.shift();
      },
    );
  } finally {
    if (editorId) await api(`/users/${editorId}`, "DELETE", undefined, cookie);
    for (const id of familyIds)
      await api(`/fonts/${id}`, "DELETE", undefined, cookie);
    await api("/auth/logout", "POST", {}, cookie);
  }
});
