import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const blog = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    pubDate: z.coerce.date(),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
  }),
});

const apps = defineCollection({
  loader: glob({ pattern: '**/*.yaml', base: './src/content/apps' }),
  schema: z.object({
    name: z.string(),
    tagline: z.string(),
    description: z.string(),
    platform: z.array(z.string()),
    status: z.enum(['available', 'beta', 'in-development']),
    repoPath: z.string().optional(),
    repoUrl: z.string().url().optional(),
    websiteUrl: z.string().url().optional(),
    tags: z.array(z.string()),
    featured: z.boolean().default(false),
  }),
});

export const collections = { blog, apps };
