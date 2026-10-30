const collapsedCards = new Map();

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
        const update = () => {
            const collapsed = collapsedCards.get(key) === true;
            card.classList.toggle("card--collapsed", collapsed);
            button.setAttribute("aria-expanded", String(!collapsed));
            button.setAttribute("aria-label", `${collapsed ? "Expand" : "Collapse"} ${label}`);
        };
        button.addEventListener("click", () => {
            collapsedCards.set(key, !collapsedCards.get(key));
            update();
        });
        title.replaceChildren(button);
        update();
    }
}
