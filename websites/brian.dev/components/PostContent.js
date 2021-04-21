import Image from 'next/image'
import SEO from '@/components/SEO'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { formatContentfulDate } from '@/utils/helpers'

const renderers = {
  code: ({ language, value }) => {
    return <SyntaxHighlighter style={vs} language={language} children={value} />
  }
}



function Post({ content, post }) {
  const { title, image, publish_date } = post
  const seo = {
    metaTitle: title
  };
  return (
    <div className="mx-auto my-8 md:my-12 w-full">
      <SEO seo={seo} />


      <h1 className="text-center text-3xl md:text-4xl lg:text-5xl font-extrabold text-gray-900 dark:text-white">{title}</h1>
      <p className="text-sm text-center text-gray-700 dark:text-gray-200 my-2 sm:mb-4">{formatContentfulDate(publish_date)}</p>
      <div className="prose prose-dark text-lg text-gray-800 dark:text-gray-100 container mx-auto p-4 sm:p-8">
        <Image className="rounded-sm object-cover object-center w-full h-72 sm:h-96 md:h-120 py-2" width={1000} layout='responsive' height={1000} alt={title | title} priority='true' src={image} />
      {content}

      </div>
    </div>
  )
}

export default Post;
