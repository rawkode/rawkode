import { GlobalContext } from "./_app";
import { PAGE_QUERY } from "@/lib/queries";
import ReactMarkdown from "react-markdown";
import SEO from '@/components/SEO';
import SocialMedia from '@/components/SocialMedia';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import gfm from 'remark-gfm';
import { initializeApollo } from "@/lib/apolloClient";
import { useContext } from "react";
import { vs } from 'react-syntax-highlighter/dist/cjs/styles/prism'

const renderers = {
  code: ({ language, value }) => {
    return <SyntaxHighlighter style={vs} language={language} children={value} />
  }
}
function AboutPage({page}) {
  const pageTitle = `About | ${process.env.siteTitle}`;
  const { writer } = useContext(GlobalContext);

  return (
    <div className="container mx-auto mb-20 min-h-screen">
      <SEO title={pageTitle} />
      <h1 className="leading-loose font-extrabold text-4xl text-center text-gray-900 dark:text-white">
        About
      </h1>
      <section className="w-full px-4 sm:max-w-6xl mx-auto py-2 text-gray-800 dark:text-gray-200">
        <div className="prose prose-pacific text-lg text-gray-800 dark:text-gray-100 container mx-auto p-4 sm:p-8">

          <img className="my-8 h-64 w-64 object-cover mx-auto rounded-full" src={writer.picture.url} alt="my-pic" />
          <ReactMarkdown
            renderers={renderers}
            plugins={[gfm]}
            source={page.body}
            escapeHtml={false} />

          <SocialMedia />
        </div>
      </section>

    </div>
  )
}

export default AboutPage;

export async function getStaticProps() {
  const apolloClient = initializeApollo();
  const page = await
    apolloClient.query({
      query: PAGE_QUERY,
      variables: {
        pageID: "about",
      }

    });

  var data = page.data.Page
  return {
    props: {
      initialApolloState: apolloClient.cache.extract(),
      page: data,
    },
    revalidate: 30,

  }
}
