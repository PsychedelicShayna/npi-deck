import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readManagedEnvFile, writeManagedEnvUpdates } from "./env-store.ts";

let dir: string;
let envPath: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "npi-deck-env-store-"));
	envPath = path.join(dir, ".env");
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

async function roundTrip(values: Record<string, string>): Promise<Map<string, string>> {
	await writeManagedEnvUpdates(values, envPath);
	return readManagedEnvFile(envPath).values;
}

describe("managed .env serialization", () => {
	test("values read back exactly as saved", async () => {
		const cases: Record<string, string> = {
			WIN_NEWLINE_SEGMENT: "C:\\new-project",
			WIN_NESTED: "C:\\notes\\agent",
			WIN_TAB_SEGMENT: "D:\\tmp\\tests",
			WIN_TRAILING_BACKSLASH: "C:\\Users\\me\\",
			BACKSLASH_BEFORE_QUOTE: 'say \\"hi\\"',
			LITERAL_ESCAPES: "\\n \\t \\r \\\\ \\u0041",
			TAB: "a\tb",
			CR: "a\rb",
			NEWLINE: "line one\nline two",
			CRLF: "one\r\ntwo",
			QUOTES: `he said "hi" and 'bye'`,
			ONLY_QUOTES: '""',
			SINGLE_QUOTED_LOOKING: "'x'",
			HASH: "value # not a comment",
			HASH_TIGHT: "a#b",
			EQUALS: "a=b==c",
			SPACES: "  padded  ",
			EMPTY: "",
			UNICODE: "héllo 世界 🚀 \u2028 \u00a0",
			LONE_SURROGATE: "x\ud800y",
			NUL: "a\u0000b",
		};
		const read = await roundTrip(cases);
		for (const [key, value] of Object.entries(cases)) expect([key, read.get(key)]).toEqual([key, value]);
	});

	test("a value survives repeated saves of other keys", async () => {
		await writeManagedEnvUpdates({ PROJECT: "C:\\new-project\\tests" }, envPath);
		await writeManagedEnvUpdates({ OTHER: "1" }, envPath);
		await writeManagedEnvUpdates({ OTHER: "2" }, envPath);
		expect(readManagedEnvFile(envPath).values.get("PROJECT")).toBe("C:\\new-project\\tests");
	});

	test("round-trips generated strings", async () => {
		// Deterministic PRNG so a failure reproduces.
		let seed = 0x15_15_15;
		const next = () => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed;
		};
		const alphabet = [
			..."abcnrtuxAZ019 _-./:@,+=#'\"\\$`{}",
			"\\",
			"\\",
			'"',
			"\n",
			"\r",
			"\t",
			"\u0000",
			"\u001b",
			"\u007f",
			"é",
			"世",
			"🚀",
			"\u2028",
			"\ud800",
			"\udc00",
		];
		const values: Record<string, string> = {};
		for (let i = 0; i < 2000; i++) {
			const length = next() % 24;
			let value = "";
			for (let j = 0; j < length; j++) value += alphabet[next() % alphabet.length];
			values[`GEN_${i}`] = value;
		}
		const read = await roundTrip(values);
		const mismatches = Object.entries(values).filter(([key, value]) => read.get(key) !== value);
		expect(mismatches.map(([key, value]) => [key, JSON.stringify(value), JSON.stringify(read.get(key))])).toEqual([]);
	});

	test("files written by earlier deck versions load as before", async () => {
		// Lines an earlier deck wrote (bare or JSON.stringify-quoted) and hand-written dotenv lines.
		fs.writeFileSync(
			envPath,
			[
				"# user comment",
				"PLAIN=abc/def:1",
				'EMPTY=""',
				'SPACED="hello world"',
				'QUOTED="a \\"b\\" c"',
				'MULTILINE="one\\ntwo"',
				'WIN="C:\\\\Program Files\\\\app"',
				'HASHED="x # y"',
				"UNQUOTED_COMMENT=value # trailing comment",
				"SINGLE='raw \\n kept'",
				'HAND_ESCAPE="C:\\path\\dir"',
				'HAND_NEWLINE="first\\nsecond"',
				"  PADDED_KEY = padded  ",
				"# npi-deck managed",
				"",
			].join("\n"),
		);
		const expected = {
			PLAIN: "abc/def:1",
			EMPTY: "",
			SPACED: "hello world",
			QUOTED: 'a "b" c',
			MULTILINE: "one\ntwo",
			WIN: "C:\\Program Files\\app",
			HASHED: "x # y",
			UNQUOTED_COMMENT: "value",
			SINGLE: "raw \\n kept",
			HAND_ESCAPE: "C:\\path\\dir",
			HAND_NEWLINE: "first\nsecond",
			PADDED_KEY: "padded",
		};
		expect(Object.fromEntries(readManagedEnvFile(envPath).values)).toEqual(expected);

		// Saving one key leaves every other value unchanged.
		await writeManagedEnvUpdates({ PLAIN: "changed" }, envPath);
		expect(Object.fromEntries(readManagedEnvFile(envPath).values)).toEqual({ ...expected, PLAIN: "changed" });
	});
});
