import test from "./isolated-test.js";
import assert from "node:assert/strict";
import { commentShortcut } from "../src/commentShortcuts.js";
import {
  emptyExportSelection,
  exportCategoryLabels,
  wxrExportQuery,
} from "../src/wxrExportSelection.js";
import type { Comment } from "../src/api.js";

const comment = (
  status: Comment["status"],
  permissions = { moderate: true, delete: true, edit: true, reply: true },
): Comment => ({
  id: 1,
  authorName: "Reader",
  content: "Hello",
  postId: 1,
  postTitle: "Post",
  status,
  createdAt: "2026-11-01",
  permissions,
});

test("comment shortcuts preserve row permissions and removed-comment action boundaries", () => {
  assert.equal(commentShortcut(comment("pending"), "a", false), "approved");
  assert.equal(commentShortcut(comment("approved"), "u", false), "pending");
  assert.equal(commentShortcut(comment("approved"), "d", false), "trash");
  for (const removed of ["spam", "trash"] as const) {
    assert.equal(commentShortcut(comment(removed), "d", false), "delete");
    assert.equal(commentShortcut(comment(removed), "z", false), "restore");
    for (const key of ["a", "u", "s", "r", "q", "e"])
      assert.equal(commentShortcut(comment(removed), key, false), null);
  }
  const none = { moderate: false, delete: false, edit: false, reply: false };
  for (const status of ["approved", "pending", "spam", "trash"] as const)
    for (const key of ["a", "u", "s", "d", "r", "q", "e", "z", "t"])
      for (const shifted of [false, true])
        assert.equal(
          commentShortcut(comment(status, none), key, shifted),
          null,
        );
  const author = comment("approved", { ...none, edit: true, reply: true });
  assert.equal(commentShortcut(author, "q", false), "quick");
  assert.equal(commentShortcut(author, "r", false), "reply");
  assert.equal(commentShortcut(author, "s", false), null);
});

test("shifted comment shortcuts choose the source bulk action only when applicable", () => {
  const active = comment("approved");
  for (const [key, operation] of [
    ["a", "approved"],
    ["u", "pending"],
    ["s", "spam"],
    ["t", "trash"],
  ])
    assert.equal(commentShortcut(active, key, true), operation);
  assert.equal(commentShortcut(active, "d", true), null);
  assert.equal(commentShortcut(active, "z", true), null);
  assert.equal(commentShortcut(comment("trash"), "z", true), "restore");
  assert.equal(commentShortcut(comment("spam"), "z", true), null);
  assert.equal(commentShortcut(comment("trash"), "d", true), "delete");
});

test("XML query builder applies only the selected content type's filters and rejects invalid ranges", () => {
  const filters = {
    ...emptyExportSelection,
    category: "3",
    author: "7",
    startDate: "2025-01",
    endDate: "2026-11",
    status: "publish",
  };
  assert.equal(wxrExportQuery(filters).toString(), "format=wxr&content=all");
  const posts = wxrExportQuery({ ...filters, content: "posts" });
  assert.deepEqual(Object.fromEntries(posts), {
    format: "wxr",
    content: "posts",
    author: "7",
    category: "3",
    startDate: "2025-01",
    endDate: "2026-11",
    status: "publish",
  });
  assert.equal(
    wxrExportQuery({ ...filters, content: "pages" }).has("category"),
    false,
  );
  const media = wxrExportQuery({ ...filters, content: "attachment" });
  assert.equal(media.has("category"), false);
  assert.equal(media.has("status"), false);
  assert.equal(
    wxrExportQuery({
      ...emptyExportSelection,
      content: "pages",
      startDate: "0001-01",
      endDate: "9999-12",
    }).get("startDate"),
    "0001-01",
  );
  for (const override of [
    { author: "0" },
    { category: "-2" },
    { author: "1&status=private" },
    { startDate: "0000-01" },
    { startDate: "2026-13" },
    { startDate: "2026-11", endDate: "2025-01" },
    { status: "deleted" },
  ])
    assert.throws(() =>
      wxrExportQuery({
        ...emptyExportSelection,
        content: "posts",
        ...override,
      }),
    );
});

test("safe category labels terminate on broken or cyclic hierarchies without interpreting names", () => {
  const result = exportCategoryLabels([
    { id: 1, name: "Root", parentId: null },
    { id: 2, name: "Child & <label>", parentId: 1 },
    { id: 3, name: "Cycle", parentId: 4 },
    { id: 4, name: "Other", parentId: 3 },
    { id: 5, name: "Orphan", parentId: 99 },
  ]);
  assert.equal(
    result.find((item) => item.id === 2)!.label,
    "— Child & <label>",
  );
  assert.equal(result.find((item) => item.id === 3)!.label, "Cycle");
  assert.equal(result.find((item) => item.id === 5)!.label, "Orphan");
  const reordered = exportCategoryLabels([
    { id: 2, name: "A child", parentId: 1 },
    { id: 1, name: "Z parent", parentId: null },
  ]);
  assert.deepEqual(
    reordered.map((item) => item.id),
    [1, 2],
  );
});
