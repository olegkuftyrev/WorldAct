import assert from "node:assert/strict";
import test from "node:test";
import { parseVideoEmbed } from "../src/embeds.js";

test("video embeds derive player URLs only from recognized providers and IDs", () => {
  assert.equal(
    parseVideoEmbed("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s")?.src,
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=30",
  );
  assert.equal(
    parseVideoEmbed("https://youtu.be/dQw4w9WgXcQ")?.provider,
    "YouTube",
  );
  assert.equal(
    parseVideoEmbed("https://youtube.com/shorts/dQw4w9WgXcQ")?.provider,
    "YouTube",
  );
  assert.equal(
    parseVideoEmbed("https://vimeo.com/123456789/abc123def")?.src,
    "https://player.vimeo.com/video/123456789?h=abc123def",
  );
  assert.equal(
    parseVideoEmbed("https://player.vimeo.com/video/123456789")?.src,
    "https://player.vimeo.com/video/123456789",
  );
  for (const url of [
    "javascript:alert(1)",
    "https://youtube.com.attacker.test/watch?v=dQw4w9WgXcQ",
    "https://youtube.com@attacker.test/watch?v=dQw4w9WgXcQ",
    "https://attacker.test@youtube.com/watch?v=dQw4w9WgXcQ",
    "https://vimeo.com/not-a-video",
    "https://youtube.com/watch?v=invalid",
    "https://youtube.com:9443/watch?v=dQw4w9WgXcQ",
  ])
    assert.equal(parseVideoEmbed(url), null, url);
});
