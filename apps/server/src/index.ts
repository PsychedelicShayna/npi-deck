// Process entry for the deck server. Everything lives in startDeck().
import { logger } from "./log.ts";
import { startDeck } from "./deck.ts";

startDeck().catch((err) => {
	logger("server").error(`fatal`, err);
	process.exit(1);
});
