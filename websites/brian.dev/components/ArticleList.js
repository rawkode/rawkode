import { faArrowLeft, faArrowRight } from '@fortawesome/free-solid-svg-icons';
import { useEffect, useState } from 'react';

import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import PostPreview from './PostPreview';

function ArticleList({ posts, showPagination }) {
  const displayNum = 9;
  const [displayedPosts, setDisplayedPosts] = useState(posts);
  const [minIdx, setMinIdx] = useState(0);
  const [maxIdx, setMaxIdx] = useState(Math.min(displayNum, posts.length));

  useEffect(() => {
    if (posts.length > displayNum) {
      setDisplayedPosts(posts.slice(minIdx, displayNum))
    } else {
      setDisplayedPosts(posts)
    }
  }, [posts])

  function indexIncrement(oldIdx) {
    if (posts.length > displayNum) {
      const newIdx = oldIdx + displayNum
      let newMin, newMax
      if (newIdx < posts.length) {
        newMax = newIdx
        newMin = minIdx + displayNum
      } else {
        newMax = posts.length
        newMin = Math.min(minIdx + displayNum, newMax - 1)
      }
      setMinIdx(newMin)
      setMaxIdx(newMax)
      setDisplayedPosts(posts.slice(newMin, newMax))
    }
  }

  function indexDecrement(oldIdx) {
    const newIdx = oldIdx - displayNum
    let newMin, newMax
    if (newIdx >= 0) {
      newMin = newIdx
      newMax = newMin + displayNum
    } else {
      newMin = 0
      newMax = displayNum
    }
    setMinIdx(newMin)
    setMaxIdx(newMax)
    setDisplayedPosts(posts.slice(newMin, newMax))
  }

  return (
    <div className="py-4 md:py-8 lg:py-12 max-w-6xl mx-auto">
      <ul className="flex flex-wrap justify-center md:justify-start w-full px-4 sm:px-8">
        {displayedPosts.map((node) => {
          return (
            <li key={node.id}>
              <PostPreview
                key={node.id}
                featured={node.featured}
                slug={node.id}
                date={node.publish_date}
                image={node.image}
                title={node.title}
                description={node.excerpt}
              />
            </li>
          )
        })}
      </ul>

      {showPagination ?
        <div className="my-4 md:my-8 lg:my-12 flex justify-center items-center space-x-4">
          <div className="text-gray-900 dark:text-white font-semibold">
            {Math.min(minIdx + 1, posts.length)}-{Math.min(maxIdx, posts.length)} of {posts.length} Posts
          </div>
          <button
            className="text-palette-primary hover:text-palette-dark focus:outline-none"
            aria-label="left-arrow"
            onClick={() => indexDecrement(minIdx)}
          >
            <FontAwesomeIcon className="w-6 sm:w-8 ml-2 inline" icon={faArrowLeft} />
          </button>
          <button
            className="text-palette-primary hover:text-palette-dark focus:outline-none"
            aria-label="left-arrow"
            onClick={() => indexIncrement(maxIdx)}
          >
            <FontAwesomeIcon className="w-6 sm:w-8 ml-2 inline" icon={faArrowRight} />
          </button>
        </div>
        :
        null
      }

    </div>
  )
}

export default ArticleList;
