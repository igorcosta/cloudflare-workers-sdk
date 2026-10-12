import { Miniflare } from "miniflare";
import { test } from "vitest";
import { singleModuleManifest, useDispose } from "../../../test-shared";
import type { MiniflareOptions } from "miniflare";

test.for(["secrets-store", "flagship"])(
	"preserves synchronous %s admin factories across runtime invalidation",
	async (bindingType, { expect }) => {
		const options: MiniflareOptions = {
			workers: [
				{
					config: {
						name: "",
						compatibilityDate: "2025-01-01",
						manifest: singleModuleManifest(
							`export default { fetch() { return new Response("ok"); } }`
						),
						env: {
							SECRET: {
								type: "secrets-store-secret",
								storeId: "factory-test",
								secretName: "secret",
							},
							FLAGS: { type: "flagship", id: "factory-test" },
						},
					},
				},
			],
		};
		const miniflare = new Miniflare(options);
		useDispose(miniflare);
		function getFactory() {
			return bindingType === "secrets-store"
				? miniflare.getSecretsStoreSecretAPI("SECRET")
				: miniflare.getFlagshipBindingAPI("FLAGS");
		}

		const factory = await getFactory();
		expect(await getFactory()).toBe(factory);
		const firstAdmin = factory();
		expect(firstAdmin).not.toBeInstanceOf(Promise);
		const secondAdmin = factory();
		expect(secondAdmin).not.toBeInstanceOf(Promise);
		expect(secondAdmin).not.toBe(firstAdmin);

		await miniflare.setOptions(options);
		expect(() => factory()).toThrow("Attempted to use poisoned stub");
		expect(() => Object.keys(firstAdmin)).toThrow(
			"Attempted to use poisoned stub"
		);

		const replacementFactory = await getFactory();
		expect(replacementFactory).not.toBe(factory);
		expect(await getFactory()).toBe(replacementFactory);
		await miniflare.dispose();
		expect(() => replacementFactory()).toThrow(
			"Attempted to use poisoned stub"
		);
	}
);
