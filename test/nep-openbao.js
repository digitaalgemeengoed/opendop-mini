// Nabootsing van het deel van de transit-API van OpenBao dat het platform
// gebruikt: keys aanmaken, datakey/wrapped, decrypt, config, verwijderen.
// Gedrag volgens de documentatie van OpenBao/Vault: verwijderen kan alleen
// met deletion_allowed, decrypt met een onbekende sleutel geeft 400.
import { createServer } from "node:http";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export async function startNepOpenBao(token, poort = 0) {
  const sleutels = new Map(); // naam -> { kek, verwijderbaar }
  const log = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const d of req) body += d;
    const json = body ? JSON.parse(body) : {};
    const stuur = (status, data) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(data === undefined ? "" : JSON.stringify(data));
    };
    log.push(`${req.method} ${req.url}`);
    if (req.headers["x-vault-token"] !== token) return stuur(403, { errors: ["permission denied"] });
    if (req.url === "/v1/auth/token/renew-self" && req.method === "POST") {
      return stuur(200, { auth: { client_token: token, lease_duration: 2764800, renewable: true } });
    }
    const m = req.url.match(/^\/v1\/transit\/(keys|datakey\/wrapped|decrypt)\/([^/]+)(\/config)?$/);
    if (!m) return stuur(404, { errors: ["no handler for route"] });
    const [, soort, naam, config] = m;
    const s = sleutels.get(naam);
    if (soort === "keys" && config) {
      if (!s) return stuur(400, { errors: ["no existing key named " + naam + " could be found"] });
      s.verwijderbaar = !!json.deletion_allowed;
      return stuur(200, { data: {} });
    }
    if (soort === "keys" && req.method === "POST") {
      if (!s) sleutels.set(naam, { kek: randomBytes(32), verwijderbaar: false });
      return stuur(204);
    }
    if (soort === "keys" && req.method === "DELETE") {
      if (!s) return stuur(204);
      if (!s.verwijderbaar) return stuur(400, { errors: ["deletion is not allowed for this key"] });
      sleutels.delete(naam);
      return stuur(204);
    }
    if (soort === "datakey/wrapped") {
      if (!s) return stuur(400, { errors: ["encryption key not found"] });
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", s.kek, iv);
      const ct = Buffer.concat([c.update(randomBytes((json.bits ?? 256) / 8)), c.final(), c.getAuthTag()]);
      return stuur(200, { data: { ciphertext: "vault:v1:" + Buffer.concat([iv, ct]).toString("base64") } });
    }
    if (soort === "decrypt") {
      if (!s) return stuur(400, { errors: ["encryption key not found"] });
      const raw = Buffer.from(String(json.ciphertext).replace(/^vault:v1:/, ""), "base64");
      const d = createDecipheriv("aes-256-gcm", s.kek, raw.subarray(0, 12));
      d.setAuthTag(raw.subarray(raw.length - 16));
      const pt = Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]);
      return stuur(200, { data: { plaintext: pt.toString("base64") } });
    }
    stuur(405, { errors: ["unsupported"] });
  });
  await new Promise((r) => server.listen(poort, "127.0.0.1", r));
  return { adres: `http://127.0.0.1:${server.address().port}`, sleutels, log, stop: () => new Promise((r) => server.close(r)) };
}
