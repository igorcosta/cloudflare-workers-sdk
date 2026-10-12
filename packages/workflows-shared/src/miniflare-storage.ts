type StorageEnv = {
	MINIFLARE_WORKFLOW_STORAGE?: Fetcher;
	WORKFLOW_NAME: string;
};

const pendingDeletes = new Map<string, Promise<boolean>>();

function storageUrl(workflowName: string, hexId: string): string {
	if (
		/[\\/]/.test(workflowName) ||
		workflowName.includes("\0") ||
		!/^[a-f0-9]{64}$/i.test(hexId)
	) {
		throw new Error("Invalid Workflow storage path");
	}
	return `http://disk/${encodeURIComponent(`miniflare-workflows-${workflowName}`)}/${hexId}`;
}

async function removeFile(disk: Fetcher, url: string): Promise<boolean> {
	for (let attempt = 0; ; attempt++) {
		let isDirectory = false;
		try {
			const file = await disk.fetch(url, { method: "HEAD" });
			if (file.status === 404) {
				return false;
			}
			if (
				file.ok &&
				file.headers.get("Content-Type") !== "application/octet-stream"
			) {
				isDirectory = true;
			} else if (file.ok) {
				const response = await disk.fetch(url, { method: "DELETE" });
				if (response.ok || response.status === 404) {
					return response.ok;
				}
			}
		} catch (error) {
			if (attempt === 40) {
				throw error;
			}
		}
		if (isDirectory) {
			throw new Error("Refusing to delete a Workflow storage directory");
		}
		if (attempt === 40) {
			throw new Error("Failed to delete Workflow storage file");
		}
		await scheduler.wait(50);
	}
}

/** Records unfinished local deletion so reload or disposal can recover it. */
export async function markWorkflowStorageDeletion(
	env: StorageEnv,
	hexId: string
): Promise<void> {
	const response = await env.MINIFLARE_WORKFLOW_STORAGE?.fetch(
		storageUrl(env.WORKFLOW_NAME, hexId) + ".sqlite-delete",
		{ method: "PUT", body: "" }
	);
	if (response !== undefined && !response.ok) {
		throw new Error("Failed to mark Workflow storage deletion");
	}
}

/** Aborts local execution and serializes file cleanup with reuse of the same ID. */
export function deleteWorkflowStorage(
	env: StorageEnv,
	ctx: ExecutionContext,
	hexId: string,
	abort: () => Promise<void>
): Promise<boolean> {
	const disk = env.MINIFLARE_WORKFLOW_STORAGE;
	if (disk === undefined) {
		return abort().then(() => false);
	}
	const url = storageUrl(env.WORKFLOW_NAME, hexId);
	const previous = pendingDeletes.get(url);
	const pending = (async () => {
		let deleted = (await previous?.catch(() => false)) ?? false;
		await markWorkflowStorageDeletion(env, hexId);
		await abort();
		await scheduler.wait(100);
		let failure: unknown;
		for (const extension of [".sqlite", ".sqlite-shm", ".sqlite-wal"]) {
			try {
				const removed = await removeFile(disk, url + extension);
				deleted ||= extension === ".sqlite" && removed;
			} catch (error) {
				failure ??= error;
			}
		}
		if (failure !== undefined) {
			throw failure;
		}
		await removeFile(disk, url + ".sqlite-delete");
		return deleted;
	})();
	pendingDeletes.set(url, pending);
	ctx.waitUntil(
		pending.finally(() => {
			if (pendingDeletes.get(url) === pending) {
				pendingDeletes.delete(url);
			}
		})
	);
	return pending;
}

/** Prevents a new local instance from opening files still awaiting deletion. */
export async function waitForWorkflowStorageDeletion(
	env: StorageEnv,
	ctx: ExecutionContext,
	hexId: string,
	abort: () => Promise<void>
): Promise<void> {
	const disk = env.MINIFLARE_WORKFLOW_STORAGE;
	if (disk === undefined) {
		return;
	}
	const url = storageUrl(env.WORKFLOW_NAME, hexId);
	let pending = pendingDeletes.get(url);
	if (pending === undefined) {
		const marker = await disk.fetch(url + ".sqlite-delete", { method: "HEAD" });
		pending = pendingDeletes.get(url);
		if (pending === undefined) {
			if (marker.status === 404) {
				return;
			}
			if (!marker.ok) {
				throw new Error("Failed to inspect pending Workflow deletion");
			}
			pending = deleteWorkflowStorage(env, ctx, hexId, abort);
		}
	}
	while (pending !== undefined) {
		await pending;
		const latest = pendingDeletes.get(url);
		pending = latest === pending ? undefined : latest;
	}
}
