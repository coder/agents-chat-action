import { z } from "zod";

const BaseInputsSchema = z.object({
	chatPrompt: z.string().min(1),
	coderToken: z.string().min(1),
	coderURL: z.string().url(),
	githubIssueURL: z.string().url(),
	githubToken: z.string(),
	coderOrganization: z.string().min(1).optional().default("default"),
	workspaceId: z.string().uuid().optional(),
	modelConfigId: z.string().uuid().optional(),
	existingChatId: z.string().uuid().optional(),
	commentOnIssue: z.boolean().default(true),
});

const WithGithubUserIDSchema = BaseInputsSchema.extend({
	githubUserID: z.number().min(1),
	coderUsername: z.undefined(),
});

const WithCoderUsernameSchema = BaseInputsSchema.extend({
	githubUserID: z.undefined(),
	coderUsername: z.string().min(1),
});

export const ActionInputsSchema = z.union([
	WithGithubUserIDSchema,
	WithCoderUsernameSchema,
]);

export type ActionInputs = z.infer<typeof ActionInputsSchema>;

export const ActionOutputsSchema = z.object({
	coderUsername: z.string(),
	chatId: z.string().uuid(),
	chatUrl: z.string().url(),
	chatCreated: z.boolean(),
	chatStatus: z.string(),
	chatTitle: z.string(),
	workspaceId: z.string().uuid().optional(),
	// Diff/PR metadata — populated when the chat has tracked changes.
	pullRequestUrl: z.string().optional(),
	pullRequestState: z.string().optional(),
	pullRequestTitle: z.string().optional(),
	pullRequestNumber: z.number().optional(),
	additions: z.number().optional(),
	deletions: z.number().optional(),
	changedFiles: z.number().optional(),
	headBranch: z.string().optional(),
	baseBranch: z.string().optional(),
});

export type ActionOutputs = z.infer<typeof ActionOutputsSchema>;
