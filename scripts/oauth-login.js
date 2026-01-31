#!/usr/bin/env node
/**
 * Claude Max OAuth Login Script
 * 
 * Based on the opencode-anthropic-auth plugin implementation.
 * Performs the OAuth PKCE flow to get access and refresh tokens
 * from your Claude Max/Pro subscription.
 * 
 * Usage: node scripts/oauth-login.js
 */

import crypto from 'crypto';
import readline from 'readline';

// OAuth configuration (from opencode-anthropic-auth)
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_AUTHORIZE_URL = "https://claude.ai/oauth/authorize"; // For Max/Pro
const OAUTH_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const OAUTH_REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const OAUTH_SCOPES = "org:create_api_key user:profile user:inference";

/**
 * Generate PKCE code verifier and challenge
 * Using the same approach as @openauthjs/openauth/pkce
 */
function generatePKCE() {
  // Generate a random 32-byte verifier and encode as base64url
  const verifierBytes = crypto.randomBytes(32);
  const verifier = verifierBytes.toString('base64url');
  
  // Create SHA256 hash of verifier and encode as base64url
  const hash = crypto.createHash('sha256').update(verifier).digest();
  const challenge = hash.toString('base64url');
  
  return { verifier, challenge };
}

/**
 * Build the OAuth authorization URL
 */
function buildAuthorizeURL(challenge, verifier) {
  const url = new URL(OAUTH_AUTHORIZE_URL);
  url.searchParams.set("code", "true"); // Important: enables code display
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", OAUTH_REDIRECT_URI);
  url.searchParams.set("scope", OAUTH_SCOPES);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", verifier); // State is the verifier in this implementation
  return url.toString();
}

/**
 * Exchange authorization code for tokens
 */
async function exchangeCodeForTokens(code, verifier) {
  // Code may come as "code#state" format
  const splits = code.split("#");
  const actualCode = splits[0];
  const state = splits[1] || verifier;
  
  const response = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: actualCode,
      state: state,
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      redirect_uri: OAUTH_REDIRECT_URI,
      code_verifier: verifier,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token exchange failed: ${response.status} ${error}`);
  }

  return response.json();
}

/**
 * Prompt user for input
 */
function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Main login flow
 */
async function main() {
  console.log('='.repeat(60));
  console.log('Claude Max OAuth Login');
  console.log('='.repeat(60));
  console.log();
  
  // Generate PKCE values
  const { verifier, challenge } = generatePKCE();
  
  // Build authorization URL
  const authorizeURL = buildAuthorizeURL(challenge, verifier);
  
  console.log('Step 1: Open this URL in your browser:');
  console.log();
  console.log(authorizeURL);
  console.log();
  
  // Try to open browser automatically
  try {
    const { exec } = await import('child_process');
    const platform = process.platform;
    const openCmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
    exec(`${openCmd} "${authorizeURL}"`);
    console.log('(Attempting to open browser automatically...)');
  } catch (e) {
    console.log('(Please open the URL manually)');
  }
  
  console.log();
  console.log('Step 2: Log in with your Claude account and click "Authorize"');
  console.log();
  console.log('Step 3: After authorizing, you will see a page with an authorization code.');
  console.log('        Copy the ENTIRE code (it may be long and contain special characters).');
  console.log();
  console.log('        The code might look like: abc123...xyz#verifier_string');
  console.log();
  
  const code = await prompt('Enter the authorization code: ');
  
  if (!code) {
    console.error('Error: No code provided');
    process.exit(1);
  }
  
  console.log();
  console.log('Exchanging code for tokens...');
  
  let tokens;
  try {
    tokens = await exchangeCodeForTokens(code, verifier);
  } catch (err) {
    console.error('Error exchanging code:', err.message);
    process.exit(1);
  }
  
  console.log();
  console.log('='.repeat(60));
  console.log('SUCCESS! Tokens received.');
  console.log('='.repeat(60));
  console.log();
  console.log('Token expires in:', tokens.expires_in, 'seconds');
  console.log();
  
  // Save to file
  const fs = await import('fs');
  const tokensFile = '.tokens.json';
  fs.writeFileSync(tokensFile, JSON.stringify({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_in: tokens.expires_in,
    obtained_at: new Date().toISOString(),
  }, null, 2));
  console.log(`Tokens saved to ${tokensFile}`);
  console.log();
  
  console.log('='.repeat(60));
  console.log('Now run these commands to set up your worker:');
  console.log('='.repeat(60));
  console.log();
  console.log('cd ~/claude-max-proxy');
  console.log();
  console.log('# Set the access token:');
  console.log(`echo '${tokens.access_token}' | wrangler secret put CLAUDE_ACCESS_TOKEN`);
  console.log();
  console.log('# Set the refresh token:');
  console.log(`echo '${tokens.refresh_token}' | wrangler secret put CLAUDE_REFRESH_TOKEN`);
  console.log();
  console.log('# Set your proxy secret (use any strong password you want):');
  console.log('echo "your-secret-key-here" | wrangler secret put PROXY_SECRET');
  console.log();
  console.log('# Then deploy:');
  console.log('npm run deploy');
  console.log();
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
