import * as dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { RedditPost, Post, CrawlerResult, ImageValidation } from './types';

// Load environment variables
dotenv.config({ path: '.env.local' });

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY!;

const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Database helper functions
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

    if (error && error.code !== 'PGRST116') { // PGRST116 is "not found"
      console.error('Error checking post existence:', error);
      return false;
    }

    return !!data;
  } catch (error) {
    console.error('Error checking post existence:', error);
    return false;
  }
}

const REDDIT_CONFIG = {
  clientId: process.env.REDDIT_CLIENT_ID!,
  clientSecret: process.env.REDDIT_CLIENT_SECRET!,
  userAgent: process.env.REDDIT_USER_AGENT!,
};

const CRAWLER_CONFIG = {
  subreddit: 'MeJulgue',
  limit: 50,
  timeFilter: 'week' as const,
  sort: 'hot' as const,
};

// Image validation helpers
function isImageUrl(url: string): boolean {
  const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
  const imageDomains = ['i.redd.it', 'i.imgur.com', 'preview.redd.it'];
  
  // Check file extension
  const hasImageExtension = imageExtensions.some(ext => 
    url.toLowerCase().includes(ext)
  );
  
  // Check domain (removed 'imgur.com' - will handle separately)
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
    // Simple conversion: imgur.com/a/abc123 -> i.imgur.com/abc123.jpg
    const albumMatch = url.match(/imgur\.com\/(?:a|gallery)\/([a-zA-Z0-9]+)/);
    if (albumMatch) {
      const albumId = albumMatch[1];
      // Try common image formats
      const possibleUrls = [
        `https://i.imgur.com/${albumId}.jpg`,
        `https://i.imgur.com/${albumId}.png`,
        `https://i.imgur.com/${albumId}.gif`
      ];
      
      // Test each URL quickly
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
    // Check if post has gallery data
    if (!post.is_gallery || !post.media_metadata) {
      return null;
    }

    // Use gallery_data.items for correct order (not Object.keys!)
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

async function checkImageAvailability(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(5000),
    });
    
    // Check if response is OK and content-type is actually an image
    if (!response.ok) return false;
    
    const contentType = response.headers.get('content-type') || '';
    return contentType.startsWith('image/');
  } catch (error) {
    console.error(`Error checking image ${url}:`, error);
    return false;
  }
}

async function validateImage(post: any): Promise<ImageValidation> {
  // Check if post has URL
  if (!post.url) {
    return { isValid: false, url: '', reason: 'No URL found' };
  }
  
  // Check if it's a video
  if (post.is_video) {
    return { isValid: false, url: post.url, reason: 'Post is a video' };
  }
  
  let imageUrl: string | null = null;
  
  // Handle direct image URLs
  if (isImageUrl(post.url)) {
    imageUrl = post.url;
  }
  // Handle Reddit gallery posts
  else if (isGalleryUrl(post.url)) {
    imageUrl = await extractFirstImageFromGallery(post);
    if (!imageUrl) {
      return { isValid: false, url: post.url, reason: 'Could not extract image from gallery' };
    }
  }
  // Handle Imgur album URLs
  else if (isImgurAlbumUrl(post.url)) {
    imageUrl = await extractImageFromImgurAlbum(post.url);
    if (!imageUrl) {
      return { isValid: false, url: post.url, reason: 'Could not extract image from Imgur album' };
    }
  }
  else {
    return { isValid: false, url: post.url, reason: 'URL is not an image or gallery' };
  }
  
  // Ensure we have a valid image URL before checking availability
  if (!imageUrl) {
    return { isValid: false, url: post.url, reason: 'No valid image URL found' };
  }
  
  // Check if the image is actually available
  const isAvailable = await checkImageAvailability(imageUrl);
  if (!isAvailable) {
    return { isValid: false, url: imageUrl, reason: 'Image URL returns 404 or is unavailable' };
  }
  
  return { isValid: true, url: imageUrl };
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

async function fetchRedditPosts(subreddit: string, limit: number = 50): Promise<any[]> {
  try {
    const token = await getAccessToken();
    
    const response = await fetch(
      `https://oauth.reddit.com/r/${subreddit}/hot?limit=${limit}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'User-Agent': REDDIT_CONFIG.userAgent,
        },
      }
    );

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    return data.data.children.map((child: any) => child.data);
  } catch (error) {
    console.error('❌ Failed to fetch posts from Reddit:', error);
    throw error;
  }
}

// Main crawler function
async function crawlReddit(): Promise<CrawlerResult> {
  const result: CrawlerResult = {
    processed: 0,
    inserted: 0,
    skipped: 0,
    errors: 0,
  };
  
  try {
    console.log(`🚀 Starting Reddit crawler for r/${CRAWLER_CONFIG.subreddit}`);
    
    // Fetch posts
    const posts = await fetchRedditPosts(CRAWLER_CONFIG.subreddit, CRAWLER_CONFIG.limit);
    
    console.log(`📥 Fetched ${posts.length} posts from r/${CRAWLER_CONFIG.subreddit}`);
    
    // Process each post
    for (const post of posts) {
      result.processed++;
      
      try {
        // Validate image
        const imageValidation = await validateImage(post);
        if (!imageValidation.isValid) {
          console.log(`⏭️  Skipping post ${post.id}: ${imageValidation.reason}`);
          result.skipped++;
          continue;
        }
        
        // Check if post already exists
        const exists = await checkPostExists(post.id);
        if (exists) {
          console.log(`⏭️  Skipping post ${post.id}: Already exists in database`);
          result.skipped++;
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
          elo: 1500, // Default ELO
          wins: 0,
          losses: 0,
        };
        
        // Insert into database
        const inserted = await insertPost(newPost);
        if (inserted) {
          console.log(`✅ Inserted post ${post.id}: "${post.title.substring(0, 50)}..."`);
          result.inserted++;
        } else {
          console.log(`❌ Failed to insert post ${post.id}`);
          result.errors++;
        }
        
      } catch (error) {
        console.error(`❌ Error processing post ${post.id}:`, error);
        result.errors++;
      }
    }
    
    console.log(`🎉 Crawler completed:`);
    console.log(`   Processed: ${result.processed}`);
    console.log(`   Inserted: ${result.inserted}`);
    console.log(`   Skipped: ${result.skipped}`);
    console.log(`   Errors: ${result.errors}`);
    
    return result;
    
  } catch (error) {
    console.error('❌ Crawler failed:', error);
    throw error;
  }
}

// Run crawler if called directly
if (require.main === module) {
  crawlReddit()
    .then(() => {
      console.log('✅ Crawler finished successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('❌ Crawler failed:', error);
      process.exit(1);
    });
}

export { crawlReddit };