import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { isFileNotFoundError } from "../../shared/error";

export const SERVICE_WORKFLOW_STORAGE = "workflows:storage-cleanup";
export const WORKFLOW_STORAGE_BINDING = "MINIFLARE_WORKFLOW_STORAGE";

/** Finishes marked deletions after workerd exits, before its storage is reused. */
export async function recoverWorkflowStorage(
	persistPath: string,
	logError: (error: Error) => void
): Promise<void> {
	let namespaces;
	try {
		namespaces = await fs.readdir(persistPath, { withFileTypes: true });
	} catch (error) {
		if (isFileNotFoundError(error)) {
			return;
		}
		throw error;
	}
	for (const namespace of namespaces) {
		if (
			!namespace.isDirectory() ||
			!namespace.name.startsWith("miniflare-workflows-")
		) {
			continue;
		}
		const namespacePath = path.join(persistPath, namespace.name);
		const entries = await fs.readdir(namespacePath, { withFileTypes: true });
		for (const entry of entries) {
			if (
				!entry.isFile() ||
				!/^[a-f0-9]{64}\.sqlite-delete$/i.test(entry.name)
			) {
				continue;
			}
			const instancePath = path.join(
				namespacePath,
				entry.name.slice(0, -".sqlite-delete".length)
			);
			let failed = false;
			for (const extension of [".sqlite", ".sqlite-shm", ".sqlite-wal"]) {
				for (let attempt = 0; attempt <= 40; attempt++) {
					try {
						await fs.unlink(instancePath + extension);
						break;
					} catch (error) {
						if (isFileNotFoundError(error)) {
							break;
						}
						const code = (error as NodeJS.ErrnoException).code;
						if ((code === "EBUSY" || code === "EPERM") && attempt < 40) {
							await wait(50);
							continue;
						}
						failed = true;
						logError(error instanceof Error ? error : new Error(String(error)));
						break;
					}
				}
			}
			if (!failed) {
				await fs.unlink(path.join(namespacePath, entry.name));
			}
		}
	}
}
