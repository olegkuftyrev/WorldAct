import test from "node:test";
import assert from "node:assert/strict";
import { attachment } from "../src/editor/mediaAttachment.js";
import type { Media } from "../src/api.js";

test("local upload and REST picker attachments expose native playlist audio and cover metadata", () => {
  const item: Media = {
    id: 8,
    title: "Song <Live>",
    url: "/uploads/song.mp3",
    mimeType: "audio/mpeg",
    filename: "song.mp3",
    alt: "",
    caption: "",
    size: 32,
    createdAt: "2026-01-01",
    audioMetadata: {
      artist: "Example artist",
      album: "Recorded album",
      length: 9,
      length_formatted: "0:09",
    },
    image: {
      id: 9,
      src: "/uploads/cover.png",
      alt: "Album cover",
      width: 512,
      height: 512,
    },
  };
  for (const rest of [false, true]) {
    const result = attachment(item, rest, "https://example.test");
    assert.equal(result.artist, "Example artist");
    assert.equal(result.album, "Recorded album");
    assert.equal(result.fileLength, "0:09");
    assert.deepEqual(result.image, {
      ...item.image,
      src: "https://example.test/uploads/cover.png",
    });
    assert.equal((result.media_details as any).length_formatted, "0:09");
    assert.equal(
      rest ? (result.title as any).raw : result.title,
      "Song <Live>",
    );
  }
  const noCover = attachment({
    ...item,
    image: null,
    audioMetadata: undefined,
  });
  assert.equal(noCover.image, undefined);
  assert.equal(noCover.artist, undefined);
});
