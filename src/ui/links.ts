import { PURCHASE_URL } from "../product";

/** Returns `url` if it is a well-formed http(s) URL, otherwise `fallback`. */
export function safeHttpUrl(url: string, fallback: string): string {
	try {
		const parsed = new URL(url);
		if (parsed.protocol === "http:" || parsed.protocol === "https:") return url;
	} catch {
		// Not a parseable URL — fall through.
	}
	return fallback;
}

/**
 * Every outbound link goes through here: the href is sanitised to http(s) (so a value that
 * ever became user-editable could not smuggle in `javascript:`), and it opens in a new tab
 * with rel="noopener noreferrer".
 *
 * An ANCHOR, deliberately — not `window.open`. Obsidian routes a real anchor to the OS
 * browser on desktop AND on mobile; `window.open` does not, and a Pro link that silently
 * does nothing on a phone is worse than no link.
 */
export function createExternalLink(
	parent: HTMLElement,
	options: { text: string; url: string; cls?: string }
): HTMLAnchorElement {
	const link = parent.createEl("a", {
		cls: options.cls,
		text: options.text,
		href: safeHttpUrl(options.url, PURCHASE_URL),
	});
	link.setAttr("target", "_blank");
	link.setAttr("rel", "noopener noreferrer");
	return link;
}
