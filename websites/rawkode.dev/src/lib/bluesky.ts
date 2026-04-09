export interface BlueskyPost {
  uri: string;
  text: string;
  createdAt: string;
  likeCount: number;
  repostCount: number;
  replyCount: number;
  postUrl: string;
}

export async function getBlueskyPosts(limit = 6): Promise<BlueskyPost[]> {
  try {
    const url = `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=rawkode.dev&limit=${limit + 4}&filter=posts_no_replies`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json() as { feed: any[] };
    return data.feed
      .filter((item) => item.post.author.handle === 'rawkode.dev' && item.post.record.text?.trim())
      .slice(0, limit)
      .map((item) => {
        const rkey = item.post.uri.split('/').pop() ?? '';
        return {
          uri: item.post.uri,
          text: item.post.record.text as string,
          createdAt: item.post.record.createdAt as string,
          likeCount: (item.post.likeCount ?? 0) as number,
          repostCount: (item.post.repostCount ?? 0) as number,
          replyCount: (item.post.replyCount ?? 0) as number,
          postUrl: `https://bsky.app/profile/rawkode.dev/post/${rkey}`,
        };
      });
  } catch {
    return [];
  }
}
