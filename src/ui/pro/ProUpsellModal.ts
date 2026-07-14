import { App, Modal, Notice } from "obsidian";
import {
	PRO_NAME,
	PRO_PRICE_LABEL,
	PRO_TAGLINE,
	PRO_UPSELL,
	PRODUCT_NAME,
	PURCHASE_URL,
} from "../../product";
import { createExternalLink } from "../links";

/**
 * Shown the moment a free user reaches for a Pro feature: what they get, the price, a
 * purchase link, and a shortcut to paste a key — instead of a toast that fades with no
 * next step.
 *
 * Built with createDiv/createEl only. Never innerHTML: the review bot rejects it, and the
 * copy here is interpolated from product.ts, which is exactly the shape of string that
 * turns into an injection the day someone makes it configurable.
 */
export class ProUpsellModal extends Modal {
	constructor(
		app: App,
		private feature: keyof typeof PRO_UPSELL
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.titleEl.setText(`${PRO_NAME} — ${PRO_PRICE_LABEL}`);

		contentEl.createDiv({
			cls: "note-decay-upsell-lead",
			text: PRO_UPSELL[this.feature] ?? PRO_TAGLINE,
		});
		contentEl.createDiv({ cls: "note-decay-upsell-sub", text: PRO_TAGLINE });

		const actions = contentEl.createDiv({ cls: "note-decay-upsell-actions" });
		createExternalLink(actions, {
			cls: "note-decay-pro-btn",
			text: `Get Pro — ${PRO_PRICE_LABEL}`,
			url: PURCHASE_URL,
		});

		// Modal is not a Component, so there is no registerDomEvent here. onClose() empties
		// contentEl, which takes the button and this listener with it.
		const haveKey = actions.createEl("button", { text: "I have a license key" });
		haveKey.addEventListener("click", () => {
			this.close();
			// A plain instruction rather than a private-API jump into the settings pane.
			new Notice(`Open Settings → Community plugins → ${PRODUCT_NAME} → License and paste your key.`);
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
