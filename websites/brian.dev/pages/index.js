import {ARTICLES_HOME_QUERY, FEATURED_ARTICLES_HOME_QUERY, PAGE_QUERY} from '@/lib/queries';

import ArticleList from '@/components/ArticleList';
import BlogCta from '@/components/BlogCta';
import { GlobalContext } from "./_app";
import Hero from '@/components/Hero';
import SEO from '@/components/SEO'
import SubscribeCTA from '@/components/SubscribeCTA';
import { initializeApollo } from "@/lib/apolloClient";
import { useContext } from "react";

function IndexPage({  posts, homepage }) {
  const { writer } = useContext(GlobalContext);

  return (
    <div className="">
      <SEO seo={homepage.seo} />

      {/* hero section */}
      <Hero writer={writer} title={homepage.title} content={homepage.body} />


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
  const apolloClient = initializeApollo();
  const [regular,featured,page] = await Promise.all([
    apolloClient.query({
      query: ARTICLES_HOME_QUERY,
    }),
    apolloClient.query({
      query: FEATURED_ARTICLES_HOME_QUERY,
    }),
    apolloClient.query({
      query: PAGE_QUERY,
      variables: {
        pageID: "index"
    }
    }),
  ]);

  var posts = merge(featured.data.allArticles,regular.data.allArticles,"id")
  return {
    props: {
      initialApolloState: apolloClient.cache.extract(),
      posts,
      homepage: page.data.Page,
    },
    revalidate: 30,

  }
}
function merge(a, b, prop) {
  var reduced = a.filter(aitem => !b.find(bitem => aitem[prop] === bitem[prop]))
  return reduced.concat(b);
}
export default IndexPage;
/*
,
    apolloClient.query({
      query: FEATURED_ARTICLES_HOME_QUERY,
    }),
    apolloClient.query({
      query: PAGE_QUERY,
      variables: {
        pageID: "home"
    }
    })
      console.log(featured)
  console.log(homepage)
*/
