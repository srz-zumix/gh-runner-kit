import {
    FIELD_GROUPS, fieldByName, fieldsOfEditor, fieldsOfGroup,
    readFieldValue, sameFieldValue, writeFieldValue,
} from "/shared/fields.mjs";
import { PERIOD_PRESETS, periodPreset } from "/shared/period.mjs";

const PERIOD_FIELDS = { collection: ["since", "until"], dataset: ["filterFrom", "filterTo"] };
const PRESET_NOTE = "Local calendar dates; weeks start on Monday. Presets fill this draft only.";

function coverageOf(state) {
    return state?.metrics?.meta?.dataset?.collectionWindow ?? state?.metrics?.meta?.dataset?.window;
}

function windowText(window) {
    return `${new Date(window.Start).toLocaleString()} → ${new Date(window.End).toLocaleString()} (end exclusive)`;
}

/** Independent drafts follow untouched live fields and retain conflicts across SSE updates. */
export function initQueryEditors({ state: getState, applyFilters, el, now = Date.now }) {
    let identity = null;
    const editors = [...new Set(FIELD_GROUPS.map(group => group.editor))].map(id => ({
        id, open: false, applying: false, message: "",
        edited: new Map(), baseline: new Map(), conflicts: new Set(),
        controls: new Map(), wrappers: new Map(), presets: new Map(),
        fields: fieldsOfEditor(id),
        dom: Object.fromEntries(["toggle", "dirty-count", "editor", "form", "groups", "effect", "reset", "apply"]
            .map(name => [name, document.getElementById(`${id}-${name}`)])),
    }));

    function valueOf(editor, name) {
        return editor.edited.has(name) ? editor.edited.get(name) : getState()?.filters?.[name];
    }

    function recordValue(editor, field, value) {
        const live = getState()?.filters?.[field.name];
        if (!editor.baseline.has(field.name)) editor.baseline.set(field.name, live);
        if (sameFieldValue(field, value, live)) {
            editor.edited.delete(field.name);
            editor.baseline.delete(field.name);
            editor.conflicts.delete(field.name);
        } else {
            editor.edited.set(field.name, value);
        }
        editor.message = "";
    }

    function setPeriod(editor, group, values) {
        for (const [index, name] of PERIOD_FIELDS[group].entries()) {
            const field = fieldByName(name);
            editor.controls.get(name).value = writeFieldValue(field, values[index]);
            recordValue(editor, field, values[index]);
        }
    }

    function fieldControl(editor, field) {
        const props = { id: `query-field-${field.name}`, name: field.name, "aria-describedby": `query-hint-${field.name}` };
        let control;
        if (field.control === "select") {
            control = el("select", props, field.options.map(value => el("option", { value, text: value })));
        } else {
            const type = { checkbox: "checkbox", number: "number", datetime: "datetime-local" }[field.control] ?? "text";
            control = el("input", {
                ...props, type, ...(type === "number" ? { min: field.min, max: field.max, step: field.step ?? 1 }
                    : type === "datetime-local" ? { step: "any" }
                        : { spellcheck: "false", autocomplete: "off", placeholder: field.placeholder ?? "" }),
            });
            control.required = type === "number";
        }
        editor.controls.set(field.name, control);
        const event = ["select", "checkbox"].includes(field.control) ? "change" : "input";
        control.addEventListener(event, () => {
            const raw = field.control === "checkbox" ? control.checked : control.value;
            recordValue(editor, field, readFieldValue(field, raw));
            if (PERIOD_FIELDS[field.group]?.includes(field.name)) editor.presets.get(field.group).selection = null;
            render();
        });
        const label = el("label", {
            class: `field${field.control === "checkbox" ? " field--checkbox" : ""}`, "data-field": field.name,
        }, field.control === "checkbox" ? [control, el("span", { text: field.label })] : [el("span", { text: field.label }), control]);
        editor.wrappers.set(field.name, label);
        return el("div", { class: "query-field" }, [
            label, el("small", { class: "field-hint", id: `query-hint-${field.name}`, text: field.hint ?? "" }),
        ]);
    }

    function presetControl(editor, group) {
        const options = PERIOD_PRESETS.map(preset => el("option", { value: preset.id, text: preset.label }));
        const select = el("select", { id: `${group}-period-preset`, "aria-describedby": `${group}-period-note` }, [
            el("option", { value: "", text: "Custom period" }), ...options,
        ]);
        const note = el("p", { id: `${group}-period-note`, class: "query-group__note", role: "status" });
        const preset = { select, options, note, selection: null };
        editor.presets.set(group, preset);
        select.addEventListener("change", () => {
            if (!select.value) {
                preset.selection = null;
                render();
                return;
            }
            const time = now();
            const result = periodPreset(select.value, { now: time, coverage: group === "dataset" ? coverageOf(getState()) : undefined });
            if (!result.available) {
                editor.message = result.reason;
                render();
                return;
            }
            const end = group === "collection" && result.requested.End === new Date(time).toISOString() ? "" : result.window.End;
            const days = group === "collection" ? { "last-7-days": 7, "last-30-days": 30 }[select.value] : undefined;
            const values = days ? ["", ""] : [result.window.Start, end];
            setPeriod(editor, group, values);
            if (days) {
                editor.controls.get("days").value = String(days);
                recordValue(editor, fieldByName("days"), days);
            }
            preset.selection = { id: select.value, result, values, days };
            render();
        });
        return el("div", { class: "period-preset" }, [
            el("label", { class: "field" }, [el("span", { text: "Period preset" }), select]), note,
        ]);
    }

    function clearDraft(editor, { preservePresets = false } = {}) {
        editor.edited.clear();
        editor.baseline.clear();
        editor.conflicts.clear();
        editor.message = "";
        if (!preservePresets) for (const preset of editor.presets.values()) preset.selection = null;
    }

    function closeEditor(editor, restoreFocus = true) {
        editor.open = false;
        editor.dom.editor.hidden = true;
        editor.dom.toggle.setAttribute("aria-expanded", "false");
        if (restoreFocus) editor.dom.toggle.focus();
    }

    for (const editor of editors) {
        editor.dom.groups.replaceChildren(...FIELD_GROUPS.filter(group => group.editor === editor.id).map(group => {
            const content = [
                el("h3", {}, [document.createTextNode(group.title), el("span", { class: "query-group__effect", text: group.effect })]),
                el("p", { class: "query-group__note", text: group.note }),
            ];
            if (group.id === "dataset") content.push(el("p", { class: "query-group__note", id: "dataset-period-coverage" }));
            if (PERIOD_FIELDS[group.id]) content.push(presetControl(editor, group.id));
            content.push(el("div", { class: "field-grid" }, fieldsOfGroup(group.id).map(field => fieldControl(editor, field))));
            if (group.id === "dataset") {
                const clear = el("button", { type: "button", class: "button", id: "dataset-period-clear", text: "Clear period filter" });
                clear.addEventListener("click", () => {
                    setPeriod(editor, "dataset", ["", ""]);
                    editor.presets.get("dataset").selection = null;
                    render();
                });
                content.push(clear);
            }
            return el("section", { class: "query-group", "data-group": group.id }, content);
        }));
        editor.dom.toggle.addEventListener("click", () => {
            if (editor.open) {
                closeEditor(editor);
                return;
            }
            for (const other of editors) if (other.open) closeEditor(other, false);
            editor.open = true;
            editor.dom.editor.hidden = false;
            editor.dom.toggle.setAttribute("aria-expanded", "true");
            render();
            [...editor.controls.values()].find(control => !control.disabled)?.focus();
        });
        editor.dom.reset.addEventListener("click", () => {
            clearDraft(editor);
            render();
        });
        editor.dom.form.addEventListener("submit", async event => {
            event.preventDefault();
            const state = getState();
            if (editors.some(other => other.applying) || (editor.id === "display" && (!coverageOf(state) || state?.status === "loading"))
                || !editor.dom.form.reportValidity() || editor.edited.size === 0) return;
            const patch = Object.fromEntries(editor.edited);
            editor.applying = true;
            editor.message = "";
            render();
            try {
                await applyFilters(patch);
                clearDraft(editor, { preservePresets: true });
                closeEditor(editor);
            } catch (error) {
                editor.message = `Could not apply: ${error?.message ?? error}`;
            } finally {
                editor.applying = false;
                render();
            }
        });
    }

    function render() {
        const state = getState();
        if (!state) return;
        if (identity !== null && identity !== state.identity) {
            for (const editor of editors) {
                const dirty = editor.edited.size > 0;
                clearDraft(editor);
                if (dirty) editor.message = `Target changed to ${state.key}; this draft was discarded.`;
            }
        }
        identity = state.identity;
        const busy = editors.some(editor => editor.applying);
        const coverage = coverageOf(state);
        const datasetUnavailable = !coverage || state.status === "loading";
        for (const editor of editors) {
            for (const field of editor.fields) {
                const control = editor.controls.get(field.name);
                const live = state.filters?.[field.name];
                if (editor.edited.has(field.name)) {
                    if (sameFieldValue(field, editor.edited.get(field.name), live)) {
                        editor.edited.delete(field.name);
                        editor.baseline.delete(field.name);
                        editor.conflicts.delete(field.name);
                    } else if (sameFieldValue(field, editor.baseline.get(field.name), live)) {
                        editor.conflicts.delete(field.name);
                    } else {
                        editor.conflicts.add(field.name);
                    }
                }
                const edited = editor.edited.has(field.name);
                if (!edited) {
                    const value = writeFieldValue(field, live);
                    if (field.control === "checkbox") control.checked = value;
                    else if (control.value !== value) control.value = value;
                }
                editor.wrappers.get(field.name).classList.toggle("field--dirty", edited);
                control.disabled = editor.applying || (field.name === "days" && Boolean(valueOf(editor, "since")))
                    || (editor.id === "display" && datasetUnavailable);
            }
            for (const [group, preset] of editor.presets) {
                preset.select.disabled = editor.applying || (group === "dataset" && datasetUnavailable);
                for (const [index, option] of preset.options.entries()) {
                    const definition = PERIOD_PRESETS[index];
                    const result = periodPreset(definition.id, { now: now(), coverage: group === "dataset" ? coverage : undefined });
                    option.disabled = !result.available || (group === "dataset" && datasetUnavailable);
                    option.textContent = definition.label + (!result.available ? " (unavailable)" : result.partial ? " (partial coverage)" : "");
                    option.title = result.available ? `Requested: ${windowText(result.requested)}` : result.reason;
                }
                if (preset.selection && (!PERIOD_FIELDS[group].every((name, index) =>
                    sameFieldValue(fieldByName(name), valueOf(editor, name), preset.selection.values[index]))
                    || (preset.selection.days && valueOf(editor, "days") !== preset.selection.days))) preset.selection = null;
                preset.select.value = preset.selection?.id ?? "";
                const result = preset.selection?.result;
                preset.note.classList.toggle("period-preset__partial", Boolean(result?.partial));
                preset.note.textContent = result?.partial
                    ? `Partial coverage: requested ${windowText(result.requested)}. Only ${windowText(result.window)} is available; missing dates are not analysed.`
                    : result ? `Selected ${windowText(result.window)}.${preset.selection.days ? ` Window remains a rolling ${preset.selection.days} days.`
                        : group === "collection" && !preset.selection.values[1] ? " End remains now when applied." : ""} ${PRESET_NOTE}`
                        : PRESET_NOTE;
            }
            const count = editor.edited.size;
            const effects = FIELD_GROUPS.filter(group => editor.fields.some(field => field.group === group.id && editor.edited.has(field.name)))
                .map(group => group.effect.toLowerCase());
            const conflicts = [...editor.conflicts].filter(name => editor.edited.has(name));
            editor.dom["dirty-count"].hidden = count === 0;
            editor.dom["dirty-count"].textContent = String(count);
            editor.dom.reset.disabled = count === 0 || editor.applying;
            editor.dom.apply.disabled = count === 0 || busy || (editor.id === "display" && datasetUnavailable);
            editor.dom.effect.textContent = editor.message || (editor.applying ? "Applying…"
                : count ? `${count} change${count === 1 ? "" : "s"}: ${effects.join(", ")}.${conflicts.length
                    ? ` ${conflicts.join(", ")} changed elsewhere while you were editing; applying will overwrite that.` : ""}` : "No changes.");
        }
        const coverageNote = document.getElementById("dataset-period-coverage");
        coverageNote.textContent = coverage ? `Collected: ${windowText(coverage)}.` : "Load a dataset before setting this filter.";
        const display = editors.find(editor => editor.id === "display");
        document.getElementById("dataset-period-clear").disabled = datasetUnavailable || display.applying
            || !PERIOD_FIELDS.dataset.some(name => valueOf(display, name));
        const bucketHint = document.getElementById("query-hint-bucket");
        const baseHint = fieldByName("bucket").hint;
        const resolved = state.metrics?.fleet?.bucket;
        bucketHint.textContent = state.filters?.bucket === "auto" && resolved ? `${baseHint} This window resolved to ${resolved}.` : baseHint;
    }

    return {
        render,
        close() {
            const editor = editors.find(editor => editor.open);
            if (editor) closeEditor(editor);
        },
    };
}
