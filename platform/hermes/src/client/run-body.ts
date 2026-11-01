import { RELAY_MAX_REQUEST_BODY } from "@openedbot/contracts-connector";
import type {
  HermesRunImage,
  CreateHermesRunInput,
} from "../contracts";


/**
 * `input` stays a plain string unless the turn carries images. Then it becomes
 * one user message whose content is the text part followed by one `image_url`
 * part per image: `/v1/runs` hands the last input message's `content` to
 * `run_conversation` as is, and the agent reads OpenAI vision parts natively
 * (`api_server_runs.py`, `_normalize_multimodal_content` in `api_server.py`).
 */
function hermesRunInput(input: CreateHermesRunInput): unknown {
  if (!input.images?.length) return input.input;
  return [{
    role: "user",
    content: [
      ...(input.input ? [{ type: "text", text: input.input }] : []),
      ...input.images.map((image) => ({ type: "image_url", image_url: { url: image.dataUrl } })),
    ],
  }];
}

function hermesRunModelOptions(input: CreateHermesRunInput): Record<string, string> | null {
  const options: Record<string, string> = {};
  if (input.reasoningEffort) options.reasoning_effort = input.reasoningEffort;
  if (input.promptCacheTtl) options.prompt_cache_ttl = input.promptCacheTtl;
  return Object.keys(options).length ? options : null;
}

export function hermesRunRequestBody(input: CreateHermesRunInput): Record<string, unknown> {
  const modelOptions = hermesRunModelOptions(input);
  return {
    input: hermesRunInput(input),
    instructions: input.instructions,
    session_id: input.sessionId,
    ...(input.model ? { model: input.model } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    ...(modelOptions ? { model_options: modelOptions } : {}),
    ...(input.conversationHistory?.length ? { conversation_history: input.conversationHistory } : {}),
  };
}

/** Room left under the relay bound for the notes the caller adds about dropped images. */
const RUN_BODY_MARGIN = 16 << 10;

/**
 * The images of a run that fit, in order, and the ones that do not.
 *
 * The connector link refuses a request body over `RELAY_MAX_REQUEST_BODY`
 * (`transport/relay.ts`) and the whole run fails with it. An image is
 * dropped, and named to the caller, rather than taking the turn down. The
 * gateway itself accepts 10 MB: the link is the bound.
 */
export function fitHermesRunImages(
  input: CreateHermesRunInput,
  limit = RELAY_MAX_REQUEST_BODY - RUN_BODY_MARGIN,
): { images: HermesRunImage[]; dropped: HermesRunImage[] } {
  const images: HermesRunImage[] = [];
  const dropped: HermesRunImage[] = [];
  for (const image of input.images ?? []) {
    const body = JSON.stringify(hermesRunRequestBody({ ...input, images: [...images, image] }));
    if (Buffer.byteLength(body) <= limit) images.push(image);
    else dropped.push(image);
  }
  return { images, dropped };
}
