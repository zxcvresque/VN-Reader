import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import React from "react";
import Renderer, { act } from "react-test-renderer";
import ts from "typescript";
import * as formLogic from "../server/formLogic.mjs";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../src/forms/FormRunner.tsx", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const schema = formLogic.normalizeSchema({ pages: [
  { id: "start", title: "Start", fields: [{ id: "member", type: "yesno", label: "Member?", required: true }], jumps: [{ when: { rules: [{ field: "member", op: "eq", value: "no" }] }, to: "end" }] },
  { id: "details", title: "Details", fields: [{ id: "name", type: "short", label: "Name", required: true }] },
  { id: "end", title: "End", fields: [{ id: "note", type: "short", label: "Note", required: true }] }
] });

test("draft resume follows the applicable path and remembers backwards navigation immediately", () => {
  const original = globalThis.window;
  globalThis.window = { requestAnimationFrame() {} };
  let draft = { startedAt: 100, answers: { member: "yes", name: "Ada" } };
  const api = { drafts: { get: () => draft, set: (_slug, value) => { draft = value; } }, call: async () => ({}) };
  const module = { exports: {} };
  new Function("require", "module", "exports", js)(id => id === "./api" ? api : id.endsWith("/formLogic.mjs") ? formLogic : require(id), module, module.exports);
  let tree;
  function open(layout = "classic") {
    act(() => tree?.unmount());
    const form = { slug: "draft-test", schema, settings: {}, theme: { layout, submitLabel: "Send" } };
    act(() => { tree = Renderer.create(React.createElement(module.exports.default, { form })); });
    return tree.root.findByType("h2").children.join("");
  }
  const button = name => tree.root.findAllByType("button").find(item => item.children.includes(name));
  try {
    assert.equal(open(), "End", "legacy answer-only draft");
    act(() => button("Back").props.onClick());
    assert.equal(draft.stepKey, "details");
    assert.equal(open(), "Details", "an intentionally revisited complete page");
    draft = { ...draft, answers: { member: "no" } };
    assert.equal(open(), "End", "previous page is now skipped");
    draft = { ...draft, answers: { member: "yes" } };
    assert.equal(open(), "Details", "an earlier required page became applicable");
    assert.equal(open("focus"), "Details", "layout change resolves by visible question");
    assert.equal(draft.stepKey, "name");
    act(() => button("Start over").props.onClick());
    assert.equal(draft, null);
    assert.equal(tree.root.findByType("h2").children.join(""), "Start");
  } finally {
    act(() => tree?.unmount());
    if (original === undefined) delete globalThis.window;
    else globalThis.window = original;
  }
});
