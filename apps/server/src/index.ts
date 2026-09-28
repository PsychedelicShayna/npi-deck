// Process entry for the deck server. Everything lives in startDeck().
import { logger } from "./log.ts";
import { rollbackFailedBoot, startDeck } from "./deck.ts";

startDeck().catch((err) => {
	logger("server").error("fatal", err);
	try {
		if (rollbackFailedBoot()) process.exit(75);
	} catch (rollbackError) { logger("server").error("backend rollback failed", rollbackError); }
	process.exit(1);
});
