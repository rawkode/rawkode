import { getArticlesHome, getFeaturedArticlesHome, getPage } from '@/lib/cms';

import ArticleList from '@/components/ArticleList';
import BlogCta from '@/components/BlogCta';
import { GlobalContext } from "./_app";
import { GraphQLClient } from 'graphql-request';
import Hero from '@/components/Hero';
import SEO from '@/components/SEO'
import SubscribeCTA from '@/components/SubscribeCTA';
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




  // fetch up to 10 posts on main page
  const [regular, featured, homepage] = await Promise.all([
    getArticlesHome(),
    getFeaturedArticlesHome(),
    getPage('index'),
  ]);

  var posts = merge(featured, regular, "id")
  return {
    props: {
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
