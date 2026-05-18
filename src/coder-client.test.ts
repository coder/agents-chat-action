import { describe, expect, test, beforeEach, mock } from "bun:test";
import {
	RealCoderClient,
	CoderAPIError,
	DEFAULT_REQUEST_TIMEOUT_MS,
} from "./coder-client";
import {
	mockUser,
	mockChat,
	mockChatMessageResponse,
	mockOrganization,
	createMockInputs,
	createMockResponse,
} from "./test-helpers";

describe("CoderClient", () => {
	let client: RealCoderClient;
	let mockFetch: ReturnType<typeof mock>;

	beforeEach(() => {
		const mockInputs = createMockInputs();
		client = new RealCoderClient(mockInputs.coderURL, mockInputs.coderToken);
		mockFetch = mock(() => Promise.resolve(createMockResponse([])));
		global.fetch = mockFetch as unknown as typeof fetch;
	});

	describe("createChat", () => {
		test("normalizes a trailing slash on serverURL so the API URL has no double slash", async () => {
			const clientWithSlash = new RealCoderClient(
				"https://coder.test/",
				"test-token",
			);
			mockFetch.mockResolvedValueOnce(createMockResponse(mockChat));
			await clientWithSlash.createChat({
				organization_id: mockOrganization.id,
				content: [{ type: "text", text: "Test" }],
			});
			expect(mockFetch).toHaveBeenCalledWith(
				"https://coder.test/api/experimental/chats",
				expect.anything(),
			);
		});

		test("creates chat successfully", async () => {
			mockFetch.mockResolvedValueOnce(createMockResponse(mockChat));
			const result = await client.createChat({
				organization_id: mockOrganization.id,
				content: [{ type: "text", text: "Test prompt" }],
			});
			expect(result.id).toBe(mockChat.id);
			expect(result.title).toBe(mockChat.title);
			expect(mockFetch).toHaveBeenNthCalledWith(
				1,
				"https://coder.test/api/experimental/chats",
				expect.objectContaining({
					method: "POST",
					headers: expect.objectContaining({
						"Coder-Session-Token": "test-token",
					}),
					body: JSON.stringify({
						organization_id: mockOrganization.id,
						content: [{ type: "text", text: "Test prompt" }],
					}),
				}),
			);
		});

		test("creates chat with workspace_id", async () => {
			mockFetch.mockResolvedValueOnce(createMockResponse(mockChat));
			const workspaceId = "550e8400-e29b-41d4-a716-446655440000";
			await client.createChat({
				organization_id: mockOrganization.id,
				content: [{ type: "text", text: "Test prompt" }],
				workspace_id: workspaceId,
			});
			const call = mockFetch.mock.calls[0];
			const body = JSON.parse(call[1].body);
			expect(body.workspace_id).toBe(workspaceId);
		});

		test("request body includes organization_id on every call", async () => {
			mockFetch.mockResolvedValueOnce(createMockResponse(mockChat));
			await client.createChat({
				organization_id: mockOrganization.id,
				content: [{ type: "text", text: "Test prompt" }],
			});
			const body = JSON.parse(mockFetch.mock.calls[0][1].body);
			expect(body.organization_id).toBe(mockOrganization.id);
		});
	});

	describe("createChatMessage", () => {
		test("sends message successfully", async () => {
			mockFetch.mockResolvedValue(createMockResponse(mockChatMessageResponse));
			const result = await client.createChatMessage(mockChat.id, {
				content: [{ type: "text", text: "Follow-up" }],
			});
			expect(result.queued).toBe(false);
			expect(mockFetch).toHaveBeenCalledWith(
				`https://coder.test/api/experimental/chats/${mockChat.id}/messages`,
				expect.objectContaining({
					method: "POST",
					body: expect.stringContaining("Follow-up"),
				}),
			);
		});

		test("throws on 404", async () => {
			mockFetch.mockResolvedValue(
				createMockResponse(
					{ error: "Not Found" },
					{ ok: false, status: 404, statusText: "Not Found" },
				),
			);
			expect(
				client.createChatMessage(mockChat.id, {
					content: [{ type: "text", text: "Test" }],
				}),
			).rejects.toThrow(CoderAPIError);
		});
	});

	describe("getChat", () => {
		test("returns chat when found", async () => {
			mockFetch.mockResolvedValue(createMockResponse(mockChat));
			const result = await client.getChat(mockChat.id);
			expect(result.id).toBe(mockChat.id);
			expect(result.status).toBe(mockChat.status);
			expect(mockFetch).toHaveBeenCalledWith(
				`https://coder.test/api/experimental/chats/${mockChat.id}`,
				expect.objectContaining({
					headers: expect.objectContaining({
						"Coder-Session-Token": "test-token",
					}),
				}),
			);
		});
	});

	describe("getAuthenticatedUser", () => {
		test("returns the user behind the configured token", async () => {
			mockFetch.mockResolvedValueOnce(createMockResponse(mockUser));

			const result = await client.getAuthenticatedUser();

			expect(result.id).toBe(mockUser.id);
			expect(result.username).toBe(mockUser.username);
			expect(mockFetch).toHaveBeenCalledWith(
				"https://coder.test/api/v2/users/me",
				expect.objectContaining({
					headers: expect.objectContaining({
						"Coder-Session-Token": "test-token",
					}),
				}),
			);
		});

		test("propagates 401 as CoderAPIError", async () => {
			mockFetch.mockResolvedValueOnce(
				createMockResponse(
					{ error: "Unauthorized" },
					{ ok: false, status: 401, statusText: "Unauthorized" },
				),
			);

			let caught: unknown;
			try {
				await client.getAuthenticatedUser();
			} catch (e) {
				caught = e;
			}

			expect(caught).toBeInstanceOf(CoderAPIError);
			expect((caught as CoderAPIError).statusCode).toBe(401);
		});
	});

	describe("getOrganizationByName", () => {
		test("returns the organization when found", async () => {
			mockFetch.mockResolvedValueOnce(createMockResponse(mockOrganization));

			const result = await client.getOrganizationByName(mockOrganization.name);

			expect(result.id).toBe(mockOrganization.id);
			expect(result.name).toBe(mockOrganization.name);
			expect(mockFetch).toHaveBeenCalledWith(
				`https://coder.test/api/v2/organizations/${mockOrganization.name}`,
				expect.objectContaining({
					headers: expect.objectContaining({
						"Coder-Session-Token": "test-token",
					}),
				}),
			);
		});

		test("encodes the organization name in the URL path", async () => {
			mockFetch.mockResolvedValueOnce(createMockResponse(mockOrganization));

			await client.getOrganizationByName("acme corp");

			expect(mockFetch).toHaveBeenCalledWith(
				"https://coder.test/api/v2/organizations/acme%20corp",
				expect.anything(),
			);
		});

		test("throws CoderAPIError on empty name without making a request", async () => {
			await expect(client.getOrganizationByName("")).rejects.toThrow(
				CoderAPIError,
			);
			expect(mockFetch).not.toHaveBeenCalled();
		});

		test("throws CoderAPIError with statusCode 404 on missing org", async () => {
			mockFetch.mockResolvedValueOnce(
				createMockResponse(
					{ error: "Not Found" },
					{ ok: false, status: 404, statusText: "Not Found" },
				),
			);

			let caught: unknown;
			try {
				await client.getOrganizationByName("does-not-exist");
			} catch (e) {
				caught = e;
			}

			expect(caught).toBeInstanceOf(CoderAPIError);
			expect((caught as CoderAPIError).statusCode).toBe(404);
		});
	});

	describe("default request timeout", () => {
		test("wires DEFAULT_REQUEST_TIMEOUT_MS into AbortSignal.timeout", async () => {
			const originalTimeout = AbortSignal.timeout;
			let capturedMs: number | undefined;
			try {
				AbortSignal.timeout = ((ms: number) => {
					capturedMs = ms;
					return originalTimeout.call(AbortSignal, 10);
				}) as typeof AbortSignal.timeout;
				mockFetch.mockResolvedValueOnce(createMockResponse(mockChat));
				await client.getChat(mockChat.id);
			} finally {
				AbortSignal.timeout = originalTimeout;
			}
			expect(capturedMs).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
		});

		test("rewraps an AbortSignal.timeout abort as CoderAPIError naming the endpoint and timeout", async () => {
			const originalTimeout = AbortSignal.timeout;
			try {
				// 10ms keeps the test fast; the value asserted in the body is
				// DEFAULT_REQUEST_TIMEOUT_MS because that is what the
				// CoderAPIError message reports.
				AbortSignal.timeout = ((_ms: number) =>
					originalTimeout.call(AbortSignal, 10)) as typeof AbortSignal.timeout;
				mockFetch.mockImplementation(
					(_url: string, init?: RequestInit) =>
						new Promise((_resolve, reject) => {
							// Keep the event loop alive so the abort timer fires.
							const keepalive = setTimeout(() => {}, 5000);
							if (init?.signal?.aborted) {
								clearTimeout(keepalive);
								reject(init.signal.reason);
								return;
							}
							init?.signal?.addEventListener("abort", () => {
								clearTimeout(keepalive);
								reject(init.signal?.reason);
							});
						}),
				);
				let caught: unknown;
				try {
					await client.getChat(mockChat.id);
				} catch (e) {
					caught = e;
				}
				expect(caught).toBeInstanceOf(CoderAPIError);
				expect((caught as CoderAPIError).message).toContain(
					`/api/experimental/chats/${mockChat.id}`,
				);
				expect((caught as CoderAPIError).message).toContain(
					`${DEFAULT_REQUEST_TIMEOUT_MS}ms`,
				);
			} finally {
				AbortSignal.timeout = originalTimeout;
			}
		});

		test("passes a default AbortSignal to fetch", async () => {
			mockFetch.mockResolvedValueOnce(createMockResponse(mockChat));
			await client.getChat(mockChat.id);
			const call = mockFetch.mock.calls[0];
			const init = call[1] as RequestInit;
			expect(init.signal).toBeInstanceOf(AbortSignal);
		});
	});
});

describe("createMockResponse", () => {
	test("headers behaves like fetch Response.headers (case-insensitive)", () => {
		// Production code at coder-client.ts calls
		// `response.headers?.get("content-length")` to detect empty bodies.
		// The real `fetch` `Response.headers` is a case-insensitive `Headers`
		// instance, so the mock must match. A regression to `new Map()` (the
		// pre-fix behavior) would fail this assertion.
		const res = createMockResponse({}, { headers: { "Content-Length": "0" } });

		expect(res.headers.get("content-length")).toBe("0");
		expect(res.headers.get("Content-Length")).toBe("0");
	});
});
