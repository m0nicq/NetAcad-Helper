/*
 * Page-side helper for the NetAcad helper extension.
 *
 * The UI (floating button + answer box) is created once. The matching/clicking
 * logic is declared at the top level and is therefore re-usable when the
 * background injects this file again at runtime via chrome.scripting.
 */

const { parseAnswerLines, matchAnswersToOptions } = globalThis.AnswerMatcher;

const SELECTED_ICONS = ["check_box", "check_box_checked", "radio_button_checked"];
const UNCHECKED_ICONS = ["check_box_outline_blank", "radio_button_unchecked"];
const STATE_CHECK_DELAY_MS = 150;

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ------------------------------------------------------------------
// Shadow-DOM aware traversal
// NetAcad renders the MCQ items inside Lit web components, so plain
// document.querySelectorAll() finds nothing. These helpers walk every
// open shadow root recursively.
// ------------------------------------------------------------------
function collectRoots(root = document, roots = []) {
    roots.push(root);
    const hosts = root.querySelectorAll ? root.querySelectorAll("*") : [];
    for (const el of hosts) {
        if (el.shadowRoot) collectRoots(el.shadowRoot, roots);
    }
    return roots;
}

function deepQueryAll(selector, baseRoot = document) {
    const found = [];
    const seen = new Set();
    for (const root of collectRoots(baseRoot)) {
        if (!root.querySelectorAll) continue;
        for (const el of root.querySelectorAll(selector)) {
            if (!seen.has(el)) {
                seen.add(el);
                found.push(el);
            }
        }
    }
    return found;
}

function deepQuery(selector, baseRoot = document) {
    return deepQueryAll(selector, baseRoot)[0] || null;
}

function countShadowRoots() {
    return collectRoots().length - 1;
}

function getOptionInput(item) {
    if (item.tagName === "INPUT") return item;
    return deepQuery("input[type='radio'], input[type='checkbox']", item);
}

function getStateIcon(item) {
    return deepQuery(".mcq__item-icon material-icon, material-icon", item);
}

// Collect every answer option on the page (MCQ items and generic radio/checkbox wrappers).
function collectOptionItems() {
    const items = [];
    const seen = new Set();
    const add = (el) => {
        if (el && !seen.has(el)) {
            seen.add(el);
            items.push(el);
        }
    };

    deepQueryAll(".mcq__item").forEach(add);
    deepQueryAll("[role='radio'], [role='checkbox']").forEach((el) => {
        if (deepQuery("label", el) || getOptionInput(el)) add(el);
    });
    deepQueryAll("input[type='radio'], input[type='checkbox']").forEach((input) => {
        if (!input.closest) return;
        add(input.closest(".mcq__item") || input.closest("label") || input.parentElement);
    });
    // Last resort: an icon that marks an answer state — climb to its wrapper.
    if (!items.length) {
        deepQueryAll("material-icon[icon^='check_box'], material-icon[icon^='radio_button']").forEach((icon) => {
            const wrapper = icon.closest ? (icon.closest(".mcq__item") || icon.closest("label")) : null;
            if (wrapper) add(wrapper);
        });
    }

    return items;
}

// Options of one question share the same parent container.
function groupIntoQuestions(items) {
    const groups = new Map();
    for (const item of items) {
        const parent = item.parentElement || item.getRootNode();
        if (!groups.has(parent)) groups.set(parent, []);
        groups.get(parent).push(item);
    }
    return Array.from(groups.values());
}

// Visible text of an option, without screen-reader noise ("1 of 5").
function optionText(item) {
    const clone = item.cloneNode(true);
    deepQueryAll("input, script, style, .screenReader-position-text, [class*='screenReader']", clone)
        .forEach((node) => node.remove());
    const textEl = deepQuery(".mcq__item-text-inner", clone)
        || deepQuery(".mcq__item-text", clone)
        || deepQuery("label", clone)
        || clone;
    return (textEl.textContent || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function isOptionSelected(item) {
    if (!item) return false;
    if (item.getAttribute("aria-checked") === "true") return true;

    const input = getOptionInput(item);
    if (input && input.checked) return true;

    const icon = getStateIcon(item);
    if (icon && SELECTED_ICONS.includes(icon.getAttribute("icon"))) return true;

    return item.classList.contains("is-checked")
        || item.classList.contains("selected")
        || item.classList.contains("is-selected");
}

function dispatchPointerSequence(el) {
    const options = { bubbles: true, cancelable: true, composed: true, view: window };
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        const usePointer = type.startsWith("pointer") && typeof PointerEvent === "function";
        el.dispatchEvent(usePointer ? new PointerEvent(type, options) : new MouseEvent(type, options));
    }
}

// Clicks an option and verifies the state actually changed.
async function selectOption(item) {
    if (isOptionSelected(item)) return { ok: true, already: true };

    // Click order mirrors what a real user click does: the visible label/wrapper
    // first (its listener lives on the .mcq__item container), then the input.
    const strategies = [
        (el) => {
            const label = deepQuery("label", el);
            if (!label) return false;
            label.click();
            return true;
        },
        (el) => {
            if (el.classList.contains("mcq__item")) {
                el.click();
                return true;
            }
            const wrapper = el.closest && el.closest(".mcq__item");
            if (!wrapper) return false;
            wrapper.click();
            return true;
        },
        (el) => {
            dispatchPointerSequence(deepQuery("label", el) || el);
            return true;
        },
        (el) => {
            const input = getOptionInput(el);
            if (!input) return false;
            input.click();
            return true;
        }
    ];

    for (const strategy of strategies) {
        if (!strategy(item)) continue;
        await delay(STATE_CHECK_DELAY_MS);
        if (isOptionSelected(item)) return { ok: true };
    }

    // Last resort: force the input and notify listeners (composed so it escapes shadow roots).
    const input = getOptionInput(item);
    if (input) {
        try {
            input.checked = true;
            input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
            input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
            const wrapper = (input.closest && input.closest(".mcq__item")) || item;
            wrapper.setAttribute("aria-checked", "true");
            const icon = getStateIcon(wrapper);
            if (icon) {
                const current = icon.getAttribute("icon") || "";
                if (current.startsWith("radio_button")) icon.setAttribute("icon", "radio_button_checked");
                else if (current.startsWith("check_box")) icon.setAttribute("icon", "check_box");
            }
            await delay(STATE_CHECK_DELAY_MS);
        } catch {
            // ignore and fall through to the final check
        }
    }

    return { ok: isOptionSelected(item) };
}

function buildQuestionsModel() {
    const groups = groupIntoQuestions(collectOptionItems());
    return groups.map((group) => {
        const single = !group.some((item) =>
            item.getAttribute("role") === "checkbox"
            || deepQuery(".is-checkbox", item)
            || (getStateIcon(item)?.getAttribute("icon") || "").startsWith("check_box")
        );
        return {
            single,
            items: group,
            options: group.map((item) => ({ text: optionText(item) }))
        };
    }).filter((question) => question.items.length > 0);
}

// Main entry: matches the AI answer against page options and clicks them.
async function applyAnswerToPage(answerText) {
    const lines = parseAnswerLines(answerText);
    if (!lines.length) {
        return { selected: [], failed: [], notMatched: [], error: "Empty answer." };
    }

    const questions = buildQuestionsModel();
    if (!questions.length) {
        const stats = {
            mcqItems: deepQueryAll(".mcq__item").length,
            inputs: deepQueryAll("input[type='radio'], input[type='checkbox']").length,
            roles: deepQueryAll("[role='radio'], [role='checkbox']").length,
            shadowRoots: countShadowRoots(),
            iframes: document.querySelectorAll("iframe").length
        };
        console.log("[NetAcad Helper] no answer options found", stats);
        return {
            selected: [],
            failed: [],
            notMatched: lines,
            error: `No answer options found on this page (mcq items: ${stats.mcqItems}, ` +
                   `inputs: ${stats.inputs}, roles: ${stats.roles}, shadow roots: ${stats.shadowRoots}, ` +
                   `iframes: ${stats.iframes}).`
        };
    }

    const { assignments, notMatched } = matchAnswersToOptions(
        lines,
        questions.map((question) => ({ single: question.single, options: question.options }))
    );

    const selected = [];
    const failed = [];

    for (const assignment of assignments) {
        const item = questions[assignment.questionIndex].items[assignment.optionIndex];
        const result = await selectOption(item);
        if (result.ok) {
            selected.push({ text: assignment.text, already: !!result.already });
        } else {
            failed.push(assignment.text);
        }
    }

    const report = { selected, failed, notMatched };
    report.submit = await maybeAutoSubmit(report);
    return report;
}

// ------------------------------------------------------------------
// Auto-submit
// ------------------------------------------------------------------
const SUBMIT_DELAY_MS = 800;

function isEnabled(el) {
    if (!el) return false;
    if (el.disabled) return false;
    if (el.getAttribute && el.getAttribute("aria-disabled") === "true") return false;
    return true;
}

function isVisible(el) {
    if (!el) return false;
    if (el.getAttribute && el.getAttribute("aria-hidden") === "true") return false;
    // offsetParent is null for display:none, but also for position:fixed elements.
    const style = (el.ownerDocument && el.ownerDocument.defaultView
        ? el.ownerDocument.defaultView.getComputedStyle(el)
        : (typeof getComputedStyle === "function" ? getComputedStyle(el) : null));
    if (style && (style.display === "none" || style.visibility === "hidden")) return false;
    return true;
}

// AQUI: really the quiz's Submit.
// Matches the real NetAcad markup:
//   <button aria-label="submit" class="btn-icon btn__action abs__btn-arrow submit-button">
// "aria-label=submit" or the "submit-button" class are the ONLY reliable markers.
// The generic "btn__action" class is deliberately NOT used: it also covers the
// menu / back / table-of-contents buttons, and clicking one of those opens a
// panel instead of submitting.
function isSubmitButton(el) {
    if (!el || el.tagName !== "BUTTON") return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    if (el.getAttribute("aria-label") === "submit") return true;
    if (el.classList.contains("submit-button")) return true;

    // Text fallback: exact word only. "startsWith" was matching menu entries
    // such as "Submit attempt".
    const text = (el.textContent || "")
        .replace(/\s+/g, " ")
        .replace(/\s+\d+\s+of\s+\d+\s*$/i, "")
        .trim()
        .toLowerCase();
    return text === "submit" || text === "submit →" || text === "submit >" || text === "submit>";
}

// Ordered by specificity. Candidates must be visible; enabled is checked at
// click time so a disabled Submit reports "disabled" rather than "not found".
const SUBMIT_SELECTORS = [
    'button.submit-button[aria-label="submit"]',
    'button[aria-label="submit"]',
    "button.submit-button"
];

function findSubmitButton() {
    for (const selector of SUBMIT_SELECTORS) {
        for (const btn of deepQueryAll(selector)) {
            if (isVisible(btn)) return btn;
        }
    }
    for (const btn of deepQueryAll("button")) {
        if (isSubmitButton(btn) && isVisible(btn)) return btn;
    }
    return null;
}

async function clickSubmit() {
    const btn = findSubmitButton();
    if (!btn) return { submitted: false, reason: "submit button not found" };
    if (!isEnabled(btn)) return { submitted: false, reason: "submit button is disabled" };

    // Diagnostic: makes a wrong target obvious in the console.
    console.log("[NetAcad Helper] submit target:", btn.outerHTML.slice(0, 200));

    // A single native click: the page's own listener handles it. Firing the
    // pointer sequence as well would submit twice.
    btn.click();
    return { submitted: true };
}

function selectedCount(report) {
    return report && Array.isArray(report.selected) ? report.selected.length : 0;
}

// Called after auto-select. Reads the setting live so popup changes apply instantly.
async function maybeAutoSubmit(report) {
    let enabled = false;
    try {
        const stored = await chrome.storage.local.get(["autoSubmit"]);
        enabled = !!stored.autoSubmit;
    } catch {
        return { submitted: false, reason: "auto-submit setting unavailable" };
    }

    if (!enabled) return { skipped: true };
    if (!selectedCount(report)) return { submitted: false, reason: "nothing was selected" };

    await delay(SUBMIT_DELAY_MS);
    try {
        return await clickSubmit();
    } catch (e) {
        return { submitted: false, reason: e.message || "submit failed" };
    }
}

// ------------------------------------------------------------------
// Rendering
// ------------------------------------------------------------------
function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = String(text == null ? "" : text);
    return div.innerHTML;
}

function renderReport(report) {
    if (!report) return "";
    if (report.error) return `<br><br>⚠️ Auto-select: ${escapeHtml(report.error)}`;

    let html = "<br><br><strong>Selected on page:</strong><br>";
    html += report.selected.length
        ? report.selected.map((item) => `✅ ${escapeHtml(item.text)}${item.already ? " (was already)" : ""}`).join("<br>")
        : "— nothing —";

    if (report.failed.length) {
        html += "<br><br><strong>⚠️ Could not click:</strong><br>";
        html += report.failed.map((text) => `❌ ${escapeHtml(text)}`).join("<br>");
    }
    if (report.notMatched.length) {
        html += "<br><br><strong>⚠️ No matching option on page:</strong><br>";
        html += report.notMatched.map((text) => `❓ ${escapeHtml(text)}`).join("<br>");
    }
    if (report.submit) {
        if (report.submit.skipped) {
            html += "<br><br>📤 Auto-submit: off";
        } else if (report.submit.submitted) {
            html += "<br><br>📤 <strong>Submitted</strong>";
        } else {
            html += `<br><br>⚠️ Auto-submit failed: ${escapeHtml(report.submit.reason || "unknown reason")}`;
        }
    }
    return html;
}

function showAnswer(htmlContent, isError = false) {
    const answerBox = document.getElementById("netacad-gemini-answer-box");
    if (!answerBox) return;

    answerBox.innerHTML = htmlContent;
    answerBox.style.display = "block";
    if (isError) {
        answerBox.style.background = "#fff2ee";
        answerBox.style.border = "1px solid #f0d6cc";
        answerBox.style.color = "#9a3e2d";
    } else {
        answerBox.style.background = "#fcfdfa";
        answerBox.style.border = "1px solid #d0e6d7";
        answerBox.style.color = "#203732";
    }

    // Add a close button
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "×";
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "Close answer panel");
    closeBtn.style.cssText = `
        position: absolute;
        top: 8px;
        right: 8px;
        width: 28px;
        height: 28px;
        padding: 0;
        background: none;
        border: none;
        font-size: 22px;
        cursor: pointer;
        color: inherit;
        opacity: 0.7;
    `;
    closeBtn.onclick = () => answerBox.style.display = "none";
    answerBox.appendChild(closeBtn);
}

function showSolved(answer, report) {
    const formattedAnswer = escapeHtml(answer || "").replace(/\n/g, "<br>");
    showAnswer(`<strong>✦ Suggested answer</strong><br><br>${formattedAnswer}${renderReport(report)}`);
}

// ------------------------------------------------------------------
// UI (created once, top frame only)
// ------------------------------------------------------------------
function ensureSolveButton() {
    if (window.top !== window.self) return null;
    if (document.getElementById("netacad-gemini-solve-btn")) return document.getElementById("netacad-gemini-solve-btn");

    const btn = document.createElement("button");
    btn.id = "netacad-gemini-solve-btn";
    btn.textContent = "✦ Solve";
    btn.type = "button";
    btn.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        z-index: 999999;
        background: #166b55;
        color: white;
        border: none;
        padding: 13px 23px;
        border-radius: 14px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        box-shadow: 0 4px 16px rgba(22,107,85,0.25);
        transition: transform 0.2s, background 0.2s;
    `;

    (document.body || document.documentElement).appendChild(btn);

    const answerBox = document.createElement("div");
    answerBox.id = "netacad-gemini-answer-box";
    answerBox.setAttribute("role", "status");
    answerBox.setAttribute("aria-live", "polite");
    answerBox.style.cssText = `
        position: fixed;
        bottom: 80px;
        right: 20px;
        z-index: 999999;
        background: #fcfdfa;
        border: 1px solid #d0e6d7;
        padding: 22px 40px 22px 22px;
        border-radius: 16px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 14px;
        color: #203732;
        box-shadow: 0 12px 40px rgba(32,55,50,0.15);
        box-sizing: border-box;
        max-width: min(420px, calc(100vw - 40px));
        max-height: calc(100vh - 110px);
        overflow-y: auto;
        overflow-wrap: anywhere;
        display: none;
        line-height: 1.5;
    `;
    (document.body || document.documentElement).appendChild(answerBox);

    return btn;
}

function setBtnState(btn, busy) {
    if (!btn || !btn.isConnected) return;
    btn.textContent = busy ? "Finding answer…" : "✦ Solve";
    btn.disabled = busy;
    btn.setAttribute("aria-busy", String(busy));
    btn.style.cursor = busy ? "wait" : "pointer";
    btn.style.background = busy ? "#667b70" : "#166b55";
}

function runtimeAlive() {
    try {
        // Only true when the runtime is callable; do not rely on chrome.runtime.id,
        // which can be absent even in a perfectly working context.
        return typeof chrome !== "undefined" && !!chrome.runtime && typeof chrome.runtime.sendMessage === "function";
    } catch {
        return false;
    }
}

// Wired once, so a runtime re-injection (chrome.scripting) never double-binds it.
function ensureSolveButtonHandler() {
    const btn = ensureSolveButton();
    if (!btn || btn.dataset.netacadWired === "true") return;

    btn.dataset.netacadWired = "true";
    btn.addEventListener("click", () => {
        // Never let an exception escape as "Uncaught".
        handleSolveClick(btn).catch((error) => {
            safeShowError(btn, error);
        });
    });
}

function safeShowError(btn, error) {
    setBtnState(btn, false);
    const message = String(error && error.message ? error.message : error);
    const stale = /context invalidated|receiving end does not exist|could not establish connection|extension context/i.test(message);
    if (stale) {
        showStaleContextNotice();
        return;
    }
    showAnswer(`❌ Error: ${escapeHtml(message)}`, true);
}

// Shown when the tab was opened before the extension was reloaded.
function showStaleContextNotice() {
    const box = document.getElementById("netacad-gemini-answer-box");
    if (!box) return;
    showAnswer(
        "⚠️ <strong>The extension was updated.</strong><br><br>" +
        "This page still runs the old code. Reload it, then press Solve again.",
        true
    );
    const reloadBtn = document.createElement("button");
    reloadBtn.textContent = "Reload page";
    reloadBtn.style.cssText = "margin-top:10px;padding:6px 12px;cursor:pointer;";
    reloadBtn.onclick = () => location.reload();
    const current = document.getElementById("netacad-gemini-answer-box");
    if (current) current.appendChild(reloadBtn);
}

async function handleSolveClick(btn) {
    setBtnState(btn, true);
    const answerBox = document.getElementById("netacad-gemini-answer-box");
    if (answerBox) answerBox.style.display = "none";

    if (!runtimeAlive()) {
        throw new Error("Extension context invalidated: the extension was reloaded while this page stayed open.");
    }

    let response;
    try {
        response = await chrome.runtime.sendMessage({ action: "captureAndSolve" });
    } catch (e) {
        throw new Error(e && e.message ? e.message : "Could not reach the extension background.");
    } finally {
        setBtnState(btn, false);
    }

    if (!response) {
        throw new Error("The extension background returned no response. Reload the page (F5).");
    }
    if (response.error) {
        throw new Error(response.error);
    }
    if (!response.answer) {
        throw new Error("The AI returned an empty answer.");
    }

    // The background already applied the answer (same code path as the popup).
    // Fall back to applying it here only if it did not.
    let report = response.applyResult;
    if (!report) {
        try {
            report = await applyAnswerToPage(response.answer);
        } catch (e) {
            report = { error: e.message };
        }
    }
    showSolved(response.answer, report);
}

// ------------------------------------------------------------------
// Message bridge (popup flow). Registered at the top level and idempotent,
// because content.js may be injected again at runtime via chrome.scripting.
// ------------------------------------------------------------------
if (!window.__netacadApplyAnswerListener) {
    window.__netacadApplyAnswerListener = true;
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === "applyAnswer") {
            applyAnswerToPage(request.answer)
                .then((report) => sendResponse(report))
                .catch((error) => sendResponse({ selected: [], failed: [], notMatched: [], error: error.message }));
            return true; // async response
        }
    });
}

// Create/show the button whenever the script runs (initial inject or re-inject).
ensureSolveButtonHandler();
