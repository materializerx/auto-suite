import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config({ path: '.env.local' });

const REDDIT_CONFIG = {
  clientId: process.env.REDDIT_CLIENT_ID!,
  clientSecret: process.env.REDDIT_CLIENT_SECRET!,
  userAgent: process.env.REDDIT_USER_AGENT!,
  refreshToken: process.env.REDDIT_BOT_REFRESH_TOKEN!,
};

interface TokenInfo {
  access_token: string;
  expires_at: number; // Unix timestamp
  token_type: string;
  scope: string;
}

class RedditOAuthManager {
  private currentToken: TokenInfo | null = null;
  
  /**
   * Get a valid access token, refreshing if necessary
   */
  async getAccessToken(): Promise<string> {
    // Check if we have a current token and if it's still valid
    if (this.currentToken && this.currentToken.expires_at > Date.now() / 1000 + 60) {
      // Token is still valid (with 60 second buffer)
      return this.currentToken.access_token;
    }
    
    // Token is expired or doesn't exist, refresh it
    await this.refreshAccessToken();
    
    if (!this.currentToken) {
      throw new Error('Failed to obtain access token');
    }
    
    return this.currentToken.access_token;
  }
  
  /**
   * Refresh the access token using the refresh token
   */
  private async refreshAccessToken(): Promise<void> {
    if (!REDDIT_CONFIG.refreshToken) {
      throw new Error('REDDIT_BOT_REFRESH_TOKEN environment variable is required. Run setup-bot-oauth.ts first.');
    }
    
    const auth = Buffer.from(`${REDDIT_CONFIG.clientId}:${REDDIT_CONFIG.clientSecret}`).toString('base64');
    
    const response = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': REDDIT_CONFIG.userAgent,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: REDDIT_CONFIG.refreshToken,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ Token refresh failed:', response.status, errorText);
      throw new Error(`Token refresh failed: ${response.status}`);
    }

    const tokenData = await response.json();
    
    // Calculate expiration time (current time + expires_in seconds)
    const expiresAt = Math.floor(Date.now() / 1000) + tokenData.expires_in;
    
    this.currentToken = {
      access_token: tokenData.access_token,
      expires_at: expiresAt,
      token_type: tokenData.token_type,
      scope: tokenData.scope,
    };
    
    console.log('✅ Access token refreshed successfully');
    console.log(`   Token expires at: ${new Date(expiresAt * 1000).toISOString()}`);
    console.log(`   Token scope: ${tokenData.scope}`);
  }
  
  /**
   * Make an authenticated request to Reddit API
   */
  async makeAuthenticatedRequest(url: string, options: RequestInit = {}): Promise<Response> {
    const accessToken = await this.getAccessToken();
    
    const authenticatedOptions: RequestInit = {
      ...options,
      headers: {
        ...options.headers,
        'Authorization': `Bearer ${accessToken}`,
        'User-Agent': REDDIT_CONFIG.userAgent,
      },
    };
    
    return fetch(url, authenticatedOptions);
  }
  
  /**
   * Post a comment to Reddit
   */
  async postComment(postId: string, commentText: string): Promise<boolean> {
    try {
      const response = await this.makeAuthenticatedRequest(
        'https://oauth.reddit.com/api/comment',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            thing_id: `t3_${postId}`,
            text: commentText,
          }),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`❌ Comment posting failed: ${response.status}`, errorText);
        return false;
      }

      const result = await response.json();
      
      // Check for Reddit API errors
      if (result.json && result.json.errors && result.json.errors.length > 0) {
        console.error('❌ Reddit API returned errors:', result.json.errors);
        return false;
      }
      
      // Check for success
      if (result.json && result.json.data && result.json.data.things) {
        console.log('✅ Comment posted successfully');
        console.log(`   Comment ID: ${result.json.data.things[0]?.data?.id || 'Unknown'}`);
        return true;
      }
      
      // Check for success flag
      if (result.success === true) {
        console.log('✅ Comment posted successfully');
        return true;
      }
      
      console.error('❌ Unexpected response format:', result);
      return false;
      
    } catch (error) {
      console.error('❌ Error posting comment:', error);
      return false;
    }
  }
  
  /**
   * Verify authentication by getting current user info
   */
  async verifyAuthentication(): Promise<{ username: string; id: string } | null> {
    try {
      const response = await this.makeAuthenticatedRequest('https://oauth.reddit.com/api/v1/me');
      
      if (!response.ok) {
        console.error(`❌ Authentication verification failed: ${response.status}`);
        return null;
      }
      
      const userInfo = await response.json();
      return {
        username: userInfo.name,
        id: userInfo.id,
      };
      
    } catch (error) {
      console.error('❌ Error verifying authentication:', error);
      return null;
    }
  }
}

// Export singleton instance
export const redditOAuth = new RedditOAuthManager();
export { RedditOAuthManager };