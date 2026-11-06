// Errores de omi con su código de salida semántico: 0 ok, 1 ejecución/API, 2 uso/guardrail.

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;

export const GUARDRAIL_CONFIRMATION_REQUIRED = "guardrail_confirmation_required";

export class OmiError extends Error {
	readonly code: string;
	readonly exitCode: number;
	readonly hint: string | undefined;

	constructor(code: string, message: string, options: { exitCode?: number; hint?: string; cause?: unknown } = {}) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = new.target.name;
		this.code = code;
		this.exitCode = options.exitCode ?? EXIT_ERROR;
		this.hint = options.hint;
	}
}

export class UsageError extends OmiError {
	constructor(message: string, hint?: string) {
		super("usage_error", message, { exitCode: EXIT_USAGE, ...(hint === undefined ? {} : { hint }) });
	}
}

export class GuardrailError extends OmiError {
	readonly diff: string | undefined;

	constructor(message: string, diff?: string) {
		super(GUARDRAIL_CONFIRMATION_REQUIRED, message, { exitCode: EXIT_USAGE });
		this.diff = diff;
	}
}

export class ApiError extends OmiError {
	readonly status: number;

	constructor(code: string, message: string, status: number, hint?: string) {
		super(code, message, { exitCode: EXIT_ERROR, ...(hint === undefined ? {} : { hint }) });
		this.status = status;
	}
}
