import { ApolloClient, InMemoryCache, gql } from '@apollo/client';

const client = new ApolloClient({
  uri: process.env.NEXT_PUBLIC_CMS_URL,
  cache: new InMemoryCache()
});



export async function getPage(slug) {

  const { data } = await client.query({
    query: gql`
{
  Page(id: "${slug}") {
    id
    title
    body
    image
    tags
    draft
    publish_date
  }
}
`});
  const page = data.Page;
  console.log(page)
  return page
}


export async function getSections() {

  const { data } = await client.query({

    query: gql`
{
  allSections(sortField: "weight", sortOrder: "asc") {
    id
    name
    description
    weight
    Pages{
      id
      title
      weight
    }
  }
}
`});

  const sections = data.allSections;

  return sections


}

export async function getArticles() {
  const { data } = await client.query({
    query: gql`
    query {
    allArticles {
    id
        title
        Category{
    id
          name
  }
        tags
        publish_date
        last_edit_date
        edit_description
      }
    }
`
  });
  const articles = data.allArticles;
  return articles;
}
