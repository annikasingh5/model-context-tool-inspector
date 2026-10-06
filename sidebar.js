/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleGenAI } from './js-genai.js';
import { initGeminiLive, updateLiveTools } from './gemini-live.js';
import { getAllFrameOrigins } from './utils.js';
import { renderMarkdown } from './markdown.js';

const statusDiv = document.getElementById('status');
const tbody = document.getElementById('tableBody');
const thead = document.getElementById('tableHeaderRow');
const copyToClipboard = document.getElementById('copyToClipboard');
const copyAsScriptToolConfig = document.getElementById('copyAsScriptToolConfig');
const copyAsJSON = document.getElementById('copyAsJSON');
const toolNames = document.getElementById('toolNames');
const inputArgsText = document.getElementById('inputArgsText');
const executeBtn = document.getElementById('executeBtn');
const toolResults = document.getElementById('toolResults');
const userPromptText = document.getElementById('userPromptText');
const promptBtn = document.getElementById('promptBtn');
const traceBtn = document.getElementById('traceBtn');
const resetBtn = document.getElementById('resetBtn');
const apiKeyBtn = document.getElementById('apiKeyBtn');
const promptResults = document.getElementById('promptResults');
const advancedSection = document.getElementById('advancedSection');
const micBtn = document.getElementById('micBtn');
const suggestUserPromptCheckbox = document.getElementById('suggestUserPromptCheckbox');
const chatApp = document.querySelector('.chat-app');
const noKeyPage = document.getElementById('noKeyPage');
const noToolsPage = document.getElementById('noToolsPage');
const noKeyBtn = document.getElementById('noKeyBtn');
const retryToolsBtn = document.getElementById('retryToolsBtn');

// 'loading' | 'ready' | 'none' (page has no tools) | 'unavailable' (can't reach the page)
let keyEntryOpen = false;
let toolsState = 'loading';
let toolsStateDetail = '';

// If the page never answers, stop spinning and show the no-tools page.
const LOADING_TIMEOUT_MS = 5000;
let loadingTimer = null;

function hasApiKey() {
  return Boolean(localStorage.apiKey);
}

function setToolsState(state, detail = '') {
  clearTimeout(loadingTimer);
  loadingTimer = null;
  toolsState = state;
  toolsStateDetail = detail;
  if (state === 'loading') {
    loadingTimer = setTimeout(() => setToolsState('none'), LOADING_TIMEOUT_MS);
  }
  updateView();
}

function updateView() {
  let view = 'chat';
  if (keyEntryOpen) view = 'setkey';
  else if (!hasApiKey()) view = 'nokey';
  else if (toolsState === 'loading') view = 'loading';
  else if (toolsState === 'none' || toolsState === 'unavailable') view = 'notools';
  chatApp.dataset.view = view;
  document.getElementById('loadingPage').hidden = view !== 'loading';
  noKeyPage.hidden = view !== 'nokey';
  noToolsPage.hidden = view !== 'notools';
  document.getElementById('setKeyPage').hidden = view !== 'setkey';

  if (view === 'notools') {
    const unavailable = toolsState === 'unavailable';
    document.getElementById('noToolsIcon').textContent = unavailable ? '🔌' : '🛠️';
    document.getElementById('noToolsTitle').textContent = unavailable
      ? 'Can\u2019t reach this page'
      : 'No tools registered';
    const noToolsText = document.getElementById('noToolsText');
    noToolsText.textContent = '';
    if (unavailable) {
      noToolsText.textContent = toolsStateDetail;
    } else {
      const hint = document.createElement('span');
      hint.className = 'page-hint';
      hint.textContent = 'this';
      if (/^https?:\/\//.test(toolsStateDetail)) {
        hint.tabIndex = 0;
        const tip = document.createElement('span');
        tip.className = 'page-hint-tip';
        const link = document.createElement('a');
        link.href = toolsStateDetail;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = toolsStateDetail;
        tip.append('Current page: ', link);
        hint.append(tip);
      }
      noToolsText.append('No WebMCP tools were found on ', hint, ' page.');
    }
    document.getElementById('noToolsSteps').hidden = unavailable;
  }
}

// Request list of tools from content script living in top-level frame.
async function requestToolsFromActiveTab() {
  if (toolsState !== 'ready' && !(toolsState === 'loading' && loadingTimer)) setToolsState('loading');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      statusDiv.textContent = 'Navigate to a webpage (e.g. RSC) to inspect WebMCP tools.';
      statusDiv.hidden = false;
      copyToClipboard.hidden = true;
      setToolsState('unavailable', 'Navigate to a regular web page (not a chrome:// page) to inspect its WebMCP tools.');
      return;
    }
    const fromOrigins = await getAllFrameOrigins(tab.id);
    try {
      await chrome.tabs.sendMessage(tab.id, { action: 'LIST_TOOLS', fromOrigins }, { frameId: 0 });
    } catch {
      // Content script may not be injected yet; inject dynamically:
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js'],
        });
        await chrome.tabs.sendMessage(tab.id, { action: 'LIST_TOOLS', fromOrigins }, { frameId: 0 });
      } catch {}
    }
  } catch (error) {
    statusDiv.textContent = 'Please refresh the active web tab to connect the inspector.';
    statusDiv.hidden = false;
    copyToClipboard.hidden = true;
    setToolsState('unavailable', 'Please refresh the active web tab to connect the inspector, then press the retry button.');
  }
}

requestToolsFromActiveTab();

chrome.tabs.onActivated.addListener(() => requestToolsFromActiveTab());
chrome.tabs.onUpdated.addListener((_, changeInfo) => {
  if (changeInfo.status === 'complete') requestToolsFromActiveTab();
});

let currentTools = [];

let userPromptPendingId = 0;
let suggestedForTools = '';
let suggestionsDismissed = false;
const suggestionList = document.getElementById('suggestionList');

// Listen for the results coming back from content.js
chrome.runtime.onMessage.addListener(async ({ message, tools, url, type, tabId }, sender) => {
  // Internal signals (e.g. contentScriptReady) are handled elsewhere.
  if (type) return;
  if (sender.frameId && sender.frameId !== 0) return;
  if (!message && !tools) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (sender.tab && sender.tab.id !== tab.id) return;
  // Ignore errors about other tabs, e.g. the mic permission popup window.
  if (tabId && tabId !== tab.id) return;

  tbody.innerHTML = '';
  thead.innerHTML = '';
  toolNames.innerHTML = '';

  statusDiv.textContent = message;
  statusDiv.hidden = !message;

  const haveNewTools = JSON.stringify(currentTools) !== JSON.stringify(tools);

  currentTools = tools || [];
  if (haveNewTools) updateLiveTools();

  if (!tools || tools.length === 0) {
    const row = document.createElement('tr');
    row.innerHTML = `<td colspan="100%"><i>No tools registered yet in ${url || tab.url}</i></td>`;
    tbody.appendChild(row);
    setToolsState('none', url || tab.url);
    inputArgsText.value = '';
    inputArgsText.disabled = true;
    toolNames.disabled = true;
    executeBtn.disabled = true;
    copyToClipboard.hidden = true;
    return;
  }

  setToolsState('ready');
  inputArgsText.disabled = false;
  toolNames.disabled = false;
  executeBtn.disabled = false;
  copyToClipboard.hidden = false;

  const KEYS = ['description', 'inputSchema', 'annotations', 'name'];
  const keys = KEYS.filter((key) => tools.some((tool) => key in tool));
  keys.forEach((key) => {
    const th = document.createElement('th');
    th.textContent = key;
    thead.appendChild(th);
  });

  tools.forEach((item) => {
    const row = document.createElement('tr');
    keys.forEach((key) => {
      const td = document.createElement('td');
      const pre = document.createElement('pre');
      try {
        pre.textContent = JSON.stringify(JSON.parse(item[key]), '', '  ');
        td.appendChild(pre);
      } catch (error) {
        td.textContent = item[key];
      }
      row.appendChild(td);
    });
    tbody.appendChild(row);

    const option = document.createElement('option');
    option.textContent = `"${item.name}"${item.frameId !== 0 ? ` (${item.frameId})` : ''}`;
    option.value = item.name;
    option.dataset.inputSchema = item.inputSchema || '{}';
    option.dataset.frameId = item.frameId;
    toolNames.appendChild(option);
  });
  updateDefaultValueForInputArgs();

  if (haveNewTools) {
    suggestionsDismissed = false;
    suggestUserPrompt();
  }
});

tbody.ondblclick = () => {
  tbody.classList.toggle('prettify');
};

copyAsScriptToolConfig.onclick = async () => {
  const text = (currentTools || [])
    .map((tool) => {
      return `\
script_tools {
  name: ${JSON.stringify(tool.name)}
  description: ${JSON.stringify(tool.description || '')}
  input_schema: ${JSON.stringify(tool.inputSchema || { type: 'object', properties: {} })}
}`;
    })
    .join('\r\n');
  await navigator.clipboard.writeText(text);
};

copyAsJSON.onclick = async () => {
  const tools = (currentTools || []).map((tool) => {
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
        ? JSON.parse(tool.inputSchema)
        : { type: 'object', properties: {} },
    };
  });
  await navigator.clipboard.writeText(JSON.stringify(tools, '', '  '));
};

// Interact with the page

let genAI, chat;

async function initGenAI() {
  let env;
  try {
    // Try load .env.json if present.
    env = (await import('./.env.json', { with: { type: 'json' } })).default;
  } catch {}

  if (env?.apiKey) localStorage.apiKey ??= env.apiKey;

  if (localStorage.model === 'gemini-2.5-flash') {
    localStorage.model = 'gemini-3-flash-preview';
  }
  if (localStorage.model === 'gemini-3.1-flash-lite-preview') {
    localStorage.model = 'gemini-3.1-flash-lite';
  }
  localStorage.model ??= env?.model || 'gemini-3.6-flash';
  document.getElementById('activeModel').textContent = localStorage.model;

  const hasKey = hasApiKey();

  genAI = hasKey ? new GoogleGenAI({ apiKey: localStorage.apiKey }) : undefined;

  promptBtn.disabled = !hasKey;
  resetBtn.disabled = !hasKey;

  apiKeyBtn.textContent = hasKey ? 'Update Gemini Key' : 'Set Gemini API Key';

  suggestUserPromptCheckbox.checked = localStorage.suggestUserPrompt !== 'false';
  updateView();
}
await initGenAI();

noKeyBtn.onclick = () => apiKeyBtn.click();
retryToolsBtn.onclick = () => {
  setToolsState('loading');
  requestToolsFromActiveTab();
};

suggestUserPromptCheckbox.onchange = () => {
  localStorage.suggestUserPrompt = suggestUserPromptCheckbox.checked;
  suggestUserPrompt();
  advancedSection.hidePopover();
};

const SUGGESTION_COUNT = 3;

function showSuggestions(prompts) {
  suggestionList.replaceChildren(
    ...prompts.map((text) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'suggestion-chip';
      chip.title = 'Send this suggestion';
      chip.textContent = text;
      chip.onclick = () => {
        if (promptBtn.disabled) return;
        hideSuggestions();
        userPromptText.value = text;
        promptBtn.click();
      };
      return chip;
    }),
  );
  suggestionList.hidden = prompts.length === 0;
}

function hideSuggestions() {
  userPromptPendingId++; // Invalidate any request still in flight.
  suggestedForTools = '';
  showSuggestions([]);
}

// Models are asked for a JSON array; fall back to one suggestion per line.
function parseSuggestions(raw) {
  const cleaned = String(raw || '').replace(/```(?:json)?/gi, '').trim();
  let list;
  try {
    list = JSON.parse(cleaned);
  } catch {
    list = cleaned.split('\n').map((line) => line.replace(/^\s*(?:[-*\u2022]|\d+[.)])\s*/, '').replace(/^["']|["',]+$/g, ''));
  }
  if (!Array.isArray(list)) return [];
  return list
    .filter((s) => typeof s === 'string')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, SUGGESTION_COUNT);
}

async function suggestUserPrompt() {
  if (localStorage.suggestUserPrompt === 'false' || currentTools.length === 0) {
    hideSuggestions();
    return;
  }
  // Only offer a starting point: not after a reset, and not mid-conversation.
  if (suggestionsDismissed || promptResults.querySelector('.msg-user')) return;

  if (!genAI) return;

  const toolsKey = JSON.stringify(currentTools);
  if (suggestedForTools === toolsKey) return; // Already showing or fetching one for these tools.
  suggestedForTools = toolsKey;
  const userPromptId = ++userPromptPendingId;

  let raw = '';
  try {
    const response = await genAI.models.generateContent({
      model: localStorage.model,
      contents: [
        '**Context:**',
        `Today's date is: ${getFormattedDate()}`,
        '**Tool Rules:**',
        '1. **Bank Transaction Filter:** Use **PAST** dates only (e.g., "last month," "December 15th," "yesterday").',
        '2. **Flight Search:** Use **FUTURE** dates only (e.g., "next week," "February 15th").',
        '3. **Accommodation Search:** Use **FUTURE** dates only (e.g., "next weekend," "March 15th").',
        '**Task:**',
        `Generate ${SUGGESTION_COUNT} distinct natural user queries for a range of tools below, ideally chaining them together.`,
        'Ensure the date makes sense relative to today.',
        `Output only a JSON array of ${SUGGESTION_COUNT} strings.`,
        '**Tools:**',
        JSON.stringify(currentTools),
      ],
    });
    raw = response.text || '';
  } catch {}

  if (userPromptId !== userPromptPendingId) return; // Superseded or dismissed meanwhile.
  const prompts = parseSuggestions(raw);
  if (prompts.length) {
    showSuggestions(prompts);
  } else {
    suggestedForTools = ''; // Let a later attempt retry.
  }
}

userPromptText.onkeydown = (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    promptBtn.click();
  }
};

promptBtn.onclick = async () => {
  try {
    await promptAI();
  } catch (error) {
    trace.push({ error });
    logPrompt(`⚠️ Error: "${error.message || error}"`);
  }
};

let trace = [];

async function promptAI() {
  const message = userPromptText.value.trim();
  if (!message) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  chat ??= genAI.chats.create({ model: localStorage.model });

  userPromptText.value = '';
  logPrompt(`User prompt: "${message}"`);
  const sendMessageParams = { message, config: getConfig() };
  trace.push({ userPrompt: sendMessageParams });
  let currentResult = await chat.sendMessage(sendMessageParams);
  let finalResponseGiven = false;

  while (!finalResponseGiven) {
    const response = currentResult;
    trace.push({ response });
    const functionCalls = response.functionCalls || [];

    if (functionCalls.length === 0) {
      if (!response.text) {
        logPrompt(`⚠️ AI response has no text: ${JSON.stringify(response.candidates)}\n`);
      } else {
        renderAiResult(response.text?.trim());
      }
      finalResponseGiven = true;
    } else {
      const toolResponses = [];
      for (const { name: toolName, args } of functionCalls) {
        let [frameId, name] = toolName.split(/_(.*)/s)[1].split(/_(.*)/s);
        frameId = parseInt(frameId);
        const inputArgs = JSON.stringify(args);
        logPrompt(`AI calling tool "${name}" with ${inputArgs}`);
        try {
          const result = await executeTool(tab.id, name, inputArgs, frameId);
          toolResponses.push({ functionResponse: { name: toolName, response: { result } } });
          logPrompt(`Tool "${name}" result: ${result}`);
        } catch (e) {
          logPrompt(`⚠️ Error executing tool "${name}": ${e.message}`);
          toolResponses.push({
            functionResponse: { name: toolName, response: { error: e.message } },
          });
        }
      }

      const sendMessageParams = { message: toolResponses, config: getConfig() };
      trace.push({ userPrompt: sendMessageParams });
      currentResult = await chat.sendMessage(sendMessageParams);
    }
  }
}

resetBtn.onclick = () => {
  chat = undefined;
  trace = [];
  userPromptText.value = '';
  promptResults.innerHTML = '';
  suggestionsDismissed = true;
  hideSuggestions();
};

function syncSaveKeyBtn() {
  document.getElementById('saveKeyBtn').disabled =
    !document.getElementById('apiKeyInput').value.trim();
}

document.getElementById('apiKeyInput').oninput = syncSaveKeyBtn;

apiKeyBtn.onclick = () => {
  document.getElementById('setKeyTitle').textContent = 'Google Gemini API key';
  document.getElementById('setKeyText').textContent = 'Enter your Google Gemini API key.';
  const input = document.getElementById('apiKeyInput');
  input.value = localStorage.apiKey || '';
  input.type = 'password';
  syncSaveKeyBtn();
  document.getElementById('showKeyCheckbox').checked = false;
  advancedSection.hidePopover?.();
  keyEntryOpen = true;
  updateView();
  input.focus();
};

document.getElementById('showKeyCheckbox').onchange = (e) => {
  document.getElementById('apiKeyInput').type = e.target.checked ? 'text' : 'password';
};

document.getElementById('cancelKeyBtn').onclick = () => {
  keyEntryOpen = false;
  updateView();
};

document.getElementById('setKeyForm').onsubmit = async (e) => {
  e.preventDefault();
  const key = document.getElementById('apiKeyInput').value.trim();
  if (!key) return;
  localStorage.apiKey = key;
  keyEntryOpen = false;
  await initGenAI();
  suggestUserPrompt();
};

traceBtn.onclick = async () => {
  const text = JSON.stringify(trace, '', ' ');
  await navigator.clipboard.writeText(text);
};

executeBtn.onclick = async () => {
  toolResults.textContent = '';
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const name = toolNames.selectedOptions[0].value;
  const inputArgs = inputArgsText.value;
  const frameId = parseInt(toolNames.selectedOptions[0].dataset.frameId);
  toolResults.textContent = await executeTool(tab.id, name, inputArgs, frameId).catch(
    (error) => `⚠️ Error: "${error}"`,
  );
};

async function executeTool(tabId, name, inputArgs, frameId) {
  let toolsReady;
  const toolsPromise = new Promise((resolve) => {
    toolsReady = resolve;
  });

  let targetTabId = tabId;
  let contentScriptReadyResolve;
  const contentScriptReadyPromise = new Promise((r) => { contentScriptReadyResolve = r; });

  const listener = (msg, sender) => {
    if (msg.type === 'contentScriptReady' && sender.tab) {
      if (sender.tab.id === tabId || sender.tab.openerTabId === tabId) {
        targetTabId = sender.tab.id;
        contentScriptReadyResolve();
      }
    }
    if (msg.tools && sender.tab?.id === targetTabId) {
      toolsReady();
    }
  };
  chrome.runtime.onMessage.addListener(listener);

  try {
    try {
      const result = await chrome.tabs.sendMessage(
        tabId,
        { action: 'EXECUTE_TOOL', name, inputArgs },
        { frameId },
      );
      if (result !== null) return result;
    } catch (error) {
      if (!/message channel (is )?closed/.test(error.message)) throw error;
    }

    // A navigation was triggered. The result will be on the next document,
    // which may live in a new tab if the tool opened one.
    await Promise.race([
      contentScriptReadyPromise,
      new Promise((r) => setTimeout(r, 2000)),
    ]);

    await Promise.race([
      toolsPromise,
      new Promise((r) => setTimeout(r, 2000)),
    ]);

    await waitForPageLoad(targetTabId);

    return await chrome.tabs.sendMessage(
      targetTabId,
      { action: 'GET_CROSS_DOCUMENT_SCRIPT_TOOL_RESULT' },
      // The original frameId only makes sense in the original tab.
      { frameId: targetTabId === tabId ? frameId : 0 },
    );
  } finally {
    chrome.runtime.onMessage.removeListener(listener);
  }
}

toolNames.onchange = updateDefaultValueForInputArgs;

function updateDefaultValueForInputArgs() {
  const inputSchema = toolNames.selectedOptions[0].dataset.inputSchema || '{}';
  const template = generateTemplateFromSchema(JSON.parse(inputSchema));
  inputArgsText.value = JSON.stringify(template, '', ' ');
}

// Initialize Gemini Live
initGeminiLive({
  micBtn,
  apiKeyBtn,
  getTools: () => currentTools,
  getConfig,
  executeTool,
  logPrompt,
  addToTrace: (o) => trace.push(o),
});

// Utils

const verboseToggleBtn = document.getElementById('verboseToggleBtn');

function setVerboseLogs(on) {
  promptResults.classList.toggle('show-verbose', on);
  verboseToggleBtn.setAttribute('aria-pressed', String(on));
  verboseToggleBtn.textContent = on ? 'Hide verbose logs' : 'Show verbose logs';
  promptResults.scrollTop = promptResults.scrollHeight;
}

let verboseLogs = false;
try {
  verboseLogs = localStorage.verboseLogs === 'true';
} catch {}
setVerboseLogs(verboseLogs);

verboseToggleBtn.onclick = () => {
  verboseLogs = !verboseLogs;
  try {
    localStorage.verboseLogs = verboseLogs;
  } catch {}
  setVerboseLogs(verboseLogs);
};

function logPrompt(text) {
  text = String(text).trim();
  let role = 'system';
  const userMatch = text.match(/^User prompt: "([\s\S]*)"$/);
  if (userMatch) {
    role = 'user';
    text = userMatch[1];
    hideSuggestions();
  } else if (text.startsWith('AI result: ')) {
    role = 'ai';
    text = text.slice('AI result: '.length);
  }
  const bubble = document.createElement('div');
  bubble.className = `msg msg-${role}`;
  if (role === 'system' && text.startsWith('⚠️')) bubble.classList.add('msg-error');
  if (role === 'ai') {
    bubble.classList.add('md');
    bubble.replaceChildren(renderMarkdown(text));
  } else {
    bubble.textContent = text;
  }
  promptResults.appendChild(bubble);
  promptResults.scrollTop = promptResults.scrollHeight;
}

function renderAiResult(text) {
  if (!text) return;

  // Detect code blocks: ```[lang][:filename]\n[code]```
  const codeBlockRegex = /```(?:([a-zA-Z0-9_-]+)(?:\s*:\s*([^\n\r]+))?)?\n([\s\S]*?)```/g;

  // Code blocks are delivered as script cards below, so the bubble shows only the prose.
  const prose = text.replace(codeBlockRegex, '').trim();
  if (prose) logPrompt(`AI result: ${prose}`);
  let match;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    const rawLang = (match[1] || '').toLowerCase();
    const explicitFilename = match[2]?.trim();
    const code = match[3].trim();

    const lang = rawLang || (code.includes('import ') || code.includes('def ') ? 'python' : 'script');
    let filename = explicitFilename;
    if (!filename) {
      const commentMatch = code.match(/^(?:#|\/\/|\/\*)\s*([\w.-]+\.(?:py|sh|js|ts|json|yml|yaml))\b/m);
      if (commentMatch) {
        filename = commentMatch[1];
      } else if (lang === 'python' || lang === 'py') {
        filename = 'salesforce_monthly_audit.py';
      } else if (lang === 'sh' || lang === 'bash') {
        filename = 'run_audit.sh';
      } else if (lang === 'json') {
        filename = 'audit_report.json';
      } else {
        filename = 'automation_script.py';
      }
    }

    createScriptDeliveryCard(filename, lang, code);
  }
}

function createScriptDeliveryCard(filename, lang, code) {
  const card = document.createElement('div');
  card.className = 'script-delivery-card';

  const isPython = lang === 'python' || lang === 'py' || filename.endsWith('.py');
  const badgeText = isPython ? 'Python 3 • Zero Dependencies' : `${lang.toUpperCase()} Script`;

  card.innerHTML = `
    <div class="script-delivery-header">
      <div class="script-delivery-title">
        <span>⚡</span>
        <span>${escapeHtml(filename)}</span>
      </div>
      <span class="script-delivery-badge">${badgeText}</span>
    </div>
    <div class="script-delivery-actions">
      <button class="script-delivery-btn primary download-btn">⬇️ Download ${escapeHtml(filename)}</button>
      <button class="script-delivery-btn secondary copy-btn">📋 Copy Code</button>
      <button class="script-delivery-btn secondary toggle-btn">👁️ View Code</button>
    </div>
    <pre class="script-delivery-code" style="display: none;">${escapeHtml(code)}</pre>
    <div class="script-delivery-runbook">
      <strong>Run without WebMCP / Extension:</strong><br>
      <code>export RUBRIK_BASE_URL="https://your-org.my.rubrik.com"</code><br>
      <code>export RUBRIK_API_TOKEN="&lt;your-service-account-token&gt;"</code><br>
      <code>python3 ${escapeHtml(filename)}</code>
    </div>
  `;

  const downloadBtn = card.querySelector('.download-btn');
  downloadBtn.onclick = (e) => {
    e.stopPropagation();
    downloadFile(filename, code, isPython ? 'text/x-python' : 'text/plain');
  };

  const copyBtn = card.querySelector('.copy-btn');
  copyBtn.onclick = async (e) => {
    e.stopPropagation();
    await navigator.clipboard.writeText(code);
    copyBtn.textContent = '✓ Copied!';
    setTimeout(() => {
      copyBtn.textContent = '📋 Copy Code';
    }, 2000);
  };

  const toggleBtn = card.querySelector('.toggle-btn');
  const codePre = card.querySelector('.script-delivery-code');
  toggleBtn.onclick = (e) => {
    e.stopPropagation();
    const isHidden = codePre.style.display === 'none';
    codePre.style.display = isHidden ? 'block' : 'none';
    toggleBtn.textContent = isHidden ? '🙈 Hide Code' : '👁️ View Code';
  };

  promptResults.appendChild(card);
  promptResults.scrollTop = promptResults.scrollHeight;
}

function downloadFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getFormattedDate() {
  const today = new Date();
  return today.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function getConfig() {
  const systemInstruction = [
    'You are an assistant embedded in a browser tab for Rubrik Security Cloud.',
    'User prompts typically refer to the current tab unless stated otherwise.',
    'Use the provided tools to query page content when you need it.',
    `Today's date is: ${getFormattedDate()}`,
    'CRITICAL RULE: Whenever the user provides a relative date (e.g., "next Monday", "tomorrow", "in 3 days"),  you must calculate the exact calendar date based on today\'s date.',
    'CRITICAL RULE: Do not try to use other tools than the available ones.',
    'AUTOMATION & SCRIPT DELIVERY RULE: When asked to audit, automate, or generate a script: first use the page tools to query live data and identify status or gaps. Then output a complete, standalone, production-ready Python script inside a ```python code block. The script MUST use only standard libraries (urllib.request, json, os, sys, datetime) with zero external pip dependencies. It should read credentials from RUBRIK_BASE_URL and RUBRIK_API_TOKEN environment variables and print a clean summary report.',
  ];

  const functionDeclarations = (currentTools || []).map((tool) => {
    return {
      name: `_${tool.frameId}_${tool.name}`,
      description: tool.description,
      parametersJsonSchema: tool.inputSchema
        ? (typeof tool.inputSchema === 'string' ? JSON.parse(tool.inputSchema) : tool.inputSchema)
        : { type: 'object', properties: {} },
    };
  });
  const tools = functionDeclarations.length > 0 ? [{ functionDeclarations }] : [];
  return { systemInstruction, tools };
}

function generateTemplateFromSchema(schema) {
  if (!schema || typeof schema !== 'object') {
    return null;
  }

  if (schema.hasOwnProperty('const')) {
    return schema.const;
  }

  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    return generateTemplateFromSchema(schema.oneOf[0]);
  }

  if (schema.hasOwnProperty('default')) {
    return schema.default;
  }

  if (Array.isArray(schema.examples) && schema.examples.length > 0) {
    return schema.examples[0];
  }

  switch (schema.type) {
    case 'object':
      const obj = {};
      if (schema.properties) {
        Object.keys(schema.properties).forEach((key) => {
          obj[key] = generateTemplateFromSchema(schema.properties[key]);
        });
      }
      return obj;

    case 'array':
      if (schema.items) {
        return [generateTemplateFromSchema(schema.items)];
      }
      return [];

    case 'string':
      if (schema.enum && schema.enum.length > 0) {
        return schema.enum[0];
      }
      if (schema.format === 'date') {
        return new Date().toISOString().substring(0, 10);
      }
      // yyyy-MM-ddThh:mm:ss.SSS
      if (
        schema.format ===
        '^[0-9]{4}-(0[1-9]|1[0-2])-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\\.[0-9]{1,3})?)?$'
      ) {
        return new Date().toISOString().substring(0, 23);
      }
      // yyyy-MM-ddThh:mm:ss
      if (
        schema.format ===
        '^[0-9]{4}-(0[1-9]|1[0-2])-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$'
      ) {
        return new Date().toISOString().substring(0, 19);
      }
      // yyyy-MM-ddThh:mm
      if (schema.format === '^[0-9]{4}-(0[1-9]|1[0-2])-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]$') {
        return new Date().toISOString().substring(0, 16);
      }
      // yyyy-MM
      if (schema.format === '^[0-9]{4}-(0[1-9]|1[0-2])$') {
        return new Date().toISOString().substring(0, 7);
      }
      // yyyy-Www
      if (schema.format === '^[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$') {
        return `${new Date().toISOString().substring(0, 4)}-W01`;
      }
      // HH:mm:ss.SSS
      if (schema.format === '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\\.[0-9]{1,3})?)?$') {
        return new Date().toISOString().substring(11, 23);
      }
      // HH:mm:ss
      if (schema.format === '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$') {
        return new Date().toISOString().substring(11, 19);
      }
      // HH:mm
      if (schema.format === '^([01][0-9]|2[0-3]):[0-5][0-9]$') {
        return new Date().toISOString().substring(11, 16);
      }
      if (schema.format === '^#[0-9a-zA-Z]{6}$') {
        return '#ff00ff';
      }
      if (schema.format === 'tel') {
        return '123-456-7890';
      }
      if (schema.format === 'email') {
        return 'user@example.com';
      }
      return 'example_string';

    case 'number':
    case 'integer':
      if (schema.minimum !== undefined) return schema.minimum;
      return 0;

    case 'boolean':
      return false;

    case 'null':
      return null;

    default:
      return {};
  }
}

function waitForPageLoad(tabId) {
  return new Promise((resolve) => {
    let timeoutId;
    const done = () => {
      clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') done();
    };

    timeoutId = setTimeout(done, 5000); // resolve rather than reject to avoid crashing the AI loop
    chrome.tabs.onUpdated.addListener(listener);

    // The tab may already be done loading, or gone; don't wait on the
    // timeout for those.
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') done();
    }).catch(done);
  });
}

document.querySelectorAll('.collapsible-header').forEach((header) => {
  header.addEventListener('click', () => {
    header.classList.toggle('collapsed');
    const content = header.nextElementSibling;
    if (content?.classList.contains('section-content')) {
      content.classList.toggle('is-hidden');
    }
  });
});
