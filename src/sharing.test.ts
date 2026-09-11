import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as core from "@actions/core";
import { CoderAPIError } from "./coder-client";
import {
	hasShareTargets,
	parseShareList,
	resolveChatShare,
	shareNewChat,
} from "./sharing";
import {
	MockCoderClient,
	mockChat,
	mockGroup,
	mockOrganization,
	mockUser,
} from "./test-helpers";

const ORG = mockOrganization.id;
const OWNER = mockUser.id;
const OTHER_USER_ID = "ee0e8400-e29b-41d4-a716-446655440000";
const ctx = { organizationID: ORG, tokenOwnerID: OWNER };

describe("parseShareList", () => {
	test("returns an empty list for an unset input", () => {
		expect(parseShareList(undefined)).toEqual([]);
		expect(parseShareList("")).toEqual([]);
	});

	test("splits on commas and newlines, trims, and drops duplicates", () => {
		expect(parseShareList(" docs, platform\n\ndocs ,\n platform-2 ")).toEqual([
			"docs",
			"platform",
			"platform-2",
		]);
	});
});

describe("hasShareTargets", () => {
	test("is false only when every input is empty", () => {
		expect(
			hasShareTargets({ organization: false, groups: [], users: [] }),
		).toBe(false);
		expect(hasShareTargets({ organization: true, groups: [], users: [] })).toBe(
			true,
		);
		expect(
			hasShareTargets({ organization: false, groups: ["docs"], users: [] }),
		).toBe(true);
		expect(
			hasShareTargets({ organization: false, groups: [], users: ["ben"] }),
		).toBe(true);
	});
});

describe("resolveChatShare", () => {
	let coder: MockCoderClient;
	let warning: ReturnType<typeof spyOn>;

	beforeEach(() => {
		coder = new MockCoderClient();
		warning = spyOn(core, "warning").mockImplementation(() => {});
	});

	afterEach(() => {
		warning.mockRestore();
	});

	test("organization becomes one group entry keyed by the org ID, with no lookup", async () => {
		const acl = await resolveChatShare(
			coder,
			{ organization: true, groups: [], users: [] },
			ctx,
		);
		expect(acl).toEqual({ group_roles: { [ORG]: "read" } });
		expect(coder.mockGetGroupByName).not.toHaveBeenCalled();
	});

	test("group UUIDs pass through and names resolve inside the chat's org", async () => {
		const acl = await resolveChatShare(
			coder,
			{
				organization: false,
				groups: ["ff0e8400-e29b-41d4-a716-446655440000", "docs"],
				users: [],
			},
			ctx,
		);
		expect(coder.mockGetGroupByName).toHaveBeenCalledTimes(1);
		expect(coder.mockGetGroupByName).toHaveBeenCalledWith(ORG, "docs");
		expect(acl).toEqual({
			group_roles: {
				"ff0e8400-e29b-41d4-a716-446655440000": "read",
				[mockGroup.id]: "read",
			},
		});
	});

	test("user UUIDs pass through and usernames resolve", async () => {
		coder.mockGetUser.mockResolvedValue({ ...mockUser, id: OTHER_USER_ID });
		const acl = await resolveChatShare(
			coder,
			{ organization: false, groups: [], users: ["nick"] },
			ctx,
		);
		expect(coder.mockGetUser).toHaveBeenCalledWith("nick");
		expect(acl).toEqual({ user_roles: { [OTHER_USER_ID]: "read" } });
	});

	test("drops the token owner from users, since the API rejects a self-share", async () => {
		coder.mockGetUser.mockResolvedValue(mockUser);
		const acl = await resolveChatShare(
			coder,
			{ organization: true, groups: [], users: [OWNER, mockUser.username] },
			ctx,
		);
		// The org entry survives; the owner never reaches user_roles.
		expect(acl).toEqual({ group_roles: { [ORG]: "read" } });
	});

	test("an unresolvable name is warned about and skipped, the rest still share", async () => {
		coder.mockGetGroupByName.mockRejectedValue(
			new CoderAPIError("Coder API error: Not Found", 404),
		);
		const acl = await resolveChatShare(
			coder,
			{ organization: true, groups: ["nope"], users: [] },
			ctx,
		);
		expect(acl).toEqual({ group_roles: { [ORG]: "read" } });
		expect(warning).toHaveBeenCalledWith(
			expect.stringContaining("needs a licensed deployment"),
		);
	});

	test("returns null when nothing resolves", async () => {
		coder.mockGetUser.mockRejectedValue(
			new CoderAPIError("Coder API error: Not Found", 404),
		);
		const acl = await resolveChatShare(
			coder,
			{ organization: false, groups: [], users: ["ghost"] },
			ctx,
		);
		expect(acl).toBeNull();
		expect(warning).toHaveBeenCalledWith(
			expect.stringContaining("share-with-users entry 'ghost'"),
		);
	});
});

describe("shareNewChat", () => {
	let coder: MockCoderClient;
	let warning: ReturnType<typeof spyOn>;

	beforeEach(() => {
		coder = new MockCoderClient();
		warning = spyOn(core, "warning").mockImplementation(() => {});
	});

	afterEach(() => {
		warning.mockRestore();
	});

	test("does nothing when no share input is set", async () => {
		await shareNewChat(
			coder,
			mockChat.id,
			{ organization: false, groups: [], users: [] },
			ctx,
		);
		expect(coder.mockUpdateChatACL).not.toHaveBeenCalled();
		expect(warning).not.toHaveBeenCalled();
	});

	test("sends one PATCH carrying every resolved entry", async () => {
		coder.mockGetUser.mockResolvedValue({ ...mockUser, id: OTHER_USER_ID });
		await shareNewChat(
			coder,
			mockChat.id,
			{ organization: true, groups: ["docs"], users: ["nick"] },
			ctx,
		);
		expect(coder.mockUpdateChatACL).toHaveBeenCalledTimes(1);
		expect(coder.mockUpdateChatACL).toHaveBeenCalledWith(mockChat.id, {
			group_roles: { [ORG]: "read", [mockGroup.id]: "read" },
			user_roles: { [OTHER_USER_ID]: "read" },
		});
	});

	test("warns instead of throwing when the PATCH is rejected", async () => {
		coder.mockUpdateChatACL.mockRejectedValue(
			new CoderAPIError("Chat sharing is disabled for this deployment.", 403),
		);
		await shareNewChat(
			coder,
			mockChat.id,
			{ organization: true, groups: [], users: [] },
			ctx,
		);
		expect(warning).toHaveBeenCalledWith(
			expect.stringContaining("Could not share the chat"),
		);
	});
});
