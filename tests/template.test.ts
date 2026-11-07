import test from "node:test";
import assert from "node:assert/strict";
import { DOMParser as TestDOMParser } from "linkedom";
import { renderTemplate } from "../src/template.js";

const parser = new TestDOMParser() as unknown as DOMParser;
function render(template: string, values: Record<string, string>) {
  return renderTemplate(template, values, parser);
}
function documentOf(html: string) {
  return parser.parseFromString(
    `<!doctype html><html><head></head><body>${html}</body></html>`,
    "text/html",
  );
}

test("template raw HTML slots cannot break out of attributes", () => {
  const output = render('<div class="{{content}}">{{content}}</div>', {
    content: '<p>x" onmouseover="alert(1)" x="</p>',
  });
  const document = documentOf(output);
  assert.equal(document.querySelector("[onmouseover]"), null);
  assert.equal(document.querySelector("div")?.hasAttribute("class"), false);
  assert.equal(
    document.querySelector("p")?.textContent,
    'x" onmouseover="alert(1)" x="',
  );
});

test("metadata is text in both text nodes and quoted attributes", () => {
  const output = render('<h1 aria-label="{{postTitle}}">{{postTitle}}</h1>', {
    postTitle: '<img src=x onerror=alert(1)> & "hello"',
  });
  const document = documentOf(output);
  assert.equal(document.querySelector("img"), null);
  assert.equal(
    document.querySelector("h1")?.textContent,
    '<img src=x onerror=alert(1)> & "hello"',
  );
  assert.equal(
    document.querySelector("h1")?.getAttribute("aria-label"),
    '<img src=x onerror=alert(1)> & "hello"',
  );
});

test("bound URL tokens cannot introduce executable or protocol-relative schemes", () => {
  for (const unsafe of [
    "javascript:alert(1)",
    "java\tscript:alert(1)",
    "data:text/html,unsafe",
    "//example.com",
    "/\\example.com",
  ]) {
    const document = documentOf(
      render('<a href="{{postTitle}}">Link</a><img src="{{postTitle}}">', {
        postTitle: unsafe,
      }),
    );
    assert.equal(
      document.querySelector("a")?.hasAttribute("href"),
      false,
      unsafe,
    );
    assert.equal(
      document.querySelector("img")?.hasAttribute("src"),
      false,
      unsafe,
    );
  }
  const document = documentOf(
    render('<a href="{{postTitle}}">Link</a>', {
      postTitle: "https://example.com/path?a=1&b=2",
    }),
  );
  assert.equal(
    document.querySelector("a")?.getAttribute("href"),
    "https://example.com/path?a=1&b=2",
  );
  assert.equal(
    document.querySelector("a")?.getAttribute("rel"),
    "noopener noreferrer",
  );
});

test("template binding preserves safe Gutenberg layout and never recursively expands author text", () => {
  const content =
    '<div class="wp-block-columns is-layout-flex"><div class="wp-block-column"><p>{{postTitle}}</p></div><div class="wp-block-column"><figure class="wp-block-table"><table><tbody><tr><td>A</td></tr></tbody></table></figure></div></div>';
  const document = documentOf(
    render("<article><h1>{{postTitle}}</h1>{{content}}</article>", {
      postTitle: "Saved title",
      content,
    }),
  );
  assert.equal(document.querySelectorAll(".wp-block-column").length, 2);
  assert.equal(document.querySelector("td")?.textContent, "A");
  assert.equal(document.querySelector("p")?.textContent, "{{postTitle}}");
  assert.equal(document.querySelector("h1")?.textContent, "Saved title");
});

test("bound raw fragments cannot add handlers, executable tags, or unsafe resource URLs", () => {
  const document = documentOf(
    render("<main>{{content}}</main>", {
      content:
        '<script>alert(1)</script><iframe src="https://example.com"></iframe><img src="javascript:alert(1)" onerror="alert(1)"><a href="javascript:alert(1)">Unsafe</a>',
    }),
  );
  assert.equal(document.querySelector("script,iframe,[onerror]"), null);
  assert.equal(document.querySelector("img")?.hasAttribute("src"), false);
  assert.equal(document.querySelector("a")?.hasAttribute("href"), false);
});

test("metadata preserves literal entity-looking user text without decoding it", () => {
  const literal = "A &lt;literal&gt; &amp; title";
  const document = documentOf(
    render("<h1>{{postTitle}}</h1>", { postTitle: literal }),
  );
  assert.equal(document.querySelector("h1")?.textContent, literal);
});
