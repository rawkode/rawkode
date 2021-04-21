const withPWA = require('next-pwa');

module.exports = withPWA({
  images: {
    domains: ['res.cloudinary.com'],
  },
  future: { webpack5: true },
  pwa: {
    dest: 'public',
    disable: process.env.NODE_ENV === 'development',
  },
  env: {
    siteTitle: 'Brian Ketelsen',
    siteDescription: 'News from the Edge.',
    siteKeywords: 'nextjs, tailwindcss, contentful, blog',
    siteUrl: 'https://next-tails-blog.vercel.app/',
    siteImagePreviewUrl: '/images/main-img-preview.jpg',
    mainRoutes: ['/index', '/about', '/blog'], // for sitemap; blog posts are generated dynamically
    blogRoute: '/blog', // for sitemap
    recentBlogNum: 3, // no. of blogs to display in recent posts
    twitterHandle: '@bketelsen',
    twitterUrl: 'https://twitter.com/bketelsen',
    facebookUrl: 'https://facebook.com',
    instagramUrl: 'https://instagram.com',
    pinterestUrl: 'https://pinterest.com',
    youtubeUrl: 'https://youtube.com/bketelsen',
  }
})
