/**
 * DIFF: Changes to add to container/ollama-runner/src/index.ts
 * to support Jarvis → Andy escalation with user confirmation.
 *
 * Paste these additions into the existing file at the indicated locations.
 */

// ─── 1. NEW CONSTANTS (add after existing constants block) ──────────────────

const ANDY_REQUESTS_DIR = '/workspace/group/andy-requests';
const ESCALATE_MARKER = '[ESCALATE:';
const AFFIRMATIVE = new Set(['yes', 'yeah', 'yep', 'sure', 'ok', 'okay', 'please', 'do it', 'go ahead', 'y']);

// ─── 2. REPLACE getSystemPrompt ─────────────────────────────────────────────

function getSystemPrompt(assistantName: string): string {
  return `You are ${assistantName}, a helpful assistant running on local Ollama models. Keep responses concise and conversational.

When you cannot confidently answer something — because it requires real-time web data, file access, running commands, or complex reasoning beyond your capability — add this exact line at the very end of your response (on its own line):
[ESCALATE: <one-sentence summary of what the user needs>]

Otherwise answer normally.

Use Telegram/WhatsApp formatting only: *bold* (single asterisks only, never double), _italic_, • bullets, \`\`\`code\`\`\`. No ## headings, no [links](url).`;
}

// ─── 3. NEW HELPER FUNCTIONS (add before main()) ────────────────────────────

function isAffirmative(text: string): boolean {
  return AFFIRMATIVE.has(text.trim().toLowerCase());
}

/**
 * Parse [ESCALATE: reason] marker from Ollama response.
 * Returns { clean: response without marker, reason: string | null }
 */
function parseEscalate(response: string): { clean: string; reason: string | null } {
  const idx = response.indexOf(ESCALATE_MARKER);
  if (idx === -1) return { clean: response, reason: null };

  const end = response.indexOf(']', idx);
  const reason = end !== -1
    ? response.slice(idx + ESCALATE_MARKER.length, end).trim()
    : 'something beyond local models';

  const clean = response.slice(0, idx).trimEnd();
  return { clean, reason };
}

/**
 * Write a help request to disk for Andy to pick up.
 * Returns the request ID.
 */
function writeAndyRequest(
  question: string,
  reason: string,
  history: Message[],
  chatJid: string,
): string {
  fs.mkdirSync(ANDY_REQUESTS_DIR, { recursive: true });
  const id = `req-${Date.now()}`;
  const payload = {
    id,
    chatJid,           // so Andy knows which Telegram group to acknowledge from
    question,
    reason,
    history: history.slice(-10),  // last 10 msgs for context
    requestedAt: new Date().toISOString(),
    status: 'pending',
  };
  const filePath = path.join(ANDY_REQUESTS_DIR, `${id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  log(`Andy request written: ${filePath}`);
  return id;
}

// ─── 4. REPLACE the inner while(true) loop body in main() ───────────────────
//
// Replace everything from:
//   const model = selectModel(prompt);
// down to:
//   prompt = nextMessage;
//
// With the following:

/*
      const model = selectModel(prompt);
      log(`Model: ${model}, prompt length: ${prompt.length}`);

      const userMsg: Message = { role: 'user', content: prompt };
      const messages = [systemMsg, ...history, userMsg];

      const rawResponse = await callOllama(model, messages);
      const { clean: response, reason: escalateReason } = parseEscalate(rawResponse);

      history = [...history, userMsg, { role: 'assistant', content: response }];
      saveHistory(history);

      // If Ollama flagged escalation, offer to ask Andy before outputting
      if (escalateReason !== null) {
        const offer = response
          ? `${response}\n\n_This might need Andy's help (${escalateReason}). Want me to ask him? He'll reply in your private chat. (yes/no)_`
          : `_This seems beyond my local models (${escalateReason}). Want me to ask Andy for help? He'll reply in your private chat. (yes/no)_`;

        writeOutput({ status: 'success', result: offer, newSessionId: sessionId });
        writeOutput({ status: 'success', result: null, newSessionId: sessionId });

        log('Waiting for user escalation decision...');
        const decision = await waitForIpcMessage();

        if (decision !== null && isAffirmative(decision)) {
          writeAndyRequest(prompt, escalateReason, history, chatJid);
          writeOutput({
            status: 'success',
            result: "Got it! I've passed this to Andy — check your private chat with him shortly. 🤙",
            newSessionId: sessionId,
          });
          writeOutput({ status: 'success', result: null, newSessionId: sessionId });
          break; // end this session, Andy takes over
        }

        // User said no — just continue as normal
        writeOutput({
          status: 'success',
          result: "No worries! Let me know if there's anything else I can help with. 😊",
          newSessionId: sessionId,
        });
        writeOutput({ status: 'success', result: null, newSessionId: sessionId });
      } else {
        // Normal response
        writeOutput({ status: 'success', result: response || null, newSessionId: sessionId });
        writeOutput({ status: 'success', result: null, newSessionId: sessionId });
      }

      log('Waiting for next message...');
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Session closed (idle timeout or sentinel)');
        break;
      }

      log(`Next message: ${nextMessage.length} chars`);
      prompt = nextMessage;
*/
