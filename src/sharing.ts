import * as core from "@actions/core";
import { z } from "zod";
import {
	type ChatId,
	CoderAPIError,
	type CoderClient,
	type UpdateChatACL,
} from "./coder-client";

/**
 * Who a newly created chat should be readable by, straight from the
 * `share-with-*` inputs. Groups and users may be names or UUIDs.
 */
export interface ShareRequest {
	organization: boolean;
	groups: string[];
	users: string[];
}

/**
 * Facts the resolver needs that only the create path knows.
 */
export interface ShareContext {
	/** Organization the chat was created in. Doubles as the Everyone group ID. */
	organizationID: string;
	/** The `coder-token` holder. The API rejects a request that names its own caller. */
	tokenOwnerID: string;
}

const UUIDSchema = z.uuid();

/**
 * Split a `share-with-groups` or `share-with-users` input. Accepts commas,
 * newlines, or both, so a one-line YAML value and a block scalar both work.
 */
export function parseShareList(raw: string | undefined): string[] {
	if (!raw) {
		return [];
	}
	const values = raw
		.split(/[,\n]/)
		.map((part) => part.trim())
		.filter(Boolean);
	return [...new Set(values)];
}

export function hasShareTargets(request: ShareRequest): boolean {
	return (
		request.organization ||
		request.groups.length > 0 ||
		request.users.length > 0
	);
}

/**
 * Resolve names to UUIDs, skipping failed lookups with a warning. UUID
 * inputs pass through without an existence check. Returns null when no
 * recipients remain.
 */
export async function resolveChatShare(
	coder: CoderClient,
	request: ShareRequest,
	ctx: ShareContext,
): Promise<UpdateChatACL | null> {
	const [groupIDs, userIDs] = await Promise.all([
		resolveAll(request.groups, (group) =>
			resolveID("share-with-groups", group, async () => {
				const found = await coder.getGroupByName(ctx.organizationID, group);
				return found.id;
			}),
		),
		resolveAll(request.users, (user) =>
			resolveID("share-with-users", user, async () => {
				const found = await coder.getUser(user);
				return found.id;
			}),
		),
	]);

	if (request.organization) {
		// The Everyone group shares its organization's ID, so this needs no
		// lookup and works on deployments without the groups API.
		groupIDs.add(ctx.organizationID);
	}

	// The API rejects the entire PATCH if it includes the caller's user ID.
	if (userIDs.delete(ctx.tokenOwnerID)) {
		core.info("Skipping the coder-token owner in share-with-users");
	}

	if (groupIDs.size === 0 && userIDs.size === 0) {
		return null;
	}
	return {
		...(groupIDs.size > 0 && { group_roles: readRoles(groupIDs) }),
		...(userIDs.size > 0 && { user_roles: readRoles(userIDs) }),
	};
}

/**
 * Attempt to share a newly created chat. Lookup and PATCH failures log
 * warnings without failing the action. Callers must not use this to
 * reconcile access on reused chats.
 */
export async function shareNewChat(
	coder: CoderClient,
	chatId: ChatId,
	request: ShareRequest,
	ctx: ShareContext,
): Promise<void> {
	if (!hasShareTargets(request)) {
		return;
	}
	const acl = await resolveChatShare(coder, request, ctx);
	if (!acl) {
		core.warning("No share-with-* entry resolved, so the chat was not shared");
		return;
	}
	try {
		await coder.updateChatACL(chatId, acl);
		core.info(
			`Granted read access on the chat to ${Object.keys(acl.group_roles ?? {}).length} group(s) and ${Object.keys(acl.user_roles ?? {}).length} user(s)`,
		);
	} catch (error) {
		core.warning(`Could not share the chat: ${describe(error)}`);
	}
}

async function resolveAll(
	values: string[],
	resolve: (value: string) => Promise<string | undefined>,
): Promise<Set<string>> {
	const ids = await Promise.all(values.map(resolve));
	return new Set(ids.filter((id): id is string => id !== undefined));
}

/**
 * A UUID is used as given. Anything else goes through `lookup`, and a
 * failed lookup becomes a warning naming the input and the entry.
 */
async function resolveID(
	input: string,
	value: string,
	lookup: () => Promise<string>,
): Promise<string | undefined> {
	if (UUIDSchema.safeParse(value).success) {
		return value;
	}
	try {
		return await lookup();
	} catch (error) {
		// Group lookup by name is only served by the licensed build, so a 404
		// there is ambiguous. A UUID skips the lookup either way.
		const hint =
			input === "share-with-groups" &&
			error instanceof CoderAPIError &&
			error.statusCode === 404
				? " Check that the group exists. If this deployment lacks group-name lookup, provide the UUID of an existing group."
				: "";
		core.warning(
			`Could not resolve ${input} entry '${value}': ${describe(error)}.${hint}`,
		);
		return undefined;
	}
}

function readRoles(ids: Set<string>): Record<string, "read"> {
	return Object.fromEntries([...ids].map((id) => [id, "read" as const]));
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
