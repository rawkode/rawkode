import ArticleList from '@/components/ArticleList';
import SEO from '@/components/SEO'
import SearchBar from '@/components/SearchBar';
import { fetchArticles } from "@/lib/api";
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
  // fetch all posts
  const posts = await fetchArticles()

  return {
    props: {
      posts,
    },
  }
}

export default BlogPage;
