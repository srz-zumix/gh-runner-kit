import { readFileSync } from "node:fs";

export const HOSTED_PRICES = JSON.parse(readFileSync(new URL("./hosted_prices.json", import.meta.url), "utf8"));

/** Match workflow labels to current hosted pools; job runner IDs identify instances, not pools. */
export function priceHostedJob(job, { hostedRunners = [], selfHostedIds = new Set(), selfHostedNames = new Set(), publicRepository = null } = {}) {
    const labels = (job.labels ?? []).map((label) => String(label).toLowerCase());
    let price = { os: "UNKNOWN", sku: "", runnerClass: "Unknown runner", architecture: "", cpuCores: 0, memoryGB: 0, storageGB: 0, larger: false, excluded: false, rate: null, source: "", reason: "runner hardware could not be identified" };
    if (selfHostedIds.has(job.runner_id) || selfHostedNames.has(job.runner_name) || labels.includes("self-hosted")) {
        return { ...price, excluded: true, source: "self-hosted", reason: "" };
    }
    const matches = hostedRunners.filter((runner) => runner.name && labels.includes(runner.name.toLowerCase()));
    if (matches.length > 0) {
        if (matches.length !== 1 || (job.runner_group_id && job.runner_group_id !== matches[0].runner_group_id)) {
            return { ...price, reason: "hosted pool label or runner group is ambiguous" };
        }
        price = pricePool(matches[0], price);
    } else {
        const specs = [...HOSTED_PRICES.standard, ...HOSTED_PRICES.macosLarger]
            .filter((spec) => spec.labels.some((label) => labels.includes(label)));
        if (specs.length === 1 && (!job.runner_group_name || job.runner_group_name.toLowerCase() === "github actions")) {
            const spec = specs[0];
            const larger = !spec.sku.startsWith("actions_");
            const varies = !larger && spec.publicCPU;
            price = {
                ...price, os: spec.os, sku: spec.sku, architecture: spec.architecture,
                cpuCores: varies ? (publicRepository === null ? 0 : publicRepository ? spec.publicCPU : spec.cpu) : spec.cpu,
                memoryGB: varies ? (publicRepository === null ? 0 : publicRepository ? spec.publicMemoryGB : spec.memoryGB) : spec.memoryGB,
                storageGB: spec.storageGB, larger, source: "workflow label",
            };
        } else {
            for (const label of labels) {
                if (label.startsWith("ubuntu-")) price.os = "UBUNTU";
                if (label.startsWith("windows-")) price.os = "WINDOWS";
                if (label.startsWith("macos-")) price.os = "MACOS";
            }
        }
    }
    price.runnerClass = price.sku || `${price.os} (unknown hardware)`;
    const rate = HOSTED_PRICES.rates[price.sku];
    if (Number.isFinite(rate)) {
        if (price.sku.startsWith("actions_") && publicRepository === null) {
            price.reason = "repository visibility is unavailable";
        } else {
            const free = price.sku.startsWith("actions_") && publicRepository;
            price.rate = free ? 0 : rate;
            price.reason = "";
            if (free) price.source += "; public standard runner is free";
        }
    }
    return price;
}

function pricePool(runner, base) {
    const price = { ...base, larger: true, source: "current hosted pool", reason: "unsupported hosted machine size or platform" };
    const size = runner.machine_size_details;
    if (!size) return price;
    price.cpuCores = size.cpu_cores;
    price.memoryGB = size.memory_gb;
    price.storageGB = size.storage_gb;
    const platform = String(runner.platform ?? "").toLowerCase();
    let os;
    if (["linux-x64", "linux-arm64"].includes(platform)) { price.os = "UBUNTU"; os = "linux"; }
    else if (["win-x64", "win-arm64", "windows-x64", "windows-arm64"].includes(platform)) { price.os = "WINDOWS"; os = "windows"; }
    else if (["mac-x64", "mac-arm64", "macos-x64", "macos-arm64"].includes(platform)) { price.os = "MACOS"; os = "macos"; }
    else return price;
    const match = /^([0-9]+)-core(?:-(arm|arm64|gpu))?$/.exec(String(size.id).toLowerCase());
    if (!match || Number(match[1]) !== size.cpu_cores) return price;
    price.architecture = "x64";
    let suffix = "";
    if (match[2] === "gpu") suffix = "_gpu";
    else if (match[2] === "arm" || match[2] === "arm64" || platform.includes("arm64")) {
        price.architecture = "arm64";
        suffix = "_arm";
    }
    price.sku = `${os}_${size.cpu_cores}_core${suffix}`;
    if (os === "linux" && size.cpu_cores === 2 && !suffix) price.sku = "linux_2_core_advanced";
    if (os === "macos") {
        if (size.cpu_cores === 12 && !suffix) price.sku = "macos_l";
        if (size.cpu_cores === 5 && suffix === "_arm") price.sku = "macos_xl";
    }
    return price;
}
