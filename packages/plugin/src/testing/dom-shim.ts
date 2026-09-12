/**
 * Vitest runs in the node environment, which has no `window` or `document`. The plugin
 * schedules its retries through `window.setTimeout` and toggles one class on the body,
 * so the handful of globals it reaches for are supplied here rather than by pulling in
 * jsdom for two properties.
 */
const bodyClasses = new Set<string>();

const shim = {
	window: {
		setTimeout: (fn: () => void, ms?: number): number => setTimeout(fn, ms) as unknown as number,
		clearTimeout: (id: number): void => {
			clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
		},
		addEventListener: (): void => {},
	},
	document: {
		hidden: false,
		body: {
			classList: {
				add: (name: string): void => {
					bodyClasses.add(name);
				},
				remove: (name: string): void => {
					bodyClasses.delete(name);
				},
				toggle: (name: string, on?: boolean): void => {
					if (on ?? !bodyClasses.has(name)) {
						bodyClasses.add(name);
					} else {
						bodyClasses.delete(name);
					}
				},
				contains: (name: string): boolean => bodyClasses.has(name),
			},
		},
		addEventListener: (): void => {},
	},
};

Object.assign(globalThis, shim);
