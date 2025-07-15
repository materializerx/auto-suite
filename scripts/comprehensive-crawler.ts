import * as dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { RedditPost, Post, CrawlerResult, ImageValidation } from './types';

// Load environment variables
dotenv.config({ path: '.env.local' });

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY!;

const supabase = createClient(supabaseUrl, supabaseAnonKey);

const REDDIT_CONFIG = {
  clientId: process.env.REDDIT_CLIENT_ID!,
  clientSecret: process.env.REDDIT_CLIENT_SECRET!,
  userAgent: process.env.REDDIT_USER_AGENT!,
};

// Conservative crawl strategies (guaranteed completion)
const CRAWL_STRATEGIES = [
  { sort: 'new', batches: 5, priority: 1, description: 'Newest posts (fresh content pipeline) - up to 500' },
  { sort: 'hot', batches: 2, priority: 2, description: 'Currently trending posts - up to 200' },
  { sort: 'top', time: 'week', batches: 1, priority: 3, description: 'Top posts this week - up to 100' },
  { sort: 'top', time: 'month', batches: 1, priority: 4, description: 'Top posts this month - up to 100' },
  { sort: 'top', time: 'year', batches: 1, priority: 5, description: 'Top posts this year - up to 100' },
];

// Database helper functions (same as before)
async function insertPost(post: Omit<Post, 'id' | 'created_at_app'>): Promise<Post | null> {
  try {
    const { data, error } = await supabase
      .from('posts')
      .insert(post)
      .select()
      .single();

    if (error) {
      console.error('Error inserting post:', error);
      return null;
    }
    return data;
  } catch (error) {
    console.error('Error inserting post:', error);
    return null;
  }
}

async function checkPostExists(redditId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('posts')
      .select('id')
      .eq('reddit_id', redditId)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error('Error checking post existence:', error);
      return false;
    }
    return !!data;
  } catch (error) {
    console.error('Error checking post existence:', error);
    return false;
  }
}

// Image validation functions (same as before)
function isImageUrl(url: string): boolean {
  const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
  const imageDomains = ['i.redd.it', 'i.imgur.com', 'preview.redd.it'];
  
  const hasImageExtension = imageExtensions.some(ext => 
    url.toLowerCase().includes(ext)
  );
  
  const hasImageDomain = imageDomains.some(domain => 
    url.includes(domain)
  );
  
  return hasImageExtension || hasImageDomain;
}

function isGalleryUrl(url: string): boolean {
  return url.includes('reddit.com/gallery/');
}

function isImgurAlbumUrl(url: string): boolean {
  return url.includes('imgur.com/a/') || url.includes('imgur.com/gallery/');
}

async function extractImageFromImgurAlbum(url: string): Promise<string | null> {
  try {
    const albumMatch = url.match(/imgur\.com\/(?:a|gallery)\/([a-zA-Z0-9]+)/);
    if (albumMatch) {
      const albumId = albumMatch[1];
      const possibleUrls = [
        `https://i.imgur.com/${albumId}.jpg`,
        `https://i.imgur.com/${albumId}.png`,
        `https://i.imgur.com/${albumId}.gif`
      ];
      
      for (const testUrl of possibleUrls) {
        try {
          const response = await fetch(testUrl, {
            method: 'HEAD',
            signal: AbortSignal.timeout(2000),
          });
          if (response.ok && response.headers.get('content-type')?.startsWith('image/')) {
            return testUrl;
          }
        } catch (error) {
          // Continue to next URL
        }
      }
    }
    return null;
  } catch (error) {
    console.error('Error extracting image from Imgur album:', error);
    return null;
  }
}

async function extractFirstImageFromGallery(post: any): Promise<string | null> {
  try {
    if (!post.is_gallery || !post.media_metadata) {
      return null;
    }

    // Use gallery_data.items for correct order
    if (post.gallery_data && post.gallery_data.items && post.gallery_data.items.length > 0) {
      const firstItem = post.gallery_data.items[0];
      const firstMediaId = firstItem.media_id;
      const mediaItem = post.media_metadata[firstMediaId];

      if (mediaItem && mediaItem.s && mediaItem.s.u) {
        const imageUrl = mediaItem.s.u.replace(/&amp;/g, '&');
        return imageUrl;
      }
    }

    // Fallback to Object.keys() if gallery_data is missing
    const mediaIds = Object.keys(post.media_metadata);
    if (mediaIds.length === 0) {
      return null;
    }

    const firstMediaId = mediaIds[0];
    const mediaItem = post.media_metadata[firstMediaId];

    if (mediaItem && mediaItem.s && mediaItem.s.u) {
      const imageUrl = mediaItem.s.u.replace(/&amp;/g, '&');
      return imageUrl;
    }

    return null;
  } catch (error) {
    console.error('Error extracting image from gallery:', error);
    return null;
  }
}

async function validateImage(post: any): Promise<ImageValidation> {
  if (!post.url) {
    return { isValid: false, url: '', reason: 'No URL found' };
  }
  
  if (post.is_video) {
    return { isValid: false, url: post.url, reason: 'Post is a video' };
  }
  
  // Handle direct image URLs
  if (isImageUrl(post.url)) {
    return { isValid: true, url: post.url };
  }
  
  // Handle gallery posts
  if (isGalleryUrl(post.url)) {
    const firstImage = await extractFirstImageFromGallery(post);
    if (firstImage) {
      return { isValid: true, url: firstImage };
    } else {
      return { isValid: false, url: post.url, reason: 'Could not extract image from gallery' };
    }
  }
  
  // Handle Imgur album URLs
  if (isImgurAlbumUrl(post.url)) {
    const extractedImage = await extractImageFromImgurAlbum(post.url);
    if (extractedImage) {
      return { isValid: true, url: extractedImage };
    } else {
      return { isValid: false, url: post.url, reason: 'Could not extract image from Imgur album' };
    }
  }
  
  return { isValid: false, url: post.url, reason: 'URL is not an image or gallery' };
}

// Reddit API authentication
let accessToken: string | null = null;

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
    
    console.log('✅ Reddit API authentication successful');
    
    return accessToken;
  } catch (error) {
    console.error('❌ Failed to authenticate with Reddit API:', error);
    throw error;
  }
}

// Fetch posts with pagination support
async function fetchRedditPostsBatch(
  subreddit: string, 
  sort: string, 
  timeFilter?: string,
  after?: string,
  limit: number = 100
): Promise<{ posts: any[], after: string | null }> {
  try {
    const token = await getAccessToken();
    
    let url = `https://oauth.reddit.com/r/${subreddit}/${sort}?limit=${limit}`;
    if (timeFilter) url += `&t=${timeFilter}`;
    if (after) url += `&after=${after}`;
    
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': REDDIT_CONFIG.userAgent,
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    const posts = data.data.children.map((child: any) => child.data);
    const nextAfter = data.data.after;
    
    return { posts, after: nextAfter };
  } catch (error) {
    console.error('❌ Failed to fetch posts from Reddit:', error);
    throw error;
  }
}

// Process a batch of posts
async function processPosts(posts: any[], strategyName: string): Promise<{ inserted: number, skipped: number, errors: number }> {
  let inserted = 0;
  let skipped = 0;
  let errors = 0;

  for (const post of posts) {
    try {
      // Validate image
      const imageValidation = await validateImage(post);
      if (!imageValidation.isValid) {
        skipped++;
        continue;
      }

      // Check if post already exists
      const exists = await checkPostExists(post.id);
      if (exists) {
        skipped++;
        continue;
      }

      // Create post object
      const newPost: Omit<Post, 'id' | 'created_at_app'> = {
        reddit_id: post.id,
        image_url: imageValidation.url,
        title: post.title,
        username: post.author,
        created_at: new Date(post.created_utc * 1000).toISOString(),
        reddit_score: post.score,
        elo: 1500,
        wins: 0,
        losses: 0,
      };

      // Insert into database
      const insertedPost = await insertPost(newPost);
      if (insertedPost) {
        console.log(`✅ [${strategyName}] Inserted: "${post.title.substring(0, 50)}..."`);
        inserted++;
      } else {
        errors++;
      }

    } catch (error) {
      console.error(`❌ [${strategyName}] Error processing post ${post.id}:`, error);
      errors++;
    }
  }

  return { inserted, skipped, errors };
}

// Main comprehensive crawler
async function comprehensiveCrawl(): Promise<CrawlerResult> {
  const totalResult: CrawlerResult = {
    processed: 0,
    inserted: 0,
    skipped: 0,
    errors: 0,
  };

  console.log('🚀 Starting comprehensive Reddit crawler for r/MeJulgue');
  console.log('📊 Strategy Priority: new > hot > top week > top month > top year\n');

  for (const strategy of CRAWL_STRATEGIES) {
    console.log(`🎯 [Priority ${strategy.priority}] ${strategy.description}`);
    console.log(`   Fetching ${strategy.batches} batches of 100 posts each...`);

    let after: string | null = null;
    let strategyInserted = 0;
    let strategySkipped = 0;
    let strategyErrors = 0;

    for (let batch = 1; batch <= strategy.batches; batch++) {
      try {
        const { posts, after: nextAfter } = await fetchRedditPostsBatch(
          'MeJulgue',
          strategy.sort,
          strategy.time,
          after || undefined,
          100
        );

        console.log(`   📥 Batch ${batch}/${strategy.batches}: Fetched ${posts.length} posts`);

        if (posts.length === 0) {
          console.log(`   ⚠️  No more posts available for ${strategy.sort}`);
          break;
        }

        const batchResult = await processPosts(posts, `${strategy.sort}${strategy.time ? `-${strategy.time}` : ''}`);
        
        strategyInserted += batchResult.inserted;
        strategySkipped += batchResult.skipped;
        strategyErrors += batchResult.errors;
        totalResult.processed += posts.length;

        after = nextAfter;
        if (!after) {
          console.log(`   ✅ Reached end of ${strategy.sort} posts`);
          break;
        }

        // Small delay to respect rate limits (reduced for speed)
        await new Promise(resolve => setTimeout(resolve, 200));

      } catch (error) {
        console.error(`❌ Error in batch ${batch} for ${strategy.sort}:`, error);
        strategyErrors++;
        
        // Fail fast on authentication errors
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage.includes('401') || errorMessage.includes('HTTP error! status: 401')) {
          console.error('❌ Authentication failed - stopping crawler');
          throw error;
        }
      }
    }

    console.log(`   📊 ${strategy.sort}: ${strategyInserted} inserted, ${strategySkipped} skipped, ${strategyErrors} errors\n`);
    
    totalResult.inserted += strategyInserted;
    totalResult.skipped += strategySkipped;
    totalResult.errors += strategyErrors;
  }

  console.log('🎉 Comprehensive crawl completed:');
  console.log(`   Total Processed: ${totalResult.processed}`);
  console.log(`   Total Inserted: ${totalResult.inserted}`);
  console.log(`   Total Skipped: ${totalResult.skipped}`);
  console.log(`   Total Errors: ${totalResult.errors}`);

  // Fail if no posts were processed and there were errors
  if (totalResult.processed === 0 && totalResult.errors > 0) {
    throw new Error(`Crawler failed: 0 posts processed with ${totalResult.errors} errors`);
  }

  return totalResult;
}

// Run crawler if called directly
if (require.main === module) {
  comprehensiveCrawl()
    .then(() => {
      console.log('✅ Comprehensive crawler finished successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('❌ Comprehensive crawler failed:', error);
      process.exit(1);
    });
}

export { comprehensiveCrawl };