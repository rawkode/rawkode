import { defineCollection, z } from "astro:content";

export const collections = {
	work: defineCollection({
		schema: z.object({
			title: z.string(),
			priority: z.number().positive(),
			description: z.string(),
			tags: z.array(z.string()),
			img: z.string(),
			img_alt: z.string().optional(),
		}),
	}),
};
