// Nabootsing van het deel van de REST-API van OpenSearch dat het platform
// via de officiële client gebruikt: index bestaat/aanmaken, document
// indexeren en verwijderen, zoeken met multi_match, term-filters en
// highlight. Het zoeken is eenvoudig (woorden tellen), genoeg om de
// aanroepen en de bevestiging tegen het register te toetsen.
import { createServer } from "node:http";

export async function startNepOpenSearch(poort = 0) {
  const indexen = new Map(); // naam -> Map(id -> doc)
  const log = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const d of req) body += d;
    const json = body ? JSON.parse(body) : {};
    const url = new URL(req.url, "http://x");
    const delen = url.pathname.split("/").filter(Boolean);
    log.push(`${req.method} ${url.pathname}`);
    const stuur = (status, data) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(req.method === "HEAD" ? "" : JSON.stringify(data ?? {}));
    };
    const [index, deel, id] = delen;
    if (delen.length === 1 && req.method === "HEAD") return stuur(indexen.has(index) ? 200 : 404);
    if (delen.length === 1 && req.method === "PUT") {
      if (indexen.has(index)) return stuur(400, { error: { type: "resource_already_exists_exception" } });
      indexen.set(index, new Map());
      return stuur(200, { acknowledged: true, index });
    }
    const docs = indexen.get(index);
    if (!docs) return stuur(404, { error: { type: "index_not_found_exception" } });
    if (deel === "_doc" && req.method === "PUT") {
      docs.set(id, json);
      return stuur(201, { _id: id, result: "created" });
    }
    if (deel === "_doc" && req.method === "DELETE") {
      if (!docs.has(id)) return stuur(404, { _id: id, result: "not_found" });
      docs.delete(id);
      return stuur(200, { _id: id, result: "deleted" });
    }
    if (deel === "_search") {
      const q = json.query.bool;
      const woorden = String(q.must[0].multi_match.query).toLowerCase().split(/\s+/).filter(Boolean);
      const hits = [];
      for (const [docId, d] of docs) {
        if (!q.filter.every((f) => Object.entries(f.term).every(([k, v]) => d[k] === v))) continue;
        const tekst = `${d.naam ?? ""} ${d.omschrijving ?? ""} ${d.tekst ?? ""}`.toLowerCase();
        const score = woorden.filter((w) => tekst.includes(w)).length;
        if (!score) continue;
        const w = woorden.find((x) => (d.tekst ?? "").toLowerCase().includes(x));
        const highlight = w ? { tekst: [(d.tekst ?? "").replace(new RegExp(w, "i"), (m) => `<mark>${m}</mark>`).slice(0, 160)] } : undefined;
        hits.push({ _index: index, _id: docId, _score: score, highlight });
      }
      hits.sort((a, b) => b._score - a._score);
      return stuur(200, { hits: { total: { value: hits.length }, hits: hits.slice(0, json.size ?? 10) } });
    }
    stuur(405, { error: "unsupported" });
  });
  await new Promise((r) => server.listen(poort, "127.0.0.1", r));
  return { adres: `http://127.0.0.1:${server.address().port}`, indexen, log, stop: () => new Promise((r) => server.close(r)) };
}
