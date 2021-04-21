import React from 'react';
import { fetchArticleSlugs } from "@/lib/api";

const MAIN_URL = process.env.siteUrl.slice(-1) === '/' ? process.env.siteUrl.substring(0, process.env.siteUrl.length - 1) : process.env.siteUrl;

const createSitemap = (blogPostSlugs) => `<?xml version="1.0" encoding="UTF-8"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      ${process.env.mainRoutes
    .map((page) => {
      const path = page
        .replace('pages', '')
        .replace('.js', '');
      const route = path === '/index' ? '' : path;

      return `
                  <url>
                      <loc>${`${MAIN_URL}${route}`}</loc>
                  </url>
              `;
    })
    .join('')}    
        ${blogPostSlugs
    .map((id) => {
      return `
                    <url>
                        <loc>${`${MAIN_URL}${process.env.blogRoute}/${id}`}</loc>
                    </url>
                `;
    })
    .join('')}
    </urlset>
    `;

class Sitemap extends React.Component {
  static async getInitialProps({ res }) {
    const blogPostSlugs = await fetchArticleSlugs()

    res.setHeader('Content-Type', 'text/xml')
    res.write(createSitemap(blogPostSlugs))
    res.end()
  }
}




export default Sitemap;

