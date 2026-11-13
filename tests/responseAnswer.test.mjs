import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import React from "react";
import Renderer from "react-test-renderer";
import ts from "typescript";
import * as formLogic from "../server/formLogic.mjs";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../src/admin/ResponseAnswer.tsx", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX }
});
const toasts = [];
const browser = { clipboard: {} };
const component = { exports: {} };
new Function("require", "module", "exports", "navigator", outputText)(name => {
  if (name === "../../server/formLogic.mjs") return formLogic;
  if (name === "./ui") return { useToast: () => (...args) => toasts.push(args) };
  return require(name);
}, component, component.exports, browser);

function render(answer, overrides = {}) {
  return Renderer.create(React.createElement(component.exports.default, {
    answer, field: { id: "question", type: "short", label: "Question", ...overrides }
  }));
}

test("answer buttons copy the displayed value and report clipboard failures", async () => {
  const copied = [];
  browser.clipboard.writeText = async value => copied.push(value);
  const answers = [
    ["~first line\nsecond line", { type: "long" }],
    [0, { type: "number" }],
    [["one", "~Something else"], { type: "multi", options: [{ id: "one", label: "First" }] }],
    ["@example", { role: "telegram" }]
  ];
  for (const [answer, field] of answers) {
    const view = render(answer, field);
    await view.root.findByType("button").props.onClick();
    view.unmount();
  }
  assert.deepEqual(copied, ["~first line\nsecond line", "0", "First, Something else", "@example"]);
  assert.deepEqual(toasts.at(-1), ["Answer copied."]);

  browser.clipboard.writeText = async () => { throw new Error("denied"); };
  const view = render("example");
  await view.root.findByType("button").props.onClick();
  assert.equal(toasts.at(-1)[1], "bad");
  view.unmount();

  const blank = render(undefined);
  assert.equal(blank.root.findByType("dd").props.children, "Not answered");
  assert.equal(blank.root.findAllByType("button").length, 0);
  blank.unmount();
});

test("social profiles and web URLs open separately from copy controls", () => {
  const social = { label: "Active social media ID" };
  const cases = [
    ["@example", { label: "Telegram account" }, "https://t.me/example"],
    ["example", { role: "telegram" }, "https://t.me/example"],
    ["t.me/example", { role: "telegram" }, "https://t.me/example"],
    ["instagram.com/example", social, "https://instagram.com/example"],
    ["https://example.com/profile?ref=1", {}, "https://example.com/profile?ref=1"],
    ["+91 (98765) 43210", { type: "phone", label: "WhatsApp number" }, "https://wa.me/919876543210"],
    ["@example", social, undefined],
    ["javascript:alert(1)", social, undefined],
    ["https://instagram.com@example.com/", social, undefined],
    ["example.com/typed in prose", social, undefined]
  ];
  for (const [value, field, href] of cases) {
    const view = render(value, field);
    assert.equal(view.root.findAllByType("button").length, 1);
    const links = view.root.findAllByType("a");
    if (href) {
      assert.equal(links.length, 1);
      assert.equal(links[0].props.href, href);
      assert.equal(links[0].props.target, "_blank");
      assert.equal(links[0].props.rel, "noopener noreferrer");
    } else {
      assert.equal(links.length, 0);
    }
    view.unmount();
  }
});
