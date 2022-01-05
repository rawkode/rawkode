import { default as sanityClient } from '@sanity/client';

export async function get() {
	const query = `*[_type == "article"] {
		"slug": slug.current,
	}`;

	const client = sanityClient({
		projectId: 'ypvmf3jx',
		dataset: 'website',
		apiVersion: '2021-03-25',
		useCdn: true,
	});

	const articles = await client.fetch(query, {});

	const headers = {
		'Cache-Control': 'max-age=0, s-maxage=3600',
		'Content-Type': 'application/xml',
	};

	return {
		headers,
		body: `<?xml version="1.0" encoding="UTF-8" ?>
    <urlset
      xmlns="https://www.sitemaps.org/schemas/sitemap/0.9"
      xmlns:news="https://www.google.com/schemas/sitemap-news/0.9"
      xmlns:xhtml="https://www.w3.org/1999/xhtml"
      xmlns:mobile="https://www.google.com/schemas/sitemap-mobile/1.0"
      xmlns:image="https://www.google.com/schemas/sitemap-image/1.1"
      xmlns:video="https://www.google.com/schemas/sitemap-video/1.1"
    >
			<url>
				<loc>https://rawkode.dev</loc>
				<changefreq>daily</changefreq>
				<priority>1</priority>
			</url>
			<url>
				<loc>https://rawkode.dev/articles</loc>
				<changefreq>daily</changefreq>
				<priority>1</priority>
			</url>
			${articles.map(
				(article) => `
				<url>
					<loc>https://rawkode.dev/articles/${article.slug}</loc>
					<changefreq>daily</changefreq>
					<priority>1</priority>
				</url>`,
			)}
		</urlset>`,
	};
}
