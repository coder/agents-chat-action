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

function isUUID(value: string): boolean {
	return UUIDSchema.safeParse(value).success;
}

/**
 * Split a `share-with-groups` or `share-with-users` input. Accepts commas,
 * newlines, or both, so a one-line YAML value and a block scalar both work.
 */
export function parseShareList(raw: string | undefined): string[] {
	if (!raw) {
		return [];
	}
	const seen = new Set<string>();
	const out: string[] = [];
	for (const part of raw.split(/[,\n]/)) {
		const value = part.trim();
		if (value && !seen.has(value)) {
			seen.add(value);
			out.push(value);
		}
	}
	return out;
}

export function hasShareTargets(request: ShareRequest): boolean {
	return (
		request.organization ||
		request.groups.length > 0 ||
		request.users.length > 0
	);
}

/**
 * Turn names into the UUIDs the ACL API requires. Every entry the API
 * receives must be an existing UUID, so anything that fails to resolve is
 * dropped with a warning rather than sent along to fail the whole PATCH.
 * Returns null when nothing is left to share.
 */
export async function resolveChatShare(
	coder: CoderClient,
	request: ShareRequest,
	ctx: ShareContext,
): Promise<UpdateChatACL | null> {
	const groupRoles: Record<string, "read"> = {};
	const userRoles: Record<string, "read"> = {};

	if (request.organization) {
		// The Everyone group shares its organization's ID, so this needs no
		// lookup and works on deployments without the groups API.
		groupRoles[ctx.organizationID] = "read";
	}

	for (const group of request.groups) {
		const id = await resolveGroupID(coder, ctx.organizationID, group);
		if (id) {
			groupRoles[id] = "read";
		}
	}

	for (const user of request.users) {
		const id = await resolveUserID(coder, user);
		if (!id) {
			continue;
		}
		if (id === ctx.tokenOwnerID) {
			// The owner already reads their own chat, and the API answers 400
			// to a request that changes the caller's own role, which would
			// take every other entry in this PATCH down with it.
			core.info(
				`Skipping share-with-users entry '${user}': it is the coder-token owner`,
			);
			continue;
		}
		userRoles[id] = "read";
	}

	const acl: UpdateChatACL = {};
	if (Object.keys(groupRoles).length > 0) {
		acl.group_roles = groupRoles;
	}
	if (Object.keys(userRoles).length > 0) {
		acl.user_roles = userRoles;
	}
	return acl.group_roles || acl.user_roles ? acl : null;
}

async function resolveGroupID(
	coder: CoderClient,
	organizationID: string,
	group: string,
): Promise<string | undefined> {
	if (isUUID(group)) {
		return group;
	}
	try {
		const found = await coder.getGroupByName(organizationID, group);
		return found.id;
	} catch (error) {
		// Group lookup by name is served by the licensed build only. A UUID
		// skips the lookup, so name the workaround in the warning.
		const hint =
			error instanceof CoderAPIError && error.statusCode === 404
				? " Group lookup by name needs a licensed deployment; pass the group UUID instead."
				: "";
		core.warning(
			`Could not resolve share-with-groups entry '${group}': ${describe(error)}.${hint}`,
		);
		return undefined;
	}
}

async function resolveUserID(
	coder: CoderClient,
	user: string,
): Promise<string | undefined> {
	if (isUUID(user)) {
		return user;
	}
	try {
		const found = await coder.getUser(user);
		return found.id;
	} catch (error) {
		core.warning(
			`Could not resolve share-with-users entry '${user}': ${describe(error)}`,
		);
		return undefined;
	}
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
		core.info(`Granted read access on the chat to ${summarize(acl)}`);
	} catch (error) {
		core.warning(`Could not share the chat: ${describe(error)}`);
	}
}

function summarize(acl: UpdateChatACL): string {
	const parts: string[] = [];
	const groups = Object.keys(acl.group_roles ?? {}).length;
	const users = Object.keys(acl.user_roles ?? {}).length;
	if (groups) {
		parts.push(`${groups} group${groups === 1 ? "" : "s"}`);
	}
	if (users) {
		parts.push(`${users} user${users === 1 ? "" : "s"}`);
	}
	return parts.join(" and ");
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
