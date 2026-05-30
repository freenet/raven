export interface Post {
  id: string;
  author: User;
  content: string;
  timestamp: Date;
  likes: number;
  reposts: number;
  replies: number;
  liked: boolean;
  reposted: boolean;
  /** Count of quote reposts of this post (from its thread shard). */
  quotes?: number;
  /** Content address of the post this one quotes, if it is a quote repost. */
  quotedPostId?: string;
}

export interface User {
  displayName: string;
  handle: string;
  avatarColor?: string;
  publicKey?: string;
}

export interface TrendingTopic {
  category: string;
  topic: string;
  postCount: number;
}
