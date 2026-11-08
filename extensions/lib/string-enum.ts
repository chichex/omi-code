// `StringEnum` de pi-ai devuelve `Schema<T>` de pi-schema, y `Static` de typebox lo lee como `unknown`.
// El cast es solo de tipos: en runtime sigue siendo el schema `{ type: "string", enum: [...] }` de Pi.

import { StringEnum as piStringEnum } from "@earendil-works/pi-ai";
import type { TUnsafe } from "typebox";

export const StringEnum = piStringEnum as unknown as <T extends readonly string[]>(
	values: T,
	options?: { description?: string; default?: T[number] },
) => TUnsafe<T[number]>;
