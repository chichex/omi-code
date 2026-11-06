// Lo que ve el tsconfig raíz de cada `#extensions/*`: solo el contrato con Pi. Ese tsconfig apaga
// resolvePackageJsonImports para no entrar a extensions/, que se chequea con su propio tsconfig.
// Node y bun no leen esto: resuelven `#extensions/*` con `imports` de package.json.

declare module "#extensions/*" {
	import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

	const factory: ExtensionFactory;
	export default factory;
}
