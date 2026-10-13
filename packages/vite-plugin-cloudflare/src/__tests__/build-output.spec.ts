import * as fs from "node:fs";
import * as path from "node:path";
import {
	getRootConfigPath,
	getWorkerConfigPath,
} from "@cloudflare/build-output-utils";
import { InputWorkerSchema } from "@cloudflare/config";
import { runInTempDir, seed } from "@cloudflare/workers-utils/test-helpers";
import { createBuilder } from "vite";
import { afterEach, describe, it, vi } from "vitest";
import { isPreviewBuild, PREVIEW_BUILD_ENV_VAR } from "../build-output-env";
import { buildOutputPlugin, detectModuleType } from "../plugins/build-output";
import type { PluginContext } from "../context";

describe("Preview Build Output", () => {
	runInTempDir();
	afterEach(() => vi.unstubAllEnvs());

	it.for([
		{ isPreview: false, assetsOnly: false },
		{ isPreview: true, assetsOnly: false },
		{ isPreview: false, assetsOnly: true },
		{ isPreview: true, assetsOnly: true },
	])(
		"emits domains only for production (isPreview: $isPreview, assetsOnly: $assetsOnly)",
		async ({ isPreview, assetsOnly }, { expect }) => {
			vi.stubEnv(PREVIEW_BUILD_ENV_VAR, String(isPreview));
			const root = process.cwd();
			const domains = [
				"example.com",
				{ hostname: "previews.example.com", production: false, previews: true },
			];
			const worker = InputWorkerSchema.parse({
				name: "test-worker",
				compatibilityDate: "2026-05-18",
				entrypoint: assetsOnly ? undefined : "./index.js",
				domains,
			});
			await seed({
				"index.html":
					'<html><script type="module" src="/index.js"></script></html>',
				"index.js":
					"export default { fetch() { return new Response('ok'); } };",
			});
			const ctx = {
				isChildEnvironment: () => false,
				resolvedViteConfig: { root, mode: "production" },
				resolvedPluginConfig: {
					type: assetsOnly ? "assets-only" : "workers",
					entryWorkerEnvironmentName: "client",
					parsedNewConfig: { worker },
				},
				getWorkerNewConfig: () => worker,
			} as unknown as PluginContext;
			const builder = await createBuilder({
				root,
				configFile: false,
				logLevel: "silent",
				plugins: [buildOutputPlugin(ctx)],
				build: assetsOnly
					? {}
					: { rollupOptions: { input: path.join(root, "index.js") } },
			});
			await builder.buildApp();

			const output = JSON.parse(
				fs.readFileSync(getWorkerConfigPath(root), "utf8")
			);
			if (isPreview) {
				expect(output).not.toHaveProperty("domains");
			} else {
				expect(output.domains).toEqual(domains);
			}
			expect(
				JSON.parse(fs.readFileSync(getRootConfigPath(root), "utf8"))
			).toMatchObject({
				buildContext: { isPreview },
			});
		}
	);
});

describe("isPreviewBuild", () => {
	afterEach(() => vi.unstubAllEnvs());

	it("uses the shared Preview build environment variable", ({ expect }) => {
		expect(PREVIEW_BUILD_ENV_VAR).toBe("CLOUDFLARE_PREVIEW_BUILD");
		vi.stubEnv(PREVIEW_BUILD_ENV_VAR, "true");

		expect(isPreviewBuild()).toBe(true);
	});

	it("is false for non-Preview builds", ({ expect }) => {
		vi.stubEnv(PREVIEW_BUILD_ENV_VAR, "false");

		expect(isPreviewBuild()).toBe(false);
	});
});

describe("detectModuleType", () => {
	const cases: Array<{ filename: string; expected: string }> = [
		{ filename: "entry.js", expected: "esm" },
		{ filename: "entry.mjs", expected: "esm" },
		{ filename: "lib.wasm", expected: "wasm" },
		{ filename: "raw.bin", expected: "data" },
		{ filename: "greeting.txt", expected: "text" },
		{ filename: "page.html", expected: "text" },
		{ filename: "query.sql", expected: "text" },
		{ filename: "data.json", expected: "json" },
		{ filename: "bundle.js.map", expected: "sourcemap" },
		{ filename: "unknown.xyz", expected: "data" },
		// Case-insensitive on extension
		{ filename: "ENTRY.JS", expected: "esm" },
		{ filename: "LIB.WASM", expected: "wasm" },
		// No extension → default `data`
		{ filename: "LICENSE", expected: "data" },
		// Nested paths — only the extension matters
		{ filename: "chunks/foo.js", expected: "esm" },
		{ filename: "chunks/foo.wasm", expected: "wasm" },
	];

	it.for(cases)(
		"maps $filename → $expected",
		({ filename, expected }, { expect }) => {
			expect(detectModuleType(filename)).toBe(expected);
		}
	);
});
