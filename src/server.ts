import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

/** De eigen versie, voor /gezondheid (de overzichtspagina toont welke versie draait). */
const VERSIE = (() => {
  try {
    return (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string }).version ?? "onbekend";
  } catch {
    return "onbekend";
  }
})();
import type { Actor, AnonimiseringsMeting, Inhoud, PiiInvoer, Zoekantwoord, Zoekresultaat } from "@digitaalgemeengoed/oa-contract";
import { INHOUD_SCHEMA, METADATAMODELLEN, MODELNAAM_MAX, SIGNAALWOORDEN, ROLLEN, WAARDELIJSTEN, actieveVelden, controleerConfig, rolWaarden, schemaUitConfig, type MetadatamodelConfig } from "@digitaalgemeengoed/oa-contract";
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
  versiesVanObjecttype,
  voegVersieToe,
  type Middelen,
  toetsToegang,
  wijzigAard,
  legAnonimiseringVast,
} from "./objecten.js";
import { meetKwaliteit } from "./kwaliteit.js";
import {
  SELECTIELIJSTEN,
  beoordeelVoorstel,
  dienVoorstelIn,
  leesClassificatiemodel,
  leesVoorstel,
  leesVoorstelWeergave,
  legClassificatieVast,
  lijstVan,
  lijstVoorstellen,
  publiceerClassificatiemodel,
  statussenVan,
  versiesClassificatiemodel,
} from "./classificatie.js";
import { CLASSIFICATIEMODELNAAM_MAX, controleerClassificatiemodel, resultatenInGebruik, standaardClassificatiemodel, type ClassificatiemodelConfig } from "@digitaalgemeengoed/oa-contract";
import { bevestigPii, leesPiiRegister, onthulPii, registreerPii, terugzettenPii, toetsVersieMetPii, vernietigPii, vervallenPii, wijzigCategoriePii, zetVersieTerug } from "./piiregister.js";

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
    // Het PPL-niveau komt van de integratielaag (rollen ppl-1..3); alles anders telt als 0.
    actor.niveau = ([0, 1, 2, 3] as const).find((n) => n === actor.niveau) ?? 0;
    actor.beheerder = actor.beheerder === true;
    actor.vrijgever = actor.vrijgever === true;
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
    versie: VERSIE,
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

  // --- Metadatamodellen (beheerportaal) ----------------------------------------
  // De catalogus (MDTO, RGBZ, TMLO en de waardelijsten, ook uit TOOI) staat in
  // het contract; het beheerportaal stuurt alleen de keuze van de gemeente.

  app.get("/metadatamodellen", async () => ({ modellen: METADATAMODELLEN, waardelijsten: WAARDELIJSTEN, rollen: ROLLEN }));

  const CONFIG_SCHEMA = {
    type: "object",
    required: ["basis", "velden"],
    additionalProperties: false,
    properties: {
      basis: { enum: ["mdto", "rgbz", "tmlo"] },
      naam: { type: "string", maxLength: MODELNAAM_MAX },
      velden: {
        type: "array",
        maxItems: 200,
        items: {
          type: "object",
          required: ["sleutel", "aan", "verplicht"],
          additionalProperties: false,
          properties: {
            sleutel: { type: "string", minLength: 1, maxLength: 40 },
            aan: { type: "boolean" },
            verplicht: { type: "boolean" },
            label: { type: "string", maxLength: 100 },
            beschrijving: { type: "string", maxLength: 500 },
            waardelijst: { type: "string", maxLength: 60 },
            eigen: {
              type: "object",
              required: ["type"],
              additionalProperties: false,
              properties: {
                type: { enum: ["tekst", "lange-tekst", "datum", "keuze", "getal"] },
                maxLengte: { type: "integer", minimum: 1, maximum: 10000 },
                opties: { type: "array", maxItems: 200, items: { type: "string", minLength: 1, maxLength: 200 } },
                rol: { enum: [...ROLLEN] },
              },
            },
          },
        },
      },
    },
  } as const;

  /** Een keuze toetsen en tonen zonder iets vast te leggen: problemen, schema en velden zoals het paneel ze krijgt. */
  app.post<{ Body: { config: MetadatamodelConfig } }>(
    "/metadatamodellen/controle",
    { schema: { body: { type: "object", required: ["config"], properties: { config: CONFIG_SCHEMA } } } },
    async (req) => {
      const problemen = controleerConfig(req.body.config);
      const fout = problemen.some((p) => p.ernst === "fout");
      return { problemen, velden: actieveVelden(req.body.config), schema: fout ? null : schemaUitConfig(req.body.config) };
    },
  );

  // --- Classificeren en bewaren --------------------------------------------------

  const CLASSIFICATIEMODEL_SCHEMA = {
    type: "object",
    required: ["selectielijst", "attributen", "vergrendelBij", "termijnStartBij"],
    additionalProperties: false,
    properties: {
      naam: { type: "string", maxLength: CLASSIFICATIEMODELNAAM_MAX },
      selectielijst: { enum: Object.keys(SELECTIELIJSTEN) },
      uitgezet: { type: "array", maxItems: 1000, items: { type: "string", maxLength: 20 } },
      afwijkingen: {
        type: "array",
        maxItems: 500,
        items: {
          type: "object",
          required: ["resultaat", "reden"],
          additionalProperties: false,
          properties: {
            resultaat: { type: "string", maxLength: 20 },
            waardering: { enum: ["vernietigen", "blijvend-bewaren"] },
            bewaartermijn: { type: "string", maxLength: 20 },
            reden: { type: "string", maxLength: 1000 },
          },
        },
      },
      attributen: {
        type: "array",
        maxItems: 50,
        items: {
          type: "object",
          required: ["sleutel", "label", "type", "verplicht"],
          additionalProperties: false,
          properties: {
            sleutel: { type: "string", maxLength: 40 },
            label: { type: "string", maxLength: 100 },
            type: { enum: ["tekst", "keuze", "ja-nee"] },
            opties: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 200 } },
            verplicht: { type: "boolean" },
            beschrijving: { type: "string", maxLength: 500 },
          },
        },
      },
      vergrendelBij: { type: "array", maxItems: 20, items: { type: "string", maxLength: 100 } },
      termijnStartBij: { type: "string", maxLength: 100 },
    },
  } as const;

  /** Voor het paneel: het model dat nu geldt, met de resultaten die de gemeente gebruikt. */
  app.get<{ Querystring: { alleenModel?: string } }>("/classificatie", async (req) => {
    const { gemeente } = context(req);
    return inGemeente(gemeente, async (c) => {
      const model = await leesClassificatiemodel(c);
      if (!model || req.query.alleenModel) return { model };
      const lijst = lijstVan(model.config);
      return {
        model,
        selectielijst: { id: lijst.id, naam: lijst.naam, toelichting: lijst.toelichting, procestypen: lijst.procestypen, resultaten: resultatenInGebruik(model.config, lijst) },
      };
    });
  });

  /** Voor het beheerportaal: de selectielijst, de statussen uit het metadatamodel, het model en zijn versies. */
  app.get("/classificatiemodel", async (req) => {
    const { gemeente } = context(req);
    return inGemeente(gemeente, async (c) => {
      const type = await leesObjecttype(c, "document");
      return {
        selectielijsten: Object.values(SELECTIELIJSTEN),
        statussen: statussenVan(type),
        standaard: standaardClassificatiemodel(),
        actief: await leesClassificatiemodel(c),
        versies: await versiesClassificatiemodel(c),
      };
    });
  });

  app.post<{ Body: { config: ClassificatiemodelConfig } }>(
    "/classificatiemodel/controle",
    { schema: { body: { type: "object", required: ["config"], properties: { config: CLASSIFICATIEMODEL_SCHEMA } } } },
    async (req) => {
      const { gemeente } = context(req);
      const type = await inGemeente(gemeente, (c) => leesObjecttype(c, "document"));
      return { problemen: controleerClassificatiemodel(req.body.config, lijstVan(req.body.config), statussenVan(type)) };
    },
  );

  app.post<{ Body: { config: ClassificatiemodelConfig } }>(
    "/classificatiemodel",
    { schema: { body: { type: "object", required: ["config"], additionalProperties: false, properties: { config: CLASSIFICATIEMODEL_SCHEMA } } } },
    async (req, antwoord) => {
      const { gemeente, actor } = context(req);
      const model = await inGemeente(gemeente, (c) => publiceerClassificatiemodel(c, gemeente, actor, req.body.config));
      return antwoord.status(201).send(model);
    },
  );

  app.put<{ Params: { id: string }; Body: { resultaat: string; attributen?: Record<string, string | boolean>; einddatumProcesobject?: string; verwachteVolgnummer?: number } }>(
    "/objecten/:id/classificatie",
    {
      schema: {
        body: {
          type: "object",
          required: ["resultaat"],
          additionalProperties: false,
          properties: {
            resultaat: { type: "string", maxLength: 20 },
            attributen: { type: "object", maxProperties: 50, additionalProperties: { type: ["string", "boolean"] } },
            einddatumProcesobject: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
            verwachteVolgnummer: { type: "integer" },
          },
        },
      },
    },
    async (req) => {
      const { gemeente, actor } = context(req);
      return inGemeente(gemeente, async (c) => {
        await toetsToegang(c, req.params.id, actor);
        return legClassificatieVast(c, gemeente, actor, req.params.id, req.body);
      });
    },
  );

  // --- Vergrendeld: wijzigingsvoorstellen -------------------------------------------

  app.post<{ Params: { id: string }; Body: { inhoud: Inhoud; weergave?: Inhoud; reden: string } }>(
    "/objecten/:id/voorstellen",
    {
      schema: {
        body: {
          type: "object",
          required: ["inhoud", "reden"],
          properties: { inhoud: INHOUD_SCHEMA, weergave: WEERGAVE_SCHEMA, reden: { type: "string", minLength: 5, maxLength: 1000 } },
        },
      },
    },
    async (req, antwoord) => {
      const { gemeente, actor } = context(req);
      const v = await inGemeente(gemeente, async (c) => {
        await toetsToegang(c, req.params.id, actor);
        return dienVoorstelIn(c, m, gemeente, actor, req.params.id, req.body);
      });
      return antwoord.status(201).send(v);
    },
  );

  app.get<{ Querystring: { object?: string; status?: string } }>(
    "/voorstellen",
    { schema: { querystring: { type: "object", properties: { object: { type: "string", pattern: "^[0-9a-fA-F-]{36}$" }, status: { enum: ["open", "goedgekeurd", "afgewezen"] } } } } },
    async (req) => {
      const { gemeente, actor } = context(req);
      return inGemeente(gemeente, async (c) => {
        if (req.query.object) await toetsToegang(c, req.query.object, actor);
        // Zonder object: de lijst om te beoordelen, alleen voor vrijgevers.
        else if (!actor.vrijgever) throw new PlatformFout(403, "geen-vrijgever", "Alleen een vrijgever ziet alle voorstellen.");
        return lijstVoorstellen(c, { object: req.query.object, status: req.query.status ?? (req.query.object ? undefined : "open") });
      });
    },
  );

  app.get<{ Params: { vid: string } }>("/voorstellen/:vid/weergave", async (req) => {
    const { gemeente, actor } = context(req);
    return inGemeente(gemeente, async (c) => {
      const v = await leesVoorstel(c, req.params.vid);
      await toetsToegang(c, v.object, actor);
      if (!actor.vrijgever && v.door.sub !== actor.sub) throw new PlatformFout(403, "geen-vrijgever", "Alleen de indiener en een vrijgever zien het voorstel.");
      return leesVoorstelWeergave(c, m, gemeente, req.params.vid);
    });
  });

  app.post<{ Params: { vid: string }; Body: { besluit: "goedkeuren" | "afwijzen"; toelichting?: string } }>(
    "/voorstellen/:vid/beoordeling",
    {
      schema: {
        body: {
          type: "object",
          required: ["besluit"],
          additionalProperties: false,
          properties: { besluit: { enum: ["goedkeuren", "afwijzen"] }, toelichting: { type: "string", maxLength: 1000 } },
        },
      },
    },
    async (req) => {
      const { gemeente, actor } = context(req);
      return inGemeente(gemeente, (c) => beoordeelVoorstel(c, m, gemeente, actor, req.params.vid, req.body));
    },
  );

  app.get<{ Params: { naam: string } }>("/objecttypen/:naam/versies", async (req) => {
    const { gemeente } = context(req);
    return inGemeente(gemeente, (c) => versiesVanObjecttype(c, gemeente, req.params.naam));
  });

  /** Een metadatamodel publiceren als nieuwe versie van het objecttype (alleen voor deze gemeente). */
  app.post<{ Params: { naam: string }; Body: { config: MetadatamodelConfig; titel?: string } }>(
    "/objecttypen/:naam/model",
    {
      schema: {
        params: { type: "object", properties: { naam: { type: "string", pattern: "^[a-z][a-z0-9-]{1,60}$" } } },
        body: { type: "object", required: ["config"], additionalProperties: false, properties: { config: CONFIG_SCHEMA, titel: { type: "string", minLength: 1, maxLength: 100 } } },
      },
    },
    async (req, antwoord) => {
      const { gemeente, actor } = context(req);
      const problemen = controleerConfig(req.body.config).filter((p) => p.ernst === "fout");
      if (problemen.length) throw new PlatformFout(422, "model-ongeldig", "Het metadatamodel klopt nog niet.", problemen.map((p) => ({ veld: p.sleutel ?? "", melding: p.melding })));
      const schema = schemaUitConfig(req.body.config);
      const type = await inGemeente(gemeente, async (c) => {
        const huidig = await leesObjecttype(c, req.params.naam).catch(() => null);
        return publiceerObjecttype(c, gemeente, actor, { naam: req.params.naam, titel: req.body.titel ?? huidig?.titel ?? "Document", schema, vervaldatum: null });
      });
      return antwoord.status(201).send(type);
    },
  );

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
      await toetsVersieMetPii(c, req.params.id, Number(req.params.nummer), actor);
      return leesInhoud(c, m, gemeente, req.params.id, Number(req.params.nummer));
    });
    return antwoord.header("content-type", r.mediaType).header("x-oa-formaat", r.formaat).send(r.data);
  });

  app.get<{ Params: { id: string; nummer: string; formaat: string }; Querystring: { soort?: string } }>("/objecten/:id/versies/:nummer/weergaven/:formaat", async (req, antwoord) => {
    const { gemeente, actor } = context(req);
    const soort = req.query.soort === "geanonimiseerd" ? "geanonimiseerd" : "weergave";
    const r = await inGemeente(gemeente, async (c) => {
      await toetsToegang(c, req.params.id, actor);
      if (soort === "weergave") await toetsVersieMetPii(c, req.params.id, Number(req.params.nummer), actor);
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

  // Register van persoonsgegevens (anonimiseren bij de bron).
  app.post<{ Params: { id: string }; Body: { items: PiiInvoer[]; voorvertoning?: boolean } }>(
    "/objecten/:id/pii",
    {
      schema: {
        body: {
          type: "object",
          required: ["items"],
          properties: {
            items: {
              type: "array",
              maxItems: 5000,
              items: {
                type: "object",
                required: ["soort", "waarde", "bron"],
                properties: {
                  soort: { type: "string", maxLength: 40 },
                  waarde: { type: "string", minLength: 1, maxLength: 2000 },
                  bron: { enum: ["model", "patroon", "medewerker"] },
                  categorie: { enum: ["c1", "c2", "c3"] },
                },
              },
            },
            voorvertoning: { type: "boolean" },
          },
        },
      },
    },
    async (req, antwoord) => {
      const { gemeente, actor } = context(req);
      const plaatshouders = await inGemeente(gemeente, async (c) => {
        await toetsToegang(c, req.params.id, actor);
        return registreerPii(c, m, gemeente, actor, req.params.id, req.body.items, req.body.voorvertoning === true);
      });
      return antwoord.status(201).send({ plaatshouders });
    },
  );

  app.get<{ Params: { id: string } }>("/objecten/:id/pii", async (req) => {
    const { gemeente, actor } = context(req);
    return inGemeente(gemeente, async (c) => {
      await toetsToegang(c, req.params.id, actor);
      return leesPiiRegister(c, req.params.id, actor);
    });
  });

  app.post<{ Params: { id: string }; Body: { plaatshouders: string[] } }>(
    "/objecten/:id/pii/onthul",
    { schema: { body: { type: "object", required: ["plaatshouders"], properties: { plaatshouders: { type: "array", minItems: 1, maxItems: 500, items: { type: "string", maxLength: 60 } } } } } },
    async (req) => {
      const { gemeente, actor } = context(req);
      const waarden = await inGemeente(gemeente, async (c) => {
        await toetsToegang(c, req.params.id, actor);
        return onthulPii(c, m, gemeente, actor, req.params.id, req.body.plaatshouders);
      });
      return { waarden };
    },
  );

  app.post<{ Params: { id: string }; Body: { plaatshouders: string[] } }>(
    "/objecten/:id/pii/vervallen",
    { schema: { body: { type: "object", required: ["plaatshouders"], properties: { plaatshouders: { type: "array", maxItems: 5000, items: { type: "string", maxLength: 60 } } } } } },
    async (req) => {
      const { gemeente, actor } = context(req);
      return inGemeente(gemeente, async (c) => {
        await toetsToegang(c, req.params.id, actor);
        return vervallenPii(c, req.params.id, actor, req.body.plaatshouders);
      });
    },
  );

  app.post<{ Params: { id: string }; Body: { plaatshouder: string; categorie: "c1" | "c2" | "c3" } }>(
    "/objecten/:id/pii/categorie",
    {
      schema: {
        body: { type: "object", required: ["plaatshouder", "categorie"], properties: { plaatshouder: { type: "string", maxLength: 60 }, categorie: { enum: ["c1", "c2", "c3"] } } },
      },
    },
    async (req) => {
      const { gemeente, actor } = context(req);
      return inGemeente(gemeente, async (c) => {
        await toetsToegang(c, req.params.id, actor);
        return wijzigCategoriePii(c, m, gemeente, actor, req.params.id, req.body.plaatshouder, req.body.categorie);
      });
    },
  );

  const METING_SCHEMA = {
    type: "object",
    required: ["items"],
    additionalProperties: false,
    properties: {
      motor: { type: "string", maxLength: 200 },
      items: {
        type: "array",
        maxItems: 5000,
        items: {
          type: "object",
          required: ["soort", "bron", "uitkomst", "standaard", "plekken"],
          additionalProperties: false,
          properties: {
            soort: { type: "string", maxLength: 40 },
            bron: { enum: ["model", "patroon", "medewerker"] },
            score: { type: "number", minimum: 0, maximum: 1 },
            uitkomst: { enum: ["bevestigd", "gelaten", "toegevoegd"] },
            reden: { enum: ["geen-persoonsgegeven", "mag-openbaar", "verkeerde-soort"] },
            standaard: { type: "boolean" },
            categorie: { type: "object", required: ["van", "naar"], additionalProperties: false, properties: { van: { enum: ["c1", "c2", "c3"] }, naar: { enum: ["c1", "c2", "c3"] } } },
            // De vorm bevat alleen 9, A, a, spaties en leestekens: nooit letters of cijfers van de waarde zelf.
            vorm: { type: "string", maxLength: 60, pattern: "^[9Aa \\p{P}\\p{S}]*$" },
            lengte: { enum: ["kort", "middel", "lang"] },
            signaal: { enum: [...SIGNAALWOORDEN] },
            plekken: { type: "integer", minimum: 0, maximum: 100000 },
            plekkenGelaten: { type: "integer", minimum: 0, maximum: 100000 },
          },
        },
      },
    },
  } as const;

  app.post<{ Params: { id: string }; Body: { inhoud: Inhoud; weergave?: Inhoud; bronversie: number; behouden: string[]; meting?: AnonimiseringsMeting } }>(
    "/objecten/:id/pii/bevestig",
    {
      schema: {
        body: {
          type: "object",
          required: ["inhoud", "bronversie", "behouden"],
          properties: {
            inhoud: INHOUD_SCHEMA,
            weergave: WEERGAVE_SCHEMA,
            bronversie: { type: "integer", minimum: 1 },
            behouden: { type: "array", maxItems: 5000, items: { type: "string", maxLength: 60 } },
            meting: METING_SCHEMA,
          },
        },
      },
    },
    async (req, antwoord) => {
      const { gemeente, actor } = context(req);
      const o = await inGemeente(gemeente, async (c) => {
        await toetsToegang(c, req.params.id, actor);
        return bevestigPii(c, m, gemeente, actor, req.params.id, req.body);
      });
      return antwoord.status(201).send(o);
    },
  );

  app.post<{ Params: { id: string }; Body: { plaatshouders: string[] } }>(
    "/objecten/:id/pii/terugzetten",
    { schema: { body: { type: "object", required: ["plaatshouders"], properties: { plaatshouders: { type: "array", minItems: 1, maxItems: 500, items: { type: "string", maxLength: 60 } } } } } },
    async (req) => {
      const { gemeente, actor } = context(req);
      const waarden = await inGemeente(gemeente, async (c) => {
        await toetsToegang(c, req.params.id, actor);
        return terugzettenPii(c, m, gemeente, actor, req.params.id, req.body.plaatshouders);
      });
      return { waarden };
    },
  );

  app.post<{ Params: { id: string; nummer: string }; Body: { reden: string } }>(
    "/objecten/:id/versies/:nummer/terugzetten",
    { schema: { body: { type: "object", required: ["reden"], properties: { reden: { type: "string", minLength: 10, maxLength: 1000 } } } } },
    async (req, antwoord) => {
      const { gemeente, actor } = context(req);
      const o = await inGemeente(gemeente, async (c) => {
        await toetsToegang(c, req.params.id, actor);
        return zetVersieTerug(c, m, gemeente, actor, req.params.id, Number(req.params.nummer), req.body.reden);
      });
      return antwoord.status(201).send(o);
    },
  );

  app.post<{ Params: { id: string }; Body: { categorie: "c1" | "c2" | "c3"; reden: string; originelen?: "laten" | "beperken" } }>(
    "/objecten/:id/pii/vernietig",
    {
      schema: {
        body: { type: "object", required: ["categorie", "reden"], properties: { categorie: { enum: ["c1", "c2", "c3"] }, reden: { type: "string", minLength: 10, maxLength: 1000 }, originelen: { enum: ["laten", "beperken"] } } },
      },
    },
    async (req) => {
      const { gemeente, actor } = context(req);
      return inGemeente(gemeente, async (c) => {
        await toetsToegang(c, req.params.id, actor);
        return vernietigPii(c, m, gemeente, actor, req.params.id, req.body.categorie, req.body.reden, req.body.originelen);
      });
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

  // --- Kwaliteit van het anonimiseren (beheerportaal) ----------------------

  app.get<{ Querystring: { dagen?: number; drempel?: number } }>(
    "/anonimisering/kwaliteit",
    {
      schema: {
        querystring: {
          type: "object",
          properties: { dagen: { type: "integer", minimum: 1, maximum: 3660 }, drempel: { type: "integer", minimum: 2, maximum: 100 } },
        },
      },
    },
    async (req) => {
      const { gemeente } = context(req);
      return inGemeente(gemeente, (c) => meetKwaliteit(c, { dagen: req.query.dagen ?? 90, drempel: req.query.drempel ?? 5 }));
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
      // De schema's van de objecttypen van de resultaten: daarin staat welk veld welke rol heeft.
      const schemas = new Map<string, unknown>();
      await inGemeente(gemeente, async (c) => {
        for (const r of rijen) {
          const k = `${r.objecttype_naam}@${r.objecttype_versie}`;
          if (schemas.has(k)) continue;
          const t = await c.query("SELECT schema FROM objecttypen WHERE naam = $1 AND versie = $2", [r.objecttype_naam, r.objecttype_versie]);
          schemas.set(k, t.rows[0]?.schema);
        }
      });
      const resultaten: Zoekresultaat[] = [];
      for (const t of treffers) {
        const r = perId.get(t.identificatie);
        if (!r) continue;
        const md = r.metadata as Record<string, unknown>;
        const kern = rolWaarden(schemas.get(`${r.objecttype_naam}@${r.objecttype_versie}`), md);
        if (vraag.informatiecategorie && kern.informatiecategorie !== vraag.informatiecategorie) continue;
        if (vraag.vertrouwelijkheid && kern.vertrouwelijkheid !== vraag.vertrouwelijkheid) continue;
        if (vraag.objecttype && r.objecttype_naam !== vraag.objecttype) continue;
        resultaten.push({
          identificatie: t.identificatie,
          objecttype: { naam: r.objecttype_naam, versie: r.objecttype_versie },
          metadata: md,
          kern,
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
