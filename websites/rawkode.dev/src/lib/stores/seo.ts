export default interface Seo {
	title: string;
	emoji: string;
	openGraph: OpenGraph;
}

interface OpenGraph {
	title: string;
	description?: string;
	image?: string;
	type?: string;
}
