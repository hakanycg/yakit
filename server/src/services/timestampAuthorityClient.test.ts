import { afterEach, describe, expect, it } from "vitest";
import { getTimestampAuthorityClient, noopTimestampAuthorityClient, setTimestampAuthorityClient } from "./timestampAuthorityClient.js";

afterEach(() => {
  setTimestampAuthorityClient(noopTimestampAuthorityClient);
});

describe("noopTimestampAuthorityClient", () => {
  it("TSA hesabi henuz acilmadigindan hep null doner", async () => {
    await expect(noopTimestampAuthorityClient.requestTimestamp("a".repeat(64))).resolves.toBeNull();
  });
});

describe("getTimestampAuthorityClient / setTimestampAuthorityClient", () => {
  it("varsayilan olarak noop istemciyi dondurur", () => {
    expect(getTimestampAuthorityClient()).toBe(noopTimestampAuthorityClient);
  });

  it("gercek bir istemci takilinca onu dondurur", async () => {
    const fakeClient = { requestTimestamp: async () => ({ token: "fake-token", timestampedAt: "2026-01-01T00:00:00.000Z" }) };
    setTimestampAuthorityClient(fakeClient);
    expect(getTimestampAuthorityClient()).toBe(fakeClient);
    await expect(getTimestampAuthorityClient().requestTimestamp("hash")).resolves.toEqual({
      token: "fake-token",
      timestampedAt: "2026-01-01T00:00:00.000Z",
    });
  });
});
