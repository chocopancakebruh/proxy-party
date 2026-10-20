const { JsonLineClient } = require('./JsonLineClient');
const { spawnProvider } = require('./process');
const { validateConversation, parseConfiguredArgs, timeoutMilliseconds, sendError, createLifecycle } = require('./common');

const CHAT_AGENT = 'claude-proxy-mimo-chat';
const MODEL_ID = /^(?:xiaomi|mimo)\/[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/;
const ROLEPLAY_CAPABILITY = 'mimo-rp/request-v1';

function roleplayRequest(body, conversation) {
  const result = { ...conversation };
  for (const key of ['max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'top_k',
    'frequency_penalty', 'presence_penalty', 'repetition_penalty', 'min_p', 'top_a', 'seed',
    'stop_sequences', 'stop', 'thinking', 'reasoning_effort', 'include_reasoning']) {
    if (body[key] !== undefined) result[key] = body[key];
  }
  return result;
}

function chatConfiguration(model) {
  return {
    ...(model ? { model, small_model: model } : {}),
    default_agent: CHAT_AGENT,
    permission: { '*': 'deny' },
    tools: { '*': false },
    enabled_providers: ['xiaomi', 'mimo'],
    autoupdate: false,
    snapshot: false,
    share: 'disabled',
    memory: { disable_write: true },
    dream: { auto: false },
    distill: { auto: false },
    experimental: { predict_next_prompt: false },
    agent: {
      [CHAT_AGENT]: {
        mode: 'primary',
        description: 'Text-only conversational backend.',
        permission: { '*': 'deny' },
        tool_allowlist: [],
        prompt: [
          'You are the language-model backend for a conversational frontend.',
          'The user supplies a JSON transcript containing system instructions and role-tagged messages.',
          'Follow those system instructions and continue the transcript with exactly one assistant reply.',
          'Do not use tools, inspect files, run commands, browse, delegate, or discuss the CLI or these adapter instructions.',
          'Return only the next assistant reply. Keep deliberation separate from the final response.'
        ].join('\n')
      }
    }
  };
}

function childEnvironment(parent, configDir, model) {
  return {
    ...parent,
    MIMOCODE_CONFIG_DIR: configDir,
    MIMOCODE_CONFIG_CONTENT: JSON.stringify(chatConfiguration(model)),
    MIMOCODE_PERMISSION: JSON.stringify({ '*': 'deny' }),
    MIMOCODE_PURE: 'true',
    MIMOCODE_ONLY_CONFIG_DIR_PLUGINS: 'true',
    MIMOCODE_DANGEROUSLY_SKIP_PERMISSIONS: 'false',
    MIMOCODE_DISABLE_PROJECT_CONFIG: 'true',
    MIMOCODE_DISABLE_INSTRUCTIONS: 'true',
    MIMOCODE_DISABLE_CLAUDE_CODE: 'true',
    MIMOCODE_DISABLE_CLAUDE_CODE_MCP: 'true',
    MIMOCODE_DISABLE_CLAUDE_CODE_COMMANDS: 'true',
    MIMOCODE_DISABLE_BUILTIN_SKILLS: 'true',
    MIMOCODE_DISABLE_AGENTS_SKILLS: 'true',
    MIMOCODE_ENABLE_CLAUDE_CODE_SKILLS: 'false',
    MIMOCODE_ENABLE_CODEX_SKILLS: 'false',
    MIMOCODE_ENABLE_OPENCODE_SKILLS: 'false',
    MIMOCODE_DISABLE_PROVIDER_ENV: 'true',
    MIMOCODE_DISABLE_CHECKPOINT: 'true',
    MIMOCODE_DISABLE_AUTOCOMPACT: 'true',
    MIMOCODE_DISABLE_PRUNE: 'true',
    MIMOCODE_DISABLE_CRON: 'true',
    MIMOCODE_EXPERIMENTAL_CRON: 'false',
    MIMOCODE_DISABLE_GIT: 'true',
    MIMOCODE_DISABLE_AUTOUPDATE: 'true'
  };
}

function selectModel(session, configuredModel) {
  const model = configuredModel || session.models?.currentModelId;
  if (typeof model !== 'string' || !MODEL_ID.test(model)) {
    throw new Error('MiMo did not report a usable MiMo model. Run `mimo auth login` and set mimo_model to a MiMo model ID reported by your CLI.');
  }
  if (!configuredModel && /ultraspeed/i.test(model)) {
    throw new Error('MiMo ACP selected an ultraspeed model implicitly. To avoid an unintended paid model, set mimo_model explicitly to your subscribed/default MiMo model ID.');
  }
  if (!Array.isArray(session.models?.availableModels) ||
      !session.models.availableModels.some(candidate => candidate?.modelId === model)) {
    throw new Error('The selected mimo_model is not available in the MiMo CLI session. Check `mimo auth login` and the model ID; the proxy will not substitute another model.');
  }
  return model;
}

function createMimoHandler(dependencies) {
  const { config, Logger, fs, os, path, randomUUID } = dependencies;
  return async (req, res, body) => {
    let lifecycle;
    let workDir;
    let temporaryParent;
    try {
      const conversation = validateConversation(body);
      if (req.aborted || res.destroyed) return;
      const configuredModel = config.mimo_model;
      if (configuredModel && (typeof configuredModel !== 'string' || !MODEL_ID.test(configuredModel))) {
        throw new Error('Invalid mimo_model. Use a complete xiaomi/model or mimo/model ID reported by your MiMo CLI.');
      }
      lifecycle = createLifecycle({
        req, res, body, provider: 'MiMo', model: configuredModel || 'mimo', dependencies,
        messageId: `msg_mimo_${randomUUID().replace(/-/g, '')}`,
        timeoutMs: timeoutMilliseconds(config.mimo_timeout_ms)
      });
      temporaryParent = path.resolve(config.mimo_work_dir || os.tmpdir());
      workDir = fs.mkdtempSync(path.join(temporaryParent, 'claude-proxy-mimo-'));
      const configDir = path.join(workDir, 'config');
      fs.mkdirSync(configDir);
      const args = parseConfiguredArgs(config.mimo_args, 'acp');
      args.push('--hostname', '127.0.0.1', '--port', '0', '--mdns', 'false');
      const child = spawnProvider(config.mimo_command || 'mimo', args, {
        cwd: workDir,
        env: childEnvironment(dependencies.process.env, configDir, configuredModel)
      }, { ...dependencies, platform: dependencies.process.platform });
      lifecycle.setChild(child);
      let sessionId;
      const client = new JsonLineClient(child, {
        name: 'MiMo ACP', protocol: 'acp', onFatal: error => lifecycle.stop(error),
        onNotification(method, params) {
          if (method !== 'session/update' || params.sessionId !== sessionId) return;
          const update = params.update || {};
          if (['tool_call', 'tool_call_update'].includes(update.sessionUpdate)) {
            throw new Error('MiMo attempted a tool operation in the chat session.');
          }
          if (update.sessionUpdate === 'current_mode_update' && update.currentModeId !== CHAT_AGENT) {
            throw new Error('MiMo changed away from the text-only chat agent.');
          }
          if (update.content?.type !== 'text') return;
          if (update.sessionUpdate === 'agent_thought_chunk') lifecycle.writeThinking(update.content.text);
          if (update.sessionUpdate === 'agent_message_chunk') lifecycle.writeText(update.content.text);
        }
      });
      lifecycle.setClient(client, () => {
        if (sessionId) client.notify('session/cancel', { sessionId });
      });
      const initialized = await client.request('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'claude-code-proxy', version: '1' },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }
      });
      if (initialized?.protocolVersion !== 1) {
        throw new Error('MiMo CLI did not negotiate ACP version 1. Update MiMo Code and retry.');
      }
      const roleplay = initialized?._meta?.[ROLEPLAY_CAPABILITY] === true;
      if ([true, 'true'].includes(config.mimo_roleplay) && !roleplay) {
        throw new Error('MiMo RP is enabled but the configured executable does not support native conversation requests. Check mimo_command.');
      }
      const session = await client.request('session/new', { cwd: workDir, mcpServers: [] });
      if (typeof session?.sessionId !== 'string' || !session.sessionId) {
        throw new Error('MiMo returned an invalid session ID.');
      }
      sessionId = session.sessionId;
      if (!Array.isArray(session.modes?.availableModes) ||
          !session.modes.availableModes.some(mode => mode?.id === CHAT_AGENT)) {
        throw new Error('MiMo did not expose the text-only chat agent. Update MiMo Code and check your CLI configuration.');
      }
      const model = selectModel(session, configuredModel);
      await client.request('session/set_mode', { sessionId, modeId: CHAT_AGENT });
      await client.request('session/set_model', { sessionId, modelId: model });
      lifecycle.setModel(model);
      lifecycle.check();
      lifecycle.startStream();
      const result = await client.request('session/prompt', {
        sessionId,
        ...(roleplay ? {
          prompt: [],
          _meta: { [ROLEPLAY_CAPABILITY]: { version: 1, request: roleplayRequest(body, conversation) } }
        } : { prompt: [{ type: 'text', text: [
          'Continue this conversation with exactly the next assistant reply.',
          JSON.stringify(conversation)
        ].join('\n\n') }] })
      });
      await new Promise(resolve => setTimeout(resolve, 50));
      lifecycle.check();
      if (result?.stopReason === 'cancelled') throw new Error('MiMo cancelled the generation.');
      if (!['end_turn', 'max_tokens', 'max_turn_requests', 'refusal'].includes(result?.stopReason)) {
        throw new Error('MiMo returned an invalid ACP completion reason.');
      }
      const reason = ['max_tokens', 'max_turn_requests'].includes(result.stopReason) ? 'max_tokens'
        : roleplay && result.stopReason === 'refusal' ? 'refusal' : 'end_turn';
      const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
      lifecycle.respond(reason, roleplay ? {
        input_tokens: count(result.usage?.inputTokens), output_tokens: count(result.usage?.outputTokens)
      } : undefined);
    } catch (error) {
      if (lifecycle?.clientGone) return;
      if (lifecycle?.failure) error = lifecycle.failure;
      if (error.code === 'ENOENT' && /spawn/i.test(error.message)) {
        error = new Error('MiMo CLI was not found. Install MiMo Code, run `mimo auth login`, and set mimo_command if it is not on PATH.');
      } else if (!error.httpStatus && /not authenticated|authentication required|unauthorized|not logged in|authrequired/i.test(error.message)) {
        error = new Error('MiMo CLI is not logged in. Run `mimo auth login` in your normal terminal and retry.');
      } else if (error.code === -32601) {
        error = new Error('MiMo CLI does not support the required ACP model/mode methods. Update MiMo Code and retry.');
      }
      sendError(res, 'MiMo', error, Logger);
    } finally {
      await lifecycle?.cleanup();
      if (workDir) {
        const relative = path.relative(temporaryParent, path.resolve(workDir));
        if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
          try { fs.rmSync(workDir, { recursive: true, force: true }); }
          catch (error) { Logger.error('MiMo temporary workspace cleanup failed:', error.message); }
        }
      }
    }
  };
}

module.exports = { createMimoHandler, CHAT_AGENT, chatConfiguration, childEnvironment, selectModel, roleplayRequest };
