import { describe, expect, it } from "vitest";
import { viewerFromToken, viewerToken } from "../src/web/viewer.js";

describe("personal trip-page links", () => {
  it("round-trips a token to the member it was made for, and rejects anything else", () => {
    const t = viewerToken("s3cret", 7, 42);
    expect(t).toMatch(/^[0-9a-f]{16}$/);
    expect(viewerFromToken("s3cret", 7, [41, 42, 43], t)).toBe(42);
    expect(viewerFromToken("s3cret", 8, [41, 42, 43], t)).toBeNull(); // other trip
    expect(viewerFromToken("other", 7, [41, 42, 43], t)).toBeNull(); // other secret
    expect(viewerFromToken("s3cret", 7, [41, 43], t)).toBeNull(); // not a member
    expect(viewerFromToken("s3cret", 7, [42], undefined)).toBeNull();
    expect(viewerFromToken("s3cret", 7, [42], "nope")).toBeNull();
  });
});
