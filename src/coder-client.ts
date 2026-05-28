import { z } from "zod";
import { normalizeBaseUrl } from "./url";
import {
	ChatSchema,
	ChatDiffStatusSchema,
	ChatErrorSchema,
	ChatStatusSchema,
	CreateChatMessageRequestSchema,
	CreateChatRequestSchema,
	OrganizationSchema,
	UserSchema,
} from "./codersdk.gen";
import type {
	CreateChatMessageRequest,
	CreateChatRequest,
	Organization,
	User,
} from "./codersdk.gen";

// Hand-written: the action only reads `queued` from the response.
// The full ChatMessage/ChatMessagePart types use a discriminated
// union that the flat codegen cannot represent correctly.
export const CreateChatMessageResponseSchema = z.object({
	queued: z.boolean(),
});
export type CreateChatMessageResponse = z.infer<
	typeof CreateChatMessageResponseSchema
>;

export {
	ChatSchema,
	ChatDiffStatusSchema,
	ChatErrorSchema,
	ChatStatusSchema,
	CreateChatMessageRequestSchema,
	CreateChatRequestSchema,
	OrganizationSchema,
	UserSchema,
};
export type {
	Chat,
	ChatDiffStatus,
	ChatError,
	ChatStatus,
	CreateChatMessageRequest,
	CreateChatRequest,
	Organization,
	User,
} from "./codersdk.gen";

/**
 * Default per-request timeout. A hung Coder server would otherwise burn
 * CI minutes up to the workflow's job-level timeout (default 6 hours).
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

// Branded chat ID for type safety across the action.
export const ChatIdSchema = z.uuid().brand("ChatId");
export type ChatId = z.infer<typeof ChatIdSchema>;

export const CoderChatSchema = ChatSchema.extend({
	id: ChatIdSchema,
});
export type CoderChat = z.infer<typeof CoderChatSchema>;

// Chat list response (the API returns an array).
export const CoderChatListResponseSchema = z.array(CoderChatSchema);

export interface CoderClient {
	/**
	 * Resolve the Coder user the configured `coder-token` belongs to via
	 * `GET /api/v2/users/me`. The chat owner on `POST /api/experimental/chats`
	 * is always the token holder (the API has no owner override), so this is
	 * the Coder identity the chat runs as.
	 */
	getAuthenticatedUser(): Promise<User>;

	getOrganizationByName(name: string): Promise<Organization>;

	createChat(params: CreateChatRequest): Promise<CoderChat>;

	createChatMessage(
		chatId: ChatId,
		params: CreateChatMessageRequest,
	): Promise<CreateChatMessageResponse>;

	getChat(chatId: ChatId): Promise<CoderChat>;

	listChats(opts?: ListChatsOptions): Promise<CoderChat[]>;
}

export interface ListChatsOptions {
	/**
	 * `key:value` label filter. Multiple entries become repeated
	 * `?label=...` params and are ANDed by the API.
	 */
	label?: string | string[];
	/** If false, send `?q=archived:false` explicitly. */
	archived?: boolean;
}

export class RealCoderClient implements CoderClient {
	private readonly serverURL: string;
	private readonly headers: Record<string, string>;

	constructor(serverURL: string, apiToken: string) {
		// Strip trailing slashes so `${this.serverURL}${endpoint}` never
		// produces a double-slash URL when a user passes `https://coder/`.
		this.serverURL = normalizeBaseUrl(serverURL);
		this.headers = {
			"Coder-Session-Token": apiToken,
			"Content-Type": "application/json",
		};
	}

	private async request<T>(
		endpoint: string,
		options?: RequestInit,
	): Promise<T> {
		const url = `${this.serverURL}${endpoint}`;
		let response: Response;
		try {
			response = await fetch(url, {
				...options,
				headers: { ...this.headers, ...options?.headers },
				signal:
					options?.signal ?? AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS),
			});
		} catch (err) {
			// Rewrap AbortSignal.timeout's DOMException so callers see a
			// CoderAPIError carrying the endpoint and the configured
			// timeout. Without this, classifyError downgrades the abort to
			// a generic `api_error` with the runtime-default message.
			if (err instanceof DOMException && err.name === "TimeoutError") {
				throw new CoderAPIError(
					`Request to ${endpoint} timed out after ${DEFAULT_REQUEST_TIMEOUT_MS}ms`,
					0,
				);
			}
			throw err;
		}

		if (!response.ok) {
			const body = await response.text().catch(() => "");
			throw new CoderAPIError(
				`Coder API error: ${response.statusText}`,
				response.status,
				body,
			);
		}

		if (
			response.status === 204 ||
			response.headers?.get("content-length") === "0"
		) {
			return undefined as T;
		}

		return response.json() as Promise<T>;
	}

	async getAuthenticatedUser(): Promise<User> {
		// Resolves the session token to its owning user. Callers
		// memoize when they reference the result more than once.
		const response = await this.request<unknown>("/api/v2/users/me");
		return UserSchema.parse(response);
	}

	async getOrganizationByName(name: string): Promise<Organization> {
		if (!name) {
			throw new CoderAPIError("Organization name cannot be empty", 400);
		}
		const endpoint = `/api/v2/organizations/${encodeURIComponent(name)}`;
		const response = await this.request<unknown>(endpoint);
		return OrganizationSchema.parse(response);
	}

	async createChat(params: CreateChatRequest): Promise<CoderChat> {
		const endpoint = "/api/experimental/chats";
		const response = await this.request<unknown>(endpoint, {
			method: "POST",
			body: JSON.stringify(params),
		});
		return CoderChatSchema.parse(response);
	}

	async createChatMessage(
		chatId: ChatId,
		params: CreateChatMessageRequest,
	): Promise<CreateChatMessageResponse> {
		const endpoint = `/api/experimental/chats/${encodeURIComponent(chatId)}/messages`;
		const response = await this.request<unknown>(endpoint, {
			method: "POST",
			body: JSON.stringify(params),
		});
		return CreateChatMessageResponseSchema.parse(response);
	}

	async getChat(chatId: ChatId): Promise<CoderChat> {
		const endpoint = `/api/experimental/chats/${encodeURIComponent(chatId)}`;
		const response = await this.request<unknown>(endpoint);
		return CoderChatSchema.parse(response);
	}

	async listChats(opts?: ListChatsOptions): Promise<CoderChat[]> {
		const params: string[] = [];
		if (opts?.label !== undefined) {
			const labels = Array.isArray(opts.label) ? opts.label : [opts.label];
			for (const l of labels) {
				params.push(`label=${encodeURIComponent(l)}`);
			}
		}
		if (opts?.archived === false) {
			// Explicit `?q=archived:false` pins the contract even though
			// the API filters archived chats by default.
			params.push(`q=${encodeURIComponent("archived:false")}`);
		}
		const query = params.length ? `?${params.join("&")}` : "";
		const endpoint = `/api/experimental/chats${query}`;
		const response = await this.request<unknown>(endpoint);
		const parsed = CoderChatListResponseSchema.parse(response);
		return parsed;
	}
}

/**
 * CoderAPIError carries the status code and raw response body from a Coder
 * API failure. The body is preserved verbatim so the failure-path
 * classifier in `comment.ts` can pattern-match structured shapes (e.g.
 * the spend-exceeded 409) without rerunning the request.
 */
export class CoderAPIError extends Error {
	constructor(
		message: string,
		public readonly statusCode: number,
		public readonly response?: unknown,
	) {
		super(message);
		this.name = "CoderAPIError";
	}
}
