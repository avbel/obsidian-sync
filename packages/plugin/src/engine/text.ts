const textExtensions = [
	'.md',
	'.markdown',
	'.txt',
	'.csv',
	'.json',
	'.css',
	'.js',
	'.html',
	'.yml',
	'.yaml',
];

/** Whether the engine will attempt a line-based merge or diff on this path. */
export function isTextPath(path: string): boolean {
	return textExtensions.some((extension) => path.endsWith(extension));
}
