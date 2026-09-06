'use strict';

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const REDIRECT_URI = 'http://localhost:1455/auth/callback';
const SCOPE = 'openid profile email offline_access';
const EXTENSION_VERSION = '1.0.4';
const MAX_LOGS = 100;

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function randomString(size = 32) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function sha256Base64Url(value) {
  const data = new TextEncoder().encode(value);
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', data)));
}

function decodeJwtPayload(token) {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return {};
    const normalized = part.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (_) {
    return {};
  }
}

async function logEvent(event, details = {}) {
  const entry = { at: new Date().toISOString(), event, details };
  console.info(`[CodexTokenCapture v${EXTENSION_VERSION}] ${event}`, details);
  try {
    const stored = await chrome.storage.local.get('codexCaptureLogs');
    const logs = Array.isArray(stored.codexCaptureLogs) ? stored.codexCaptureLogs : [];
    logs.push(entry);
    await chrome.storage.local.set({ codexCaptureLogs: logs.slice(-MAX_LOGS) });
  } catch (error) {
    console.warn(`[CodexTokenCapture v${EXTENSION_VERSION}] log_write_failed`, error.message || String(error));
  }
}

async function setStatus(status) {
  await chrome.storage.local.set({ codexCaptureStatus: status });
}

async function startOAuth() {
  await logEvent('start_requested');
  const verifier = randomString(48);
  const state = randomString(24);
  const challenge = await sha256Base64Url(verifier);
  await logEvent('pkce_created', {
    stateLength: state.length,
    verifierLength: verifier.length,
    challengeLength: challenge.length,
  });
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('id_token_add_organizations', 'true');
  url.searchParams.set('codex_cli_simplified_flow', 'true');
  url.searchParams.set('originicator', 'codex_cli');

  await chrome.storage.local.set({
    codexCaptureSession: { state, verifier },
    codexCaptureStatus: { stage: 'waiting_for_login', message: 'Đăng nhập và 2FA thủ công trong tab OAuth.' },
  });
  try {
    const created = await chrome.windows.create({ url: url.toString(), incognito: true });
    await logEvent('oauth_window_opened', { windowId: created && created.id, incognito: true });
  } catch (error) {
    await logEvent('oauth_window_open_failed', { error: error.message || String(error) });
    throw error;
  }
}

async function exchangeCode(code, state, tabId) {
  await logEvent('exchange_started', { tabId, codePresent: Boolean(code), statePresent: Boolean(state) });
  const stored = await chrome.storage.local.get('codexCaptureSession');
  const session = stored.codexCaptureSession;
  await logEvent('session_loaded', { found: Boolean(session), stateMatches: Boolean(session && session.state === state) });
  if (!session || session.state !== state) throw new Error('state_mismatch');

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: session.verifier,
  });
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  });
  const payload = await response.json().catch(() => ({}));
  await logEvent('token_endpoint_response', {
    status: response.status,
    ok: response.ok,
    payloadKeys: Object.keys(payload).filter((key) => !/token/i.test(key)),
    hasAccessToken: Boolean(payload.access_token),
    hasRefreshToken: Boolean(payload.refresh_token),
    hasIdToken: Boolean(payload.id_token),
  });
  if (!response.ok || !payload.access_token || !payload.refresh_token) {
    throw new Error(payload.error || `token_exchange_http_${response.status}`);
  }

  const accessClaims = decodeJwtPayload(payload.access_token);
  const idClaims = decodeJwtPayload(payload.id_token);
  const profile = idClaims['https://api.openai.com/profile'] || accessClaims['https://api.openai.com/profile'] || {};
  const auth = accessClaims['https://api.openai.com/auth'] || idClaims['https://api.openai.com/auth'] || {};
  const expiresIn = Number(payload.expires_in) || 0;
  const output = {
    email: profile.email || idClaims.email || accessClaims.email || null,
    last_refresh: new Date().toISOString(),
    tokens: {
      access_token: payload.access_token,
      refresh_token: payload.refresh_token,
      id_token: payload.id_token || null,
      expires_in: expiresIn,
      expires_at: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
      account_id: auth.chatgpt_account_id || null,
    },
  };
  const json = JSON.stringify(output, null, 2) + '\n';
  const url = `data:application/json;charset=utf-8,${encodeURIComponent(json)}`;
  await logEvent('token_normalized', {
    emailPresent: Boolean(output.email),
    accountIdPresent: Boolean(output.tokens.account_id),
    expiresIn: expiresIn || null,
  });
  try {
    const downloadId = await chrome.downloads.download({
      url,
      filename: 'codex-oauth-token.json',
      saveAs: true,
    });
    await logEvent('download_started', { downloadId });
  } catch (error) {
    await logEvent('download_failed', { error: error.message || String(error) });
    throw error;
  }
  await chrome.storage.local.remove('codexCaptureSession');
  await setStatus({ stage: 'complete', message: 'Đã lấy token và mở hộp thoại lưu JSON.', email: output.email });
  await logEvent('flow_complete', { emailPresent: Boolean(output.email), tabId });
  if (Number.isInteger(tabId)) {
    const resultUrl = `${chrome.runtime.getURL('result.html')}?stage=success&email=${encodeURIComponent(output.email || '')}`;
    await chrome.tabs.update(tabId, { url: resultUrl }).catch(() => {});
  }
}

const handledCallbackTabs = new Set();

function handleCallback(tabId, rawUrl, source) {
  if (handledCallbackTabs.has(tabId)) return;
  let callback;
  try {
    callback = new URL(rawUrl);
  } catch (_) {
    return;
  }
  if (callback.origin !== 'http://localhost:1455' || callback.pathname !== '/auth/callback') return;
  handledCallbackTabs.add(tabId);

  logEvent('callback_seen', {
    source,
    tabId,
    origin: callback.origin,
    path: callback.pathname,
    queryKeys: [...callback.searchParams.keys()],
  });

  const state = callback.searchParams.get('state') || '';
  const code = callback.searchParams.get('code') || '';
  const error = callback.searchParams.get('error') || '';
  if (error) {
    logEvent('callback_oauth_error', { tabId, error });
    setStatus({ stage: 'error', message: error });
    chrome.tabs.update(tabId, { url: `${chrome.runtime.getURL('result.html')}?stage=error&message=${encodeURIComponent(error)}` }).catch(() => {});
    return;
  }
  if (!code || !state) {
    logEvent('callback_missing_fields', { tabId, codePresent: Boolean(code), statePresent: Boolean(state) });
    setStatus({ stage: 'error', message: 'callback_missing_code_or_state' });
    chrome.tabs.update(tabId, { url: `${chrome.runtime.getURL('result.html')}?stage=error&message=callback_missing_code_or_state` }).catch(() => {});
    return;
  }
  logEvent('callback_accepted', { tabId });
  chrome.tabs.update(tabId, { url: `${chrome.runtime.getURL('result.html')}?stage=processing` }).catch(() => {});
  exchangeCode(code, state, tabId).catch((exchangeError) => {
    logEvent('flow_failed', { tabId, error: exchangeError.message || String(exchangeError) });
    setStatus({ stage: 'error', message: exchangeError.message || String(exchangeError) });
    const message = encodeURIComponent(exchangeError.message || String(exchangeError));
    chrome.tabs.update(tabId, { url: `${chrome.runtime.getURL('result.html')}?stage=error&message=${message}` }).catch(() => {});
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === 'start_oauth') {
    startOAuth()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        logEvent('start_failed', { error: error.message || String(error) });
        setStatus({ stage: 'error', message: error.message || String(error) });
        sendResponse({ ok: false, error: error.message || String(error) });
      });
    return true;
  }
  if (message && message.type === 'get_status') {
    chrome.storage.local.get('codexCaptureStatus').then((value) => sendResponse(value.codexCaptureStatus || null));
    return true;
  }
  if (message && message.type === 'get_logs') {
    chrome.storage.local.get('codexCaptureLogs').then((value) => sendResponse(value.codexCaptureLogs || []));
    return true;
  }
  if (message && message.type === 'clear_logs') {
    chrome.storage.local.remove('codexCaptureLogs').then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) handleCallback(tabId, changeInfo.url, 'tabs.onUpdated');
});

chrome.webNavigation.onCommitted.addListener((details) => {
  handleCallback(details.tabId, details.url, 'webNavigation.onCommitted');
});

chrome.webRequest.onBeforeRequest.addListener(
  (details) => handleCallback(details.tabId, details.url, 'webRequest.onBeforeRequest'),
  { urls: ['http://localhost:1455/auth/callback*'], types: ['main_frame'] }
);

logEvent('service_worker_loaded', { version: EXTENSION_VERSION });
