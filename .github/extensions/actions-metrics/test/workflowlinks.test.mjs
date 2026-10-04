import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../public/links.js", import.meta.url), "utf8");
const { workflowFileLink } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

function renderLink(row, host) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
    globalThis.document = {
        createElement: (tag) => ({
            tag,
            attributes: {},
            setAttribute(key, value) {
                this.attributes[key] = value;
            },
        }),
    };
    try {
        return workflowFileLink(row, host);
    } finally {
        if (descriptor) Object.defineProperty(globalThis, "document", descriptor);
        else delete globalThis.document;
    }
}

test("workflow names link to their default-branch files for both report shapes and hosts", () => {
    for (const host of [null, "ghe.example.com"]) {
        for (const label of [{ workflow: "Build and Test" }, { name: "Build and Test" }]) {
            for (const repository of ["octo/app", "octo/other"]) {
                const node = renderLink({ ...label, repository, workflowPath: ".github/workflows/build.yml" }, host);
                assert.equal(node.tag, "a");
                assert.equal(node.textContent, "Build and Test");
                assert.equal(node.attributes.href, `https://${host || "github.com"}/${repository}/blob/HEAD/.github/workflows/build.yml`);
                assert.equal(node.attributes.target, "_blank");
                assert.equal(node.attributes.rel, "noreferrer");
                assert.ok(node.attributes.title.includes("default branch"));
            }
        }
    }
});

test("workflow file links encode path segments without changing the display name", () => {
    const node = renderLink({
        repository: "octo/app",
        workflow: "<Build & Test>",
        workflowPath: ".github/workflows/build #1.yml",
    });
    assert.equal(node.textContent, "<Build & Test>");
    assert.equal(node.attributes.href, "https://github.com/octo/app/blob/HEAD/.github/workflows/build%20%231.yml");
});

test("dynamic workflows and missing file identities are not given broken file links", () => {
    for (const row of [
        { repository: "octo/app", workflowPath: "dynamic/agents/copilot-pull-request-reviewer" },
        { repository: "octo/app", workflowPath: "dynamic/dependabot/dependabot-updates" },
        { repository: "octo/app" },
        { workflowPath: ".github/workflows/build.yml" },
    ]) {
        const node = renderLink({ workflow: "Workflow", ...row });
        assert.equal(node.tag, "span");
        assert.equal(node.textContent, "Workflow");
        assert.equal(node.attributes.href, undefined);
        assert.equal(node.attributes.title, "No repository workflow file is available for this workflow");
    }
});
