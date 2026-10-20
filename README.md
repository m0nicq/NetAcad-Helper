<div align="center">

<h1>Cisco Netacad Auto-Solver</h1>

<img
  width="150"
  height="150"
  alt="netacad-autosolver-modified"
  src="https://github.com/user-attachments/assets/14853378-c93d-4f1a-8b61-ae3c2faa81af"
/>

<br>

<p>
  A lightweight Chrome Extension that screenshots the current quiz page,
  sends the image to your chosen AI provider (Gemini, OpenAI, Claude, Grok, Groq, OpenRouter)
  and displays the suggested answer directly on the screen. <em>(Originally DOM-based, but now uses OCR and works fine)</em>
</p>

<p>
  Welcoming contributions from the OSS community to make it even better.
</p>

</div>

## Setup

### 1. Choose an AI provider and get an API key

The extension works with any of these providers:

| Provider | Get a key |
| --- | --- |
| Google Gemini | https://aistudio.google.com/app/apikey |
| OpenAI | https://platform.openai.com/api-keys |
| Anthropic (Claude) | https://console.anthropic.com/settings/keys |
| xAI (Grok) | https://console.x.ai |
| Groq | https://console.groq.com/keys |
| OpenRouter | https://openrouter.ai/keys |

Copy the generated API key — you will paste it into the extension popup (no code editing needed).

---

## Installation

### Step 1: Load Extension in Chrome

Open Chrome and navigate to:

```text
chrome://extensions
```

Enable:

```text
Developer Mode
```

Click:

```text
Load unpacked
```

Select the project folder.

The extension should now appear in the Chrome toolbar.

---

### Step 2: Add your API key

Click the extension icon to open the popup:

1. Pick an **AI Provider** from the dropdown.
2. Pick a **Model** — the list shows the most popular options (e.g. `gpt-5.6-sol`, `gpt-4o-mini`, `gemini-2.5-flash`, `claude-sonnet-4-5`) plus a **Custom…** entry for any other model id.
3. Paste your **API Key**.
4. Click **Check** to verify the connection, then **Save**.

The key is stored locally in your browser (`chrome.storage.local`) and is only ever sent to the provider you chose.

---

### Step 3: Use the Extension

Navigate to any Cisco NetAcad quiz page.

Look for the floating **Solve** button in the **bottom-right corner** of the page:

```text
Click Solve
```
<p align="center">
  <img
    width="75%"
    alt="netacad-screenshot"
    src="https://github.com/user-attachments/assets/12a3ab99-49f4-467c-a188-ef367ed41607"
  />
</p>

Click the button to scan the page using OCR. The extension then **auto-selects the correct options on the page** (the option icons flip to `check_box` / `radio_button_checked`), and a panel shows what was selected, what could not be clicked, and which answer lines had no matching option.

The same happens when you press **Find Answer** in the extension popup — it applies the answer to the currently open quiz tab.

---

### Step 4: Auto-submit (optional)

Open the popup and tick **Auto-submit after selecting answers**.

When enabled, the extension presses the quiz **Submit** button for you — right after it selects the answers, once it has checked that at least one option was actually selected. The panel then shows `📤 Submitted`; if it could not submit, it says why (`submit button not found`, `submit button is disabled`, `nothing was selected`).

The toggle takes effect immediately — no need to press **Save**, and no page reload. Leave it off to review the selection before submitting manually.

---
