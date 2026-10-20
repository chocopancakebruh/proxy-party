const { JsonLineClient } = require('./JsonLineClient');
const { spawnProvider } = require('./process');
const { validateConversation, timeoutMilliseconds, sendError, createLifecycle } = require('./common');

const MUSE_ARGS = Object.freeze([
  'serve', '--provider', 'meta', '--no-session-log', '--disable-write', '--disable-shell',
  '--disable-request-user-input', '--sandbox-network', 'restricted', '--contributor-mode', 'off',
  '-c', 'run.toolset=[]', '-c', 'run.reminder_roster.agents=[]',
  '-c', 'context.foreign_personal_rules=false', '-c', 'context.foreign_personal_skills=false',
  '-c', 'local_session_messaging.enabled=false', '-c', 'telemetry.enabled=false',
  '-c', 'feature_config.enabled=false'
]);

function commandId(randomUUID) {
  const random = randomUUID();
  const timestamp = Date.now().toString(16).padStart(12, '0');
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7${random.slice(15, 18)}-${random.slice(19)}`;
}

function validateInitialization(result) {
  const version = /^(\d+)\.(\d+)\.(\d+)/.exec(result?.serverInfo?.version || '');
  if (result?.serverInfo?.name !== 'muse' || result?.schema?.version !== 1 ||
      result?.sessionDurability !== 'ephemeral' || !version ||
      Number(version[1]) < 1 || (Number(version[1]) === 1 &&
        (Number(version[2]) < 4 || (Number(version[2]) === 4 && Number(version[3]) < 10)))) {
    throw new Error('Muse requires Muse Code 1.4.10 or newer with MSP v1 and memory-only sessions.');
  }
}

function createMuseHandler(dependencies) {
  const { config, Logger, fs, os, path, randomUUID } = dependencies;
  return async (req, res, body) => {
    let lifecycle;
    let workspace;
    let temporaryRoot;
    try {
      const conversation = validateConversation(body);
      if (req.aborted || res.destroyed) return;
      const model = config.muse_model || 'muse';
      const reasoningMode = config.muse_reasoning_mode || 'summary';
      if (!['summary', 'raw', 'both', 'none'].includes(reasoningMode)) {
        throw new Error('muse_reasoning_mode must be summary, raw, both, or none.');
      }
      if (config.muse_effort && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(config.muse_effort)) {
        throw new Error('muse_effort is not a supported reasoning effort.');
      }
      temporaryRoot = path.resolve(os.tmpdir());
      const created = fs.mkdtempSync(path.join(temporaryRoot, 'claude-proxy-muse-'));
      if (path.dirname(path.resolve(created)) !== temporaryRoot ||
          !path.basename(created).startsWith('claude-proxy-muse-')) {
        throw new Error('Muse temporary workspace is outside the expected directory.');
      }
      workspace = created;
      lifecycle = createLifecycle({
        req, res, body, provider: 'Muse', model, dependencies,
        messageId: `msg_muse_${randomUUID().replace(/-/g, '')}`,
        timeoutMs: timeoutMilliseconds(config.muse_timeout_ms)
      });
      const env = { ...dependencies.process.env, MUSE_NO_AUTO_UPDATE: '1', MUSE_LOGIN: '0' };
      delete env.MUSE_TRANSPORT_TRACE;
      const child = spawnProvider(config.muse_command || 'muse', [...MUSE_ARGS], {
        cwd: workspace, env
      }, { ...dependencies, platform: dependencies.process.platform });
      lifecycle.setChild(child);
      const sessionId = commandId(randomUUID);
      let turnId;
      let turnSubmitted = false;
      let turnFinished = false;
      let pendingEvents = [];
      let pendingSize = 0;
      let outputSize = 0;
      let usage = { input_tokens: 0, output_tokens: 0 };
      const items = new Map();
      const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
      const updateUsage = value => {
        if (!value || typeof value !== 'object') return;
        usage = { input_tokens: count(value.inputTokens), output_tokens: count(value.outputTokens) };
        if (Number.isSafeInteger(value.cacheReadTokens)) usage.cache_read_input_tokens = count(value.cacheReadTokens);
        if (Number.isSafeInteger(value.cacheWriteTokens)) usage.cache_creation_input_tokens = count(value.cacheWriteTokens);
      };
      const fieldType = (item, field, completed) => {
        if (item.kind === 'agentMessage' && field === 'text' &&
            (item.messagePhase === 'finalAnswer' || (completed && item.messagePhase == null))) return 'text';
        if (item.kind !== 'reasoning') return null;
        if (/^summary\.\d+$/.test(field) && ['summary', 'both'].includes(reasoningMode)) return 'thinking';
        if (field === 'text' && ['raw', 'both'].includes(reasoningMode)) return 'thinking';
        return null;
      };
      const emitField = (state, field, value, completed) => {
        if (typeof value !== 'string') throw new Error('Muse sent invalid item text.');
        const kind = fieldType(state.item, field, completed);
        if (!kind) return;
        const previous = state.emitted.get(field) || '';
        if (!value.startsWith(previous)) throw new Error('Muse replaced text already sent to the client.');
        const suffix = value.slice(previous.length);
        if (kind === 'text') lifecycle.writeText(suffix);
        else lifecycle.writeThinking(suffix);
        state.emitted.set(field, value);
      };
      const onNotification = (method, params) => {
        if (params.sessionId !== sessionId || turnFinished) return;
        if (method === 'approval/requested' || method === 'approval/request') {
          const denial = params.availableChoices?.find(choice => choice.decision === 'denied' && choice.scope === 'once');
          if (denial && params.currentRequirementId && typeof params.approvalId === 'string') {
            client.request('approval/decide', {
              sessionId, approvalId: params.approvalId, requirementId: params.currentRequirementId,
              choiceId: denial.choiceId, commandId: commandId(randomUUID)
            }).catch(() => {});
          }
          lifecycle.stop(new Error('Muse requested a tool approval in a chat-only session.'));
          return;
        }
        if (!turnSubmitted) return;
        if (!turnId) {
          pendingSize += JSON.stringify(params).length;
          if (pendingSize > 16 * 1024 * 1024) throw new Error('Muse startup events exceeded the proxy limit.');
          pendingEvents.push([method, params]);
          return;
        }
        if (params.turnId && params.turnId !== turnId) return;
        if (method === 'view/gap') throw new Error('Muse dropped response events; retry the request.');
        if (method === 'userInput/requested') throw new Error('Muse requested interactive input in a chat-only session.');
        if (method === 'session/tokenUsage') { updateUsage(params.usage); return; }
        if (method === 'turn/completed') {
          if (params.turnId !== turnId) return;
          updateUsage(params.usage);
          turnFinished = true;
          lifecycle.finish({ turn: params });
          return;
        }
        if (['item/started', 'item/updated', 'item/completed'].includes(method)) {
          const item = params.item;
          if (!item || typeof item.itemId !== 'string' || typeof item.kind !== 'string') {
            throw new Error('Muse sent an invalid transcript item.');
          }
          if (item.turnId !== turnId) return;
          if (['toolCall', 'userShell', 'subagent', 'workflow', 'sideChat', 'webSearch', 'monitorFeed'].includes(item.kind)) {
            throw new Error('Muse attempted a tool operation in a chat-only session.');
          }
          if (!['agentMessage', 'reasoning'].includes(item.kind)) return;
          if (items.size >= 10000 && !items.has(item.itemId)) throw new Error('Muse sent too many transcript items.');
          const state = items.get(item.itemId) || { item, revision: 0, fields: new Map(), emitted: new Map() };
          if (!Number.isSafeInteger(item.revision) || item.revision < 1) throw new Error('Muse sent an invalid item revision.');
          if (item.revision <= state.revision) return;
          state.item = item;
          state.revision = item.revision;
          items.set(item.itemId, state);
          const completed = method === 'item/completed';
          if (completed && (item.cutOff || item.truncated || item.status !== 'completed')) {
            throw new Error('Muse returned an incomplete transcript item.');
          }
          const fields = [['text', item.text ?? '']];
          if (item.summary !== undefined && (!Array.isArray(item.summary) || item.summary.some(value => typeof value !== 'string'))) {
            throw new Error('Muse sent invalid reasoning summaries.');
          }
          for (const [index, value] of (item.summary || []).entries()) fields.push([`summary.${index}`, value]);
          for (const [field, value] of fields) {
            if (completed || !state.fields.has(field)) {
              state.fields.set(field, value);
              emitField(state, field, value, completed);
            }
          }
          state.completed = completed;
          return;
        }
        if (method === 'item/delta') {
          const state = items.get(params.itemId);
          if (!state || state.completed) return;
          if (typeof params.delta !== 'string') throw new Error('Muse sent an invalid text delta.');
          outputSize += params.delta.length;
          if (outputSize > 64 * 1024 * 1024) throw new Error('Muse output exceeded the proxy limit.');
          const field = params.field ?? 'text';
          if (field !== 'text' && !/^summary\.\d+$/.test(field)) return;
          const value = (state.fields.get(field) || '') + params.delta;
          state.fields.set(field, value);
          emitField(state, field, value, false);
        }
      };
      const client = new JsonLineClient(child, {
        name: 'Muse MSP', protocol: 'acp', onNotification,
        onFatal: error => lifecycle.stop(error)
      });
      lifecycle.setClient(client, () => {
        if (turnSubmitted && !turnFinished) client.request('turn/cancel', {
          sessionId, ...(turnId ? { turnId } : {}), commandId: commandId(randomUUID)
        }).catch(() => {});
      });
      const initialized = await client.request('initialize', {
        clientInfo: { name: 'sillytavern_cli_proxy', version: '1.0.0' },
        capabilities: { experimentalApi: false, requestedCapabilities: [], userInputDialogs: false }
      });
      validateInitialization(initialized);
      client.notify('initialized');
      const started = await client.request('session/start', {
        sessionId, commandId: commandId(randomUUID), workspaceRoot: workspace,
        providerId: 'meta', approvalMode: 'denyUnmatched',
        ...(config.muse_model ? { modelId: config.muse_model } : {})
      });
      if (started?.session?.sessionId !== sessionId || started.session.path !== '' ||
          started.session.approvalMode?.mode !== 'denyUnmatched') {
        throw new Error('Muse did not establish the requested fresh, restricted session.');
      }
      if (started.session.providerId !== 'meta' || typeof started.session.modelId !== 'string' ||
          !started.session.modelId || (config.muse_model && started.session.modelId !== config.muse_model)) {
        throw new Error('Muse did not select the requested Meta provider and model.');
      }
      lifecycle.setModel(started.session.modelId);
      lifecycle.check();
      lifecycle.startStream();
      turnSubmitted = true;
      const accepted = await client.request('turn/start', {
        sessionId, commandId: commandId(randomUUID),
        input: [{ type: 'text', text: [
          'Continue this text conversation with exactly one assistant reply. Do not use tools or inspect the environment.',
          'The JSON below contains the system instructions and the conversation messages to continue.',
          JSON.stringify(conversation)
        ].join('\n\n') }],
        ...(config.muse_effort ? { reasoningEffort: config.muse_effort } : {})
      });
      if (accepted?.status !== 'accepted' || accepted.disposition !== 'started' ||
          typeof accepted.turnId !== 'string' || !accepted.turnId) {
        throw new Error('Muse did not accept a fresh conversation turn.');
      }
      turnId = accepted.turnId;
      const buffered = pendingEvents;
      pendingEvents = [];
      for (const [method, params] of buffered) onNotification(method, params);
      const completed = await lifecycle.completion;
      lifecycle.check();
      if (completed.error) throw completed.error;
      if (completed.turn?.terminal !== 'completed') {
        const error = new Error(completed.turn?.error?.kind === 'authRequired'
          ? 'Muse Code is not signed in. Run `muse` and sign in, then retry.'
          : `Muse turn ${completed.turn?.terminal || 'failed'}${completed.turn?.error?.kind ? ` (${completed.turn.error.kind})` : ''}.`);
        throw error;
      }
      if ([...items.values()].some(state => !state.completed)) {
        throw new Error('Muse ended the turn without completing its response items.');
      }
      lifecycle.respond('end_turn', usage);
    } catch (error) {
      if (lifecycle?.clientGone) return;
      error = lifecycle?.failure || error;
      if (error.code === 'ENOENT') {
        error = new Error('Muse Code could not be started. Install Muse Code 1.4.10 or newer, run `muse` to sign in, and set muse_command if it is not on PATH.');
      }
      sendError(res, 'Muse', error, Logger);
    } finally {
      await lifecycle?.cleanup();
      if (workspace) {
        try {
          if (path.dirname(path.resolve(workspace)) !== temporaryRoot ||
              !path.basename(workspace).startsWith('claude-proxy-muse-')) {
            throw new Error('Invalid temporary workspace');
          }
          fs.rmSync(workspace, { recursive: true, force: true });
        }
        catch { Logger.error('Muse temporary workspace could not be removed.'); }
      }
    }
  };
}

module.exports = { createMuseHandler, MUSE_ARGS, commandId };
