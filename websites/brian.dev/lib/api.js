import qs from 'qs';
export function getStrapiURL(path = "") {
  return `${process.env.NEXT_PUBLIC_STRAPI_API_URL || "https://content.brian.dev"
    }${path}`;
}

// Helper to make GET requests to Strapi
export async function fetchAPI(path) {
  const requestUrl = getStrapiURL(path);
  const response = await fetch(requestUrl);
  const data = await response.json();
  return data;
}

// Helper to make GET requests to Strapi
export async function fetchArticle(slug) {
  const query = qs.stringify({
    _where: { slug: slug },
  }, { encode: false });

  const path = `/articles?${query}`
  const requestUrl = getStrapiURL(path);
  const response = await fetch(requestUrl);
  const data = await response.json();
  return data.pop();
}
// Helper to make GET requests to Strapi
export async function fetchArticles() {
  const query = qs.stringify({
    _sort: `article_date:DESC`
  }, { encode: false });

  const path = `/articles?${query}`
  const requestUrl = getStrapiURL(path);
  const response = await fetch(requestUrl);
  const data = await response.json();
  return data;
}

export async function fetchArticleSlugs() {
  const query = qs.stringify({
    _sort: `article_date:DESC`
  }, { encode: false });

  const path = `/articles?${query}`
  const requestUrl = getStrapiURL(path);
  const response = await fetch(requestUrl);
  const data = await response.json();
  return data.map((post) => post.slug);
}
// Helper to make GET requests to Strapi
export async function fetchArticlesHome(limit) {
  const query = qs.stringify({
    _sort: `article_date:DESC`,
    _limit: limit,
  }, { encode: false });

  const path = `/articles?${query}`
  const requestUrl = getStrapiURL(path);
  const response = await fetch(requestUrl);
  const data = await response.json();
  return data;
}
// Helper to make GET requests to Strapi
export async function fetchFeaturedArticles(limit) {
  const query = qs.stringify({
    _sort: `article_date:DESC`,
    _where: { featured: true },
    _limit: limit,
  }, { encode: false });

  const path = `/articles?${query}`
  const requestUrl = getStrapiURL(path);
  const response = await fetch(requestUrl);
  const data = await response.json();
  return data;
}
