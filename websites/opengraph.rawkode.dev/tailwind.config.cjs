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
				white: '#F8F8FF'
			},
			fontFamily: {
				...fontFamily,
				sans: ['Nunito'],
				serif: ['Bitter'],
				mono: ['Share Tech Mono']
			}
		}
	},
	plugins: []
};

module.exports = config;
