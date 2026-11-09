import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import type { Actor, Inhoud, Zoekantwoord, Zoekresultaat } from "@digitaalgemeengoed/oa-contract";
import { INHOUD_SCHEMA } from "@digitaalgemeengoed/oa-contract";
import { inGemeente } from "./db.js";
import { ZoekenUit, type Zoekindex } from "./zoekindex.js";
import {
  PlatformFout,
  leesGebeurtenissen,
  leesInhoud,
  leesWeergave,
  leesObject,
  leesObjecttype,
  legMetadataVast,
  lijstObjecttypen,
  maakObject,
  maakOnleesbaar,
  publiceerObjecttype,
  voegVersieToe,
  type Middelen,
  toetsToegang,
  wijzigAard,
  legAnonimiseringVast,
} from "./objecten.js";

interface Context {
  gemeente: string;
  actor: Actor;
}

/**
 * De Object Service. Alleen de integratielaag roept haar aan; die stelt
 * vast wie er belt en geeft gemeente en actor mee.
 */
/** Zelfde vorm als de inhoud, zonder $id: één body mag een schema-id maar één keer gebruiken. */
const { $id: _id, ...WEERGAVE_SCHEMA } = INHOUD_SCHEMA;

export function bouwServer(opties: { middelen: Middelen; zoekindex: Zoekindex; dienstsleutel: string; log?: boolean }): FastifyInstance {
  const m = opties.middelen;
  const app = Fastify({ logger: opties.log ?? true, bodyLimit: Math.ceil(m.maxBytes * 2.8) + 65536 });
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
    if (fout instanceof ZoekenUit) {
      return antwoord.status(503).send({ fout: "zoeken-uit", melding: fout.message });
    }
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

  app.get("/gezondheid", async () => ({
    status: "ok",
    opslag: m.opslag.soort,
    sleutelbeheer: m.sleutelbeheer?.soort ?? "uit",
    zoekindex: opties.zoekindex.soort,
  }));

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

  app.post<{ Body: { objecttype: string; aard?: "zakelijk" | "persoonlijk"; metadata?: Record<string, unknown>; inhoud?: Inhoud; weergave?: Inhoud } }>(
    "/objecten",
    {
      schema: {
        body: {
          type: "object",
          required: ["objecttype"],
          properties: {
            objecttype: { type: "string" },
            aard: { enum: ["zakelijk", "persoonlijk"] },
            metadata: { type: "object" },
            inhoud: INHOUD_SCHEMA,
            weergave: WEERGAVE_SCHEMA,
          },
        },
      },
    },
    async (req, antwoord) => {
      const { gemeente, actor } = context(req);
      const o = await inGemeente(gemeente, (c) => maakObject(c, m, gemeente, actor, req.body));
      return antwoord.status(201).send(o);
    },
  );

  // Elke aanroep op één object toetst eerst of de actor het mag zien: een
  // persoonlijk stuk alleen wie het vastlegde (toetsToegang).
  app.get<{ Params: { id: string } }>("/objecten/:id", async (req) => {
    const { gemeente, actor } = context(req);
    return inGemeente(gemeente, async (c) => {
      await toetsToegang(c, req.params.id, actor);
      return leesObject(c, req.params.id);
    });
  });

  app.get<{ Params: { id: string } }>("/objecten/:id/gebeurtenissen", async (req) => {
    const { gemeente, actor } = context(req);
    return inGemeente(gemeente, async (c) => {
      await toetsToegang(c, req.params.id, actor);
      return leesGebeurtenissen(c, req.params.id);
    });
  });

  app.put<{ Params: { id: string }; Body: { aard: "zakelijk" | "persoonlijk" } }>(
    "/objecten/:id/aard",
    { schema: { body: { type: "object", required: ["aard"], properties: { aard: { enum: ["zakelijk", "persoonlijk"] } } } } },
    async (req) => {
      const { gemeente, actor } = context(req);
      return inGemeente(gemeente, async (c) => {
        await toetsToegang(c, req.params.id, actor);
        return wijzigAard(c, m, gemeente, actor, req.params.id, req.body.aard);
      });
    },
  );

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
      return inGemeente(gemeente, async (c) => {
        await toetsToegang(c, req.params.id, actor);
        return legMetadataVast(c, gemeente, actor, req.params.id, req.body.metadata, req.body.verwachteVolgnummer);
      });
    },
  );

  app.post<{ Params: { id: string }; Body: { inhoud: Inhoud; weergave?: Inhoud; verwachteVolgnummer?: number } }>(
    "/objecten/:id/versies",
    {
      schema: {
        body: {
          type: "object",
          required: ["inhoud"],
          properties: { inhoud: INHOUD_SCHEMA, weergave: WEERGAVE_SCHEMA, verwachteVolgnummer: { type: "integer" } },
        },
      },
    },
    async (req, antwoord) => {
      const { gemeente, actor } = context(req);
      const o = await inGemeente(gemeente, async (c) => {
        await toetsToegang(c, req.params.id, actor);
        return voegVersieToe(c, m, gemeente, actor, req.params.id, req.body.inhoud, req.body.verwachteVolgnummer, req.body.weergave);
      });
      return antwoord.status(201).send(o);
    },
  );

  app.get<{ Params: { id: string; nummer: string } }>("/objecten/:id/versies/:nummer/inhoud", async (req, antwoord) => {
    const { gemeente, actor } = context(req);
    const r = await inGemeente(gemeente, async (c) => {
      await toetsToegang(c, req.params.id, actor);
      return leesInhoud(c, m, gemeente, req.params.id, Number(req.params.nummer));
    });
    return antwoord.header("content-type", r.mediaType).header("x-oa-formaat", r.formaat).send(r.data);
  });

  app.get<{ Params: { id: string; nummer: string; formaat: string }; Querystring: { soort?: string } }>("/objecten/:id/versies/:nummer/weergaven/:formaat", async (req, antwoord) => {
    const { gemeente, actor } = context(req);
    const soort = req.query.soort === "geanonimiseerd" ? "geanonimiseerd" : "weergave";
    const r = await inGemeente(gemeente, async (c) => {
      await toetsToegang(c, req.params.id, actor);
      return leesWeergave(c, m, gemeente, req.params.id, Number(req.params.nummer), req.params.formaat, soort);
    });
    return antwoord.header("content-type", r.mediaType).header("x-oa-formaat", r.formaat).send(r.data);
  });

  app.post<{ Params: { id: string; nummer: string }; Body: { inhoud: Inhoud; overzicht: Record<string, number> } }>(
    "/objecten/:id/versies/:nummer/anonimisering",
    {
      schema: {
        body: {
          type: "object",
          required: ["inhoud", "overzicht"],
          properties: { inhoud: INHOUD_SCHEMA, overzicht: { type: "object", additionalProperties: { type: "integer", minimum: 0 }, maxProperties: 30 } },
        },
      },
    },
    async (req, antwoord) => {
      const { gemeente, actor } = context(req);
      const o = await inGemeente(gemeente, async (c) => {
        await toetsToegang(c, req.params.id, actor);
        return legAnonimiseringVast(c, m, gemeente, actor, req.params.id, Number(req.params.nummer), req.body.inhoud, req.body.overzicht);
      });
      return antwoord.status(201).send(o);
    },
  );

  app.post<{ Params: { id: string }; Body: { reden: string } }>(
    "/objecten/:id/onleesbaar",
    { schema: { body: { type: "object", required: ["reden"], properties: { reden: { type: "string", minLength: 10, maxLength: 1000 } } } } },
    async (req) => {
      const { gemeente, actor } = context(req);
      return inGemeente(gemeente, async (c) => {
        await toetsToegang(c, req.params.id, actor);
        return maakOnleesbaar(c, m, gemeente, actor, req.params.id, req.body.reden);
      });
    },
  );

  // --- Zoeken (OA-ADR-007) ----------------------------------------------------

  app.get<{ Querystring: { tekst: string; informatiecategorie?: string; vertrouwelijkheid?: string; objecttype?: string; aantal?: number } }>(
    "/zoeken",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["tekst"],
          properties: {
            tekst: { type: "string", minLength: 2, maxLength: 200 },
            informatiecategorie: { type: "string", maxLength: 100 },
            vertrouwelijkheid: { type: "string", maxLength: 40 },
            objecttype: { type: "string", maxLength: 60 },
            aantal: { type: "integer", minimum: 1, maximum: 50 },
          },
        },
      },
    },
    async (req): Promise<Zoekantwoord> => {
      const { gemeente } = context(req);
      const vraag = req.query;
      const treffers = await opties.zoekindex.zoek(gemeente, vraag);
      if (treffers.length === 0) return { resultaten: [], nietBevestigd: 0 };
      // De index is nooit de bron van waarheid: elk resultaat wordt in het
      // register bevestigd, met Row Level Security, en de metadata komt
      // uit het register. Filters worden opnieuw op het register toegepast.
      const rijen = await inGemeente(gemeente, async (c) =>
        (
          await c.query(
            `SELECT o.identificatie, o.objecttype_naam, o.objecttype_versie, o.metadata,
                    (SELECT max(nummer) FROM versies v WHERE v.object = o.identificatie) AS versie
               FROM objecten o
              WHERE o.identificatie = ANY($1::uuid[]) AND o.onleesbaar_gemaakt IS NULL AND o.aard = 'zakelijk'`,
            [treffers.map((t) => t.identificatie)],
          )
        ).rows,
      );
      const perId = new Map(rijen.map((r) => [r.identificatie as string, r]));
      const resultaten: Zoekresultaat[] = [];
      for (const t of treffers) {
        const r = perId.get(t.identificatie);
        if (!r) continue;
        const md = r.metadata as Record<string, unknown>;
        if (vraag.informatiecategorie && md.informatiecategorie !== vraag.informatiecategorie) continue;
        if (vraag.vertrouwelijkheid && md.vertrouwelijkheid !== vraag.vertrouwelijkheid) continue;
        if (vraag.objecttype && r.objecttype_naam !== vraag.objecttype) continue;
        resultaten.push({
          identificatie: t.identificatie,
          objecttype: { naam: r.objecttype_naam, versie: r.objecttype_versie },
          metadata: md,
          versie: r.versie,
          fragmenten: t.fragmenten,
          score: t.score,
        });
      }
      return { resultaten, nietBevestigd: treffers.length - resultaten.length };
    },
  );

  return app;
}
