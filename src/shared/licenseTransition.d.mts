export interface LicenseTransition {
	isPro: boolean;
	email: string;
	changed: boolean;
	persist: boolean;
	flipped: boolean;
}

export function resolveLicenseTransition(
	before: { isPro?: boolean; email?: string },
	licenseKey: string,
	verifyResult: { valid?: boolean; email?: string } | null | undefined,
	persistUnchanged?: boolean
): LicenseTransition;
