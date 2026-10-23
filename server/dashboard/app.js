'use strict';

(() => {
  let catalog = [];
  const states = {
    authenticated: 'Signed in', expired: 'Session expired', missing: 'Not signed in',
    unknown: 'Not verified', unavailable: 'Unavailable', saved: 'Saved, unverified'
  };
  const activityStates = { running: 'Running', success: 'Completed', error: 'Error', cancelled: 'Cancelled' };
  const activityErrors = {
    invalid_request: 'Invalid request', authentication: 'Authentication error', timeout: 'Timed out',
    upstream_error: 'Provider error', cancelled: 'Request cancelled', internal_error: 'Proxy error'
  };
  const activityProviders = new Map();
  const elements = Object.fromEntries([
    'provider-grid', 'key-panel', 'key-toggle', 'key-form', 'proxy-key', 'forget-key',
    'notice', 'notice-text', 'dismiss-notice', 'connection-summary', 'last-checked',
    'refresh-all', 'confirm-dialog', 'confirm-title', 'confirm-description', 'confirm-close',
    'confirm-cancel', 'confirm-accept', 'login-dialog', 'login-title', 'login-description',
    'login-close', 'authorization-link', 'manual-code-form', 'manual-code', 'login-feedback',
    'check-login', 'submit-code', 'activity-summary', 'activity-panel', 'activity-state',
    'activity-state-title', 'activity-state-description', 'activity-table-wrap', 'activity-rows',
    'activity-updated', 'refresh-activity', 'clear-activity', 'connection-count', 'connections-empty',
    'add-provider', 'add-dialog', 'add-close', 'add-cancel', 'add-form', 'provider-options', 'connection-name', 'add-submit', 'add-feedback'
  ].map(id => [id, document.getElementById(id)]));
  const cards = new Map();
  const providers = new Map();
  let proxyKey = '';
  let loading = false;
  let statusStale = false;
  let activeAction = null;
  let confirmation = null;
  let loginFlow = null;
  let lastTrigger = null;
  let noticeSource = null;
  let activityLoading = false;
  let activityClearing = false;
  let activityLoaded = false;
  let activityEntries = [];

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function button(className, text, listener) {
    const element = node('button', className, text);
    element.type = 'button';
    element.addEventListener('click', listener);
    return element;
  }

  function notice(message, error = false, source = 'action') {
    noticeSource = source;
    elements['notice-text'].textContent = message;
    elements.notice.dataset.tone = error ? 'error' : 'success';
    elements.notice.hidden = false;
  }

  function revealKey(focus = true) {
    elements['key-panel'].hidden = false;
    elements['key-toggle'].setAttribute('aria-expanded', 'true');
    if (focus && !elements['login-dialog'].open && !elements['confirm-dialog'].open) elements['proxy-key'].focus();
  }

  async function request(url, options = {}, timeoutMs = 45000) {
    const headers = { 'X-Dashboard-Request': '1', ...options.headers };
    if (proxyKey) headers['X-Proxy-Key'] = proxyKey;
    let response;
    let data = {};
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), timeoutMs);
    try {
      response = await fetch(url, { ...options, headers, signal: controller.signal, credentials: 'same-origin', cache: 'no-store' });
      try { data = await response.json(); } catch (error) {
        if (error.name === 'AbortError') throw error;
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error(options.method === 'POST'
          ? 'The request timed out, but the change may still finish. Check status before trying it again.'
          : 'The status request timed out. Check that the proxy is running, then refresh.');
      }
      throw new Error('The local proxy could not be reached. Check that it is still running, then try again.');
    } finally {
      clearTimeout(deadline);
    }
    if (response.status === 401) {
      revealKey();
      const error = new Error('This proxy needs an access key. Enter your proxy key above and try again.');
      error.needsKey = true;
      throw error;
    }
    if (!response.ok) {
      const message = typeof data.message === 'string' ? data.message
        : typeof data.error?.message === 'string' ? data.error.message
          : typeof data.error === 'string' ? data.error : `The proxy could not complete this request (${response.status}).`;
      throw new Error(message);
    }
    return data;
  }

  function renderCard(definition) {
    const card = node('article', 'provider-card');
    card.dataset.provider = definition.provider;
    const top = node('div', 'card-top');
    const avatar = node('span', 'provider-avatar', definition.mark);
    avatar.setAttribute('aria-hidden', 'true');
    const badge = node('span', 'state-pill', 'Checking…');
    badge.dataset.state = 'unknown';
    top.append(avatar, badge);
    const category = node('p', 'provider-category', definition.short);
    const title = node('h3', '', definition.label);
    title.id = `provider-${definition.id}`;
    card.setAttribute('aria-labelledby', title.id);
    const detail = node('p', 'provider-detail', definition.detail);
    const message = node('p', 'provider-message', 'Waiting for your local proxy…');
    const expiry = node('p', 'provider-expiry');
    let modelSettings, modelSelect, modelFeedback;
    if (['mimo', 'kimi'].includes(definition.provider)) {
      modelSettings = node('div', 'model-settings');
      const modelLabel = node('label', 'model-label', 'MODEL');
      modelLabel.htmlFor = `${definition.id}-model`;
      modelSelect = node('select', 'model-select');
      modelSelect.id = modelLabel.htmlFor;
      modelSelect.setAttribute('aria-label', `${definition.label} model`);
      modelSelect.setAttribute('aria-describedby', `${definition.id}-model-feedback`);
      modelFeedback = node('p', 'model-feedback', 'Saves automatically. Applies to new requests.');
      modelFeedback.id = `${definition.id}-model-feedback`;
      modelFeedback.setAttribute('role', 'status');
      modelSelect.addEventListener('change', () => saveModel(definition.id, modelSelect.value));
      modelSettings.append(modelLabel, modelSelect, modelFeedback);
    }
    const endpointLabel = node('label', 'endpoint-label', 'SILLYTAVERN ENDPOINT');
    endpointLabel.htmlFor = `endpoint-${definition.id}`;
    const endpointRow = node('div', 'endpoint-row');
    const endpoint = node('input', 'endpoint-input');
    endpoint.type = 'text';
    endpoint.id = endpointLabel.htmlFor;
    endpoint.readOnly = true;
    endpoint.placeholder = 'Waiting for URL';
    endpoint.setAttribute('aria-label', `${definition.label} endpoint URL`);
    endpoint.addEventListener('focus', () => endpoint.select());
    const copy = button('copy-button', 'Copy', async () => {
      if (!endpoint.value) return;
      try {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
        await navigator.clipboard.writeText(endpoint.value);
        copy.textContent = 'Copied!';
        notice(`${definition.label} endpoint copied. Paste it into SillyTavern’s custom endpoint.`);
        setTimeout(() => { copy.textContent = 'Copy'; }, 1800);
      } catch {
        endpoint.focus();
        endpoint.select();
        notice('The address is selected. Press Ctrl+C (or Command+C) to copy it.', true);
      }
    });
    copy.setAttribute('aria-label', `Copy ${definition.label} endpoint URL`);
    copy.disabled = true;
    endpointRow.append(endpoint, copy);
    const actions = node('div', 'card-actions');
    const login = button('button button-dark card-primary', 'Sign in', () => runAction(definition.id, 'login', login));
    const refresh = button('button button-outline card-refresh', 'Refresh session', () => runAction(definition.id, 'refresh', refresh));
    const reset = button('button button-quiet', 'Reset & sign in', () => confirmAction(definition.id, 'reset', reset));
    const logout = button('button button-quiet', 'Sign out', () => confirmAction(definition.id, 'logout', logout));
    const remove = button('button button-quiet card-remove', 'Remove', () => confirmAction(definition.id, 'remove', remove));
    remove.setAttribute('aria-label', `Remove ${definition.label}`);
    actions.append(login, refresh, reset, logout, remove);
    const hint = node('p', 'card-hint', definition.independentAccounts === false ? 'Argon shares this computer’s CLI sign-in.' : definition.legacy && definition.kind === 'cli'
      ? 'Uses your existing CLI account. Add another for a separate sign-in.' : 'Sign-in and settings belong to this connection.');
    card.append(top, category, title, detail, message, expiry);
    if (modelSettings) card.append(modelSettings);
    card.append(endpointLabel, endpointRow, actions, hint);
    elements['provider-grid'].append(card);
    cards.set(definition.id, { definition, card, badge, message, expiry, endpoint, copy, login, refresh, reset, logout, remove, modelSelect, modelFeedback });
    providers.set(definition.id, { ...definition, state: 'unknown' });
    updateCard(definition.id);
  }

  function updateCard(id) {
    const card = cards.get(id);
    const provider = providers.get(id);
    const state = Object.hasOwn(states, provider.state) ? provider.state : 'unknown';
    card.badge.dataset.state = statusStale ? 'unknown' : state;
    card.badge.textContent = statusStale ? 'Status unavailable' : provider.loginRunning ? 'Sign-in running' : states[state];
    card.message.textContent = typeof provider.message === 'string' && provider.message
      ? provider.message : 'This connection has not been verified yet.';
    const expires = provider.expiresAt ? new Date(provider.expiresAt) : null;
    card.expiry.textContent = expires && Number.isFinite(expires.getTime())
      ? `${state === 'expired' ? 'Expired' : 'Session expires'} ${expires.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : '';
    const endpoint = typeof provider.proxyUrl === 'string' ? provider.proxyUrl : '';
    if (card.endpoint.value !== endpoint) card.endpoint.value = endpoint;
    card.copy.disabled = !endpoint;
    const busy = Boolean(activeAction);
    const thisAction = activeAction?.id === id ? activeAction.action : null;
    if (card.modelSelect) {
      const selection = provider.modelSelection;
      const signature = JSON.stringify(selection?.options || []);
      if (card.modelOptions !== signature) {
        card.modelOptions = signature;
        const placeholder = node('option', '', 'Loading models…');
        placeholder.value = '';
        placeholder.disabled = true;
        card.modelSelect.replaceChildren(placeholder, ...(selection?.options || []).map(model => {
          const option = node('option', '', model.label);
          option.value = model.id;
          return option;
        }));
      }
      const placeholder = card.modelSelect.options[0];
      placeholder.textContent = !selection ? 'Loading models…' : selection.custom ? 'Custom model (from config)' : 'Choose a model';
      placeholder.hidden = Boolean(selection?.selected);
      if (thisAction !== 'model') card.modelSelect.value = selection?.selected || '';
      card.modelSelect.disabled = loading || busy || statusStale || !selection;
      card.modelSelect.setAttribute('aria-busy', String(thisAction === 'model'));
    }
    card.login.hidden = !provider.canLogin;
    card.login.disabled = busy || Boolean(provider.loginRunning);
    card.login.textContent = thisAction === 'login' ? 'Opening sign-in…' : provider.loginRunning ? 'Sign-in running…'
      : state === 'expired' ? 'Sign in again' : state === 'authenticated' ? 'Switch account' : 'Sign in';
    card.refresh.hidden = !provider.canRefresh;
    card.refresh.disabled = busy || Boolean(provider.loginRunning);
    card.refresh.textContent = thisAction === 'refresh' ? 'Refreshing…' : provider.kind === 'oauth' ? 'Refresh session' : 'Refresh status';
    card.reset.hidden = !provider.canReset;
    card.reset.disabled = busy || Boolean(provider.loginRunning);
    card.reset.textContent = thisAction === 'reset' ? 'Resetting…' : 'Reset & sign in';
    card.logout.hidden = provider.kind !== 'oauth' || ['missing', 'unknown', 'unavailable'].includes(state);
    card.logout.disabled = busy || Boolean(provider.loginRunning);
    card.logout.textContent = thisAction === 'logout' ? 'Signing out…' : 'Sign out';
    card.remove.disabled = busy || loading || statusStale || Boolean(provider.loginRunning);
    card.remove.textContent = thisAction === 'remove' ? 'Removing…' : 'Remove';
  }

  function updateControls() {
    for (const id of cards.keys()) updateCard(id);
    elements['refresh-all'].disabled = loading || Boolean(activeAction);
    elements['submit-code'].disabled = Boolean(activeAction);
    elements['check-login'].disabled = loading || Boolean(activeAction);
    elements['manual-code'].disabled = Boolean(activeAction);
    elements['add-provider'].disabled = loading || Boolean(activeAction) || statusStale || !catalog.length;
    elements['add-submit'].disabled = Boolean(activeAction);
    elements['add-submit'].textContent = activeAction?.action === 'add' ? 'Adding…' : 'Add connection';
    elements['add-close'].disabled = elements['add-cancel'].disabled = Boolean(activeAction);
    updateActivityControls();
  }

  async function saveModel(id, model) {
    if (loading || activeAction) return;
    const provider = providers.get(id);
    const card = cards.get(id);
    if (model === provider.modelSelection?.selected) return;
    activeAction = { id, action: 'model' };
    card.modelFeedback.dataset.tone = '';
    card.modelFeedback.textContent = 'Saving model…';
    updateControls();
    try {
      const result = await request(`/dashboard/api/providers/${encodeURIComponent(id)}/model`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model })
      });
      providers.get(id).modelSelection = result.modelSelection;
      card.modelFeedback.textContent = 'Saved. New requests use this model.';
    } catch (error) {
      card.modelFeedback.dataset.tone = 'error';
      card.modelFeedback.textContent = error.message;
      // A lost response may follow a successful save. Reconcile with the server
      // before offering another change; failed status checks disable the field.
      await refreshStatus();
    } finally {
      activeAction = null;
      updateControls();
    }
  }

  function updateActivityControls() {
    const busy = activityLoading || activityClearing || Boolean(activeAction);
    elements['refresh-activity'].disabled = busy;
    elements['clear-activity'].disabled = busy || !activityEntries.length;
    elements['clear-activity'].textContent = activityClearing ? 'Clearing…' : 'Clear history';
    elements['activity-panel'].setAttribute('aria-busy', String(activityLoading || activityClearing));
  }

  function activityState(state, title, description) {
    elements['activity-state'].dataset.state = state;
    elements['activity-state-title'].textContent = title;
    elements['activity-state-description'].textContent = description;
    elements['activity-state'].hidden = false;
  }

  function formatDuration(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—';
    if (value < 1000) return `${Math.round(value)} ms`;
    if (value < 60000) return `${(value / 1000).toFixed(1)} s`;
    const seconds = Math.floor(value / 1000);
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
    return `${Math.floor(seconds / 3600)}h ${String(Math.floor(seconds % 3600 / 60)).padStart(2, '0')}m`;
  }

  function activityCell(label, content, className = '') {
    const cell = node('td', `activity-cell ${className}`.trim());
    cell.setAttribute('role', 'cell');
    const mobileLabel = node('span', 'activity-mobile-label', label);
    mobileLabel.setAttribute('aria-hidden', 'true');
    cell.append(mobileLabel, content);
    return cell;
  }

  function renderActivity() {
    const rows = [];
    for (const entry of activityEntries) {
      const provider = activityProviders.get(entry.providerId) || { mark: '·', label: 'Removed connection' };
      const row = node('tr', 'activity-row');
      row.dataset.status = entry.status;
      row.setAttribute('role', 'row');
      const connection = node('div', 'activity-connection');
      const avatar = node('span', 'activity-avatar', provider.mark);
      avatar.setAttribute('aria-hidden', 'true');
      connection.append(avatar, node('span', '', provider.label));
      const started = typeof entry.startedAt === 'string' ? new Date(entry.startedAt) : null;
      const validDate = started && Number.isFinite(started.getTime());
      const time = node('time', 'activity-time', validDate
        ? started.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }) : 'Unavailable');
      if (validDate) {
        time.dateTime = started.toISOString();
        time.title = started.toLocaleString();
      }
      const duration = node('span', 'activity-duration', formatDuration(entry.durationMs));
      const delivery = node('span', 'activity-delivery', entry.streaming === true ? 'Streaming · SSE' : entry.streaming === false ? 'JSON' : '—');
      const result = node('div', 'activity-result');
      const badges = node('div', 'activity-result-badges');
      const badge = node('span', 'activity-status', activityStates[entry.status]);
      badge.dataset.status = entry.status;
      badges.append(badge);
      if (Number.isInteger(entry.httpStatus) && entry.httpStatus >= 100 && entry.httpStatus <= 599) {
        badges.append(node('span', 'activity-http', `HTTP ${entry.httpStatus}`));
      }
      result.append(badges);
      if (entry.status === 'error') {
        result.append(node('span', 'activity-error-category', Object.hasOwn(activityErrors, entry.errorCategory)
          ? activityErrors[entry.errorCategory] : 'Request failed'));
      }
      row.append(activityCell('Connection', connection, 'activity-provider-cell'), activityCell('Started', time),
        activityCell('Duration', duration), activityCell('Delivery', delivery), activityCell('Result', result));
      rows.push(row);
    }
    elements['activity-rows'].replaceChildren(...rows);
    elements['activity-table-wrap'].hidden = !rows.length;
    const running = activityEntries.filter(entry => entry.status === 'running').length;
    const summary = `${rows.length} recent ${rows.length === 1 ? 'request' : 'requests'}${running ? ` · ${running} running in this list` : ''}`;
    if (elements['activity-summary'].textContent !== summary) elements['activity-summary'].textContent = summary;
    if (rows.length) elements['activity-state'].hidden = true;
    else activityState('empty', 'No requests yet', 'Send a message through the proxy and its connection, timing, and transport status will appear here.');
    updateActivityControls();
  }

  async function refreshActivity() {
    if (activityLoading || activityClearing) return false;
    const requestedKey = proxyKey;
    activityLoading = true;
    if (!activityLoaded) activityState('loading', 'Loading recent activity', 'Checking your proxy’s in-memory request list…');
    updateActivityControls();
    try {
      const data = await request('/dashboard/api/activity', {}, 15000);
      if (requestedKey !== proxyKey) return false;
      if (!Array.isArray(data.requests)) throw new Error('Invalid activity response');
      activityEntries = data.requests.slice(0, 100).filter(entry => entry && typeof entry === 'object' &&
        typeof entry.providerId === 'string' && Object.hasOwn(activityStates, entry.status));
      activityLoaded = true;
      renderActivity();
      elements['activity-updated'].textContent = `Updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })} · Refreshes every 5 seconds.`;
      return true;
    } catch (error) {
      if (requestedKey !== proxyKey) return false;
      activityState('error', 'Activity is unavailable', error.needsKey
        ? 'Enter your proxy key above, then refresh activity.'
        : activityEntries.length ? 'Could not refresh. The requests shown below may be out of date. Try again.'
          : 'Could not load recent requests. Check that the proxy is running, then try again.');
      elements['activity-updated'].textContent = 'Activity could not be refreshed.';
      return false;
    } finally {
      activityLoading = false;
      updateActivityControls();
      if (requestedKey !== proxyKey) refreshActivity();
    }
  }

  async function clearActivity() {
    if (activityLoading || activityClearing || activeAction) return;
    activityClearing = true;
    updateActivityControls();
    let cleared = false;
    try {
      await request('/dashboard/api/activity/clear', { method: 'POST' }, 15000);
      activityEntries = [];
      activityLoaded = true;
      renderActivity();
      notice('Recent activity cleared. No requests were stopped.');
      cleared = true;
    } catch (error) {
      activityState('error', 'Could not confirm history was cleared', error.needsKey
        ? 'Enter your proxy key above, then refresh activity before retrying.'
        : 'Refresh activity to check the list before trying again. This action does not stop requests.');
    } finally {
      activityClearing = false;
      updateActivityControls();
    }
    if (cleared) await refreshActivity();
  }

  function refreshAfterKeyChange() {
    activityEntries = [];
    activityLoaded = false;
    elements['activity-rows'].replaceChildren();
    elements['activity-table-wrap'].hidden = true;
    elements['activity-summary'].textContent = 'Checking access to recent activity…';
    activityState('loading', 'Checking activity access', 'Waiting for an authorized status update.');
    refreshStatus();
    refreshActivity();
  }

  async function refreshStatus({ announce = false } = {}) {
    if (loading) return false;
    const requestedKey = proxyKey;
    loading = true;
    elements['provider-grid'].setAttribute('aria-busy', 'true');
    updateControls();
    try {
      const data = await request(`/dashboard/api/status${announce ? '?verify=1' : ''}`);
      if (requestedKey !== proxyKey) return false;
      if (!Array.isArray(data.providers)) throw new Error('The proxy returned an unexpected status response. Try refreshing.');
      statusStale = false;
      catalog = Array.isArray(data.catalog) ? data.catalog : [];
      const currentIds = new Set(data.providers.map(provider => provider.id));
      for (const [id, card] of cards) {
        if (!currentIds.has(id)) { card.card.remove(); cards.delete(id); providers.delete(id); }
      }
      for (const current of data.providers) {
        if (!cards.has(current.id)) renderCard(current);
        providers.set(current.id, current);
        activityProviders.set(current.id, current);
      }
      elements['connection-count'].textContent = `${providers.size} ${providers.size === 1 ? 'CONNECTION' : 'CONNECTIONS'}`;
      elements['connections-empty'].hidden = providers.size > 0;
      renderActivity();
      const values = [...providers.values()];
      const authenticated = values.filter(provider => provider.state === 'authenticated').length;
      const saved = values.filter(provider => provider.state === 'saved').length;
      elements['connection-summary'].textContent = `${authenticated} signed in${saved ? ` · ${saved} saved, unverified` : ''} · Account controls stay on this PC.`;
      elements['last-checked'].textContent = `Last checked ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
      if (noticeSource === 'status') elements.notice.hidden = true;
      if (announce) notice('Connection status refreshed. Saved credentials are not proof of a working provider session.');
      return true;
    } catch (error) {
      statusStale = true;
      elements['last-checked'].textContent = 'Could not refresh status';
      elements['connection-summary'].textContent = error.needsKey ? 'Enter your proxy key to see connection status.' : 'Status is unavailable. Previously displayed details may be out of date.';
      notice(error.message, true, 'status');
      return false;
    } finally {
      loading = false;
      elements['provider-grid'].setAttribute('aria-busy', 'false');
      updateControls();
      if (requestedKey !== proxyKey) refreshStatus();
    }
  }

  function confirmAction(id, action, trigger) {
    if (activeAction) return;
    const label = cards.get(id).definition.label;
    confirmation = { id, action, trigger };
    lastTrigger = trigger;
    elements['confirm-title'].textContent = action === 'remove' ? `Remove ${label}?` : action === 'reset' ? `Reset ${label}?` : `Sign out of ${label}?`;
    elements['confirm-description'].textContent = action === 'remove'
      ? 'This removes the card and disables its URL. Saved credentials stay on this computer, and running requests can finish. Adding this provider again creates a new account. Other connections are unaffected.'
      : action === 'reset' ? 'This clears this proxy account and starts a fresh sign-in. Other accounts are unaffected. No restart is needed.'
        : 'This clears this proxy account’s saved sign-in and disables its Claude Code fallback. Other accounts are unaffected. No restart is needed.';
    elements['confirm-accept'].textContent = action === 'remove' ? 'Remove connection' : action === 'reset' ? 'Reset and sign in' : 'Sign out';
    elements['confirm-dialog'].showModal();
  }

  function openSignInWindow() {
    try {
      const popup = window.open('about:blank', '_blank');
      if (popup) popup.opener = null;
      return popup;
    } catch { return null; }
  }

  function safeAuthorizationUrl(value) {
    const url = new URL(value);
    if (url.protocol !== 'https:') throw new Error('The proxy returned an unsafe sign-in URL.');
    return url.href;
  }

  function safeCallbackPath(value) {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin || !/^\/auth(?:\/[a-z0-9-]+)?\/callback$/.test(url.pathname) || url.search || url.hash) {
      throw new Error('The proxy returned an invalid sign-in callback.');
    }
    return url.pathname;
  }

  function beginLogin(id, result, popup) {
    const url = safeAuthorizationUrl(result.url);
    const callbackPath = safeCallbackPath(result.callbackPath);
    if (typeof result.state !== 'string' || !result.state) throw new Error('The proxy did not return a sign-in verification state.');
    loginFlow = { id, state: result.state, callbackPath, authGeneration: result.authGeneration };
    elements['login-title'].textContent = `Connect ${cards.get(id).definition.label}`;
    elements['login-description'].textContent = popup
      ? 'Complete sign-in in the provider’s window. If it gives you a code, paste it here.'
      : 'Your browser may have blocked the sign-in window. Open the page below, then complete sign-in or paste the code here.';
    elements['authorization-link'].href = url;
    elements['manual-code'].value = '';
    elements['login-feedback'].hidden = true;
    elements['login-dialog'].showModal();
    if (popup) {
      try { popup.location.replace(url); } catch { popup.close(); }
    }
  }

  async function runAction(id, action, trigger) {
    if (activeAction) return;
    lastTrigger = trigger;
    const provider = providers.get(id);
    const popup = provider.kind === 'oauth' && ['login', 'reset'].includes(action) ? openSignInWindow() : null;
    activeAction = { id, action };
    updateControls();
    try {
      const result = await request(`/dashboard/api/providers/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
      if (result.url) beginLogin(id, result, popup);
      else popup?.close();
      notice(typeof result.message === 'string' ? result.message : 'Account action completed.');
      await refreshStatus();
    } catch (error) {
      popup?.close();
      notice(error.message, true);
    } finally {
      activeAction = null;
      updateControls();
    }
  }

  function closeLogin() {
    if (activeAction?.action === 'callback') return;
    elements['login-dialog'].close();
  }

  elements['add-provider'].addEventListener('click', () => {
    if (activeAction || !catalog.length) return;
    lastTrigger = elements['add-provider'];
    elements['provider-options'].replaceChildren(...catalog.map((provider, index) => {
      const choice = node('label', 'provider-choice');
      const radio = node('input');
      radio.type = 'radio'; radio.name = 'provider'; radio.value = provider.id;
      radio.required = true; radio.checked = index === 0; radio.disabled = provider.canAdd === false;
      const mark = node('span', 'choice-mark', provider.mark);
      mark.setAttribute('aria-hidden', 'true');
      const copy = node('span', 'choice-copy', provider.label);
      if (provider.accountNote) copy.append(node('small', 'choice-note', provider.accountNote));
      choice.append(radio, mark, copy);
      return choice;
    }));
    elements['connection-name'].value = '';
    elements['add-feedback'].hidden = true;
    elements['add-dialog'].showModal();
  });
  for (const id of ['add-close', 'add-cancel']) elements[id].addEventListener('click', () => elements['add-dialog'].close());
  elements['add-dialog'].addEventListener('close', () => elements['add-provider'].focus());
  elements['add-dialog'].addEventListener('cancel', event => { if (activeAction) event.preventDefault(); });
  elements['add-form'].addEventListener('submit', async event => {
    event.preventDefault();
    if (activeAction) return;
    const provider = new FormData(elements['add-form']).get('provider');
    activeAction = { id: 'new', action: 'add' };
    updateControls();
    elements['add-feedback'].hidden = true;
    try {
      const result = await request('/dashboard/api/connections', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, label: elements['connection-name'].value.trim() })
      });
      elements['add-dialog'].close();
      notice(result.message);
      await refreshStatus();
      const card = cards.get(result.connection.id)?.card;
      if (card) { card.tabIndex = -1; card.focus(); }
    } catch (error) {
      elements['add-feedback'].textContent = error.message;
      elements['add-feedback'].hidden = false;
      await refreshStatus();
    } finally { activeAction = null; updateControls(); }
  });

  elements['key-toggle'].addEventListener('click', () => {
    const visible = elements['key-panel'].hidden;
    elements['key-panel'].hidden = !visible;
    elements['key-toggle'].setAttribute('aria-expanded', String(visible));
    if (visible) elements['proxy-key'].focus();
  });
  elements['key-form'].addEventListener('submit', event => {
    event.preventDefault();
    proxyKey = elements['proxy-key'].value;
    refreshAfterKeyChange();
  });
  elements['forget-key'].addEventListener('click', () => {
    proxyKey = '';
    elements['proxy-key'].value = '';
    notice('The proxy key has been forgotten in this tab.');
    refreshAfterKeyChange();
  });
  elements['dismiss-notice'].addEventListener('click', () => { elements.notice.hidden = true; });
  elements['refresh-all'].addEventListener('click', () => refreshStatus({ announce: true }));
  elements['refresh-activity'].addEventListener('click', refreshActivity);
  elements['clear-activity'].addEventListener('click', clearActivity);
  for (const id of ['confirm-close', 'confirm-cancel']) elements[id].addEventListener('click', () => elements['confirm-dialog'].close());
  elements['confirm-dialog'].addEventListener('close', () => {
    confirmation = null;
    lastTrigger?.focus();
  });
  elements['confirm-accept'].addEventListener('click', () => {
    const pending = confirmation;
    elements['confirm-dialog'].close();
    if (pending) runAction(pending.id, pending.action, pending.trigger);
  });
  elements['login-close'].addEventListener('click', closeLogin);
  elements['login-dialog'].addEventListener('cancel', event => {
    if (activeAction?.action === 'callback') event.preventDefault();
  });
  elements['login-dialog'].addEventListener('close', () => {
    loginFlow = null;
    elements['manual-code'].value = '';
    elements['authorization-link'].removeAttribute('href');
    lastTrigger?.focus();
  });
  elements['check-login'].addEventListener('click', async () => {
    const flow = loginFlow;
    if (!flow) return;
    const refreshed = await refreshStatus();
    if (loginFlow !== flow) return;
    const provider = providers.get(flow.id);
    if (refreshed && provider?.state === 'authenticated' && Number.isSafeInteger(flow.authGeneration) && provider.authGeneration > flow.authGeneration) {
      closeLogin();
      notice(`${cards.get(flow.id).definition.label} is signed in. You’re ready to chat.`);
    } else {
      elements['login-feedback'].textContent = refreshed ? 'Sign-in is not confirmed yet. Finish in the provider window, or paste the code above.' : 'Could not check sign-in. Check your proxy connection and access key.';
      elements['login-feedback'].hidden = false;
    }
  });
  elements['manual-code-form'].addEventListener('submit', async event => {
    event.preventDefault();
    if (!loginFlow || activeAction) return;
    const flow = loginFlow;
    const [code, pastedState] = elements['manual-code'].value.trim().split('#');
    if (!code) return;
    activeAction = { id: flow.id, action: 'callback' };
    elements['login-feedback'].textContent = 'Connecting your account…';
    elements['login-feedback'].hidden = false;
    updateControls();
    try {
      await request(flow.callbackPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, state: pastedState || flow.state }) });
      elements['login-dialog'].close();
      notice(`${cards.get(flow.id).definition.label} sign-in completed.`);
      await refreshStatus();
    } catch (error) {
      elements['login-feedback'].textContent = error.message;
    } finally {
      activeAction = null;
      updateControls();
    }
  });

  function canBackgroundRefresh() {
    return !document.hidden && !activeAction && !elements['login-dialog'].open &&
      !elements['confirm-dialog'].open && !elements['add-dialog'].open && !elements['key-panel'].contains(document.activeElement) &&
      ![...cards.values()].some(card => document.activeElement === card.modelSelect);
  }
  setInterval(() => { if (canBackgroundRefresh() && !loading) refreshStatus(); }, 15000);
  setInterval(() => { if (canBackgroundRefresh()) refreshActivity(); }, 5000);
  document.addEventListener('visibilitychange', () => {
    if (canBackgroundRefresh()) { refreshStatus(); refreshActivity(); }
  });
  refreshStatus();
  refreshActivity();
})();
