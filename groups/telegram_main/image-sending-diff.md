# Image Sending for Jarvis — Implementation Diff

FLUX models are ready (`x/flux2-klein:latest`). Three files need changes.

---

## 1. src/channels/telegram.ts — add sendJarvisPhoto()

Add after the existing `sendJarvisMessage` function:

```ts
/**
 * Send a photo via the Jarvis bot.
 * imageBase64: base64-encoded PNG/JPEG bytes
 */
export async function sendJarvisPhoto(
  chatId: string,
  imageBase64: string,
  caption?: string,
): Promise<void> {
  if (!jarvisApi) {
    logger.warn('Jarvis bot not initialized, cannot send photo');
    return;
  }
  const numericId = chatId.replace(/^tg:/, '');
  try {
    const buffer = Buffer.from(imageBase64, 'base64');
    await jarvisApi.sendPhoto(numericId, new Uint8Array(buffer), {
      caption: caption ?? '',
    });
    logger.info({ chatId, captionLen: caption?.length ?? 0 }, 'Jarvis photo sent');
  } catch (err) {
    logger.error({ chatId, err }, 'Failed to send Jarvis photo');
  }
}
```

---

## 2. src/ipc.ts — handle {type: "image"} IPC messages

In the `processIpcFiles` message-handling block, after the existing
`if (data.type === 'message' && data.chatJid && data.text)` block, add:

```ts
} else if (data.type === 'image' && data.chatJid && data.imageBase64) {
  // Authorization check (same as for text messages)
  const targetGroup = registeredGroups[data.chatJid];
  if (isMain || (targetGroup && targetGroup.folder === sourceGroup)) {
    if (sourceGroup === 'telegram_ollama' && data.chatJid.startsWith('tg:')) {
      await sendJarvisPhoto(data.chatJid, data.imageBase64, data.caption);
    } else {
      // For other groups, send as a file through the main bot if needed
      logger.warn({ sourceGroup }, 'Image IPC from non-Jarvis group — not yet supported');
    }
    logger.info({ chatJid: data.chatJid, sourceGroup }, 'IPC image sent');
  } else {
    logger.warn({ chatJid: data.chatJid, sourceGroup }, 'Unauthorized IPC image attempt blocked');
  }
}
```

Also add `sendJarvisPhoto` to the import from `./channels/telegram.js`.

---

## 3. container/ollama-runner/src/index.ts — handle FLUX tool calls

Replace the `callOllama` function to handle tool calls and image responses:

```ts
// Image-generation models — detected by name prefix
const IMAGE_MODELS = ['flux', 'stable-diffusion', 'sdxl', 'dall-e'];

function isImageModel(model: string): boolean {
  const lower = model.toLowerCase();
  return IMAGE_MODELS.some((m) => lower.includes(m));
}

async function handleToolCall(
  toolName: string,
  toolArgs: Record<string, unknown>,
  chatJid: string,
  groupFolder: string,
): Promise<string> {
  if (toolName === 'ollama_list_models') {
    const resp = await fetch(`${OLLAMA_HOST}/api/tags`);
    const data = await resp.json() as { models: Array<{ name: string; size: number }> };
    return data.models.map((m) => `• ${m.name} (${(m.size / 1e9).toFixed(1)}GB)`).join('\n');
  }

  if (toolName === 'ollama_generate') {
    const model = String(toolArgs.model ?? 'llama3.2');
    const prompt = String(toolArgs.prompt ?? '');
    const system = toolArgs.system ? String(toolArgs.system) : undefined;

    if (isImageModel(model)) {
      // Image generation — call /api/generate and extract base64 image
      const body: Record<string, unknown> = { model, prompt, stream: false };
      if (system) body.system = system;

      const resp = await fetch(`${OLLAMA_HOST}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!resp.ok) throw new Error(`Image gen error: ${resp.status}`);
      const data = await resp.json() as { images?: string[]; response?: string };

      const imageBase64 = data.images?.[0] ?? data.response;
      if (!imageBase64) throw new Error('No image in Ollama response');

      // Write image IPC message for nanoclaw to send via Telegram
      const ipcMsg = {
        type: 'image',
        chatJid,
        imageBase64,
        caption: `_Generated: ${prompt.slice(0, 200)}_`,
        timestamp: new Date().toISOString(),
      };
      const ipcFile = path.join('/workspace/ipc/messages', `img-${Date.now()}.json`);
      fs.mkdirSync(path.dirname(ipcFile), { recursive: true });
      fs.writeFileSync(ipcFile, JSON.stringify(ipcMsg));

      return `✅ Image generated! Sending to chat now...`;
    }

    // Text generation with a specific model
    const body: Record<string, unknown> = {
      model,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: prompt },
      ],
      stream: false,
    };
    const resp = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`Sub-model error: ${resp.status}`);
    const data = await resp.json() as OllamaResponse;
    return extractContent(data.message.content);
  }

  return `Unknown tool: ${toolName}`;
}
```

Then in `callOllama`, after getting the response, add a tool-call loop:

```ts
// After const data = await response.json() as OllamaResponse;
let msg = data.message;

// Tool-call loop (up to 5 rounds)
let rounds = 0;
while (msg.tool_calls && msg.tool_calls.length > 0 && rounds++ < 5) {
  const toolResults: Message[] = [];
  for (const tc of msg.tool_calls) {
    const result = await handleToolCall(
      tc.function.name,
      tc.function.arguments,
      chatJid,
      groupFolder,
    );
    toolResults.push({ role: 'tool', content: result });
  }
  // Continue conversation with tool results
  const followUp = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [...messages, msg as Message, ...toolResults],
      tools: OLLAMA_TOOLS,
      stream: false,
    }),
  });
  const next = await followUp.json() as OllamaResponse;
  msg = next.message;
}

return extractContent(msg.content);
```

---

## Deploy steps

```bash
# 1. Apply diffs above to the three files
# 2. Rebuild container
cd ~/nanoclaw/container && ./build.sh
# 3. Restart nanoclaw
```

After rebuild, Jarvis can generate images! Example prompts:
- "generate an image of a sunset over the ocean"
- "make a picture of a cat wearing a hat"
