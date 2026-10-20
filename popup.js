const { PROVIDERS, PROVIDER_ORDER } = globalThis.AIProviderKit;

const CUSTOM_MODEL = "__custom__";

const providerSelect = document.getElementById("provider");
const modelSelect = document.getElementById("model");
const modelCustomInput = document.getElementById("modelCustom");
const apiKeyInput = document.getElementById("apiKey");
const modelsLink = document.getElementById("modelsLink");
const settingsStatus = document.getElementById("settingsStatus");
const autoSubmitCheckbox = document.getElementById("autoSubmit");

let settings = {}; // { [providerId]: { apiKey, model } }

// ---------- Build provider dropdown ----------
for (const id of PROVIDER_ORDER) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = PROVIDERS[id].label;
    providerSelect.appendChild(option);
}

// ---------- Model dropdown ----------
function fillModelOptions(providerId, selectedModel) {
    const provider = PROVIDERS[providerId];
    const presets = provider.models || [];

    modelSelect.innerHTML = "";
    for (const preset of presets) {
        const option = document.createElement("option");
        option.value = preset.id;
        option.textContent = preset.label;
        modelSelect.appendChild(option);
    }

    const customOption = document.createElement("option");
    customOption.value = CUSTOM_MODEL;
    customOption.textContent = "Custom…";
    modelSelect.appendChild(customOption);

    const isPreset = presets.some((preset) => preset.id === selectedModel);
    if (selectedModel && !isPreset) {
        // Saved/typed model that is not in the preset list — keep it editable.
        modelSelect.value = CUSTOM_MODEL;
        modelCustomInput.value = selectedModel;
    } else {
        modelSelect.value = selectedModel || provider.defaultModel;
        modelCustomInput.value = "";
    }
    syncCustomVisibility();
}

function syncCustomVisibility() {
    modelCustomInput.hidden = modelSelect.value !== CUSTOM_MODEL;
}

function getSelectedModel() {
    if (modelSelect.value === CUSTOM_MODEL) {
        return modelCustomInput.value.trim() || PROVIDERS[currentProviderId()].defaultModel;
    }
    return modelSelect.value;
}

// ---------- Settings helpers ----------
function currentProviderId() {
    return PROVIDERS[providerSelect.value] ? providerSelect.value : "gemini";
}

function applyProviderDefaults(respectSavedModel = true) {
    const provider = PROVIDERS[currentProviderId()];
    const saved = settings[provider.id] || {};
    const wanted = respectSavedModel ? (saved.model || provider.defaultModel) : provider.defaultModel;

    fillModelOptions(provider.id, wanted);
    apiKeyInput.value = saved.apiKey || "";
    modelsLink.href = provider.modelsUrl;
    modelsLink.textContent = `${provider.label} models ↗`;
}

function showSettingsStatus(message, type) {
    settingsStatus.textContent = message || "";
    settingsStatus.className = message ? type || "" : "";
}

function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = String(text == null ? "" : text);
    return div.innerHTML;
}

function renderPopupResult(answer, applyResult) {
    let html = `✅ Answer:<br>${escapeHtml(answer || "").replace(/\n/g, "<br>")}`;

    if (!applyResult) return html;

    if (applyResult.error) {
        html += `<br><br>⚠️ ${escapeHtml(applyResult.error)}`;
        return html;
    }

    const selected = applyResult.selected || [];
    const failed = applyResult.failed || [];
    const notMatched = applyResult.notMatched || [];

    html += `<br><br><strong>Selected on page:</strong><br>`;
    html += selected.length
        ? selected.map((item) => `✅ ${escapeHtml(item.text)}${item.already ? " (was already)" : ""}`).join("<br>")
        : "— nothing —";

    if (failed.length) {
        html += `<br><br>⚠️ Could not click:<br>${failed.map((text) => `❌ ${escapeHtml(text)}`).join("<br>")}`;
    }
    if (notMatched.length) {
        html += `<br><br>⚠️ No matching option:<br>${notMatched.map((text) => `❓ ${escapeHtml(text)}`).join("<br>")}`;
    }
    if (applyResult.submit) {
        if (applyResult.submit.skipped) {
            html += "<br><br>📤 Auto-submit: off";
        } else if (applyResult.submit.submitted) {
            html += "<br><br>📤 <strong>Submitted</strong>";
        } else {
            html += `<br><br>⚠️ Auto-submit failed: ${escapeHtml(applyResult.submit.reason || "unknown reason")}`;
        }
    }
    return html;
}

function persistSettings() {
    return chrome.storage.local.set({
        aiProvider: currentProviderId(),
        aiProviderSettings: settings,
        autoSubmit: autoSubmitCheckbox.checked
    });
}

function collectCurrentForm() {
    const providerId = currentProviderId();
    const previous = settings[providerId] || {};
    settings[providerId] = {
        apiKey: apiKeyInput.value.trim(),
        model: getSelectedModel()
    };
    return { providerId, previous };
}

// ---------- Load stored settings on open ----------
(async () => {
    const stored = await chrome.storage.local.get(["aiProvider", "aiProviderSettings", "userApiKey", "autoSubmit"]);

    settings = stored.aiProviderSettings && typeof stored.aiProviderSettings === "object"
        ? { ...stored.aiProviderSettings }
        : {};

    // Legacy migration (old single-key versions)
    if (stored.userApiKey && !settings.gemini?.apiKey) {
        settings.gemini = { apiKey: stored.userApiKey, model: PROVIDERS.gemini.defaultModel };
    }

    providerSelect.value = PROVIDERS[stored.aiProvider] ? stored.aiProvider : "gemini";
    applyProviderDefaults(true);
    autoSubmitCheckbox.checked = !!stored.autoSubmit;
})();

providerSelect.addEventListener("change", () => {
    // Keep whatever was typed before switching, then load the new provider's values.
    showSettingsStatus("");
    applyProviderDefaults(true);
});

modelSelect.addEventListener("change", () => {
    syncCustomVisibility();
    if (modelSelect.value === CUSTOM_MODEL) {
        modelCustomInput.focus();
    }
});

document.getElementById("toggleKey").addEventListener("click", () => {
    apiKeyInput.type = apiKeyInput.type === "password" ? "text" : "password";
    const visible = apiKeyInput.type === "text";
    const button = document.getElementById("toggleKey");
    button.setAttribute("aria-pressed", String(visible));
    button.setAttribute("aria-label", visible ? "Hide API key" : "Show API key");
    button.title = visible ? "Hide API key" : "Show API key";
});

// Apply the toggle immediately; no need to press Save.
autoSubmitCheckbox.addEventListener("change", async () => {
    try {
        await chrome.storage.local.set({ autoSubmit: autoSubmitCheckbox.checked });
        showSettingsStatus(autoSubmitCheckbox.checked ? "Auto-submit enabled." : "Auto-submit disabled.", "success");
    } catch (err) {
        showSettingsStatus(`Error: ${err.message}`, "error");
    }
});

document.getElementById("saveSettings").addEventListener("click", async () => {
    const button = document.getElementById("saveSettings");
    button.disabled = true;
    try {
        collectCurrentForm();
        await persistSettings();
        showSettingsStatus("Saved.", "success");
    } catch (err) {
        showSettingsStatus(`Error: ${err.message}`, "error");
    } finally {
        button.disabled = false;
    }
});

document.getElementById("verifySettings").addEventListener("click", async () => {
    const button = document.getElementById("verifySettings");
    const { providerId, previous } = collectCurrentForm();

    button.disabled = true;
    showSettingsStatus("Checking…");

    try {
        const response = await chrome.runtime.sendMessage({
            action: "verifyAIProvider",
            provider: providerId,
            apiKey: settings[providerId].apiKey,
            model: settings[providerId].model
        });

        if (!response) throw new Error("No response from the extension background.");
        if (response.ok) {
            await persistSettings();
            showSettingsStatus(`✅ ${response.message}`, "success");
        } else {
            throw new Error(response.error || "Connection check failed.");
        }
    } catch (err) {
        settings[providerId] = previous; // do not keep a broken key in memory
        showSettingsStatus(`❌ ${err.message}`, "error");
    } finally {
        button.disabled = false;
    }
});

// ---------- Find Answer ----------
document.getElementById("findAnswer").addEventListener("click", async () => {
    const statusDiv = document.getElementById("status");
    const button = document.getElementById("findAnswer");

    // Persist whatever is currently in the form so the background uses it.
    try {
        collectCurrentForm();
        await persistSettings();
    } catch {
        // storage failure is not fatal for the request below
    }

    statusDiv.textContent = "Processing...";
    statusDiv.className = "";
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.querySelector("span").textContent = "Finding answer…";

    try {
        const tabs = await chrome.tabs.query({
            active: true,
            currentWindow: true
        });

        if (!tabs[0]) {
            throw new Error("No active tab found");
        }

        const response = await chrome.runtime.sendMessage({
            action: "captureAndSolve",
            tabId: tabs[0].id
        });

        if (!response) {
            throw new Error("No response from the extension background.");
        }

        if (response.error) {
            throw new Error(response.error);
        }

        statusDiv.innerHTML = renderPopupResult(response.answer, response.applyResult);
        statusDiv.className = "success";
    } catch (err) {
        statusDiv.textContent = `Error: ${err.message}`;
        statusDiv.className = "error";
    } finally {
        button.disabled = false;
        button.setAttribute("aria-busy", "false");
        button.querySelector("span").textContent = "Find answer";
    }
});
