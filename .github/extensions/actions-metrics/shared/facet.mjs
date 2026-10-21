export function renderFacetPicker({
    create: el, id, key, label, options = [], selected = [], query = "", open = false,
    disabled = false, format = value => value, onPick, onQuery, onToggle,
}) {
    const chosen = new Set(selected);
    const labelled = options.map(option => ({ ...option, label: option.label ?? format(option.value) }));
    const ordered = labelled.filter(option => chosen.has(option.value));
    const present = new Set(ordered.map(option => option.value));
    for (const value of selected) {
        if (!present.has(value)) ordered.push({ value, label: format(value), count: 0 });
    }
    for (const option of labelled) {
        if (!chosen.has(option.value)) ordered.push(option);
    }
    const needle = query.toLowerCase();
    const shown = needle ? ordered.filter(option => option.label.toLowerCase().includes(needle)) : ordered;
    return el("details", {
        id, class: `facet${selected.length ? " facet--on" : ""}`, open,
        onToggle: event => onToggle(event.target.open),
    }, [
        el("summary", {
            class: "facet__summary", "aria-disabled": disabled ? "true" : null,
            onClick: event => { if (disabled) event.preventDefault(); },
        }, [
            el("span", { text: label }),
            el("span", { class: "facet__badge", text: selected.length ? `${selected.length} of ${ordered.length}` : String(ordered.length) }),
        ]),
        ordered.length > 12 || query ? el("input", {
            class: "facet__search", id: `${id}-search`, type: "search", disabled,
            placeholder: `Find a ${label.toLowerCase()}…`, value: query,
            onInput: event => onQuery(event.target.value),
        }) : null,
        el("div", { class: "facet__list" }, shown.slice(0, 300).map(option => el("label", {
            class: `facet__option${chosen.has(option.value) ? " facet__option--on" : ""}`,
        }, [
            el("input", {
                type: "checkbox", checked: chosen.has(option.value), disabled,
                "data-facet": key, value: option.value, onChange: () => onPick(option.value),
            }),
            el("span", { class: "facet__name", title: option.value, text: option.label }),
            el("span", { class: "facet__count", text: Number.isFinite(option.count) ? option.count.toLocaleString() : "–" }),
        ]))),
        shown.length > 300 ? el("p", { class: "facet__more", text: `${(shown.length - 300).toLocaleString()} more — narrow with the search above.` }) : null,
    ]);
}
