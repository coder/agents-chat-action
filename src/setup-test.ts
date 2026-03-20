import { mock } from "bun:test";

// Suppress @actions/core output during tests. The real module
// writes GitHub Actions command format to stdout/stderr which
// clutters test output with lines like "::error::..." and
// "Looking up Coder user by GitHub user ID: ...".
mock.module("@actions/core", () => ({
	info: () => {},
	debug: () => {},
	error: () => {},
	warning: () => {},
	setFailed: () => {},
	setOutput: () => {},
	getInput: () => "",
	getBooleanInput: () => false,
}));
