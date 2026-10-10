/** Identify runner type independently of whether its price or duration is known. */
export function costRunnerKind(row = {}) {
    if (row.excluded === true || row.source === "self-hosted" || row.runnerClass === "SELF_HOSTED") {
        return "self-hosted";
    }
    if (["self-hosted", "github-hosted", "unknown"].includes(row.runnerKind)) {
        return row.runnerKind;
    }
    if (row.sku || row.source === "current hosted pool" || String(row.source ?? "").startsWith("workflow label")) {
        return "github-hosted";
    }
    return "unknown";
}

export function costRunnerTypeLabel(row) {
    const labels = { "self-hosted": "Self-hosted", "github-hosted": "GitHub-hosted", unknown: "Unknown" };
    return labels[costRunnerKind(row)];
}

export function unknownCostText(row) {
    return costRunnerKind(row) === "self-hosted" ? "Unknown (self-hosted)" : "Unknown";
}
