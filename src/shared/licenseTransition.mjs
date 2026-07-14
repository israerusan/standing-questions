/**
 * Pure decision for a license refresh. Given the prior pro/email state, the
 * already-computed verification result (null when there is no key), and whether
 * the caller wants an unchanged state persisted anyway, decide the next state and
 * which side effects to run. The plugin applies the settings and saves — this stays
 * testable and never touches Obsidian or data.json.
 *
 * Rules (the "no-churn" contract, each asserted in test/license-transition.test.mjs):
 * - No key + already free (not pro, no email): a no-op — DON'T re-save unless the
 *   caller forces it (the settings tab passes persistUnchanged so the typed key
 *   text is stored). This is what keeps data.json from churning on every keystroke.
 * - `flipped` fires only when isPro actually flips, never on a mere email change, so
 *   the editor extension and the panel only rebuild when entitlement really moved.
 *
 * @param {{isPro?: boolean, email?: string}} before
 * @param {string} licenseKey
 * @param {{valid?: boolean, email?: string}|null|undefined} verifyResult
 * @param {boolean} [persistUnchanged]
 * @returns {{isPro: boolean, email: string, changed: boolean, persist: boolean, flipped: boolean}}
 */
export function resolveLicenseTransition(before, licenseKey, verifyResult, persistUnchanged = false) {
	const wasPro = before && before.isPro === true;
	const wasEmail = before && typeof before.email === "string" ? before.email : "";

	if (!licenseKey) {
		// No key → free tier. Only touch data.json when something actually changes
		// (isPro was on, or a stale email needs clearing) or the caller forces it.
		if (!wasPro && !wasEmail) {
			return { isPro: false, email: "", changed: false, persist: persistUnchanged, flipped: false };
		}
		const flipped = wasPro; // isPro is about to become false
		return { isPro: false, email: "", changed: flipped, persist: true, flipped };
	}

	const isPro = verifyResult ? verifyResult.valid === true : false;
	const email = verifyResult && typeof verifyResult.email === "string" ? verifyResult.email : "";
	const flipped = wasPro !== isPro;
	const changed = flipped || wasEmail !== email;
	return { isPro, email, changed, persist: changed || persistUnchanged, flipped };
}
