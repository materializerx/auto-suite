import * as dotenv from 'dotenv';
import * as http from 'http';
import * as url from 'url';
import { randomBytes } from 'crypto';

// Load environment variables
dotenv.config({ path: '.env.local' });

const REDDIT_CONFIG = {
  clientId: process.env.REDDIT_CLIENT_ID!,
  clientSecret: process.env.REDDIT_CLIENT_SECRET!,
  userAgent: process.env.REDDIT_USER_AGENT!,
  redirectUri: 'http://localhost:3000/api/auth/callback', // Use localhost URL that matches Reddit app config
};

function log(level: 'INFO' | 'WARN' | 'ERROR', message: string, data?: any) {
  const timestamp = new Date().toISOString();
  const emoji = level === 'INFO' ? '✅' : level === 'WARN' ? '⚠️' : '❌';
  
  console.log(`${emoji} ${level}: ${message}`);
  if (data) {
    console.log('   Data:', JSON.stringify(data, null, 2));
  }
}

class BotOAuthSetup {
  private state: string;
  
  constructor() {
    this.state = randomBytes(16).toString('hex');
  }

  generateAuthUrl(): string {
    const params = new URLSearchParams({
      client_id: REDDIT_CONFIG.clientId,
      response_type: 'code',
      state: this.state,
      redirect_uri: REDDIT_CONFIG.redirectUri,
      duration: 'permanent', // Important: permanent for refresh token
      scope: 'submit read identity', // Minimal scopes needed for commenting
    });

    return `https://www.reddit.com/api/v1/authorize?${params.toString()}`;
  }

  async waitForManualCode(): Promise<string> {
    return new Promise((resolve) => {
      console.log('\n📋 After authorizing, you will be redirected to your callback URL.');
      console.log('📋 The URL will contain a "code" parameter.');
      console.log('📋 Copy the ENTIRE URL and paste it below.\n');
      
      process.stdin.setEncoding('utf8');
      process.stdin.resume();
      
      process.stdout.write('Paste the callback URL here: ');
      
      process.stdin.on('data', (data: string) => {
        const input = data.toString().trim();
        
        try {
          const parsedUrl = new URL(input);
          const code = parsedUrl.searchParams.get('code');
          const state = parsedUrl.searchParams.get('state');
          const error = parsedUrl.searchParams.get('error');
          
          if (error) {
            console.log(`❌ OAuth error: ${error}`);
            process.exit(1);
          }
          
          if (!code) {
            console.log('❌ No authorization code found in URL. Please try again.');
            process.exit(1);
          }
          
          if (state !== this.state) {
            console.log('❌ Invalid state parameter. Please try again.');
            process.exit(1);
          }
          
          resolve(code);
        } catch (error) {
          console.log('❌ Invalid URL format. Please copy the complete callback URL.');
          process.exit(1);
        }
      });
    });
  }

  async exchangeCodeForTokens(code: string): Promise<{ access_token: string; refresh_token: string }> {
    log('INFO', '🔄 Exchanging authorization code for tokens...');

    const auth = Buffer.from(`${REDDIT_CONFIG.clientId}:${REDDIT_CONFIG.clientSecret}`).toString('base64');
    
    const response = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': REDDIT_CONFIG.userAgent,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: REDDIT_CONFIG.redirectUri,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      log('ERROR', `Token exchange failed: ${response.status}`, { errorText });
      throw new Error(`Token exchange failed: ${response.status}`);
    }

    const tokens = await response.json();
    log('INFO', '✅ Token exchange successful', { 
      hasAccessToken: !!tokens.access_token,
      hasRefreshToken: !!tokens.refresh_token,
      tokenType: tokens.token_type,
      expiresIn: tokens.expires_in,
      scope: tokens.scope
    });

    if (!tokens.refresh_token) {
      throw new Error('No refresh token received. Make sure duration=permanent was used.');
    }

    return tokens;
  }

  async verifyTokens(accessToken: string): Promise<void> {
    log('INFO', '🔍 Verifying tokens by getting user info...');

    const response = await fetch('https://oauth.reddit.com/api/v1/me', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'User-Agent': REDDIT_CONFIG.userAgent,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      log('ERROR', `Token verification failed: ${response.status}`, { errorText });
      throw new Error(`Token verification failed: ${response.status}`);
    }

    const userInfo = await response.json();
    log('INFO', '✅ Token verification successful', {
      username: userInfo.name,
      id: userInfo.id,
      hasVerifiedEmail: userInfo.has_verified_email,
      accountCreated: new Date(userInfo.created_utc * 1000).toISOString()
    });

    log('INFO', `🤖 Bot will comment as Reddit user: u/${userInfo.name}`);
  }

  stopServer(): void {
    if (this.server) {
      this.server.close();
      log('INFO', '🛑 Local server stopped');
    }
  }
}

async function main() {
  try {
    log('INFO', '🚀 Starting Bot OAuth Setup');
    log('INFO', '📋 This will set up OAuth authentication for the Reddit commenting bot');
    
    // Validate environment
    if (!REDDIT_CONFIG.clientId || !REDDIT_CONFIG.clientSecret || !REDDIT_CONFIG.userAgent) {
      throw new Error('Missing required environment variables: REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USER_AGENT');
    }

    const setup = new BotOAuthSetup();
    
    // Generate auth URL
    const authUrl = setup.generateAuthUrl();
    
    log('INFO', '🔐 OAuth Authorization Required');
    console.log('\n📝 INSTRUCTIONS:');
    console.log('1. Make sure you are logged into Reddit with the account you want the bot to use');
    console.log('2. Open this URL in your browser:');
    console.log('\n   ' + authUrl + '\n');
    console.log('3. Click "Allow" to authorize the application');
    console.log('4. You will be redirected to your callback URL');
    console.log('5. Copy the ENTIRE callback URL and paste it when prompted\n');

    // Wait for manual code input
    const authCode = await setup.waitForManualCode();
    log('INFO', '✅ Authorization code received');

    // Exchange code for tokens
    const tokens = await setup.exchangeCodeForTokens(authCode);
    
    // Verify tokens work
    await setup.verifyTokens(tokens.access_token);
    
    // Display results
    console.log('\n🎉 SUCCESS! OAuth setup completed.');
    console.log('\n📋 NEXT STEPS:');
    console.log('1. Add this environment variable to your GitHub repository secrets:');
    console.log('\n   REDDIT_BOT_REFRESH_TOKEN=' + tokens.refresh_token + '\n');
    console.log('2. The bot will now be able to post comments automatically!');
    console.log('3. Test locally by setting REDDIT_BOT_REFRESH_TOKEN in your .env.local file');
    
    log('INFO', '✅ Bot OAuth setup completed successfully');
    process.exit(0);
    
  } catch (error) {
    log('ERROR', '❌ Bot OAuth setup failed', { 
      error: error instanceof Error ? error.message : String(error) 
    });
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

export { BotOAuthSetup };