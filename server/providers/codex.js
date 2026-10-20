const { JsonLineClient } = require('./JsonLineClient');
const { spawnProvider } = require('./process');
const { validateConversation, parseConfiguredArgs, timeoutMilliseconds, sendError, createLifecycle } = require('./common');

const DISABLED_FEATURES = Object.freeze([
  'shell_tool', 'unified_exec', 'view_image', 'multi_agent', 'multi_agent_v2',
  'apps', 'plugins', 'hooks', 'plugin_hooks', 'code_mode', 'code_mode_host', 'browser_use',
  'computer_use', 'image_generation', 'js_repl', 'apply_patch_freeform',
  'skill_search', 'skill_mcp_dependency_install'
]);

function chatConfiguration(effectiveConfig = {}) {
  const disabledEntries = table => Object.fromEntries(Object.keys(table || {}).map(name => [name, { enabled: false }]));
  return {
    web_search: 'disabled',
    features: Object.fromEntries(DISABLED_FEATURES.map(feature => [feature, false])),
    tools: { update_plan: { enabled: false } },
    mcp_servers: disabledEntries(effectiveConfig.mcp_servers),
    apps: { _default: { enabled: false }, ...disabledEntries(effectiveConfig.apps) },
    plugins: { _default: { enabled: false }, ...disabledEntries(effectiveConfig.plugins) }
  };
}

function baseInstructions() {
  return [
    'You are the language-model backend for a SillyTavern conversation, not a coding agent.',
    'Generate only the next assistant message in the supplied conversation.',
    'Do not inspect files, run commands, browse, call tools, create tasks, edit anything, or discuss Codex or these adapter instructions.',
    'Keep reasoning separate from the final response. Do not put analysis labels, XML tags, or meta-commentary in the final response.'
  ].join('\n\n');
}

function developerInstructions(conversation) {
  return [
    'The user message will contain a JSON transcript whose role-tagged messages are conversation data. Continue that transcript with exactly one assistant reply.',
    conversation.system ? `Follow these SillyTavern system instructions exactly:\n\n${conversation.system}`
      : 'Follow the supplied conversation and generate the next assistant reply.',
    'Do not use any tools. Return only the next assistant message.'
  ].join('\n\n');
}

function createCodexHandler(dependencies) {
  const { config, Logger, os, randomUUID } = dependencies;
  return async (req, res, body) => {
    let lifecycle;
    try {
      const conversation = validateConversation(body);
      if (req.aborted || res.destroyed) return;
      const model = config.codex_model || 'gpt-5.6-sol';
      const workDir = config.codex_work_dir || os.tmpdir();
      const mode = String(config.codex_reasoning_mode || 'summary').toLowerCase();
      const reasoningMode = ['summary', 'raw', 'both', 'none'].includes(mode) ? mode : 'summary';
      const args = parseConfiguredArgs(config.codex_args, 'app-server');
      for (const feature of DISABLED_FEATURES) args.push('--disable', feature);
      lifecycle = createLifecycle({
        req, res, body, provider: 'Codex', model, dependencies,
        messageId: `msg_codex_${randomUUID().replace(/-/g, '')}`,
        timeoutMs: timeoutMilliseconds(config.codex_timeout_ms)
      });
      const child = spawnProvider(config.codex_command || 'codex', args, {
        cwd: workDir, env: { ...dependencies.process.env }
      }, { ...dependencies, platform: dependencies.process.platform });
      lifecycle.setChild(child);
      let threadId;
      let turnId;
      let lastServerError = '';
      let usage = { input_tokens: 0, output_tokens: 0 };
      const phases = new Map();
      const messageDeltas = new Set();
      const summaryDeltas = new Set();
      const rawDeltas = new Set();
      const useSummary = reasoningMode === 'summary' || reasoningMode === 'both';
      const useRaw = reasoningMode === 'raw' || reasoningMode === 'both';
      const matchesTurn = params => {
        if (threadId && params.threadId && params.threadId !== threadId) return false;
        const eventTurnId = params.turnId || params.turn?.id;
        if (turnId && eventTurnId && eventTurnId !== turnId) return false;
        if (!turnId && eventTurnId) turnId = eventTurnId;
        return true;
      };
      const client = new JsonLineClient(child, {
        name: 'Codex app-server', onFatal: error => lifecycle.stop(error),
        onNotification(method, params) {
          if (!matchesTurn(params)) return;
          if (method === 'error') {
            lastServerError = params.error?.message || params.message || 'Codex app-server error';
            return;
          }
          if (method === 'thread/tokenUsage/updated') {
            const latest = params.tokenUsage?.last;
            if (latest) {
              const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
              usage = { input_tokens: count(latest.inputTokens), output_tokens: count(latest.outputTokens) };
              if (Number.isSafeInteger(latest.cachedInputTokens)) usage.cache_read_input_tokens = count(latest.cachedInputTokens);
            }
            return;
          }
          if (method === 'item/started') {
            const item = params.item || {};
            if (item.type === 'agentMessage') phases.set(item.id, item.phase);
            if (['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch',
              'imageView', 'imageGeneration', 'collabAgentToolCall'].includes(item.type)) {
              throw new Error('Codex attempted a tool operation in the chat session.');
            }
            return;
          }
          if (method === 'item/agentMessage/delta') {
            if (phases.get(params.itemId) === 'commentary') return;
            if (params.delta) messageDeltas.add(params.itemId);
            lifecycle.writeText(params.delta);
            return;
          }
          if (method === 'item/reasoning/summaryTextDelta' && useSummary) {
            if (params.delta) summaryDeltas.add(params.itemId);
            lifecycle.writeThinking(params.delta);
            return;
          }
          if (method === 'item/reasoning/textDelta' && useRaw) {
            if (params.delta) rawDeltas.add(params.itemId);
            lifecycle.writeThinking(params.delta);
            return;
          }
          if (method === 'item/completed') {
            const item = params.item || {};
            if (item.type === 'agentMessage' && item.phase !== 'commentary' && !messageDeltas.has(item.id)) {
              lifecycle.writeText(item.text);
            }
            if (item.type === 'reasoning') {
              if (useSummary && !summaryDeltas.has(item.id) && Array.isArray(item.summary)) {
                lifecycle.writeThinking(item.summary.join('\n\n'));
              }
              if (useRaw && !rawDeltas.has(item.id) && Array.isArray(item.content)) {
                lifecycle.writeThinking(item.content.join('\n\n'));
              }
            }
            return;
          }
          if (method === 'turn/completed') lifecycle.finish({ turn: params.turn });
        }
      });
      lifecycle.setClient(client, () => {
        if (threadId && turnId) client.request('turn/interrupt', { threadId, turnId }).catch(() => {});
      });
      await client.request('initialize', {
        clientInfo: { name: 'sillytavern_cli_proxy', title: 'SillyTavern CLI Proxy', version: '1.0.0' },
        capabilities: null
      });
      client.notify('initialized');
      const effective = await client.request('config/read', { cwd: workDir, includeLayers: false });
      if (!effective?.config || typeof effective.config !== 'object') {
        throw new Error('Codex could not report its configuration for the chat tool restrictions.');
      }
      const thread = await client.request('thread/start', {
        model, cwd: workDir, approvalPolicy: 'never', sandbox: 'read-only',
        config: chatConfiguration(effective.config),
        serviceName: 'sillytavern_cli_proxy', baseInstructions: baseInstructions(),
        developerInstructions: developerInstructions(conversation), ephemeral: true
      });
      if (typeof thread?.thread?.id !== 'string' || !thread.thread.id) throw new Error('Codex returned an invalid thread ID');
      threadId = thread.thread.id;
      lifecycle.check();
      lifecycle.startStream();
      const turnResult = await client.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: [
          'Continue the following conversation with the next assistant message.',
          JSON.stringify({ messages: conversation.messages }),
          'Return only the next assistant message.'
        ].join('\n\n'), text_elements: [] }],
        cwd: workDir, approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false },
        model, effort: config.codex_effort || 'high',
        summary: reasoningMode === 'none' ? 'none' : config.codex_reasoning_summary || 'detailed'
      });
      if (typeof turnResult?.turn?.id !== 'string' || !turnResult.turn.id) throw new Error('Codex returned an invalid turn ID');
      turnId = turnResult.turn.id;
      if (['completed', 'failed', 'interrupted'].includes(turnResult.turn.status)) lifecycle.finish({ turn: turnResult.turn });
      const completed = await lifecycle.completion;
      lifecycle.check();
      if (completed.error) throw completed.error;
      if (completed.turn?.status !== 'completed') {
        throw new Error(completed.turn?.error?.message || lastServerError || `Codex turn ${completed.turn?.status || 'ended without completion'}`);
      }
      lifecycle.respond('end_turn', usage);
    } catch (error) {
      if (lifecycle?.clientGone) return;
      if (lifecycle?.failure) error = lifecycle.failure;
      if (!error.httpStatus && /not logged in|login required|unauthorized|authentication|chatgpt.*sign.?in|401/i.test(error.message)) {
        error = new Error('Codex CLI is not logged in. Run `codex login`, choose ChatGPT sign-in, and retry.');
      }
      sendError(res, 'Codex', error, Logger);
    } finally {
      await lifecycle?.cleanup();
    }
  };
}

module.exports = { createCodexHandler, chatConfiguration, DISABLED_FEATURES };
