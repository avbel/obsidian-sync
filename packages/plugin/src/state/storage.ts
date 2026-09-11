/** A durable string blob keyed by path, backed by the plugin's excluded state directory. */
export interface StateStorage {
	read(key: string): Promise<string | undefined>;
	write(key: string, value: string): Promise<void>;
	remove(key: string): Promise<void>;
}
