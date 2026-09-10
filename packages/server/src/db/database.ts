import { DatabaseSync } from 'node:sqlite';
import { currentSchemaVersion, migrations } from './schema.js';

export { currentSchemaVersion, migrations };

export function openDatabase(filePath: string): DatabaseSync {
	const db = new DatabaseSync(filePath);

	db.exec('PRAGMA journal_mode = WAL');
	// NORMAL can lose the most recent transaction on power loss but never corrupts.
	// A lost commit is recoverable: the client's next reconcile re-pushes it.
	db.exec('PRAGMA synchronous = NORMAL');
	db.exec('PRAGMA foreign_keys = ON');
	db.exec('PRAGMA busy_timeout = 5000');

	const { user_version: version } = db.prepare('PRAGMA user_version').get() as {
		user_version: number;
	};

	if (version > currentSchemaVersion) {
		db.close();
		throw new Error(
			`database schema version ${version} is newer than this server supports (${currentSchemaVersion}); upgrade the server`,
		);
	}

	for (let step = version; step < currentSchemaVersion; step += 1) {
		const migration = migrations[step];
		if (migration === undefined) {
			db.close();
			throw new Error(`missing migration from schema version ${step}`);
		}
		db.exec('BEGIN');
		try {
			db.exec(migration);
			db.exec(`PRAGMA user_version = ${step + 1}`);
			db.exec('COMMIT');
		} catch (error) {
			db.exec('ROLLBACK');
			db.close();
			throw error;
		}
	}

	return db;
}

export function closeDatabase(db: DatabaseSync): void {
	db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
	db.close();
}
