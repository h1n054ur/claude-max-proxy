/**
 * Claude Max Proxy Worker
 * 
 * Proxies requests to Anthropic API using your Claude Max/Pro subscription
 * via OAuth tokens instead of API keys.
 */

export interface Env {
  // KV namespace for token storage
  TOKEN_STORE: KVNamespace;
  
  // OAuth client ID (public)
  CLAUDE_OAUTH_CLIENT_ID: string;
  
  // Secrets (set via wrangler secret put)
  CLAUDE_ACCESS_TOKEN: string;
  CLAUDE_REFRESH_TOKEN: string;
  PROXY_SECRET: string;
}

// Constants from opencode-anthropic-auth plugin
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_API_VERSION = "2023-06-01";
const OAUTH_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token"; // Correct endpoint
const CLAUDE_CODE_VERSION = "2.1.2"; // Match opencode plugin

// Required beta flags for OAuth
const REQUIRED_BETA_FLAGS = [
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
];

const CLAUDE_CODE_SYSTEM_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude.";

// Tool name prefix (opencode uses mcp_ prefix for tools)
const TOOL_PREFIX = "mcp_";

interface TokenData {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

/**
 * Get the current Claude Code version from npm registry
 */
async function getClaudeCodeVersion(): Promise<string> {
  try {
    const response = await fetch("https://registry.npmjs.org/@anthropic-ai/claude-code", {
      headers: { "Accept": "application/json" }
    });
    if (response.ok) {
      const data = await response.json() as any;
      return data["dist-tags"]?.["latest"] || CLAUDE_CODE_VERSION;
    }
  } catch (e) {
    console.error("Failed to fetch Claude Code version:", e);
  }
  return CLAUDE_CODE_VERSION;
}

/**
 * Refresh the OAuth access token
 */
async function refreshAccessToken(
  refreshToken: string,
  clientId: string
): Promise<TokenData> {
  const response = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token refresh failed: ${response.status} ${error}`);
  }

  const data = await response.json() as any;
  
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in * 1000),
  };
}

/**
 * Get valid access token, refreshing if necessary
 */
async function getValidToken(env: Env): Promise<string> {
  // Try to get cached token from KV
  const cached = await env.TOKEN_STORE.get("tokens", "json") as TokenData | null;
  
  if (cached && cached.expiresAt > Date.now() + 60000) {
    // Token is valid for at least 1 more minute
    return cached.accessToken;
  }

  // Need to refresh
  const refreshToken = cached?.refreshToken || env.CLAUDE_REFRESH_TOKEN;
  
  console.log("Refreshing access token...");
  const newTokens = await refreshAccessToken(refreshToken, env.CLAUDE_OAUTH_CLIENT_ID);
  
  // Store in KV
  await env.TOKEN_STORE.put("tokens", JSON.stringify(newTokens), {
    expirationTtl: 86400, // 24 hours
  });
  
  return newTokens.accessToken;
}

/**
 * Inject Claude Code system prompt at the beginning
 */
function injectSystemPrompt(body: any): any {
  if (!body.system) {
    body.system = [];
  }
  
  // If system is a string, convert to array format
  if (typeof body.system === "string") {
    body.system = [{ type: "text", text: body.system }];
  }
  
  // Check if already has Claude Code identity
  const hasIdentity = body.system.some((block: any) => 
    block.text?.startsWith("You are Claude Code")
  );
  
  if (!hasIdentity) {
    body.system.unshift({
      type: "text",
      text: CLAUDE_CODE_SYSTEM_PROMPT,
    });
  }
  
  return body;
}

/**
 * Sanitize request body - replace "OpenCode" with "Claude Code" and add tool prefixes
 * Based on opencode-anthropic-auth implementation
 */
function sanitizeBody(body: any): any {
  // Sanitize system prompt - server blocks "OpenCode" string
  if (body.system && Array.isArray(body.system)) {
    body.system = body.system.map((item: any) => {
      if (item.type === "text" && item.text) {
        return {
          ...item,
          text: item.text
            .replace(/OpenCode/g, "Claude Code")
            .replace(/opencode/gi, "Claude"),
        };
      }
      return item;
    });
  }
  
  // Add prefix to tools definitions
  if (body.tools && Array.isArray(body.tools)) {
    body.tools = body.tools.map((tool: any) => ({
      ...tool,
      name: tool.name ? `${TOOL_PREFIX}${tool.name}` : tool.name,
    }));
  }
  
  // Add prefix to tool_use blocks in messages
  if (body.messages && Array.isArray(body.messages)) {
    body.messages = body.messages.map((msg: any) => {
      if (msg.content && Array.isArray(msg.content)) {
        msg.content = msg.content.map((block: any) => {
          if (block.type === "tool_use" && block.name) {
            return {
              ...block,
              name: `${TOOL_PREFIX}${block.name}`,
            };
          }
          return block;
        });
      }
      return msg;
    });
  }
  
  return body;
}

/**
 * Build headers for Anthropic API request
 * Based on opencode-anthropic-auth plugin implementation
 */
function buildHeaders(accessToken: string, version: string, incomingBeta?: string): Headers {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${accessToken}`);
  headers.set("Content-Type", "application/json");
  headers.set("anthropic-version", ANTHROPIC_API_VERSION);
  
  // Merge required beta flags with any incoming ones
  const incomingBetasList = incomingBeta
    ? incomingBeta.split(",").map(b => b.trim()).filter(Boolean)
    : [];
  const mergedBetas = [...new Set([...REQUIRED_BETA_FLAGS, ...incomingBetasList])].join(",");
  headers.set("anthropic-beta", mergedBetas);
  
  headers.set("User-Agent", `claude-cli/${version} (external, cli)`);
  // Note: Do NOT set x-api-key header when using OAuth
  return headers;
}

/**
 * Validate the proxy secret
 */
function validateAuth(request: Request, env: Env): boolean {
  // Check Authorization header
  const authHeader = request.headers.get("Authorization");
  if (authHeader) {
    const [type, token] = authHeader.split(" ");
    if (type === "Bearer" && token === env.PROXY_SECRET) {
      return true;
    }
  }
  
  // Check x-api-key header (for OpenAI-compatible clients)
  const apiKey = request.headers.get("x-api-key");
  if (apiKey === env.PROXY_SECRET) {
    return true;
  }
  
  return false;
}

/**
 * Handle the /v1/messages endpoint
 */
async function handleMessages(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  
  // Validate authentication
  if (!validateAuth(request, env)) {
    return new Response("Unauthorized", { status: 401 });
  }
  
  // Get valid OAuth token
  let accessToken: string;
  try {
    accessToken = await getValidToken(env);
  } catch (e) {
    console.error("Failed to get access token:", e);
    return new Response(JSON.stringify({ error: "Token error", message: String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
  
  // Parse request body
  let body: any;
  try {
    body = await request.json();
  } catch (e) {
    return new Response("Invalid JSON body", { status: 400 });
  }
  
  // Inject system prompt and sanitize (replace "OpenCode" with "Claude Code")
  body = injectSystemPrompt(body);
  body = sanitizeBody(body);
  
  // Get Claude Code version
  const version = await getClaudeCodeVersion();
  
  // Get incoming beta header if any
  const incomingBeta = request.headers.get("anthropic-beta") || undefined;
  
  // Build request to Anthropic
  const headers = buildHeaders(accessToken, version, incomingBeta);
  const url = new URL(ANTHROPIC_API_URL);
  url.searchParams.set("beta", "true");
  
  // Forward to Anthropic
  const response = await fetch(url.toString(), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  
  // Handle streaming responses - transform to remove tool prefix
  if (body.stream && response.body) {
    const transformedStream = transformStreamingResponse(response.body);
    return new Response(transformedStream, {
      status: response.status,
      headers: {
        "Content-Type": response.headers.get("Content-Type") || "text/event-stream",
        "Cache-Control": "no-cache",
      },
    });
  }
  
  // Handle non-streaming responses - transform to remove tool prefix
  let responseBody = await response.text();
  responseBody = responseBody.replace(/"name"\s*:\s*"mcp_([^"]+)"/g, '"name": "$1"');
  return new Response(responseBody, {
    status: response.status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Transform streaming response to remove tool prefix from tool names
 */
function transformStreamingResponse(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      
      let text = decoder.decode(value, { stream: true });
      // Remove mcp_ prefix from tool names in streaming response
      text = text.replace(/"name"\s*:\s*"mcp_([^"]+)"/g, '"name": "$1"');
      controller.enqueue(encoder.encode(text));
    },
  });
}

/**
 * Handle the /v1/models endpoint (for compatibility)
 */
async function handleModels(): Promise<Response> {
  const models = {
    object: "list",
    data: [
      { id: "claude-opus-4-6", object: "model", owned_by: "anthropic" },
      { id: "claude-sonnet-4-6", object: "model", owned_by: "anthropic" },
      { id: "claude-haiku-4-5", object: "model", owned_by: "anthropic" },
      { id: "claude-opus-4-20250514", object: "model", owned_by: "anthropic" },
      { id: "claude-sonnet-4-20250514", object: "model", owned_by: "anthropic" },
    ],
  };
  return new Response(JSON.stringify(models), {
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Health check endpoint
 */
async function handleHealth(env: Env): Promise<Response> {
  let tokenStatus = "unknown";
  try {
    const cached = await env.TOKEN_STORE.get("tokens", "json") as TokenData | null;
    if (cached) {
      const remaining = cached.expiresAt - Date.now();
      if (remaining > 0) {
        tokenStatus = `valid (expires in ${Math.round(remaining / 1000 / 60)} minutes)`;
      } else {
        tokenStatus = "expired (will refresh on next request)";
      }
    } else {
      tokenStatus = "not cached (will use secret on first request)";
    }
  } catch (e) {
    tokenStatus = `error: ${e}`;
  }
  
  return new Response(JSON.stringify({
    status: "ok",
    service: "claude-max-proxy",
    tokenStatus,
  }), {
    headers: { "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta",
        },
      });
    }
    
    // Route requests
    if (path === "/v1/messages" || path === "/anthropic/v1/messages") {
      return handleMessages(request, env);
    }
    
    if (path === "/v1/models" || path === "/anthropic/v1/models") {
      return handleModels();
    }
    
    if (path === "/health" || path === "/") {
      return handleHealth(env);
    }
    
    return new Response("Not found", { status: 404 });
  },
};
