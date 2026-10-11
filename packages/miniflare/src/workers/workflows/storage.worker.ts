interface Env {
	DISK: Fetcher;
}

interface DirectoryEntry {
	name: string;
	type: string;
}

interface PendingDelete {
	marked: Promise<boolean>;
	promise: Promise<void>;
	failed: boolean;
	deleted: boolean;
}

const pendingDeletes = new Map<string, PendingDelete>();
const extensions = [".sqlite", ".sqlite-shm", ".sqlite-wal"];

async function list(env: Env, namespace: string): Promise<DirectoryEntry[]> {
	const response = await env.DISK.fetch(`http://disk/${namespace}`);
	if (response.status === 404) {
		return [];
	}
	if (!response.ok) {
		throw new Error("Failed to list Workflow storage");
	}
	return response.json();
}

/** Deletes only files, retaining the marker until all SQLite sidecars are gone. */
async function remove(
	env: Env,
	namespace: string,
	id: string,
	pending: PendingDelete
): Promise<void> {
	for (const extension of extensions) {
		for (let attempt = 0; attempt <= 40; attempt++) {
			try {
				const entry = (await list(env, namespace)).find(
					({ name }) => name === id + extension
				);
				if (entry === undefined) {
					break;
				}
				if (entry.type !== "file") {
					pending.failed = true;
					break;
				}
				const response = await env.DISK.fetch(
					`http://disk/${namespace}/${id}${extension}`,
					{ method: "DELETE" }
				);
				if (response.ok || response.status === 404) {
					if (response.ok && extension === ".sqlite") {
						pending.deleted = true;
					}
					break;
				}
				if (response.status < 500) {
					pending.failed = true;
					break;
				}
			} catch (error) {
				if (attempt === 40) {
					console.error(error);
				}
			}
			if (attempt === 40) {
				pending.failed = true;
			} else {
				await scheduler.wait(50);
			}
		}
	}
	if (!pending.failed && pendingDeletes.get(`${namespace}/${id}`) === pending) {
		const response = await env.DISK.fetch(
			`http://disk/${namespace}/${id}.sqlite-delete`,
			{ method: "DELETE" }
		);
		if (!response.ok && response.status !== 404) {
			pending.failed = true;
		}
	}
}

/** Serializes deletion with recreation, independently of the Node event loop. */
function queueDelete(
	env: Env,
	namespace: string,
	id: string,
	defer: boolean
): PendingDelete {
	const key = `${namespace}/${id}`;
	const previous = pendingDeletes.get(key);
	const marked = Promise.withResolvers<boolean>();
	const pending: PendingDelete = {
		marked: marked.promise,
		promise: Promise.resolve(),
		failed: false,
		deleted: false,
	};
	pendingDeletes.set(key, pending);
	pending.promise = (async () => {
		try {
			await previous?.promise;
			pending.deleted = previous?.deleted ?? false;
			const marker = await env.DISK.fetch(`http://disk/${key}.sqlite-delete`, {
				method: "PUT",
				body: "",
			});
			if (!marker.ok) {
				throw new Error("Failed to mark Workflow deletion");
			}
			marked.resolve(true);
			if (defer) {
				await scheduler.wait(100);
			}
			await remove(env, namespace, id, pending);
		} catch (error) {
			marked.resolve(false);
			pending.failed = true;
			console.error(error);
		}
		if (!pending.failed && pendingDeletes.get(key) === pending) {
			pendingDeletes.delete(key);
		}
	})();
	return pending;
}

async function waitForDelete(
	env: Env,
	namespace: string,
	id: string
): Promise<Response> {
	const key = `${namespace}/${id}`;
	for (let attempt = 0; attempt < 2; attempt++) {
		let pending = pendingDeletes.get(key);
		if (pending === undefined) {
			const marker = await env.DISK.fetch(
				`http://disk/${namespace}/${id}.sqlite-delete`,
				{ method: "HEAD" }
			);
			pending = pendingDeletes.get(key);
			if (pending === undefined) {
				if (marker.status === 404) {
					return new Response(null, { status: 204 });
				}
				if (!marker.ok) {
					return new Response("Failed to read pending deletion", {
						status: 500,
					});
				}
				pending = queueDelete(env, namespace, id, false);
			}
		}
		await pending.promise;
		let latest = pendingDeletes.get(key);
		while (latest !== undefined && latest !== pending) {
			pending = latest;
			await pending.promise;
			latest = pendingDeletes.get(key);
		}
		if (!pending.failed) {
			return new Response(null, { status: 204 });
		}
		if (attempt === 0) {
			queueDelete(env, namespace, id, false);
		}
	}
	return new Response("Failed to delete instance", { status: 500 });
}

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext
	): Promise<Response> {
		const url = new URL(request.url);
		const match = /^\/core\/workflow-storage\/([^/]+)(?:\/([^/]+))?$/.exec(
			url.pathname
		);
		if (match === null) {
			return new Response("Not Found", { status: 404 });
		}
		let workflowName: string;
		let id: string | undefined;
		try {
			workflowName = decodeURIComponent(match[1]);
			id = match[2] === undefined ? undefined : decodeURIComponent(match[2]);
		} catch {
			return new Response("Invalid storage path", { status: 400 });
		}
		if (
			/[\\/\0]/.test(workflowName) ||
			(id !== undefined && !/^[a-f0-9]{64}$/i.test(id))
		) {
			return new Response("Invalid storage path", { status: 400 });
		}
		const namespace = encodeURIComponent(`miniflare-workflows-${workflowName}`);
		if (
			request.method === "GET" &&
			id !== undefined &&
			url.searchParams.has("waitForPendingDelete")
		) {
			return waitForDelete(env, namespace, id);
		}
		if (request.method !== "DELETE") {
			return new Response("Method Not Allowed", { status: 405 });
		}
		if (id === undefined) {
			const entries = await list(env, namespace);
			const ids = new Set<string>();
			for (const entry of entries) {
				if (entry.type !== "file") {
					continue;
				}
				const instance = /^([a-f0-9]{64})\.sqlite(?:-shm|-wal)?$/i.exec(
					entry.name
				);
				if (instance !== null) {
					ids.add(instance[1]);
				} else if (
					extensions.some((extension) => entry.name.endsWith(extension))
				) {
					await env.DISK.fetch(
						`http://disk/${namespace}/${encodeURIComponent(entry.name)}`,
						{ method: "DELETE" }
					);
				}
			}
			await Promise.all(
				Array.from(
					ids,
					(instanceId) => queueDelete(env, namespace, instanceId, false).promise
				)
			);
			return new Response(null, { status: 200 });
		}
		const defer = url.searchParams.has("defer");
		const pending = queueDelete(env, namespace, id, defer);
		ctx.waitUntil(pending.promise);
		if (!(await pending.marked)) {
			return new Response("Failed to mark deletion", { status: 500 });
		}
		if (defer) {
			return new Response(null, { status: 202 });
		}
		await pending.promise;
		return new Response(
			pending.failed
				? "Failed to delete instance"
				: pending.deleted
					? null
					: "Instance not found",
			{ status: pending.failed ? 500 : pending.deleted ? 204 : 404 }
		);
	},
};
