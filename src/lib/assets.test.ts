import { test } from "node:test";
import assert from "node:assert/strict";

import { assetLink, linkLabel } from "./assets.ts";

test("asset links reach notes/assets from any note depth", () => {
  assert.equal(assetLink("a.md", "pic.png"), "assets/pic.png");
  assert.equal(assetLink("lore/a.md", "pic.png"), "../assets/pic.png");
  assert.equal(assetLink("a/b/c.md", "pic.png"), "../../assets/pic.png");
});

test("link labels drop the extension and brackets", () => {
  assert.equal(linkLabel("My Photo.PNG"), "My Photo");
  assert.equal(linkLabel("[x].png"), "x");
});
