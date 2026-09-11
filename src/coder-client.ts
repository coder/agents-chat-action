import { z } from "zod";
import { normalizeBaseUrl } from "./url";
import {
	ChatSchema,
	ChatDiffStatusSchema,
	ChatErrorSchema,
	ChatRoleSchema,
	ChatStatusSchema,
	CreateChatMessageRequestSchema,
	CreateChatRequestSchema,
	GroupSchema,
	OrganizationSchema,
	UpdateChatACLSchema,
	UserSchema,
} from "./codersdk.gen";
import type {
	CreateChatMessageRequest,
	CreateChatRequest,
	Group,
	Organization,
	UpdateChatACL,
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
	ChatRoleSchema,
	ChatStatusSchema,
	CreateChatMessageRequestSchema,
	CreateChatRequestSchema,
	GroupSchema,
	OrganizationSchema,
	UpdateChatACLSchema,
	UserSchema,
};
export type {
	Chat,
	ChatDiffStatus,
	ChatError,
	ChatRole,
	ChatStatus,
	CreateChatMessageRequest,
	CreateChatRequest,
	Group,
	Organization,
	UpdateChatACL,
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

	/**
	 * Resolve a user by username or UUID via `GET /api/v2/users/{user}`.
	 */
	getUser(usernameOrID: string): Promise<User>;

	/**
	 * Resolve a group by name inside an organization via
	 * `GET /api/v2/organizations/{organization}/groups/{groupName}`. Served
	 * by the licensed build only; unlicensed deployments answer 404.
	 */
	getGroupByName(organizationID: string, name: string): Promise<Group>;

	createChat(params: CreateChatRequest): Promise<CoderChat>;

	createChatMessage(
		chatId: ChatId,
		params: CreateChatMessageRequest,
	): Promise<CreateChatMessageResponse>;

	getChat(chatId: ChatId): Promise<CoderChat>;

	listChats(opts?: ListChatsOptions): Promise<CoderChat[]>;

	/**
	 * Grant read access on a chat to users or groups via
	 * `PATCH /api/v2/chats/{chat}/acl`. Every chat is owned by the
	 * `coder-token` holder, so without an ACL entry nobody else can open
	 * one. Keys must be existing UUIDs. Group entries send no
	 * notifications; user entries do.
	 */
	updateChatACL(chatId: ChatId, params: UpdateChatACL): Promise<void>;
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

	async getUser(usernameOrID: string): Promise<User> {
		if (!usernameOrID) {
			throw new CoderAPIError("User cannot be empty", 400);
		}
		const endpoint = `/api/v2/users/${encodeURIComponent(usernameOrID)}`;
		const response = await this.request<unknown>(endpoint);
		return UserSchema.parse(response);
	}

	async getGroupByName(organizationID: string, name: string): Promise<Group> {
		if (!organizationID || !name) {
			throw new CoderAPIError(
				"Organization and group name cannot be empty",
				400,
			);
		}
		// Only the ID is needed, so leave the member list out of the response.
		const endpoint = `/api/v2/organizations/${encodeURIComponent(organizationID)}/groups/${encodeURIComponent(name)}?exclude_members=true`;
		const response = await this.request<unknown>(endpoint);
		return GroupSchema.parse(response);
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

	async updateChatACL(chatId: ChatId, params: UpdateChatACL): Promise<void> {
		// The ACL route is served from /api/v2. The chat routes above still
		// use the /api/experimental mount, which is the older prefix.
		const endpoint = `/api/v2/chats/${encodeURIComponent(chatId)}/acl`;
		await this.request<void>(endpoint, {
			method: "PATCH",
			body: JSON.stringify(params),
		});
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
