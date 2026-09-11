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
 * Turn names into the UUIDs the ACL API requires. Every key the API
 * receives must be an existing UUID, so an entry that fails to resolve is
 * dropped with a warning rather than sent along to fail the whole PATCH.
 * Returns null when nothing is left to share.
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

	// The owner already reads their own chat, and the API answers 400 to a
	// request that changes the caller's own role, which would take every
	// other entry in this PATCH down with it.
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
 * Grant read access on a chat this run just created. Resolution and the
 * PATCH both warn instead of throwing: the chat itself is fine, and a
 * deployment with chat sharing disabled answers 403 here.
 *
 * Only the create path calls this. A reused chat keeps the access it
 * already had, so turning these inputs on does not retroactively open
 * chats created before them.
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
				? " Either the group does not exist, or this deployment is unlicensed and cannot look groups up by name; a group UUID works in both cases."
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
