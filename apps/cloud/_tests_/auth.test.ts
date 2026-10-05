import { expect, test } from "bun:test";
import { clerkAuthenticator } from "../src/auth.js";

import { localClerk } from "./clerk-fixture.js";

test("Clerk verifies signed session JWTs and normalized v2 organization permissions", async () => {
  const { config, token } = await localClerk();
  const authenticate = clerkAuthenticator(config);
  const request = async (claims?: Record<string, unknown>) =>
    new Request("https://control.test/capabilities", {
      headers: { authorization: `Bearer ${await token(claims)}` },
    });
  expect(await authenticate(await request())).toEqual({
    subject: "user_test",
    tenantId: "user:user_test",
    operations: ["read", "run", "cancel"],
  });
  expect(
    await authenticate(
      await request({
        o: { id: "org_test", rol: "member", per: "read,run,cancel", fpm: "7" },
        fea: "o:loopy",
      }),
    ),
  ).toEqual({
    subject: "user_test",
    tenantId: "org:org_test",
    operations: ["read", "run", "cancel"],
  });
  expect(await authenticate(await request({ o: { id: "org_test", rol: "member" } }))).toMatchObject(
    { tenantId: "org:org_test", operations: [] },
  );
  expect(await authenticate(await request({ sts: "pending" }))).toBeUndefined();
  expect(await authenticate(await request({ azp: undefined }))).toBeUndefined();
  expect(await authenticate(await request({ azp: "" }))).toBeUndefined();
  expect(await authenticate(await request({ azp: "https://attacker.test" }))).toBeUndefined();
  expect(
    await authenticate(
      new Request("https://control.test", { headers: { cookie: "__session=forged" } }),
    ),
  ).toBeUndefined();
});
