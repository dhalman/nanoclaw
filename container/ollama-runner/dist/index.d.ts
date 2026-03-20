/**
 * NanoClaw Ollama Runner
 * Runs inside the container, calls Ollama API directly — no Claude Code.
 * Input/output format identical to agent-runner for host compatibility.
 *
 * Model selection:
 *   - Vision tasks  → qwen2.5vl:72b (Artist/Cinematographer)
 *   - Coding tasks  → qwen3-coder:30b
 *   - Everything else → qwen3.5:35b (escalates to thinking, then deepseek-r1 as needed)
 *
 * Escalation ladder: qwen3.5:35b → qwen3.5:35b+think → deepseek-r1:70b
 *
 * Tools available to all models (via Ollama tool-calling):
 *   - ollama_list_models: list installed models
 *   - ollama_generate: call any local model for a subtask
 *
 */
interface ToolCall {
    function: {
        name: string;
        arguments: Record<string, unknown>;
    };
}
interface Message {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    tool_calls?: ToolCall[];
}
export declare const MODELS: {
    readonly COORDINATOR: string;
    readonly SECRETARY: string;
    readonly CODER: string;
    readonly ARCHITECT: string;
    readonly VISION: string;
    readonly IMAGE: string;
};
export declare function shouldThinkFallback(text: string): boolean;
export declare function shouldEscalateFallback(text: string): boolean;
export declare function selectModelFallback(text: string, hasImages?: boolean): string;
export type TaskType = 'code' | 'creative' | 'brainstorm' | 'analysis';
export type RichTaskType = 'chat' | 'code' | 'creative' | 'analysis' | 'decision' | 'debug' | 'research';
export declare function detectTaskType(text: string): TaskType;
export declare function detectRichTaskType(text: string): RichTaskType;
declare const TASK_TEMPERATURE: Record<RichTaskType, number>;
export declare function getTemperature(text: string): number;
export declare function detectDissatisfaction(text: string): boolean;
export declare function detectNeedsWeb(text: string): boolean;
export declare function estimateComplexity(text: string): 'low' | 'medium' | 'high';
export declare function buildRouteHint(text: string, hasImages: boolean): string;
export interface MessageClassification {
    model: string;
    think: boolean;
    taskType: TaskType;
    taskTypeRich: RichTaskType;
    temperature: number;
    complexity: 'low' | 'medium' | 'high';
    usedSecretary: boolean;
    needsWeb?: boolean;
}
export { TASK_TEMPERATURE };
export interface SecretaryGrade {
    at: number;
    promptPreview: string;
    routingGrade: 'correct' | 'suboptimal' | 'wrong';
    routingNote?: string;
}
/** Classify a message using the Secretary (qwen2.5:3b) for semantic routing.
 * For low-complexity messages the secretary also drafts an answer — the coordinator
 * reviews it and either echoes it or steps in with their own response.
 * Falls back to regex classifiers if the call fails or times out. */
export declare function classifyMessage(text: string, hasImages: boolean): Promise<MessageClassification>;
/** Extract a plain string from Ollama message content (handles string, array, or schema object). */
export declare function extractContent(raw: unknown): string;
export declare function getSystemPrompt(assistantName: string, groupFolder?: string): string;
export declare const MODEL_ALIASES: Record<string, string>;
export declare function resolveModel(model: string): string;
export declare const IMAGE_MODELS: string[];
export declare function isImageModel(model: string): boolean;
export declare function handleToolCall(toolName: string, toolArgs: Record<string, unknown>, chatJid: string, groupFolder: string, setStatus?: (text: string) => void): Promise<string>;
/** Returns the next reasoning tier for a given model/think state, or null if already at max. */
export declare function getEscalationTier(model: string, think: boolean): {
    model: string;
    think: boolean;
} | null;
export declare function callOllama(model: string, messages: Message[], chatJid: string, groupFolder: string, images?: string[], temperature?: number, setStatus?: (text: string) => void, think?: boolean, onToolStart?: (toolName: string) => void, complexity?: 'low' | 'medium' | 'high'): Promise<string>;
