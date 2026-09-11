import esbuild from 'esbuild';

const production = process.argv[2] === 'production';

const banner = `/*
DO NOT EDIT - this file is generated from src/ by esbuild.
Obsidian Sync plugin bundle.
*/`;

const context = await esbuild.context({
	banner: { js: banner },
	entryPoints: ['src/main.ts'],
	bundle: true,
	external: ['obsidian'],
	format: 'cjs',
	target: 'es2022',
	platform: 'browser',
	logLevel: 'info',
	sourcemap: production ? false : 'inline',
	treeShaking: true,
	minify: production,
	outfile: 'main.js',
});

if (production) {
	await context.rebuild();
	await context.dispose();
} else {
	await context.watch();
}
