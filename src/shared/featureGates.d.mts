export interface FeatureGate {
	proOnly: boolean;
	engine?: boolean;
	freeLimit?: number;
	label: string;
}

export type FeatureTable = Readonly<Record<string, FeatureGate>>;

export function isFeatureEnabled(table: FeatureTable, key: string, isPro: boolean): boolean;
export function proFeatureKeys(table: FeatureTable): string[];
export function needsEngine(table: FeatureTable, key: string): boolean;
export function featureFreeLimit(table: FeatureTable, key: string): number;
export function withinFreeLimit(
	table: FeatureTable,
	key: string,
	count: number,
	isPro: boolean
): boolean;
