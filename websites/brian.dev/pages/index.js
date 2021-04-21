import { fetchAPI, fetchArticlesHome, fetchFeaturedArticles } from "@/lib/api";

import ArticleList from '@/components/ArticleList';
import BlogCta from '@/components/BlogCta';
import { GlobalContext } from "./_app";
import { GraphQLClient } from 'graphql-request';
import Hero from '@/components/Hero';
import SEO from '@/components/SEO'
import SubscribeCTA from '@/components/SubscribeCTA';
import { getSdk } from '@/lib/sdk.ts'; // THIS FILE IS THE GENERATED FILE
import { useContext } from "react";

function IndexPage({ page, posts, homepage }) {
  const { writer } = useContext(GlobalContext);

  return (
    <div className="">
      <SEO seo={homepage.seo} />

      {/* hero section */}
      <Hero writer={writer} title={page.title} content={homepage.hero.content} />


      {/* article section */}
      <h1 className="tracking-tighter leading-loose font-extrabold text-4xl text-center text-gray-900 dark:text-white my-4 sm:pt-4">
        Featured and Recent Posts
      </h1>
      <ArticleList posts={posts} showPagination={false} />

      {/* blog cta section */}
      <BlogCta />

      {/* subscribe cta section */}
      <div className="px-4 mb-8 sm:mb-12 mx-auto max-w-xl">
        <SubscribeCTA />
      </div>
    </div>
  )
}

export async function getStaticProps() {

  const client = new GraphQLClient('http://127.0.0.1:4000/');
  const sdk = getSdk(client);
  const page = await sdk.findPage('{"pageId":"index"}')
  console.log(page)

  // fetch up to 10 posts on main page
  const [regular, featured, homepage] = await Promise.all([
    fetchArticlesHome(2),
    fetchFeaturedArticles(1),
    fetchAPI("/homepage"),
  ]);
  console.log(page)

  var posts = merge(featured, regular, "slug")
  return {
    props: {
      page,
      posts,
      homepage
    },
  }
}
function merge(a, b, prop) {
  var reduced = a.filter(aitem => !b.find(bitem => aitem[prop] === bitem[prop]))
  return reduced.concat(b);
}
export default IndexPage;
