// Reddit API types
export interface RedditPost {
  id: string;
  title: string;
  author: string;
  subreddit: string;
  url: string;
  created_utc: number;
  score: number;
  is_video: boolean;
  post_hint?: string;
  preview?: {
    images: Array<{
      source: {
        url: string;
        width: number;
        height: number;
      };
    }>;
  };
}

// Database types
export interface Post {
  id: string;
  reddit_id: string;
  image_url: string;
  title: string;
  username: string;
  created_at: string;
  reddit_score: number;
  elo: number;
  wins: number;
  losses: number;
  created_at_app: string;
}

// Crawler types
export interface CrawlerResult {
  processed: number;
  inserted: number;
  skipped: number;
  errors: number;
}

// Image validation
export interface ImageValidation {
  isValid: boolean;
  url: string;
  reason?: string;
}