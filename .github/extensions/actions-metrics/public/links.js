export function workflowFileLink(row, host) {
    const path = row.workflowPath ?? "";
    const hasFile = Boolean(row.repository) && path.startsWith(".github/workflows/");
    const node = document.createElement(hasFile ? "a" : "span");
    node.textContent = row.workflow || row.name || "(unnamed)";
    if (hasFile) {
        const repository = row.repository.split("/").map(encodeURIComponent).join("/");
        const file = path.split("/").map(encodeURIComponent).join("/");
        node.setAttribute("href", `https://${host || "github.com"}/${repository}/blob/HEAD/${file}`);
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noreferrer");
        node.setAttribute("title", `Open ${row.repository}/${path} on the default branch`);
    } else {
        node.setAttribute("title", "No repository workflow file is available for this workflow");
    }
    return node;
}
