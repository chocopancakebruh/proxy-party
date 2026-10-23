const { JsonLineClient } = require('./JsonLineClient');
const { DEFAULT_MODEL: DEFAULT_KIMI_MODEL } = require('../KimiModels');
const { spawnProvider } = require('./process');
const { validateConversation, parseConfiguredArgs, timeoutMilliseconds, sendError, createLifecycle } = require('./common');

const KIMI_MODEL_HELP = 'Update or refresh the Kimi CLI model catalog, or add the model to this account\'s CLI config.toml. Custom Kimi adapters may need updated model entries.';

function checkKimiModel(session, model) {
  const picker = Array.isArray(session.configOptions) ? session.configOptions.find(option => option?.id === 'model') : undefined;
  let available;
  if (Array.isArray(picker?.options)) {
    // ACP supports flat choices and one level of named option groups.
    available = picker.options.flatMap(option => Array.isArray(option.options) ? option.options : [option])
      .map(option => option.value);
  } else if (Array.isArray(session.models?.availableModels)) {
    available = session.models.availableModels.map(option => option.modelId);
  }
  if (available && !available.includes(model)) {
    throw new Error(`The selected Kimi model is not available in this CLI's model catalog. ${KIMI_MODEL_HELP}`);
  }
}

function buildPrompt(provider, conversation) {
  if (provider === 'Kimi') {
    return [
      'You are the language-model backend for a SillyTavern conversation.',
      'Follow the supplied system instructions and conversation exactly. Do not use tools, inspect files, run commands, create tasks, or discuss being a coding assistant.',
      'The complete conversation is supplied below as JSON. Generate the next assistant reply.',
      JSON.stringify(conversation),
      'Return only the next assistant message. Do not add analysis, labels, XML tags, or commentary about these instructions.'
    ].join('\n\n');
  }
  return [
    'The complete conversation history is supplied below as JSON.',
    JSON.stringify({ messages: conversation.messages }),
    'Continue the conversation with the next assistant message only. Do not add labels, XML tags, or commentary about these instructions.'
  ].join('\n\n');
}

function grokSystemPrompt(conversation) {
  return [
    'You are the language-model backend for a SillyTavern conversation.',
    conversation.system ? `Follow these SillyTavern system instructions exactly:\n\n${conversation.system}`
      : 'Follow the supplied conversation and generate the next assistant reply.',
    'Do not use tools, inspect files, run commands, create tasks, or discuss being a coding assistant.',
    'Return only the next assistant message. Keep any deliberation in the ACP thought stream, separate from the final response.'
  ].join('\n\n');
}

function createAcpHandler(provider, dependencies) {
  const { config, Logger, os, randomUUID } = dependencies;
  const key = provider.toLowerCase();
  return async (req, res, body, requestedModel) => {
    let lifecycle;
    try {
      const conversation = validateConversation(body);
      if (req.aborted || res.destroyed) return;
      const model = provider === 'Kimi' ? requestedModel || config.kimi_model || DEFAULT_KIMI_MODEL : config.grok_model || 'grok-build';
      const command = config[`${key}_command`] || key;
      const args = parseConfiguredArgs(config[`${key}_args`], provider === 'Kimi' ? 'acp' : 'agent');
      if (provider === 'Grok') args.push('--model', model, 'stdio');
      const workDir = config[`${key}_work_dir`] || os.tmpdir();
      lifecycle = createLifecycle({
        req, res, body, provider, model, dependencies,
        messageId: `msg_${key}_${randomUUID().replace(/-/g, '')}`,
        timeoutMs: timeoutMilliseconds(config[`${key}_timeout_ms`])
      });
      const child = spawnProvider(command, args, {
        cwd: workDir,
        env: { ...dependencies.process.env, ...(provider === 'Kimi' ? { KIMI_DISABLE_CRON: '1' } : {}) }
      }, { ...dependencies, platform: dependencies.process.platform });
      lifecycle.setChild(child);
      let sessionId;
      const client = new JsonLineClient(child, {
        name: `${provider} ACP`, protocol: 'acp', onFatal: error => lifecycle.stop(error),
        onNotification(method, params) {
          if (method !== 'session/update' || params.sessionId !== sessionId) return;
          const update = params.update || {};
          if (['tool_call', 'tool_call_update'].includes(update.sessionUpdate)) {
            throw new Error(`${provider} attempted a tool operation in the chat session.`);
          }
          if (update.content?.type !== 'text') return;
          if (update.sessionUpdate === 'agent_thought_chunk') lifecycle.writeThinking(update.content.text);
          if (update.sessionUpdate === 'agent_message_chunk') lifecycle.writeText(update.content.text);
        }
      });
      lifecycle.setClient(client, () => {
        if (sessionId) client.notify('session/cancel', { sessionId });
      });
      await client.request('initialize', {
        protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } }
      });
      const session = await client.request('session/new', {
        cwd: workDir, mcpServers: [],
        ...(provider === 'Grok' ? { _meta: { systemPromptOverride: grokSystemPrompt(conversation) } } : {})
      });
      if (typeof session?.sessionId !== 'string' || !session.sessionId) {
        throw new Error(`${provider} returned an invalid session ID`);
      }
      sessionId = session.sessionId;
      if (provider === 'Kimi') {
        checkKimiModel(session, model);
        try {
          await client.request('session/set_config_option', { sessionId, configId: 'model', value: model });
        } catch (error) {
          // Older Kimi versions hide missing-model details behind -32603.
          // Explain this operation without exposing raw CLI paths or config.
          if (error.code === -32603 && /^internal error$/i.test(error.message)) {
            throw new Error(`Kimi CLI could not select the requested model. ${KIMI_MODEL_HELP}`);
          }
          throw error;
        }
      }
      lifecycle.check();
      lifecycle.startStream();
      const result = await client.request('session/prompt', {
        sessionId, prompt: [{ type: 'text', text: buildPrompt(provider, conversation) }]
      });
      await new Promise(resolve => setTimeout(resolve, 50));
      lifecycle.check();
      if (result?.stopReason === 'cancelled') throw new Error(`${provider} cancelled the generation`);
      lifecycle.respond(result?.stopReason === 'max_tokens' ? 'max_tokens' : 'end_turn');
    } catch (error) {
      if (lifecycle?.clientGone) return;
      if (lifecycle?.failure) error = lifecycle.failure;
      if (!error.httpStatus && (error.code === -32000 ||
          /not authenticated|authentication required|unauthorized|not logged in/i.test(error.message))) {
        error = new Error(`${provider} CLI is not logged in. Complete the CLI login and retry.`);
      }
      sendError(res, provider, error, Logger);
    } finally {
      await lifecycle?.cleanup();
    }
  };
}

module.exports = { createAcpHandler };
