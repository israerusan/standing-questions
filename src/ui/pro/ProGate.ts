import type { App } from "obsidian";
import { PRO_UPSELL } from "../../product";
import { ProUpsellModal } from "./ProUpsellModal";

/** Anything carrying the resolved Pro entitlement and an app handle. */
export interface ProHost {
	isPro: boolean;
	app: App;
}

/**
 * The one place Pro features are gated at the point of use. Runs `action` when Pro is
 * active, otherwise opens an actionable upsell for `feature`.
 *
 * Note that the two Pro features Note Decay ships (`topicGroups`, `superseded`) are
 * ALSO engine features, and their COMMANDS are hidden from the palette entirely via
 * checkCallback rather than routed through here — a command that always opens a sales
 * modal is a command that should not have been in the palette. This gate exists for the
 * surfaces a free user can still see and click (a Pro row in the queue header), where
 * "here is what you would get" is the right answer.
 */
export function requirePro(
	host: ProHost,
	feature: keyof typeof PRO_UPSELL,
	action: () => void
): boolean {
	if (host.isPro) {
		action();
		return true;
	}
	new ProUpsellModal(host.app, feature).open();
	return false;
}
