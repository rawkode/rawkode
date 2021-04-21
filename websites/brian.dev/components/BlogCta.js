import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import Link from 'next/link';
import { faArrowRight } from '@fortawesome/free-solid-svg-icons';

function BlogCta() {
  return (
    <div className="my-6 sm:my-8 text-2xl sm:text-3xl tracking-tighter font-bold text-center text-gray-900 dark:text-white">
      Read More
      <Link href="/blog" passHref>
        <a className="text-palette-dark">
          <FontAwesomeIcon className="w-6 sm:w-8 ml-2 inline" aria-label="read more" icon={faArrowRight} />
        </a>
      </Link>
    </div>
  )
}

export default BlogCta;
