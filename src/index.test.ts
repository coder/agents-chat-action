// The acting-github-user-id input was dropped in the security-driven
// simplification; `parseGithubUserID` no longer exists. This file is
// retained as a placeholder so the test discovery glob still finds it
// without complaining about an empty module.
import { describe, test } from "bun:test";

describe("index", () => {
	test("placeholder", () => {});
});
