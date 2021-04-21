import {ALL_ARTICLES_QUERY} from '@/lib/queries';
import ArticleList from '@/components/ArticleList';
import SEO from '@/components/SEO'
import SearchBar from '@/components/SearchBar';
import { initializeApollo } from "@/lib/apolloClient";
import { useState } from 'react';

function BlogPage({ posts }) {
  const seo = {
    metaTitle: 'Blog'
  };
  const [filteredPosts, setFilteredPosts] = useState(posts);

  function filterResults(searchTerm) {
    let tempArray = [];
    posts.forEach((post) => {
      if (post.title.toLowerCase().includes(searchTerm.toLowerCase())) {
        tempArray.push(post)
      }
    })
    setFilteredPosts(tempArray);
  }

  return (
    <div className="container mx-auto mb-20 min-h-screen">
      <SEO seo={seo} />
      <h1 className="leading-loose font-extrabold text-4xl text-center text-gray-900 dark:text-white mb-4">
        Blog
      </h1>

      {/* search bar */}
      <SearchBar filterResults={filterResults} />

      {/* blogs */}
      <ArticleList posts={filteredPosts} showPagination={true} />

    </div>
  )
}

export async function getStaticProps() {
  const apolloClient = initializeApollo();
  const articles = await
    apolloClient.query({
      query: ALL_ARTICLES_QUERY
    });
    const posts = articles.data.allArticles;
  return {
    props: {
      initialApolloState: apolloClient.cache.extract(),
      posts: posts,
    },
    revalidate: 30,

  }
}

export default BlogPage;
