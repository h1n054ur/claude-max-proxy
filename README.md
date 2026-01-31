# Claude Max Proxy

A Cloudflare Worker that proxies Anthropic API requests using your **Claude Max/Pro subscription** via OAuth tokens instead of paying for API credits.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/h1n054ur/claude-max-proxy)

## What is this?

If you have a Claude Max ($20/month) or Claude Pro subscription, this proxy lets you use your subscription for API access instead of paying separate API fees. It works by:

1. Authenticating via OAuth (same as Claude Code CLI)
2. Injecting the required headers and system prompts
3. Proxying requests to Anthropic's API

## Requirements

- **Claude Max or Pro subscription** (claude.ai)
- **Cloudflare account** (free tier works)
- **Node.js 18+** (for the OAuth login script)

## Quick Start

### Option 1: One-Click Deploy

1. Click the **Deploy to Cloudflare** button above
2. Follow the prompts to connect your GitHub and deploy
3. After deployment, continue to [Set Up OAuth Tokens](#step-2-get-oauth-tokens)

### Option 2: Manual Deploy

```bash
# Clone the repo
git clone https://github.com/h1n054ur/claude-max-proxy.git
cd claude-max-proxy

# Install dependencies
npm install

# Create KV namespace for token storage
wrangler kv namespace create TOKEN_STORE
# Copy the ID and update wrangler.toml

# Deploy
wrangler deploy
```

## Setup Guide

### Step 1: Deploy the Worker

Use either the one-click deploy button or manual deployment above.

### Step 2: Get OAuth Tokens

Run the login script to authenticate with your Claude account:

```bash
node scripts/oauth-login.js
```

This will:
1. Open a browser window for you to authorize
2. Ask you to paste the authorization code
3. Exchange it for OAuth tokens
4. Save them to `.tokens.json`

### Step 3: Set Secrets

```bash
# Set the access token
node -e "console.log(require('./.tokens.json').access_token)" | wrangler secret put CLAUDE_ACCESS_TOKEN

# Set the refresh token  
node -e "console.log(require('./.tokens.json').refresh_token)" | wrangler secret put CLAUDE_REFRESH_TOKEN

# Set your proxy secret (generate a strong random string)
echo "your-secret-key-here" | wrangler secret put PROXY_SECRET
```

### Step 4: Use the Proxy

Configure your Anthropic client to use the proxy:

```bash
export ANTHROPIC_BASE_URL=https://your-worker.workers.dev
export ANTHROPIC_API_KEY=your-proxy-secret
```

Or in code:

```python
from anthropic import Anthropic

client = Anthropic(
    base_url="https://your-worker.workers.dev",
    api_key="your-proxy-secret"
)

response = client.messages.create(
    model="claude-sonnet-4-20250514",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}]
)
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Health check |
| `/health` | GET | Health check with token status |
| `/v1/messages` | POST | Anthropic Messages API |
| `/v1/models` | GET | List available models |

## Configuration

### Environment Variables

Set via `wrangler secret put <NAME>`:

| Secret | Required | Description |
|--------|----------|-------------|
| `CLAUDE_ACCESS_TOKEN` | Yes | OAuth access token from login |
| `CLAUDE_REFRESH_TOKEN` | Yes | OAuth refresh token from login |
| `PROXY_SECRET` | Yes | Your secret key for authenticating to this proxy |

### wrangler.toml

The `CLAUDE_OAUTH_CLIENT_ID` is pre-configured (it's the same public client ID used by Claude Code).

You need to update the KV namespace ID after creating it:

```toml
[[kv_namespaces]]
binding = "TOKEN_STORE"
id = "your-kv-namespace-id"
```

## How It Works

1. **Authentication**: Uses OAuth 2.0 with PKCE (same flow as Claude Code CLI)
2. **Token Refresh**: Automatically refreshes expired access tokens using the refresh token
3. **Token Storage**: Stores refreshed tokens in Cloudflare KV for persistence
4. **Request Proxying**: Adds required headers (`anthropic-beta`, `User-Agent`, etc.)
5. **System Prompt**: Injects Claude Code identity to pass server-side checks

## Token Lifecycle

- **Access tokens** expire after ~8 hours
- **Refresh tokens** are long-lived
- The proxy automatically refreshes tokens when needed
- New tokens are stored in KV storage

## Re-authenticating

If your refresh token expires or becomes invalid:

```bash
# Run the login script again
node scripts/oauth-login.js

# Update the secrets
node -e "console.log(require('./.tokens.json').access_token)" | wrangler secret put CLAUDE_ACCESS_TOKEN
node -e "console.log(require('./.tokens.json').refresh_token)" | wrangler secret put CLAUDE_REFRESH_TOKEN
```

## Use Cases

- **[Moltworker](https://github.com/cloudflare/moltworker)**: Run Moltbot on Cloudflare using your Claude Max subscription
- **Claude Code alternatives**: Use with tools that need Anthropic API access
- **Personal projects**: Build apps without API billing

## Security Notes

- Keep your `PROXY_SECRET` secure - anyone with it can use your subscription
- The proxy is authenticated via Bearer token or x-api-key header
- OAuth tokens are stored encrypted in Cloudflare secrets/KV
- Never commit `.tokens.json` or `.proxy-secret` to git

## Disclaimer

> **Warning**: This proxy may violate [Anthropic's Terms of Service](https://www.anthropic.com/legal/consumer-terms). Using your subscription for API access may not be permitted. Use at your own risk. Your account could be suspended or banned.

This project is for educational purposes. The authors are not responsible for any consequences of using this software.

## Credits

Based on the OAuth implementation from:
- [opencode-anthropic-auth](https://www.npmjs.com/package/opencode-anthropic-auth) by the OpenCode team
- [Pluribus](https://github.com/Arasple/pluribus) for reference implementation

## License

MIT
