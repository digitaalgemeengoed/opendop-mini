import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import type { Actor, Inhoud } from "@digitaalgemeengoed/oa-contract";
import { INHOUD_SCHEMA } from "@digitaalgemeengoed/oa-contract";
import { inGemeente } from "./db.js";
import type { Opslag } from "./opslag.js";
import {
  PlatformFout,
  leesGebeurtenissen,
  leesInhoud,
  leesObject,
  leesObjecttype,
  legMetadataVast,
  lijstObjecttypen,
  maakObject,
  publiceerObjecttype,
  voegVersieToe,
} from "./objecten.js";

interface Context {
  gemeente: string;
  actor: Actor;
}

/**
 * De Object Service. Alleen de integratielaag roept haar aan; die stelt
 * vast wie er belt en geeft gemeente en actor mee.
 */
export function bouwServer(opties: { opslag: Opslag; dienstsleutel: string; maxBytes: number; log?: boolean }): FastifyInstance {
  const app = Fastify({ logger: opties.log ?? true, bodyLimit: Math.ceil(opties.maxBytes * 1.4) + 65536 });
  const sleutel = Buffer.from(opties.dienstsleutel);

  function context(req: FastifyRequest): Context {
    const gegeven = Buffer.from(String(req.headers["x-oa-dienstsleutel"] ?? ""));
    if (gegeven.length !== sleutel.length || !timingSafeEqual(gegeven, sleutel)) {
      throw new PlatformFout(401, "geen-toegang", "Alleen de integratielaag mag het platform aanroepen.");
    }
    const gemeente = String(req.headers["x-oa-gemeente"] ?? "");
    if (!/^[a-z0-9-]{2,40}$/.test(gemeente)) throw new PlatformFout(400, "gemeente-onbekend", "Gemeente ontbreekt of is ongeldig.");
    let actor: Actor;
    try {
      actor = JSON.parse(Buffer.from(String(req.headers["x-oa-actor"] ?? ""), "base64url").toString("utf8"));
    } catch {
      throw new PlatformFout(400, "actor-ongeldig", "Actor ontbreekt of is ongeldig.");
    }
    if (!actor?.sub) throw new PlatformFout(400, "actor-ongeldig", "Actor ontbreekt of is ongeldig.");
    return { gemeente, actor };
  }

  app.setErrorHandler((fout, _req, antwoord) => {
    if (fout instanceof PlatformFout) {
      return antwoord.status(fout.status).send({ fout: fout.code, melding: fout.message, details: fout.details });
    }
    const f = fout as { validation?: unknown; statusCode?: number; message: string };
    if (f.validation) return antwoord.status(400).send({ fout: "verzoek-ongeldig", melding: f.message });
    if (f.statusCode === 413) return antwoord.status(413).send({ fout: "inhoud-te-groot", melding: "Het verzoek is te groot." });
    if ((fout as { code?: string }).code === "23503") {
      return antwoord.status(400).send({ fout: "gemeente-onbekend", melding: "Deze gemeente is niet aangesloten." });
    }
    app.log.error(fout);
    return antwoord.status(500).send({ fout: "intern", melding: "Er ging iets mis in het platform." });
  });

  app.get("/gezondheid", async () => ({ status: "ok", opslag: opties.opslag.soort }));

  // --- Objecttypen ---------------------------------------------------------

  app.get("/objecttypen", async (req) => {
    const { gemeente } = context(req);
    return inGemeente(gemeente, (c) => lijstObjecttypen(c));
  });

  app.get<{ Params: { naam: string }; Querystring: { versie?: string } }>("/objecttypen/:naam", async (req) => {
    const { gemeente } = context(req);
    const versie = req.query.versie ? Number(req.query.versie) : undefined;
    return inGemeente(gemeente, (c) => leesObjecttype(c, req.params.naam, versie));
  });

  app.post<{ Body: { naam: string; titel: string; schema: Record<string, unknown>; status?: "concept" | "actief"; vervaldatum?: string } }>(
    "/objecttypen",
    {
      schema: {
        body: {
          type: "object",
          required: ["naam", "titel", "schema"],
          properties: {
            naam: { type: "string", pattern: "^[a-z][a-z0-9-]{1,60}$" },
            titel: { type: "string", minLength: 1 },
            schema: { type: "object" },
            status: { enum: ["concept", "actief"] },
            vervaldatum: { type: "string", format: "date" },
          },
        },
      },
    },
    async (req, antwoord) => {
      const { gemeente, actor } = context(req);
      const type = await inGemeente(gemeente, (c) => publiceerObjecttype(c, gemeente, actor, req.body));
      return antwoord.status(201).send(type);
    },
  );

  // --- Informatieobjecten ---------------------------------------------------

  app.post<{ Body: { objecttype: string; metadata?: Record<string, unknown>; inhoud?: Inhoud } }>(
    "/objecten",
    {
      schema: {
        body: {
          type: "object",
          required: ["objecttype"],
          properties: { objecttype: { type: "string" }, metadata: { type: "object" }, inhoud: INHOUD_SCHEMA },
        },
      },
    },
    async (req, antwoord) => {
      const { gemeente, actor } = context(req);
      const o = await inGemeente(gemeente, (c) => maakObject(c, opties.opslag, gemeente, actor, req.body, opties.maxBytes));
      return antwoord.status(201).send(o);
    },
  );

  app.get<{ Params: { id: string } }>("/objecten/:id", async (req) => {
    const { gemeente } = context(req);
    return inGemeente(gemeente, (c) => leesObject(c, req.params.id));
  });

  app.get<{ Params: { id: string } }>("/objecten/:id/gebeurtenissen", async (req) => {
    const { gemeente } = context(req);
    return inGemeente(gemeente, async (c) => {
      await leesObject(c, req.params.id);
      return leesGebeurtenissen(c, req.params.id);
    });
  });

  app.put<{ Params: { id: string }; Body: { metadata: Record<string, unknown>; verwachteVolgnummer?: number } }>(
    "/objecten/:id/metadata",
    {
      schema: {
        body: {
          type: "object",
          required: ["metadata"],
          properties: { metadata: { type: "object" }, verwachteVolgnummer: { type: "integer" } },
        },
      },
    },
    async (req) => {
      const { gemeente, actor } = context(req);
      return inGemeente(gemeente, (c) =>
        legMetadataVast(c, gemeente, actor, req.params.id, req.body.metadata, req.body.verwachteVolgnummer),
      );
    },
  );

  app.post<{ Params: { id: string }; Body: { inhoud: Inhoud; verwachteVolgnummer?: number } }>(
    "/objecten/:id/versies",
    {
      schema: {
        body: {
          type: "object",
          required: ["inhoud"],
          properties: { inhoud: INHOUD_SCHEMA, verwachteVolgnummer: { type: "integer" } },
        },
      },
    },
    async (req, antwoord) => {
      const { gemeente, actor } = context(req);
      const o = await inGemeente(gemeente, (c) =>
        voegVersieToe(c, opties.opslag, gemeente, actor, req.params.id, req.body.inhoud, opties.maxBytes, req.body.verwachteVolgnummer),
      );
      return antwoord.status(201).send(o);
    },
  );

  app.get<{ Params: { id: string; nummer: string } }>("/objecten/:id/versies/:nummer/inhoud", async (req, antwoord) => {
    const { gemeente } = context(req);
    const r = await inGemeente(gemeente, (c) => leesInhoud(c, opties.opslag, gemeente, req.params.id, Number(req.params.nummer)));
    return antwoord.header("content-type", r.mediaType).header("x-oa-formaat", r.formaat).send(r.data);
  });

  return app;
}
