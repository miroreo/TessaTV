import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OidcClient } from "./oidc.js";

/** The shape of an Authentik issuer: a path, ending in a slash. */
const ISSUER_PATH = "/application/o/tessatv/";

describe("OidcClient discovery", () => {
  let server: Server;
  let origin: string;
  const requests: string[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      requests.push(request.url!);
      if (request.url !== `${ISSUER_PATH}.well-known/openid-configuration`) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          issuer: `${origin}${ISSUER_PATH}`,
          authorization_endpoint: `${origin}/application/o/authorize/`,
          token_endpoint: `${origin}/application/o/token/`,
          jwks_uri: `${origin}/application/o/tessatv/jwks/`,
          response_types_supported: ["code"],
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    origin = `http://127.0.0.1:${address.port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const config = (issuerUrl: string) => ({ issuerUrl, clientId: "tessatv", clientSecret: "secret", redirectUri: "http://tv.test/cb" });

  it("accepts the issuer typed without its trailing slash, and reports it as the provider states it", async () => {
    const { issuer } = await new OidcClient().check(config(`${origin}${ISSUER_PATH.slice(0, -1)}`));
    expect(issuer).toBe(`${origin}${ISSUER_PATH}`);
  });

  it("accepts the issuer as the provider states it, without a retry", async () => {
    requests.length = 0;
    const { issuer } = await new OidcClient().check(config(`${origin}${ISSUER_PATH}`));
    expect(issuer).toBe(`${origin}${ISSUER_PATH}`);
    expect(requests).toHaveLength(1);
  });

  it("still rejects an issuer that is simply wrong", async () => {
    await expect(new OidcClient().check(config(`${origin}/application/o/other/`))).rejects.toThrow();
  });
});
