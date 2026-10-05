export async function localClerk() {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
  const url64 = (value: unknown) =>
    base64(new TextEncoder().encode(JSON.stringify(value)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  const config = {
    CLERK_SECRET_KEY: "sk_test_local_fixture_not_a_credential",
    CLERK_PUBLISHABLE_KEY: `pk_test_${btoa("clerk.example$")}`,
    CLERK_JWT_KEY: `-----BEGIN PUBLIC KEY-----\n${base64(spki)
      .match(/.{1,64}/g)
      ?.join("\n")}\n-----END PUBLIC KEY-----`,
    CLERK_AUTHORIZED_PARTIES: "https://studio.test",
  };
  const token = async (extra: Record<string, unknown> = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${url64({ alg: "RS256", typ: "JWT", kid: "local" })}.${url64({ iss: "https://clerk.example", sub: "user_test", sid: "sess_test", sts: "active", azp: "https://studio.test", iat: now, nbf: now - 1, exp: now + 3600, v: 2, ...extra })}`;
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        pair.privateKey,
        new TextEncoder().encode(unsigned),
      ),
    );
    return `${unsigned}.${base64(signature).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
  };
  return { config, token };
}
