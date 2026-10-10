const disclosures = new WeakMap();

export function renderDataBanner(banner, state) {
    const messages = [
        ...(state?.error ? [state.error] : []),
        ...(state?.metrics?.meta?.warnings ?? []),
    ];
    banner.hidden = messages.length === 0;
    if (banner.hidden) return;
    banner.className = `banner${state?.error ? " banner--error" : ""}`;
    const heading = !state?.error
        ? `Partial data (${messages.length})`
        : state.errorCode === "rate_limited"
          ? state.metrics
              ? `Rate limited - showing the data collected ${state.updatedAt ? new Date(state.updatedAt).toLocaleString() : "earlier"}`
              : "Rate limited"
          : "Collection failed";
    const title = document.createElement("strong");
    title.textContent = heading;
    const list = document.createElement("ul");
    for (const message of messages) {
        const item = document.createElement("li");
        item.textContent = message;
        list.append(item);
    }
    if (state?.error) {
        banner.replaceChildren(title, list);
        return;
    }
    let record = disclosures.get(banner);
    if (!record || record.identity !== state?.identity) {
        record = { identity: state?.identity, open: false };
        disclosures.set(banner, record);
    }
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.append(title);
    details.append(summary, list);
    details.open = record.open;
    record.details = details;
    details.addEventListener("toggle", () => {
        if (disclosures.get(banner) === record && record.details === details) record.open = details.open;
    });
    banner.replaceChildren(details);
}
