// Frontera Pi: streamSimple normaliza sólo este contexto, sin crear Agent/AgentSession ni cargar settings.
import type { Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { localReviewModelBlock, type LocalReviewCall } from "../harness/lifecycle-local-review.ts";
interface ReviewRegistry<TModel> { streamSimple: (model: TModel, context: Context, options: SimpleStreamOptions) => { result: () => Promise<unknown> } }
export function createLocalReviewCall<TModel>(registry: ReviewRegistry<TModel>, model: TModel): LocalReviewCall {
 const blocked = localReviewModelBlock(model); if (blocked) throw new Error(blocked);
 return (context, options) => registry.streamSimple(model, context, { ...options, cacheRetention: "none", toolChoice: "none" }).result();
}
