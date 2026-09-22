import type { APIRoute } from "astro";
import { bindings } from "../../../lib/env.ts";
import { forwardVoiceRequest } from "../../../lib/voice.ts";

export const ALL: APIRoute = ({ request }) =>
	forwardVoiceRequest(request, bindings.VOICE);
