import { gql } from '@apollo/client';

export const PAGE_QUERY = gql`
query filterPage(
  $pageID: ID!
  ){
    Page(id: $pageID) {
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
`;

export const ALL_SECTIONS_QUERY = gql`
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
`;

export const ARTICLE_QUERY = gql`
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
`;

export const ALL_ARTICLES_QUERY = gql`
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
export const ARTICLES_HOME_QUERY = gql`
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
export const ARTICLE_SLUGS_QUERY = gql`
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
export const FEATURED_ARTICLES_HOME_QUERY = gql`
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

export const FILTER_PLAYERS_QUERY = gql`
  query filterPlayers(
    $filter: PlayerFilter
    $countryID: [ID!]
    $clubID: [ID!]
  ) {
    queryPlayer(filter: $filter) @cascade {
      name
      position
      country(filter: { id: $countryID }) {
        id
        name
      }
      club(filter: { id: $clubID }) {
        id
        name
      }
      id
    }
  }
`;
