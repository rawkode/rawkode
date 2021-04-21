import { fetchArticle, fetchArticleSlugs } from "@/lib/api";

import PostContent from '@/components/PostContent';

function Post({ post }) {

  return (
    <PostContent
      post={post}
    />
  )
}

export async function getStaticPaths() {
  const blogPostSlugs = await fetchArticleSlugs();

  const paths = blogPostSlugs.map((slug) => {
    return {
      params: { slug }
    }
  });

  return {
    paths,
    fallback: false,
  }
}

export async function getStaticProps({ params }) {
  const post = await fetchArticle(params.slug)

  return {
    props: {
      post,
    },
    revalidate: 30, // In seconds
  }
}

export default Post;