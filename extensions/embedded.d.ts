// Lo que ve el tsconfig raíz de cada `#extensions/*`: solo el contrato con Pi. El código real
// se chequea con extensions/tsconfig.json, que resuelve esos imports por `imports` de package.json.

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

declare const factory: ExtensionFactory;
export default factory;
