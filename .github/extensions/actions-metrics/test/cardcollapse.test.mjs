import test from "node:test";
import assert from "node:assert/strict";
import { makeCardsCollapsible } from "../shared/cardcollapse.mjs";

function fixture(label) {
    const buttons = [];
    const classes = new Set();
    const title = {
        textContent: label,
        querySelector: () => buttons[0] ?? null,
        replaceChildren: button => buttons.splice(0, buttons.length, button),
    };
    const card = {
        querySelector: () => title,
        classList: { toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name) },
    };
    const root = {
        querySelectorAll: selector => {
            assert.equal(selector, "section.card");
            return [card];
        },
        ownerDocument: {
            createElement: tag => {
                assert.equal(tag, "button");
                return {
                    attributes: {}, listeners: {},
                    setAttribute(name, value) { this.attributes[name] = value; },
                    addEventListener(name, callback) { this.listeners[name] = callback; },
                };
            },
        },
    };
    return { root, buttons, classes };
}

test("cards start expanded, expose an accessible toggle and do not duplicate buttons", () => {
    const { root, buttons, classes } = fixture("Initial card");
    makeCardsCollapsible(root, "overview");
    const button = buttons[0];
    assert.equal(button.type, "button");
    assert.equal(button.textContent, "Initial card");
    assert.equal(button.attributes["aria-expanded"], "true");
    assert.equal(button.attributes["aria-label"], "Collapse Initial card");
    button.listeners.click();
    assert.ok(classes.has("card--collapsed"));
    assert.equal(button.attributes["aria-expanded"], "false");
    assert.equal(button.attributes["aria-label"], "Expand Initial card");
    makeCardsCollapsible(root, "overview");
    assert.equal(buttons.length, 1);
    assert.equal(buttons[0], button);
    button.listeners.click();
    assert.ok(!classes.has("card--collapsed"));
    assert.equal(button.attributes["aria-expanded"], "true");
});

test("collapse state survives rebuilt cards but is independent across tabs and cards", () => {
    const initial = fixture("Shared title");
    makeCardsCollapsible(initial.root, "explore");
    initial.buttons[0].listeners.click();
    const rebuilt = fixture("Shared title");
    makeCardsCollapsible(rebuilt.root, "explore");
    assert.equal(rebuilt.buttons[0].attributes["aria-expanded"], "false");
    assert.ok(rebuilt.classes.has("card--collapsed"));
    const otherTab = fixture("Shared title");
    makeCardsCollapsible(otherTab.root, "steps");
    assert.equal(otherTab.buttons[0].attributes["aria-expanded"], "true");
    const otherCard = fixture("Different title");
    makeCardsCollapsible(otherCard.root, "explore");
    assert.equal(otherCard.buttons[0].attributes["aria-expanded"], "true");
});

test("cards without a title are left unchanged", () => {
    const { root } = fixture("Unused");
    root.querySelectorAll = () => [{ querySelector: () => null }];
    makeCardsCollapsible(root, "overview");
});
