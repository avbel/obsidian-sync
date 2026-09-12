import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		alias: {
			obsidian: fileURLToPath(
				new URL('./packages/plugin/src/testing/obsidian-stub.ts', import.meta.url),
			),
		},
	},
	test: {
		include: ['packages/*/src/**/*.test.ts'],
		environment: 'node',
		setupFiles: ['./packages/plugin/src/testing/dom-shim.ts'],
	},
});
