const { startAnthropicStream, writeAnthropicEvent } = require('./AnthropicStream');
const { stopProcess } = require('./process');
const { validateConversation } = require('./common');

function createArgonHandler(dependencies = {}) {
  const config = dependencies.config || {};
  const Logger = dependencies.Logger || require('../Logger');
  const fs = dependencies.fs || require('node:fs');
  const os = dependencies.os || require('node:os');
  const path = dependencies.path || require('node:path');
  const spawn = dependencies.spawn || require('node:child_process').spawn;
  const randomUUID = dependencies.randomUUID || require('node:crypto').randomUUID;
  const readArgonThinking = dependencies.readArgonThinking || require('../ArgonThinking').readArgonThinking;
  const process = dependencies.process || globalThis.process;
  const setInterval = dependencies.setInterval || globalThis.setInterval;
  const clearInterval = dependencies.clearInterval || globalThis.clearInterval;

  function buildArgonAgent(system, agentName) {
    return [
      '---',
      `name: ${agentName}`,
      'description: Conversation backend for the local SillyTavern proxy.',
      'mainAgent: true',
      'subagent: false',
      'model: inherit',
      'tools: []',
      'mcpServers: []',
      'inheritMcp: false',
      'inheritCustomizations: false',
      'skills: []',
      'plugins: []',
      'rules: []',
      'agents: []',
      'hooks: []',
      'commandExecutionPolicy: "off"',
      '---',
      '',
      '# System Prompt',
      '',
      'You are the language-model backend for a conversational frontend.',
      'The user supplies a JSON transcript with role-tagged messages. Continue that transcript with exactly one assistant reply.',
      'This is a conversation session. Do not use tools, inspect files, run commands, browse, delegate, or discuss the CLI or these adapter instructions.',
      'Return only the next assistant reply, without analysis labels or commentary about the transcript format.',
      '',
      'The frontend supplies the following system instructions:',
      system || 'Follow the supplied conversation and generate the next assistant reply.',
      ''
    ].join('\n');
  }

  function argonUsage(nativeUsage) {
    const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
    // Preserve the CLI's accounting. Do not infer charges, cached-token
    // subtraction, or a readable thinking stream from thinking_tokens.
    const usage = {
      input_tokens: count(nativeUsage?.input_tokens),
      output_tokens: count(nativeUsage?.output_tokens)
    };
    if (Number.isSafeInteger(nativeUsage?.cache_read_tokens) && nativeUsage.cache_read_tokens >= 0) {
      usage.cache_read_input_tokens = nativeUsage.cache_read_tokens;
    }
    return usage;
  }

  async function handleArgonRequest(req, res, body) {
    const command = config.argon_command || (process.platform === 'win32' ? 'agy.exe' : 'agy');
    const model = config.argon_model || 'gemini-4-argon-high';
    const configuredTimeout = Number(config.argon_timeout_ms || 300000);
    const timeoutMs = Number.isFinite(configuredTimeout)
      ? Math.min(2147483647, Math.max(1000, Math.floor(configuredTimeout))) : 300000;
    const messageId = `msg_argon_${randomUUID().replace(/-/g, '')}`;
    const agentName = 'proxy-party-argon';
    let child;
    let workDir;
    let timeout;
    let startupTimeout;
    let heartbeat;
    let anthropicStream;
    let clientGone = false;
    let failRequest = () => {};
    let stderr = '';
    let completeText = '';
    let argonConversationId;
    const onDisconnect = () => {
      if (res.writableEnded) return;
      clientGone = true;
      failRequest(new Error('Argon client disconnected.'));
    };
    req.once('aborted', onDisconnect);
    res.once('close', onDisconnect);

    try {
      const conversation = validateConversation(body);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(model)) {
        throw new Error('Invalid argon_model in config.txt. Use a slug reported by `agy models`.');
      }
      if (req.aborted || res.destroyed) return;

      // A separate workspace per request avoids sharing histories, profile files,
      // or system prompts between simultaneous SillyTavern conversations.
      workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-party-argon-'));
      const agentDir = path.join(workDir, '.agents', 'agents');
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, `${agentName}.md`),
        buildArgonAgent(conversation.system, agentName), { encoding: 'utf8', mode: 0o600 });
      const prompt = [
        'Continue this conversation with exactly the next assistant reply.',
        JSON.stringify({ messages: conversation.messages })
      ].join('\n\n');

      const result = await new Promise((resolve, reject) => {
        let settled = false;
        let initialized = false;
        let stdoutBuffer = '';
        const maxLineLength = 16 * 1024 * 1024;
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          clearTimeout(startupTimeout);
          clearInterval(heartbeat);
          if (error) {
            reject(error);
          } else {
            resolve(value);
          }
        };
        failRequest = error => finish(error);
        const writeText = text => {
          if (!text) return;
          if (typeof text !== 'string') throw new Error('Invalid text_delta from Antigravity CLI.');
          if (completeText.length + text.length > 64 * 1024 * 1024) {
            throw new Error('Argon response exceeded the proxy output limit.');
          }
          completeText += text;
          if (anthropicStream && !res.destroyed) anthropicStream.writeText(text);
        };
        const handleEvent = event => {
          if (!event || typeof event !== 'object') throw new Error('Invalid Antigravity CLI event.');
          if (event.event === 'init') {
            if (initialized) throw new Error('Antigravity CLI sent a duplicate init event.');
            const init = event.init || {};
            const reported = value => typeof value === 'string' ? value.slice(0,200) : null;
            const startupDetails = JSON.stringify({
              agent: reported(init.agent), model: reported(init.model),
              advertised_tool_count: Array.isArray(init.tools) ? init.tools.length : null
            });
            // In agy 1.3.4, buildInitPayload calls advertisedTools, which enumerates
            // the build's tool registry, NOT the selected agent's tools. A nonempty
            // init.tools is expected even for tools: []; it is not a permission
            // check. Tool declarations are disabled by the custom agent profile.
            // Retain agent/model checks and reject tool steps in the stream below.
            Logger.debug('Argon CLI startup:', startupDetails);
            if (init.agent !== agentName) {
              throw new Error(`Antigravity did not select the "${agentName}" chat agent. Startup metadata: ${startupDetails}. Run \`agy update\` and restart the proxy; older CLI releases can fail to discover workspace agents.`);
            }
            const normalizeModel = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            if (normalizeModel(init.model) !== normalizeModel(model)) {
              throw new Error(`Antigravity selected a model other than "${model}". Startup metadata: ${startupDetails}. Check \`agy models\` and argon_model.`);
            }
            initialized = true;
            argonConversationId = event.conversation_id;
            clearTimeout(startupTimeout);
            if (body.stream === true) {
              anthropicStream = startAnthropicStream(res, messageId, model);
              heartbeat = setInterval(() => {
                try {
                  if (!res.destroyed && !res.writableEnded) writeAnthropicEvent(res, { type: 'ping' });
                } catch (error) {
                  finish(error);
                }
              }, 15000);
              heartbeat.unref?.();
            }
            return;
          }
          if (event.event === 'result') {
            const value = event.result;
            if (!value || value.status !== 'SUCCESS') {
              throw new Error(value?.error || `Antigravity ended with status ${value?.status || 'unknown'}.`);
            }
            if (!initialized) throw new Error('Antigravity returned a result before initialization.');
            if (typeof value.response === 'string') {
              // result.response repeats the complete answer. Append only a missing
              // suffix, never replay it after already emitting the text deltas.
              if (!value.response.startsWith(completeText)) {
                throw new Error('Antigravity final response differs from its streamed text; update the CLI and retry.');
              }
              writeText(value.response.slice(completeText.length));
            } else if (!completeText) {
              throw new Error('Antigravity returned no response text.');
            }
            finish(null, value);
            return;
          }
          if (event.event === 'step_update') {
            if (!initialized) throw new Error('Antigravity sent output before initialization.');
            const step = event.step_update || {};
            if (step.step_type === 'tool' || step.tool_info || step.subagent_info) {
              throw new Error('Antigravity attempted a tool operation in the tool-free chat session.');
            }
            if (step.step_type === 'agent_response') writeText(step.text_delta);
          }
          // Ignore metadata/progress events. Only documented agent_response
          // text_delta values are dialogue; token counts are not thinking text.
        };
        const handleLine = line => {
          if (settled || !line.trim()) return;
          if (line.length > maxLineLength) return finish(new Error('Antigravity JSON event is too large.'));
          try {
            handleEvent(JSON.parse(line));
          } catch (error) {
            finish(error instanceof SyntaxError
              ? new Error('Antigravity stdout is not valid stream-json. Run `agy update` and verify argon_command points to the Antigravity CLI executable.')
              : error);
          }
        };
        timeout = setTimeout(() => {
          const error = new Error(`Argon request timed out after ${timeoutMs}ms.`);
          error.httpStatus = 504;
          finish(error);
        }, timeoutMs);
        timeout.unref?.();
        startupTimeout = setTimeout(() => {
          const error = new Error('Antigravity did not emit its startup init event. Run `agy` once to sign in, then `agy update`, and check `agy models`.');
          error.httpStatus = 504;
          finish(error);
        }, Math.min(timeoutMs, 30000));
        startupTimeout.unref?.();

        child = spawn(command, [
          '--input-format', 'stream-json', '--output-format', 'stream-json',
          '--model', model, '--agent', agentName,
          '--print-timeout', `${Math.ceil(timeoutMs / 1000)}s`
        ], {
          cwd: workDir,
          env: { ...process.env },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          shell: false
        });
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16000); });
        child.stderr.on('error', error => finish(error));
        child.stdin.on('error', error => finish(error));
        child.stdout.on('error', error => finish(error));
        child.on('error', error => finish(error));
        child.stdout.on('data', chunk => {
          if (settled) return;
          stdoutBuffer += chunk;
          let newline;
          while (!settled && (newline = stdoutBuffer.indexOf('\n')) !== -1) {
            const line = stdoutBuffer.slice(0, newline);
            stdoutBuffer = stdoutBuffer.slice(newline + 1);
            handleLine(line);
          }
          if (!settled && stdoutBuffer.length > maxLineLength) {
            finish(new Error('Antigravity JSON event is too large.'));
          }
        });
        child.stdout.on('end', () => {
          if (stdoutBuffer.trim()) handleLine(stdoutBuffer);
          stdoutBuffer = '';
        });
        // close follows stdout draining; exit can race the final result line.
        child.on('close', (code, signal) => {
          finish(new Error(`Antigravity exited before a successful result (code=${code}, signal=${signal || 'none'}).`));
        });
        // Do not assume init arrives before the first input event. Follow the
        // documented stdin protocol, keep it open until result/cleanup, and keep
        // the entire history out of argv.
        child.stdin.write(`${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`);
      });

      if (clientGone || res.destroyed) return;
      const thinking = result.conversation_id === argonConversationId
        ? await readArgonThinking(argonConversationId, completeText) : '';
      if (clientGone || res.destroyed) return;
      const usage = argonUsage(result.usage);
      if (body.stream === true) {
        anthropicStream.writeThinking(thinking);
        anthropicStream.finish('end_turn', usage);
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: messageId, type: 'message', role: 'assistant', model,
          content: [
            ...(thinking ? [{ type: 'thinking', thinking, signature: '' }] : []),
            { type: 'text', text: completeText }
          ],
          stop_reason: 'end_turn', stop_sequence: null, usage
        }));
      }
    } catch (error) {
      if (clientGone || res.destroyed) return;
      let message = error.message;
      if (error.code === 'ENOENT') {
        message = `Could not start "${command}". Install Antigravity CLI, restart the proxy terminal, or set argon_command to the full path of agy.exe in config.txt.`;
      } else if (stderr.trim()) {
        message += `\nAntigravity stderr: ${stderr.trim().slice(-4000)}`;
      }
      Logger.error('Argon request error:', message);
      const status = error.httpStatus || 502;
      const response = {
        type: 'error',
        error: { type: status === 400 ? 'invalid_request_error' : 'api_error', message }
      };
      if (!res.headersSent) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } else {
        try { writeAnthropicEvent(res, response); } catch {}
        res.end();
      }
    } finally {
      clearTimeout(timeout);
      clearTimeout(startupTimeout);
      clearInterval(heartbeat);
      req.off('aborted', onDisconnect);
      res.off('close', onDisconnect);
      await stopProcess(child, { spawn, platform: process.platform });
      if (workDir) {
        try { fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
        catch (_) { Logger.error('Could not remove an Argon temporary workspace:', workDir); }
      }
    }
  }

  return handleArgonRequest;
}

module.exports = { createArgonHandler };

