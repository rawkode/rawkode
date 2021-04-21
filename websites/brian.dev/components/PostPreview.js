import Image from 'next/image'
import Link from 'next/link';
import { formatContentfulDate } from "@/utils/helpers";

function PostPreview({ featured, slug, date, image, title, description }) {
  const postHref = `/blog/${slug}`;

  return (
    <Link href={postHref}>
      <div className="relative mx-2 my-4 max-w-xs cursor-pointer dark:bg-gray-900 border border-palette-lighter dark:border-gray-900 shadow-lg rounded p-4 hover:bg-palette-lighter dark:hover:bg-palette-dark">
        <Image className="rounded object-cover w-full h-48" width={300} height={200} alt={title} src={image} />
        <div className="font-bold text-xl md:text-2xl pt-6 text-gray-900 dark:text-white">
          {title}
        </div>
        <div className="text-xs text-gray-700 dark:text-gray-200 mb-2 sm:mb-4">{formatContentfulDate(date)}</div>
        <div className="text-md text-gray-800 dark:text-gray-100">
          {description}
        </div>
        {featured && (
          <span className="absolute rounded pl-2 pr-2 top-2 right-2 bg-palette-dark dark:text-gray-900 text-white">Featured</span>
        )}
      </div>
    </Link>
  )
}

export default PostPreview;
