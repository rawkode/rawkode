const { colors } = require('tailwindcss/defaultTheme');
const { fontFamily } = require('tailwindcss/defaultTheme');

const config = {
	content: ['./src/**/*.{html,js,svelte,ts}'],
	theme: {
		extend: {
			colors: {
				...colors,
				primary: '#F93983',
				secondary: '#49B6FF',
				tertiary: '#94FBAB',
				black: '#292933',
				offblack: '#2F2F2F',
			},
			fontFamily: {
				...fontFamily,
				sans: ['Nunito'],
				serif: ['Bitter'],
				mono: ['Share Tech Mono'],
			},
		},
	},
	plugins: [require('@tailwindcss/typography')],
};

module.exports = config;
