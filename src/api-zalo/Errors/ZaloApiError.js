export class ZaloApiError extends Error {
    constructor(message, code, status, details = {}) {
        super(message);
        this.name = "ZaloApiError";
        this.code = code ?? null;
        this.status = status ?? null;
        this.endpoint = details.endpoint ?? null;
        this.command = details.command ?? null;
        this.retryable = Boolean(details.retryable);
        this.reference = details.reference ?? null;
        this.cause = details.cause ?? null;
    }
}
