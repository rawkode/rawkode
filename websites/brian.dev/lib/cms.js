import { ApolloClient, InMemoryCache, gql } from '@apollo/client';
export function getAPIURL(path = "") {
  return `${process.env.API_URL || "https://api.brian.dev/graphql"
    }${path}`;
}

const client = new ApolloClient({
  uri: getAPIURL(),
  cache: new InMemoryCache()
});

export async function getPage(slug) {
  const { data } = await client.query({
    query: gql`
{
  Page(id: "${slug}") {
    id
    excerpt
    draft
    image
    title
    body
    image
    tags
    publish_date
  }
}
`});
  const page = data.Page;
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

export async function getArticle(slug) {
  const { data } = await client.query({
    query: gql`
    {
      Article(
        id: "hello-world"){
        id
        body
        title
        excerpt
        featured
        draft
        publish_date
        image
        last_edit_date
        edit_description

      }
    }
`
  });
  const article = data.Article;
  return article;
}
export async function getArticlesHome() {
  const { data } = await client.query({
    query: gql`
    {
      allArticles(
        page: 0,
        perPage: 3,
        sortField: "publish_date",
        sortOrder: "desc"){
        id
        title
        excerpt
        featured
        draft
        publish_date
        image
        last_edit_date
        edit_description

      }
    }
`
  });
  const articles = data.allArticles;
  return articles;
}
export async function getAllArticles() {
  const { data } = await client.query({
    query: gql`
    {
      allArticles(
        sortField: "publish_date",
        sortOrder: "desc"){
        id
        title
        excerpt
        featured
        draft
        publish_date
        image
        last_edit_date
        edit_description

      }
    }
`
  });
  const articles = data.allArticles;
  return articles;
}
export async function getArticleSlugs() {
  const { data } = await client.query({
    query: gql`
    {
      allArticles(
        sortField: "publish_date",
        sortOrder: "desc"){
        id
        title
        draft
        publish_date
      }
    }
`
  });
  const articles = data.allArticles;
  return articles;
}
export async function getFeaturedArticlesHome() {
  const { data } = await client.query({
    query: gql`
    {
      allArticles(
        filter: {featured: true},
        sortField: "publish_date",
        sortOrder: "desc"){
        id
        title
        excerpt
        featured
        draft
        publish_date
        image
        last_edit_date
        edit_description

      }
    }
`
  });
  const articles = data.allArticles;
  return articles;
}
