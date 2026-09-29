/** Worker thread for {@link checkStructuredOutput}: one request, one reply, then the parent terminates it. */
import { checkStructuredOutputSync } from "./structured-output.ts";

declare const self: Worker;

self.onmessage = (event: MessageEvent<{ schema: unknown; answer: string }>) => {
	self.postMessage(checkStructuredOutputSync(event.data.schema, event.data.answer));
};
