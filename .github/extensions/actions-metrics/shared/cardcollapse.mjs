const collapsedCards = new Map();
const cardControls = new WeakMap();

export function makeCardsCollapsible(root, scope) {
    for (const card of root.querySelectorAll("section.card")) {
        const title = card.querySelector(":scope > .card__header > .card__title");
        if (!title || title.querySelector(".card__toggle")) continue;
        const label = title.textContent;
        const key = `${scope}:${label}`;
        const button = root.ownerDocument.createElement("button");
        button.type = "button";
        button.className = "card__toggle";
        button.textContent = label;
        button.title = "Option/Alt-click to expand or collapse all cards in this tab";
        const update = () => {
            const collapsed = collapsedCards.get(key) === true;
            card.classList.toggle("card--collapsed", collapsed);
            button.setAttribute("aria-expanded", String(!collapsed));
            button.setAttribute("aria-label", `${collapsed ? "Expand" : "Collapse"} ${label}`);
        };
        cardControls.set(card, { scope, key, update });
        button.addEventListener("click", (event = {}) => {
            const collapsed = collapsedCards.get(key) !== true;
            if (event.altKey) {
                const container = card.closest?.("#content") ?? root;
                for (const sibling of container.querySelectorAll("section.card")) {
                    const control = cardControls.get(sibling);
                    if (!control || control.scope !== scope) continue;
                    collapsedCards.set(control.key, collapsed);
                    control.update();
                }
            } else {
                collapsedCards.set(key, collapsed);
                update();
            }
        });
        title.replaceChildren(button);
        update();
    }
}
