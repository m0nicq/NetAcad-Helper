importScripts("ai-providers.js");

const {
    PROVIDERS,
    REASONING_TIMEOUT_MS,
    isReasoningModel,
    extractResponseText,
    providerErrorMessage,
    fetchJSON
} = globalThis.AIProviderKit;

const ANSWER_PROMPT = `Analyze the multiple-choice question in the image.
Determine all the correct answer(s). If the question asks to select multiple options (e.g., "Choose two", "Choose three"), you MUST identify all of them.
Return ONLY the exact text of the correct option(s). Do not include any explanations.
If there are multiple correct options, separate each option with a blank line.`;

const REQUEST_TIMEOUT_MS = 20000; // 20 second timeout per request
const MAX_RETRIES = 3;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "captureAndSolve") {
        handleCaptureAndSolve(sender)
            .then(async (response) => {
                // Both entry points apply the answer through the exact same code path:
                //   * popup -> it supplies request.tabId (no sender.tab);
                //   * floating Solve button -> sender.tab is present.
                // The content script then only renders the report it receives.
                const tabId = sender.tab ? sender.tab.id : request.tabId;
                if (typeof tabId === "number" && response.answer) {
                    response.applyResult = await relayAnswerToTab(tabId, response.answer);
                }
                sendResponse(response);
            })
            .catch(err => sendResponse({ error: err.message }));
        return true; // Keep message channel open for async response
    }

    if (request.action === "verifyAIProvider") {
        globalThis.AIProviderKit.verifyRequest(request.provider, request.apiKey, request.model)
            .then(message => sendResponse({ ok: true, message }))
            .catch(error => sendResponse({ ok: false, error: error.message || "Connection check failed." }));
        return true;
    }
});

async function handleCaptureAndSolve(sender) {
    const windowId = sender.tab ? sender.tab.windowId : chrome.windows.WINDOW_ID_CURRENT;

    const dataUrl = await new Promise((resolve, reject) => {
        try {
            chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 80 }, (url) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                } else if (!url) {
                    reject(new Error("Failed to capture screen (no data URL returned). Ensure the extension has 'activeTab' permission."));
                } else {
                    resolve(url);
                }
            });
        } catch (e) {
            reject(new Error("Capture exception: " + e.message));
        }
    });

    const answer = await askAIVision(dataUrl);
    return { answer: answer };
}

// Hands the answer to the content script of the quiz tab so it can
// auto-select the correct options in the DOM.
async function relayAnswerToTab(tabId, answer) {
    const message = { action: "applyAnswer", answer };

    try {
        const result = await chrome.tabs.sendMessage(tabId, message);
        return result || { selected: [], failed: [], notMatched: [], error: "Content script returned no result." };
    } catch (e) {
        // No receiver: either the page was open before the extension reloaded, or
        // its domain is not covered by content_scripts. Inject on the fly and retry.
    }

    try {
        await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            files: ["answer-matcher.js", "content.js"]
        });
    } catch (e) {
        return {
            selected: [],
            failed: [],
            notMatched: [],
            error: `Cannot run on this page (${e.message || "injection blocked"}). ` +
                   `Open the quiz tab and reload it (F5).`
        };
    }

    try {
        const result = await chrome.tabs.sendMessage(tabId, message);
        return result || { selected: [], failed: [], notMatched: [], error: "Content script returned no result." };
    } catch (e) {
        return {
            selected: [],
            failed: [],
            notMatched: [],
            error: "The quiz page still does not respond after injecting the scripts. " +
                   "Reload the tab (F5) and try again."
        };
    }
}

// Reads the selected provider + key from chrome.storage (saved via the popup).
async function loadAIConfiguration() {
    const stored = await chrome.storage.local.get([
        "aiProvider",
        "aiProviderSettings",
        "userApiKey" // legacy key name from earlier versions
    ]);

    const settings = stored.aiProviderSettings && typeof stored.aiProviderSettings === "object"
        ? { ...stored.aiProviderSettings }
        : {};

    let migrated = false;
    if (stored.userApiKey && !settings.gemini?.apiKey) {
        settings.gemini = {
            apiKey: stored.userApiKey,
            model: PROVIDERS.gemini.defaultModel
        };
        migrated = true;
    }

    const providerId = PROVIDERS[stored.aiProvider] ? stored.aiProvider : "gemini";
    const providerSettings = settings[providerId] || {};
    const configuration = {
        providerId,
        apiKey: providerSettings.apiKey || "",
        model: providerSettings.model || PROVIDERS[providerId].defaultModel
    };

    if (migrated) {
        await chrome.storage.local.set({ aiProviderSettings: settings, aiProvider: providerId });
    }

    return configuration;
}

async function askAIVision(dataUrl) {
    const { providerId, apiKey, model } = await loadAIConfiguration();
    const provider = PROVIDERS[providerId];

    if (!apiKey) {
        throw new Error(
            `Add and verify a ${provider.label} API key in the extension popup ` +
            `(click the extension icon → AI Provider → paste your key).`
        );
    }

    const base64Data = dataUrl.split(",")[1];
    if (!base64Data) {
        throw new Error("Could not encode the screenshot for the AI request.");
    }

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        const spec = provider.buildVisionRequest(apiKey, model, ANSWER_PROMPT, base64Data);

        // Reasoning models (GPT-5.6 Sol & co) think before answering — give them more time.
        const timeoutMs = isReasoningModel(providerId, model) ? REASONING_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        spec.options.signal = controller.signal;

        let result;
        try {
            result = await fetchJSON(spec);
        } catch (e) {
            clearTimeout(timeoutId);
            if (attempt < MAX_RETRIES) {
                await new Promise(r => setTimeout(r, 2000 * attempt)); // wait 2s, 4s...
                continue;
            }
            if (e && e.name === "AbortError") {
                throw new Error(`${provider.label} request timed out after multiple attempts.`);
            }
            throw new Error(e.message || `Network error contacting ${provider.label}.`);
        }

        clearTimeout(timeoutId);

        const { response, data } = result;

        if (!response.ok) {
            // Auto-retry on 503 (High Demand) or 429 (Rate Limit)
            if ((response.status === 503 || response.status === 429) && attempt < MAX_RETRIES) {
                await new Promise(r => setTimeout(r, 2000 * Math.pow(2, attempt - 1))); // exponential backoff
                continue;
            }
            throw new Error(providerErrorMessage(providerId, response.status, data));
        }

        const text = extractResponseText(providerId, data);
        if (text) {
            return text;
        }

        throw new Error(`${provider.label} returned an empty or unsupported response.`);
    }
}
