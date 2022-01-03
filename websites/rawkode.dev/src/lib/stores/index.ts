import { writable } from 'svelte/store';
import type Seo from './seo';

const defaultSeo: Seo = {
	title: "Rawkode's Modern Life",
	emoji: '👋',
	openGraph: {
		title: "Rawkode's Modern Life",
		description: 'A modern life for a modern person.',
		image: 'https://capture.rawkode.dev',
		type: 'website',
	},
};

export const seo = writable(defaultSeo);
