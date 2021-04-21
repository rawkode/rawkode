import { getArticle, getArticleSlugs } from "@/lib/cms";

import Bleed from '@/lib/mdx/bleed'
import Callout from '@lib/mdx/callout'
import PostContent from '@/components/PostContent';
import hydrate from 'next-mdx-remote/hydrate'
import renderToString from 'next-mdx-remote/render-to-string'

const components = { Bleed,Callout }
function Post({ source, post }) {
  const content = hydrate(source)
  return (
    <PostContent
      post={post}
      content={content}
    />
  )
}

export async function getStaticPaths() {
  const blogPostSlugs = await getArticleSlugs();

  const paths = blogPostSlugs.map(({id}) => {
    return {
      params: { slug: id }
    }
  });

  return {
    paths,
    fallback: false,
  }
}

export async function getStaticProps({ params }) {
  const post = await getArticle(params.slug)
  const mdxSource = await renderToString(post.body,components)


  return {
    props: {
      source: mdxSource,
      post,
    },
    revalidate: 30, // In seconds
  }
}

export default Post;
