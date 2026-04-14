export const GADGET_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function validateGadgetId(id: string): void {
	if (!GADGET_ID_PATTERN.test(id)) {
		throw new InvalidGadgetIdError(id);
	}
}

export class InvalidGadgetIdError extends Error {
	override readonly name = "InvalidGadgetIdError";
	constructor(readonly id: string) {
		super(`invalid gadget id: ${JSON.stringify(id)} (must match ${GADGET_ID_PATTERN.source})`);
	}
}

export function newRevisionId(nowMs: number): string {
	const rand = Math.floor(Math.random() * 0xffffffff)
		.toString(16)
		.padStart(8, "0");
	return `${nowMs.toString(16)}-${rand}`;
}
