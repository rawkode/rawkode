import { writable } from 'svelte/store';
import type Seo from './seo';

const defaultSeo: Seo = {
	title: 'Hi',
};

export const seo = writable(defaultSeo);
