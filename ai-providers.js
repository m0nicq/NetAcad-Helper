/*
 * Shared AI provider kit for the NetAcad helper extension.
 *
 * Loaded by background.js via importScripts() (MV3 service worker) and
 * usable as a plain <script> from popup.js.
 *
 * Exposes globalThis.AIProviderKit with everything needed to talk to the
 * supported providers, including vision (image) requests.
 */
(function attach(global) {
    "use strict";

    // Providers that accept an image (JPEG) alongside the prompt.
    // DeepSeek is intentionally omitted: no vision support.
    //
    // Reasoning models (GPT-5.x, o-series) reject `temperature`, require
    // `max_completion_tokens` instead of `max_tokens`, and spend part of the
    // output budget on hidden "thinking" tokens — so they get a bigger budget
    // and a longer network timeout.
    const REASONING_MAX_OUTPUT_TOKENS = 2000;
    const REASONING_TIMEOUT_MS = 45000;
    const OPENAI_COMPATIBLE_IDS = ["openai", "openrouter", "xai", "groq"];
    const REASONING_MODEL_PATTERN = /^(gpt-5(\.\d+)*(-|$))|^(o[134](-|$))/;

    function isReasoningOpenAIModel(model) {
        const id = String(model || "").trim().split("/").pop(); // "openai/gpt-5.6-sol" -> "gpt-5.6-sol"
        return REASONING_MODEL_PATTERN.test(id);
    }

    function isReasoningModel(providerId, model) {
        return OPENAI_COMPATIBLE_IDS.includes(providerId) && isReasoningOpenAIModel(model);
    }

    // Chat-completions body that works for both regular and reasoning models.
    function openAIChatBody(model, prompt, base64Image) {
        const body = {
            model,
            messages: [{
                role: "user",
                content: [
                    { type: "text", text: prompt },
                    { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
                ]
            }]
        };

        if (isReasoningOpenAIModel(model)) {
            body.max_completion_tokens = REASONING_MAX_OUTPUT_TOKENS;
        } else {
            body.temperature = 0;
            body.max_tokens = 300;
        }

        return body;
    }

    const PROVIDERS = {
        gemini: {
            id: "gemini",
            label: "Google Gemini",
            host: "generativelanguage.googleapis.com",
            keyUrl: "https://aistudio.google.com/app/apikey",
            modelsUrl: "https://ai.google.dev/gemini-api/docs/models",
            defaultModel: "gemini-2.5-flash",
            models: [
                { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash (fast, default)" },
                { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro (smarter)" },
                { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" }
            ],
            buildVisionRequest(apiKey, model, prompt, base64Image) {
                return {
                    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
                    options: {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            contents: [{
                                parts: [
                                    { text: prompt },
                                    { inlineData: { mimeType: "image/jpeg", data: base64Image } }
                                ]
                            }],
                            generationConfig: { temperature: 0, maxOutputTokens: 300 }
                        })
                    }
                };
            },
            extractText(data) {
                const parts = data?.candidates?.[0]?.content?.parts;
                if (!Array.isArray(parts)) return "";
                return parts.map((part) => part?.text || "").join("\n").trim();
            },
            buildVerifyRequest(apiKey) {
                return {
                    url: `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
                    options: { method: "GET" },
                    listPath: "models",
                    idField: "name"
                };
            }
        },

        openai: {
            id: "openai",
            label: "OpenAI",
            host: "api.openai.com",
            keyUrl: "https://platform.openai.com/api-keys",
            modelsUrl: "https://platform.openai.com/docs/models",
            defaultModel: "gpt-5.6-sol",
            models: [
                { id: "gpt-5.6-sol", label: "GPT-5.6 Sol (flagship, reasoning)" },
                { id: "gpt-5.6-terra", label: "GPT-5.6 Terra (balanced)" },
                { id: "gpt-5.6-luna", label: "GPT-5.6 Luna (fast, cheap)" },
                { id: "gpt-4o-mini", label: "GPT-4o mini (cheap, fast)" },
                { id: "gpt-4o", label: "GPT-4o" },
                { id: "gpt-4.1-mini", label: "GPT-4.1 mini" }
            ],
            buildVisionRequest(apiKey, model, prompt, base64Image) {
                return {
                    url: "https://api.openai.com/v1/chat/completions",
                    options: {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "Authorization": `Bearer ${apiKey}`
                        },
                        body: JSON.stringify(openAIChatBody(model, prompt, base64Image))
                    }
                };
            },
            extractText(data) {
                return (data?.choices?.[0]?.message?.content || "").trim();
            },
            buildVerifyRequest(apiKey) {
                return {
                    url: "https://api.openai.com/v1/models",
                    options: { method: "GET", headers: { "Authorization": `Bearer ${apiKey}` } },
                    listPath: "data",
                    idField: "id"
                };
            }
        },

        anthropic: {
            id: "anthropic",
            label: "Anthropic (Claude)",
            host: "api.anthropic.com",
            keyUrl: "https://console.anthropic.com/settings/keys",
            modelsUrl: "https://docs.anthropic.com/en/docs/about-claude/models/overview",
            defaultModel: "claude-sonnet-4-5-20250929",
            models: [
                { id: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5 (default)" },
                { id: "claude-opus-4-1-20250805", label: "Claude Opus 4.1 (smarter)" }
            ],
            buildVisionRequest(apiKey, model, prompt, base64Image) {
                return {
                    url: "https://api.anthropic.com/v1/messages",
                    options: {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "x-api-key": apiKey,
                            "anthropic-version": "2023-06-01"
                        },
                        body: JSON.stringify({
                            model,
                            max_tokens: 300,
                            temperature: 0,
                            messages: [{
                                role: "user",
                                content: [
                                    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64Image } },
                                    { type: "text", text: prompt }
                                ]
                            }]
                        })
                    }
                };
            },
            extractText(data) {
                if (!Array.isArray(data?.content)) return "";
                return data.content.map((block) => block?.text || "").join("\n").trim();
            },
            buildVerifyRequest(apiKey) {
                return {
                    url: "https://api.anthropic.com/v1/models?limit=100",
                    options: {
                        method: "GET",
                        headers: {
                            "x-api-key": apiKey,
                            "anthropic-version": "2023-06-01"
                        }
                    },
                    listPath: "data",
                    idField: "id"
                };
            }
        },

        xai: {
            id: "xai",
            label: "xAI (Grok)",
            host: "api.x.ai",
            keyUrl: "https://console.x.ai",
            modelsUrl: "https://docs.x.ai/docs/models",
            defaultModel: "grok-2-vision-latest",
            models: [
                { id: "grok-2-vision-latest", label: "Grok 2 Vision (default)" }
            ],
            buildVisionRequest(apiKey, model, prompt, base64Image) {
                return openAICompatibleVisionRequest("https://api.x.ai/v1/chat/completions", apiKey, model, prompt, base64Image);
            },
            extractText: openAICompatibleExtractText,
            buildVerifyRequest(apiKey) {
                return {
                    url: "https://api.x.ai/v1/models",
                    options: { method: "GET", headers: { "Authorization": `Bearer ${apiKey}` } },
                    listPath: "data",
                    idField: "id"
                };
            }
        },

        groq: {
            id: "groq",
            label: "Groq",
            host: "api.groq.com",
            keyUrl: "https://console.groq.com/keys",
            modelsUrl: "https://console.groq.com/docs/models",
            defaultModel: "meta-llama/llama-4-scout-17b-16e-instruct",
            models: [
                { id: "meta-llama/llama-4-scout-17b-16e-instruct", label: "Llama 4 Scout 17B (default)" },
                { id: "meta-llama/llama-4-maverick-17b-128e-instruct", label: "Llama 4 Maverick 17B" }
            ],
            buildVisionRequest(apiKey, model, prompt, base64Image) {
                return openAICompatibleVisionRequest("https://api.groq.com/openai/v1/chat/completions", apiKey, model, prompt, base64Image);
            },
            extractText: openAICompatibleExtractText,
            buildVerifyRequest(apiKey) {
                return {
                    url: "https://api.groq.com/openai/v1/models",
                    options: { method: "GET", headers: { "Authorization": `Bearer ${apiKey}` } },
                    listPath: "data",
                    idField: "id"
                };
            }
        },

        openrouter: {
            id: "openrouter",
            label: "OpenRouter",
            host: "openrouter.ai",
            keyUrl: "https://openrouter.ai/keys",
            modelsUrl: "https://openrouter.ai/models",
            defaultModel: "openai/gpt-5.6-sol",
            models: [
                { id: "openai/gpt-5.6-sol", label: "GPT-5.6 Sol (flagship, reasoning)" },
                { id: "openai/gpt-5.6-terra", label: "GPT-5.6 Terra (balanced)" },
                { id: "openai/gpt-5.6-luna", label: "GPT-5.6 Luna (fast, cheap)" },
                { id: "openai/gpt-4o-mini", label: "GPT-4o mini (cheap, fast)" },
                { id: "anthropic/claude-sonnet-4.5", label: "Claude Sonnet 4.5" },
                { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash" }
            ],
            buildVisionRequest(apiKey, model, prompt, base64Image) {
                const spec = openAICompatibleVisionRequest("https://openrouter.ai/api/v1/chat/completions", apiKey, model, prompt, base64Image);
                spec.options.headers["HTTP-Referer"] = "https://github.com/cisco-netacad-autosolver";
                spec.options.headers["X-Title"] = "NetAcad AI Helper";
                return spec;
            },
            extractText: openAICompatibleExtractText,
            buildVerifyRequest(apiKey) {
                return {
                    url: "https://openrouter.ai/api/v1/models",
                    options: { method: "GET", headers: { "Authorization": `Bearer ${apiKey}` } },
                    listPath: "data",
                    idField: "id"
                };
            }
        }
    };

    const PROVIDER_ORDER = ["gemini", "openai", "anthropic", "xai", "groq", "openrouter"];

    function openAICompatibleVisionRequest(url, apiKey, model, prompt, base64Image) {
        return {
            url,
            options: {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${apiKey}`
                },
                body: JSON.stringify(openAIChatBody(model, prompt, base64Image))
            }
        };
    }

    function openAICompatibleExtractText(data) {
        const content = data?.choices?.[0]?.message?.content;
        if (typeof content === "string") return content.trim();
        if (Array.isArray(content)) {
            return content.map((part) => part?.text || "").join("\n").trim();
        }
        return "";
    }

    function providerHostFragment(providerId) {
        return PROVIDERS[providerId]?.host;
    }

    function extractResponseText(providerId, data) {
        const provider = PROVIDERS[providerId];
        if (!provider) return "";
        try {
            return provider.extractText(data) || "";
        } catch {
            return "";
        }
    }

    function providerErrorMessage(providerId, status, data) {
        const label = PROVIDERS[providerId]?.label || "AI provider";
        const detail =
            data?.error?.message ||
            data?.error?.type ||
            data?.message ||
            "";

        if (status === 401 || status === 403) {
            return `${label}: access denied (${status}). Check the API key.${detail ? " " + detail : ""}`;
        }
        if (status === 404) {
            return `${label}: model not found or not available for this account.${detail ? " " + detail : ""}`;
        }
        if (status === 429) {
            return `${label}: rate limit exceeded (429). Try again later.${detail ? " " + detail : ""}`;
        }
        if (status === 503) {
            return `${label}: service is busy (503). Try again later.${detail ? " " + detail : ""}`;
        }
        if (status >= 500) {
            return `${label}: server error (${status}).${detail ? " " + detail : ""}`;
        }
        return `${label} API error: ${status}${detail ? " " + detail : ""}`;
    }

    // Returns true when a schema/validation failure is worth one retry without extra config.
    function shouldRetryWithoutSchema(providerId, status) {
        return (status === 400 || status === 422) && ["gemini", "openai", "anthropic"].includes(providerId);
    }

    async function fetchJSON(spec) {
        let response;
        try {
            response = await fetch(spec.url, spec.options);
        } catch (e) {
            if (e?.name === "AbortError") throw e;
            const providerId = Object.keys(PROVIDERS).find((id) => spec.url.includes(providerHostFragment(id)));
            const label = providerId ? PROVIDERS[providerId].label : "AI provider";
            throw new Error(`Could not reach ${label}. Check your connection and try again.`);
        }

        const rawBody = await response.text();
        let data = {};
        if (rawBody) {
            try {
                data = JSON.parse(rawBody);
            } catch {
                data = { message: rawBody.slice(0, 300) };
            }
        }
        return { response, data };
    }

    // Lightweight connectivity/API-key check: GET the provider's model list.
    async function verifyRequest(providerId, apiKey, model) {
        const provider = PROVIDERS[providerId];
        if (!provider) throw new Error("Choose a supported AI provider.");
        if (!apiKey || !String(apiKey).trim()) throw new Error("Enter an API key first.");

        const spec = provider.buildVerifyRequest(String(apiKey).trim());
        const { response, data } = await fetchJSON(spec);
        if (!response.ok) {
            throw new Error(providerErrorMessage(providerId, response.status, data));
        }

        const selectedModel = String(model || "").trim();
        const items = Array.isArray(data?.[spec.listPath]) ? data[spec.listPath] : [];

        if (selectedModel && items.length) {
            const available = items.map((item) => String(item?.[spec.idField] || ""));
            if (!available.some((id) => id === selectedModel || id.endsWith("/" + selectedModel))) {
                throw new Error(
                    `The selected ${provider.label} model "${selectedModel}" is unavailable for this account. ` +
                    `Pick another model (see ${provider.modelsUrl}).`
                );
            }
        }

        return `${provider.label} is connected.`;
    }

    global.AIProviderKit = {
        PROVIDERS,
        PROVIDER_ORDER,
        REASONING_TIMEOUT_MS,
        isReasoningModel,
        extractResponseText,
        providerErrorMessage,
        shouldRetryWithoutSchema,
        fetchJSON,
        verifyRequest
    };
})(typeof self !== "undefined" ? self : this);
