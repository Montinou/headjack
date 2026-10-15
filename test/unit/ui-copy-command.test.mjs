import test from "node:test";
import assert from "node:assert/strict";
import { copyButtonText } from "../../lib/ui/copy-command.mjs";

test("without a label the button shows and is named Copy command", () =>
  assert.deepEqual(copyButtonText(), { visible: "Copy command", name: undefined }));

test("with a label the button shows Copy and is named Copy {label} command", () =>
  assert.deepEqual(copyButtonText("search"), { visible: "Copy", name: "Copy search command" }));

test("the accessible name starts with the visible label (WCAG 2.5.3)", () => {
  for (const label of [undefined, "search", "harness detect"]) {
    const { visible, name } = copyButtonText(label);
    assert.ok((name ?? visible).startsWith(visible), `${label}: ${name} / ${visible}`);
  }
});
