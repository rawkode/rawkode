import * as Dom from "graphql-request/dist/types.dom";

import { GraphQLClient } from "graphql-request";
import gql from "graphql-tag";
export type Maybe<T> = T | null;
export type Exact<T extends { [key: string]: unknown }> = {
  [K in keyof T]: T[K];
};
export type MakeOptional<T, K extends keyof T> = Omit<T, K> &
  { [SubKey in K]?: Maybe<T[SubKey]> };
export type MakeMaybe<T, K extends keyof T> = Omit<T, K> &
  { [SubKey in K]: Maybe<T[SubKey]> };
/** All built-in and custom scalars, mapped to their actual values */
export type Scalars = {
  ID: string;
  String: string;
  Boolean: boolean;
  Int: number;
  Float: number;
};

export type Article = {
  __typename?: "Article";
  title: Scalars["String"];
  excerpt: Scalars["String"];
  featured: Scalars["Boolean"];
  draft: Scalars["Boolean"];
  publish_date: Scalars["String"];
  image: Scalars["String"];
  last_edit_date: Scalars["String"];
  edit_description: Scalars["String"];
  body: Scalars["String"];
  tags: Array<Maybe<Scalars["String"]>>;
  category_id: Scalars["ID"];
  id: Scalars["ID"];
  profile_id: Scalars["ID"];
  Category?: Maybe<Category>;
  Profile?: Maybe<Profile>;
};

export type ArticleFilter = {
  q?: Maybe<Scalars["String"]>;
  ids?: Maybe<Array<Maybe<Scalars["ID"]>>>;
  title?: Maybe<Scalars["String"]>;
  excerpt?: Maybe<Scalars["String"]>;
  featured?: Maybe<Scalars["Boolean"]>;
  draft?: Maybe<Scalars["Boolean"]>;
  publish_date?: Maybe<Scalars["String"]>;
  image?: Maybe<Scalars["String"]>;
  last_edit_date?: Maybe<Scalars["String"]>;
  edit_description?: Maybe<Scalars["String"]>;
  body?: Maybe<Scalars["String"]>;
  tags?: Maybe<Array<Maybe<Scalars["String"]>>>;
  category_id?: Maybe<Scalars["ID"]>;
  id?: Maybe<Scalars["ID"]>;
  profile_id?: Maybe<Scalars["ID"]>;
};

export type Category = {
  __typename?: "Category";
  name: Scalars["String"];
  description: Scalars["String"];
  id: Scalars["ID"];
  body: Scalars["String"];
  Articles?: Maybe<Array<Maybe<Article>>>;
};

export type CategoryFilter = {
  q?: Maybe<Scalars["String"]>;
  ids?: Maybe<Array<Maybe<Scalars["ID"]>>>;
  name?: Maybe<Scalars["String"]>;
  description?: Maybe<Scalars["String"]>;
  id?: Maybe<Scalars["ID"]>;
  body?: Maybe<Scalars["String"]>;
};

export type ListMetadata = {
  __typename?: "ListMetadata";
  count?: Maybe<Scalars["Int"]>;
};

export type Mutation = {
  __typename?: "Mutation";
  createPage?: Maybe<Page>;
  updatePage?: Maybe<Page>;
  removePage?: Maybe<Scalars["Boolean"]>;
  createProfile?: Maybe<Profile>;
  updateProfile?: Maybe<Profile>;
  removeProfile?: Maybe<Scalars["Boolean"]>;
  createWebsite?: Maybe<Website>;
  updateWebsite?: Maybe<Website>;
  removeWebsite?: Maybe<Scalars["Boolean"]>;
  createArticle?: Maybe<Article>;
  updateArticle?: Maybe<Article>;
  removeArticle?: Maybe<Scalars["Boolean"]>;
  createCategory?: Maybe<Category>;
  updateCategory?: Maybe<Category>;
  removeCategory?: Maybe<Scalars["Boolean"]>;
};

export type MutationCreatePageArgs = {
  title: Scalars["String"];
  excerpt: Scalars["String"];
  draft: Scalars["Boolean"];
  publish_date: Scalars["String"];
  image: Scalars["String"];
  body: Scalars["String"];
  id: Scalars["ID"];
  tags: Array<Maybe<Scalars["String"]>>;
};

export type MutationUpdatePageArgs = {
  title?: Maybe<Scalars["String"]>;
  excerpt?: Maybe<Scalars["String"]>;
  draft?: Maybe<Scalars["Boolean"]>;
  publish_date?: Maybe<Scalars["String"]>;
  image?: Maybe<Scalars["String"]>;
  body?: Maybe<Scalars["String"]>;
  id: Scalars["ID"];
  tags?: Maybe<Array<Maybe<Scalars["String"]>>>;
};

export type MutationRemovePageArgs = {
  id: Scalars["ID"];
};

export type MutationCreateProfileArgs = {
  first_name: Scalars["String"];
  last_name: Scalars["String"];
  company: Scalars["String"];
  title: Scalars["String"];
  body: Scalars["String"];
  id: Scalars["ID"];
};

export type MutationUpdateProfileArgs = {
  first_name?: Maybe<Scalars["String"]>;
  last_name?: Maybe<Scalars["String"]>;
  company?: Maybe<Scalars["String"]>;
  title?: Maybe<Scalars["String"]>;
  body?: Maybe<Scalars["String"]>;
  id: Scalars["ID"];
};

export type MutationRemoveProfileArgs = {
  id: Scalars["ID"];
};

export type MutationCreateWebsiteArgs = {
  url: Scalars["String"];
  profile_id: Scalars["ID"];
  id: Scalars["ID"];
};

export type MutationUpdateWebsiteArgs = {
  url?: Maybe<Scalars["String"]>;
  profile_id?: Maybe<Scalars["ID"]>;
  id: Scalars["ID"];
};

export type MutationRemoveWebsiteArgs = {
  id: Scalars["ID"];
};

export type MutationCreateArticleArgs = {
  title: Scalars["String"];
  excerpt: Scalars["String"];
  featured: Scalars["Boolean"];
  draft: Scalars["Boolean"];
  publish_date: Scalars["String"];
  image: Scalars["String"];
  last_edit_date: Scalars["String"];
  edit_description: Scalars["String"];
  body: Scalars["String"];
  tags: Array<Maybe<Scalars["String"]>>;
  category_id: Scalars["ID"];
  id: Scalars["ID"];
  profile_id: Scalars["ID"];
};

export type MutationUpdateArticleArgs = {
  title?: Maybe<Scalars["String"]>;
  excerpt?: Maybe<Scalars["String"]>;
  featured?: Maybe<Scalars["Boolean"]>;
  draft?: Maybe<Scalars["Boolean"]>;
  publish_date?: Maybe<Scalars["String"]>;
  image?: Maybe<Scalars["String"]>;
  last_edit_date?: Maybe<Scalars["String"]>;
  edit_description?: Maybe<Scalars["String"]>;
  body?: Maybe<Scalars["String"]>;
  tags?: Maybe<Array<Maybe<Scalars["String"]>>>;
  category_id?: Maybe<Scalars["ID"]>;
  id: Scalars["ID"];
  profile_id?: Maybe<Scalars["ID"]>;
};

export type MutationRemoveArticleArgs = {
  id: Scalars["ID"];
};

export type MutationCreateCategoryArgs = {
  name: Scalars["String"];
  description: Scalars["String"];
  id: Scalars["ID"];
  body: Scalars["String"];
};

export type MutationUpdateCategoryArgs = {
  name?: Maybe<Scalars["String"]>;
  description?: Maybe<Scalars["String"]>;
  id: Scalars["ID"];
  body?: Maybe<Scalars["String"]>;
};

export type MutationRemoveCategoryArgs = {
  id: Scalars["ID"];
};

export type Page = {
  __typename?: "Page";
  title: Scalars["String"];
  excerpt: Scalars["String"];
  draft: Scalars["Boolean"];
  publish_date: Scalars["String"];
  image: Scalars["String"];
  body: Scalars["String"];
  id: Scalars["ID"];
  tags: Array<Maybe<Scalars["String"]>>;
};

export type PageFilter = {
  q?: Maybe<Scalars["String"]>;
  ids?: Maybe<Array<Maybe<Scalars["ID"]>>>;
  title?: Maybe<Scalars["String"]>;
  excerpt?: Maybe<Scalars["String"]>;
  draft?: Maybe<Scalars["Boolean"]>;
  publish_date?: Maybe<Scalars["String"]>;
  image?: Maybe<Scalars["String"]>;
  body?: Maybe<Scalars["String"]>;
  id?: Maybe<Scalars["ID"]>;
  tags?: Maybe<Array<Maybe<Scalars["String"]>>>;
};

export type Profile = {
  __typename?: "Profile";
  first_name: Scalars["String"];
  last_name: Scalars["String"];
  company: Scalars["String"];
  title: Scalars["String"];
  body: Scalars["String"];
  id: Scalars["ID"];
  Websites?: Maybe<Array<Maybe<Website>>>;
  Articles?: Maybe<Array<Maybe<Article>>>;
};

export type ProfileFilter = {
  q?: Maybe<Scalars["String"]>;
  ids?: Maybe<Array<Maybe<Scalars["ID"]>>>;
  first_name?: Maybe<Scalars["String"]>;
  last_name?: Maybe<Scalars["String"]>;
  company?: Maybe<Scalars["String"]>;
  title?: Maybe<Scalars["String"]>;
  body?: Maybe<Scalars["String"]>;
  id?: Maybe<Scalars["ID"]>;
};

export type Query = {
  __typename?: "Query";
  Page?: Maybe<Page>;
  allPages?: Maybe<Array<Maybe<Page>>>;
  _allPagesMeta?: Maybe<ListMetadata>;
  Profile?: Maybe<Profile>;
  allProfiles?: Maybe<Array<Maybe<Profile>>>;
  _allProfilesMeta?: Maybe<ListMetadata>;
  Website?: Maybe<Website>;
  allWebsites?: Maybe<Array<Maybe<Website>>>;
  _allWebsitesMeta?: Maybe<ListMetadata>;
  Article?: Maybe<Article>;
  allArticles?: Maybe<Array<Maybe<Article>>>;
  _allArticlesMeta?: Maybe<ListMetadata>;
  Category?: Maybe<Category>;
  allCategories?: Maybe<Array<Maybe<Category>>>;
  _allCategoriesMeta?: Maybe<ListMetadata>;
};

export type QueryPageArgs = {
  id: Scalars["ID"];
};

export type QueryAllPagesArgs = {
  page?: Maybe<Scalars["Int"]>;
  perPage?: Maybe<Scalars["Int"]>;
  sortField?: Maybe<Scalars["String"]>;
  sortOrder?: Maybe<Scalars["String"]>;
  filter?: Maybe<PageFilter>;
};

export type Query_AllPagesMetaArgs = {
  page?: Maybe<Scalars["Int"]>;
  perPage?: Maybe<Scalars["Int"]>;
  filter?: Maybe<PageFilter>;
};

export type QueryProfileArgs = {
  id: Scalars["ID"];
};

export type QueryAllProfilesArgs = {
  page?: Maybe<Scalars["Int"]>;
  perPage?: Maybe<Scalars["Int"]>;
  sortField?: Maybe<Scalars["String"]>;
  sortOrder?: Maybe<Scalars["String"]>;
  filter?: Maybe<ProfileFilter>;
};

export type Query_AllProfilesMetaArgs = {
  page?: Maybe<Scalars["Int"]>;
  perPage?: Maybe<Scalars["Int"]>;
  filter?: Maybe<ProfileFilter>;
};

export type QueryWebsiteArgs = {
  id: Scalars["ID"];
};

export type QueryAllWebsitesArgs = {
  page?: Maybe<Scalars["Int"]>;
  perPage?: Maybe<Scalars["Int"]>;
  sortField?: Maybe<Scalars["String"]>;
  sortOrder?: Maybe<Scalars["String"]>;
  filter?: Maybe<WebsiteFilter>;
};

export type Query_AllWebsitesMetaArgs = {
  page?: Maybe<Scalars["Int"]>;
  perPage?: Maybe<Scalars["Int"]>;
  filter?: Maybe<WebsiteFilter>;
};

export type QueryArticleArgs = {
  id: Scalars["ID"];
};

export type QueryAllArticlesArgs = {
  page?: Maybe<Scalars["Int"]>;
  perPage?: Maybe<Scalars["Int"]>;
  sortField?: Maybe<Scalars["String"]>;
  sortOrder?: Maybe<Scalars["String"]>;
  filter?: Maybe<ArticleFilter>;
};

export type Query_AllArticlesMetaArgs = {
  page?: Maybe<Scalars["Int"]>;
  perPage?: Maybe<Scalars["Int"]>;
  filter?: Maybe<ArticleFilter>;
};

export type QueryCategoryArgs = {
  id: Scalars["ID"];
};

export type QueryAllCategoriesArgs = {
  page?: Maybe<Scalars["Int"]>;
  perPage?: Maybe<Scalars["Int"]>;
  sortField?: Maybe<Scalars["String"]>;
  sortOrder?: Maybe<Scalars["String"]>;
  filter?: Maybe<CategoryFilter>;
};

export type Query_AllCategoriesMetaArgs = {
  page?: Maybe<Scalars["Int"]>;
  perPage?: Maybe<Scalars["Int"]>;
  filter?: Maybe<CategoryFilter>;
};

export type Website = {
  __typename?: "Website";
  url: Scalars["String"];
  profile_id: Scalars["ID"];
  id: Scalars["ID"];
  Profile?: Maybe<Profile>;
};

export type WebsiteFilter = {
  q?: Maybe<Scalars["String"]>;
  ids?: Maybe<Array<Maybe<Scalars["ID"]>>>;
  url?: Maybe<Scalars["String"]>;
  profile_id?: Maybe<Scalars["ID"]>;
  id?: Maybe<Scalars["ID"]>;
};

export const PageFieldsFragmentDoc = gql`
  fragment PageFields on Page {
    id
    title
    excerpt
  }
`;
export const FindPageDocument = gql`
  query findPage($pageId: ID!) {
    Page(id: $pageId) {
      ...PageFields
    }
  }
  ${PageFieldsFragmentDoc}
`;

export type SdkFunctionWrapper = <T>(action: () => Promise<T>) => Promise<T>;

const defaultWrapper: SdkFunctionWrapper = (sdkFunction) => sdkFunction();
export function getSdk(
  client: GraphQLClient,
  withWrapper: SdkFunctionWrapper = defaultWrapper
) {
  return {
    findPage(
      variables: FindPageQueryVariables,
      requestHeaders?: Dom.RequestInit["headers"]
    ): Promise<FindPageQuery> {
      return withWrapper(() =>
        client.request<FindPageQuery>(
          FindPageDocument,
          variables,
          requestHeaders
        )
      );
    },
  };
}
export type Sdk = ReturnType<typeof getSdk>;
