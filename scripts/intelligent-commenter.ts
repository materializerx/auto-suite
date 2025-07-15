import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { createClient } from '@supabase/supabase-js';
import { redditOAuth } from './reddit-oauth-manager';

// Load environment variables
dotenv.config({ path: '.env.local' });

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY!;
const openaiApiKey = process.env.OPENAI_API_KEY!;

const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Reddit API configuration
const REDDIT_CONFIG = {
  clientId: process.env.REDDIT_CLIENT_ID!,
  clientSecret: process.env.REDDIT_CLIENT_SECRET!,
  userAgent: process.env.REDDIT_USER_AGENT!,
};

// Types
interface CommenterConfig {
  commenting: {
    maxCommentsPerRun: number;
    delayBetweenComments: number;
    maxCommentsPerDay: number;
    cooldownAfterRateLimit: number;
  };
  postSelection: {
    minCommentCount: number;
    maxPostAgeHours: number;
    candidateBatchSize: number;
    topCommentsToFetch: number;
    excludeAutoreply: boolean;
  };
  qualityControl: {
    dryRunMode: boolean;
    maxCommentLength: number;
    minCommentLength: number;
    blacklistedKeywords: string[];
    requirePortuguese: boolean;
  };
  api: {
    requestTimeout: number;
    maxRetries: number;
    batchDelay: number;
  };
  logging: {
    logLevel: string;
    includeApiMetrics: boolean;
    includePerformanceMetrics: boolean;
  };
}

interface RedditPost {
  id: string;
  title: string;
  selftext: string;
  author: string;
  url: string;
  created_utc: number;
  num_comments: number;
  score: number;
  is_video: boolean;
}

interface RedditComment {
  id: string;
  body: string;
  author: string;
  score: number;
  created_utc: number;
}

interface CommenterResult {
  processed: number;
  commented: number;
  skipped: number;
  errors: number;
  apiCallsUsed: number;
}

// Global variables
let accessToken: string | null = null;
let config: CommenterConfig;
let promptTemplate: string;

// Utility functions
function loadConfig(): CommenterConfig {
  const configPath = path.join(process.cwd(), 'config', 'commenter-config.json');
  const configData = fs.readFileSync(configPath, 'utf8');
  return JSON.parse(configData);
}

function loadPromptTemplate(): string {
  const promptPath = path.join(process.cwd(), 'prompts', 'commenter-prompt.txt');
  return fs.readFileSync(promptPath, 'utf8');
}

function log(level: 'INFO' | 'WARN' | 'ERROR', message: string, data?: any) {
  const timestamp = new Date().toISOString();
  const emoji = level === 'INFO' ? '✅' : level === 'WARN' ? '⚠️' : '❌';
  
  if (data) {
    console.log(`${emoji} ${level}: ${message}`, data);
  } else {
    console.log(`${emoji} ${level}: ${message}`);
  }
}

function formatPostAge(createdUtc: number): string {
  const now = Math.floor(Date.now() / 1000);
  const ageHours = Math.floor((now - createdUtc) / 3600);
  
  if (ageHours < 1) return 'menos de 1 hora';
  if (ageHours < 24) return `${ageHours} horas`;
  const ageDays = Math.floor(ageHours / 24);
  return `${ageDays} dias`;
}

function isImageUrl(url: string): boolean {
  const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
  const imageDomains = ['i.redd.it', 'i.imgur.com', 'preview.redd.it'];
  
  const hasImageExtension = imageExtensions.some(ext => 
    url.toLowerCase().includes(ext)
  );
  
  const hasImageDomain = imageDomains.some(domain => 
    url.includes(domain)
  );
  
  return hasImageExtension || hasImageDomain || url.includes('reddit.com/gallery/');
}

// Database functions
async function checkAlreadyCommented(redditPostId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('bot_comments')
      .select('id')
      .eq('reddit_post_id', redditPostId)
      .single();

    if (error && error.code !== 'PGRST116') {
      log('ERROR', `Error checking if already commented on ${redditPostId}:`, error);
      return false;
    }

    return !!data;
  } catch (error) {
    log('ERROR', `Error checking comment status for ${redditPostId}:`, error);
    return false;
  }
}

async function recordComment(redditPostId: string): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('bot_comments')
      .insert({ reddit_post_id: redditPostId });

    if (error) {
      log('ERROR', `Failed to record comment for ${redditPostId}:`, error);
      return false;
    }

    log('INFO', `✅ Database updated: bot_comments record created for ${redditPostId}`);
    return true;
  } catch (error) {
    log('ERROR', `Error recording comment for ${redditPostId}:`, error);
    return false;
  }
}

// Reddit API functions
async function getAccessToken(): Promise<string> {
  if (accessToken) return accessToken;

  try {
    const auth = Buffer.from(`${REDDIT_CONFIG.clientId}:${REDDIT_CONFIG.clientSecret}`).toString('base64');
    
    const response = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': REDDIT_CONFIG.userAgent,
      },
      body: 'grant_type=client_credentials',
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    accessToken = data.access_token;
    
    if (!accessToken) {
      throw new Error('No access token received from Reddit API');
    }
    
    log('INFO', '✅ Reddit API authentication successful');
    return accessToken;
  } catch (error) {
    log('ERROR', '❌ Failed to authenticate with Reddit API:', error);
    throw error;
  }
}

async function fetchHotPosts(): Promise<RedditPost[]> {
  try {
    const token = await getAccessToken();
    const startTime = Date.now();
    
    const response = await fetch(
      `https://oauth.reddit.com/r/MeJulgue/hot?limit=${config.postSelection.candidateBatchSize}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'User-Agent': REDDIT_CONFIG.userAgent,
        },
        signal: AbortSignal.timeout(config.api.requestTimeout),
      }
    );

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    const posts = data.data.children.map((child: any) => child.data);
    const responseTime = Date.now() - startTime;
    
    log('INFO', `📥 Fetched ${posts.length} hot posts from r/MeJulgue in ${responseTime}ms`);
    
    if (config.logging.includeApiMetrics) {
      const remaining = response.headers.get('x-ratelimit-remaining');
      if (remaining) {
        log('INFO', `📊 Rate limit remaining: ${remaining}/60 requests`);
      }
    }
    
    return posts;
  } catch (error) {
    log('ERROR', '❌ Failed to fetch hot posts from Reddit:', error);
    throw error;
  }
}

async function fetchPostComments(postId: string): Promise<RedditComment[]> {
  try {
    const startTime = Date.now();
    
    const response = await redditOAuth.makeAuthenticatedRequest(
      `https://oauth.reddit.com/r/MeJulgue/comments/${postId}?sort=top&limit=${config.postSelection.topCommentsToFetch}`,
      {
        signal: AbortSignal.timeout(config.api.requestTimeout),
      }
    );

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    const comments = data[1].data.children
      .map((child: any) => child.data)
      .filter((comment: any) => comment.body && comment.body !== '[deleted]' && comment.body.length > 10);
    
    const responseTime = Date.now() - startTime;
    log('INFO', `📖 Retrieved ${comments.length} comments for post ${postId} in ${responseTime}ms`);
    
    return comments;
  } catch (error) {
    log('ERROR', `❌ Failed to fetch comments for post ${postId}:`, error);
    throw error;
  }
}

async function postComment(postId: string, commentText: string): Promise<boolean> {
  if (config.qualityControl.dryRunMode) {
    console.log('\n🎭 =================== DRY RUN COMMENT ===================');
    console.log(`📍 Post ID: ${postId}`);
    console.log(`💬 Generated Comment:`);
    console.log(`"${commentText}"`);
    console.log('🎭 ======================================================\n');
    return true;
  }

  try {
    const success = await redditOAuth.postComment(postId, commentText);
    
    if (success) {
      log('INFO', `✅ Comment posted successfully to ${postId}`);
    } else {
      log('ERROR', `❌ Failed to post comment to ${postId}`);
    }
    
    return success;
  } catch (error) {
    log('ERROR', `❌ Failed to post comment to ${postId}:`, error);
    return false;
  }
}

// LLM functions
function buildLLMContext(post: RedditPost, comments: RedditComment[]): string {
  const formattedComments = comments
    .slice(0, config.postSelection.topCommentsToFetch)
    .map((c, i) => `${i + 1}. ${c.author}: ${c.body.substring(0, 200)}...`)
    .join('\n');

  return promptTemplate
    .replace('{postTitle}', post.title)
    .replace('{postBody}', post.selftext || '[Apenas imagem]')
    .replace('{postAuthor}', post.author)
    .replace('{commentCount}', post.num_comments.toString())
    .replace('{existingComments}', formattedComments);
}

async function generateComment(post: RedditPost, comments: RedditComment[]): Promise<string | null> {
  try {
    const context = buildLLMContext(post, comments);
    const startTime = Date.now();
    
    log('INFO', `🤖 Sending context to OpenAI for post ${post.id} (${Math.round(context.length / 1024 * 10) / 10}KB context)`);
    
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'user',
            content: context,
          },
        ],
        max_tokens: 150,
        temperature: 0.8,
      }),
      signal: AbortSignal.timeout(config.api.requestTimeout),
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error! status: ${response.status}`);
    }

    const data = await response.json();
    const comment = data.choices[0].message.content.trim();
    const responseTime = Date.now() - startTime;
    
    log('INFO', `🤖 LLM response received in ${responseTime}ms, comment length: ${comment.length} chars`);
    
    // Validate comment
    if (comment.length < config.qualityControl.minCommentLength) {
      log('WARN', `⚠️ Generated comment too short (${comment.length} chars), skipping`);
      return null;
    }
    
    if (comment.length > config.qualityControl.maxCommentLength) {
      log('WARN', `⚠️ Generated comment too long (${comment.length} chars), truncating`);
      return comment.substring(0, config.qualityControl.maxCommentLength);
    }
    
    // Check for blacklisted keywords
    const hasBlacklisted = config.qualityControl.blacklistedKeywords.some(keyword =>
      comment.toLowerCase().includes(keyword.toLowerCase())
    );
    
    if (hasBlacklisted) {
      log('WARN', `⚠️ Generated comment contains blacklisted keyword, skipping`);
      return null;
    }
    
    log('INFO', '✅ Generated comment passed validation');
    return comment;
    
  } catch (error) {
    log('ERROR', `❌ OpenAI API failed for post ${post.id}:`, error);
    return null;
  }
}

// Main processing functions
async function filterCandidatePosts(posts: RedditPost[]): Promise<RedditPost[]> {
  log('INFO', `🔍 Filtering ${posts.length} hot posts...`);
  
  // Filter by comment count
  const withEnoughComments = posts.filter(post => post.num_comments >= config.postSelection.minCommentCount);
  log('INFO', `   ${withEnoughComments.length} posts have ≥${config.postSelection.minCommentCount} comments`);
  
  // Filter by age
  const now = Math.floor(Date.now() / 1000);
  const maxAge = config.postSelection.maxPostAgeHours * 3600;
  const recentPosts = withEnoughComments.filter(post => (now - post.created_utc) <= maxAge);
  log('INFO', `   ${recentPosts.length} posts are within ${config.postSelection.maxPostAgeHours} hours`);
  
  // Filter by image content
  const imagePosts = recentPosts.filter(post => !post.is_video && isImageUrl(post.url));
  log('INFO', `   ${imagePosts.length} posts have valid images`);
  
  // Filter already commented
  const notCommented = [];
  for (const post of imagePosts) {
    const alreadyCommented = await checkAlreadyCommented(post.id);
    if (!alreadyCommented) {
      notCommented.push(post);
    }
  }
  
  log('INFO', `   ${notCommented.length} posts haven't been commented on`);
  log('INFO', `🔍 Final candidates: ${notCommented.length} posts`);
  
  if (notCommented.length > 0) {
    const candidateIds = notCommented.slice(0, 5).map(p => p.id);
    log('INFO', `📝 Top candidates: [${candidateIds.join(', ')}]`);
  }
  
  return notCommented.slice(0, config.commenting.maxCommentsPerRun);
}

async function processPost(post: RedditPost): Promise<boolean> {
  try {
    const postUrl = `https://www.reddit.com/r/MeJulgue/comments/${post.id}/`;
    log('INFO', `📖 Processing post ${post.id}: "${post.title.substring(0, 50)}..."`);
    log('INFO', `🔗 Post URL: ${postUrl}`);
    
    // Fetch comments for context
    const comments = await fetchPostComments(post.id);
    
    if (comments.length < 3) {
      log('WARN', `⚠️ Post ${post.id} has only ${comments.length} useful comments, skipping`);
      return false;
    }
    
    // Generate comment
    const commentText = await generateComment(post, comments);
    if (!commentText) {
      log('WARN', `⚠️ Failed to generate valid comment for post ${post.id}`);
      return false;
    }
    
    // Post comment
    const posted = await postComment(post.id, commentText);
    if (!posted) {
      return false;
    }
    
    // Record in database ONLY if not in dry-run mode
    if (!config.qualityControl.dryRunMode) {
      const recorded = await recordComment(post.id);
      if (!recorded) {
        log('ERROR', `❌ Comment posted but database update failed for ${post.id}`);
        return false;
      }
    } else {
      log('INFO', `🎭 DRY RUN: Skipping database record for ${post.id}`);
    }
    
    // Delay before next comment
    if (config.commenting.delayBetweenComments > 0) {
      log('INFO', `⏳ Waiting ${config.commenting.delayBetweenComments}s before next comment...`);
      await new Promise(resolve => setTimeout(resolve, config.commenting.delayBetweenComments * 1000));
    }
    
    return true;
    
  } catch (error) {
    log('ERROR', `❌ Error processing post ${post.id}:`, error);
    return false;
  }
}

// Main function
async function runIntelligentCommenter(): Promise<CommenterResult> {
  const result: CommenterResult = {
    processed: 0,
    commented: 0,
    skipped: 0,
    errors: 0,
    apiCallsUsed: 0,
  };
  
  const startTime = Date.now();
  
  try {
    log('INFO', '🚀 Starting Intelligent Reddit Commenter v1.0');
    log('INFO', `📋 Config: maxComments=${config.commenting.maxCommentsPerRun}, minComments=${config.postSelection.minCommentCount}, dryRun=${config.qualityControl.dryRunMode}`);
    
    // Fetch hot posts
    const hotPosts = await fetchHotPosts();
    result.apiCallsUsed++;
    
    // Filter candidates
    const candidates = await filterCandidatePosts(hotPosts);
    
    if (candidates.length === 0) {
      log('WARN', '⚠️ No suitable candidates found');
      return result;
    }
    
    // Process each candidate
    for (const post of candidates) {
      result.processed++;
      
      try {
        const success = await processPost(post);
        result.apiCallsUsed += 2; // Comment fetch + LLM call
        
        if (success) {
          result.commented++;
          if (!config.qualityControl.dryRunMode) {
            result.apiCallsUsed++; // Comment post
          }
        } else {
          result.skipped++;
        }
        
      } catch (error) {
        log('ERROR', `❌ Error processing post ${post.id}:`, error);
        result.errors++;
      }
    }
    
    const totalTime = Math.round((Date.now() - startTime) / 1000);
    
    log('INFO', '🎉 Intelligent Commenter run completed');
    log('INFO', `📊 Summary: ${result.processed} processed, ${result.commented} commented, ${result.skipped} skipped, ${result.errors} errors`);
    log('INFO', `📊 Performance: ${totalTime}s total, ${result.apiCallsUsed} API calls used`);
    
    if (result.errors > result.commented) {
      log('WARN', `⚠️ High error rate: ${result.errors}/${result.processed} posts failed`);
    }
    
    return result;
    
  } catch (error) {
    log('ERROR', '❌ Critical failure in Intelligent Commenter:', error);
    throw error;
  }
}

// Initialize and run
async function main() {
  try {
    // Load configuration
    config = loadConfig();
    promptTemplate = loadPromptTemplate();
    
    // Validate environment
    if (!openaiApiKey) {
      throw new Error('OPENAI_API_KEY environment variable is required');
    }
    
    // Verify OAuth authentication
    log('INFO', '🔐 Verifying Reddit OAuth authentication...');
    const userInfo = await redditOAuth.verifyAuthentication();
    if (!userInfo) {
      throw new Error('Reddit OAuth authentication failed. Run "npm run setup-bot-oauth" first.');
    }
    log('INFO', `✅ Authenticated as Reddit user: u/${userInfo.username}`);
    
    // Run commenter
    await runIntelligentCommenter();
    
    log('INFO', '✅ Intelligent Commenter finished successfully');
    process.exit(0);
    
  } catch (error) {
    log('ERROR', '❌ Intelligent Commenter failed:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

export { runIntelligentCommenter };