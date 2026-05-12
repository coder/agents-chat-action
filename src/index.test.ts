import { describe, expect, test } from "bun:test";
import { parseGithubUserID } from "./index";

describe("parseGithubUserID", () => {
	test("returns undefined when input is empty", () => {
		expect(parseGithubUserID("")).toBeUndefined();
	});

	test("parses a plain decimal integer", () => {
		expect(parseGithubUserID("123")).toBe(123);
	});

	test("returns NaN for trailing non-numeric characters", () => {
		// The original #16 bug: parseInt would return 123 here and the
		// schema would happily resolve to user 123.
		expect(parseGithubUserID("123abc")).toBe(Number.NaN);
	});

	test("returns NaN for hex literals", () => {
		// `Number("0x1F")` is 31, which would pass `int().positive()`.
		// The regex gate must reject every non-decimal numeric form so
		// non-decimal input can never silently resolve to a user.
		expect(parseGithubUserID("0x1F")).toBe(Number.NaN);
	});

	test("returns NaN for binary literals", () => {
		expect(parseGithubUserID("0b101")).toBe(Number.NaN);
	});

	test("returns NaN for octal literals", () => {
		expect(parseGithubUserID("0o7")).toBe(Number.NaN);
	});

	test("returns NaN for scientific notation", () => {
		expect(parseGithubUserID("1e3")).toBe(Number.NaN);
	});

	test("returns NaN for decimals", () => {
		// GitHub user IDs are integers. Rejecting at the parser keeps
		// the runtime guard's shape aligned with the schema's
		// `.int()` constraint.
		expect(parseGithubUserID("12.5")).toBe(Number.NaN);
	});

	test("returns NaN for negative numbers", () => {
		expect(parseGithubUserID("-1")).toBe(Number.NaN);
	});

	test("returns NaN for whitespace-wrapped input", () => {
		// `Number("  123  ")` is 123. Whitespace tolerance was never
		// intentional behavior. The regex rejects it.
		expect(parseGithubUserID("  123  ")).toBe(Number.NaN);
	});

	test("returns NaN for purely non-numeric input", () => {
		expect(parseGithubUserID("abc")).toBe(Number.NaN);
	});
});
