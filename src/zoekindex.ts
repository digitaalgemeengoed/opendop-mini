import { Client } from "@opensearch-project/opensearch";
import { parseFragment } from "parse5";
import type { DefaultTreeAdapterMap } from "parse5";
import type { Zoekvraag } from "@digitaalgemeengoed/oa-contract";

/**
 * Zoekindex (OA-ADR-007). Eén index per gemeente. De index is nooit de bron
 * van waarheid: elk resultaat wordt in het register bevestigd voordat het
 * terugkomt, en de metadata in het antwoord komt uit het register.
 */
export interface IndexDocument {
  identificatie: string;
  objecttype: string;
  versie: number | null;
  metadata: Record<string, unknown>;
  tekst: string;
  bijgewerkt: string;
}

export interface Treffer {
  identificatie: string;
  score: number;
  fragmenten: string[];
}

export interface Zoekindex {
  readonly soort: string;
  indexeer(gemeente: string, doc: IndexDocument): Promise<void>;
  verwijder(gemeente: string, identificatie: string): Promise<void>;
  zoek(gemeente: string, vraag: Zoekvraag): Promise<Treffer[]>;
}

export class ZoekenUit extends Error {}

/** Zoeken staat uit: indexeren doet niets, zoeken zegt dat het niet kan. */
export class GeenZoekindex implements Zoekindex {
  readonly soort = "uit";
  async indexeer(): Promise<void> {}
  async verwijder(): Promise<void> {}
  async zoek(): Promise<Treffer[]> {
    throw new ZoekenUit("Zoeken staat in deze omgeving uit.");
  }
}

const VELDEN_METADATA = ["naam", "omschrijving", "informatiecategorie", "vertrouwelijkheid", "dossier", "zaak", "taal"];

export class OpenSearchZoekindex implements Zoekindex {
  readonly soort = "opensearch";
  private readonly client: Client;
  private readonly bestaat = new Set<string>();

  constructor(adres: string, private readonly voorvoegsel = "oa-", auth?: { gebruiker: string; wachtwoord: string }) {
    this.client = new Client({
      node: adres,
      ...(auth?.gebruiker ? { auth: { username: auth.gebruiker, password: auth.wachtwoord } } : {}),
    });
  }

  private index(gemeente: string): string {
    if (!/^[a-z0-9-]{2,40}$/.test(gemeente)) throw new Error("Ongeldige gemeente");
    return `${this.voorvoegsel}${gemeente}`;
  }

  private async zorgVoorIndex(gemeente: string): Promise<string> {
    const index = this.index(gemeente);
    if (this.bestaat.has(index)) return index;
    const r = await this.client.indices.exists({ index });
    if (!r.body) {
      await this.client.indices.create({
        index,
        body: {
          settings: { number_of_shards: 1, number_of_replicas: 0 },
          mappings: {
            dynamic: "strict",
            properties: {
              identificatie: { type: "keyword" },
              objecttype: { type: "keyword" },
              versie: { type: "integer" },
              naam: { type: "text", analyzer: "dutch" },
              omschrijving: { type: "text", analyzer: "dutch" },
              tekst: { type: "text", analyzer: "dutch" },
              informatiecategorie: { type: "keyword" },
              vertrouwelijkheid: { type: "keyword" },
              dossier: { type: "keyword" },
              zaak: { type: "keyword" },
              taal: { type: "keyword" },
              bijgewerkt: { type: "date" },
            },
          },
        },
      });
    }
    this.bestaat.add(index);
    return index;
  }

  async indexeer(gemeente: string, doc: IndexDocument): Promise<void> {
    const index = await this.zorgVoorIndex(gemeente);
    const metadata = Object.fromEntries(
      VELDEN_METADATA.filter((v) => doc.metadata[v] !== undefined && doc.metadata[v] !== "").map((v) => [v, doc.metadata[v]]),
    );
    await this.client.index({
      index,
      id: doc.identificatie,
      body: {
        identificatie: doc.identificatie,
        objecttype: doc.objecttype,
        versie: doc.versie,
        tekst: doc.tekst,
        bijgewerkt: doc.bijgewerkt,
        ...metadata,
      },
      refresh: true,
    });
  }

  async verwijder(gemeente: string, identificatie: string): Promise<void> {
    const index = await this.zorgVoorIndex(gemeente);
    try {
      await this.client.delete({ index, id: identificatie, refresh: true });
    } catch (e) {
      if ((e as { meta?: { statusCode?: number } }).meta?.statusCode !== 404) throw e;
    }
  }

  async zoek(gemeente: string, vraag: Zoekvraag): Promise<Treffer[]> {
    const index = await this.zorgVoorIndex(gemeente);
    const filters: { term: Record<string, string> }[] = [];
    if (vraag.informatiecategorie) filters.push({ term: { informatiecategorie: vraag.informatiecategorie } });
    if (vraag.vertrouwelijkheid) filters.push({ term: { vertrouwelijkheid: vraag.vertrouwelijkheid } });
    if (vraag.objecttype) filters.push({ term: { objecttype: vraag.objecttype } });
    const r = await this.client.search({
      index,
      body: {
        size: Math.min(Math.max(vraag.aantal ?? 20, 1), 50),
        query: {
          bool: {
            must: [{ multi_match: { query: vraag.tekst, fields: ["naam^3", "omschrijving^2", "tekst"] } }],
            filter: filters,
          },
        },
        highlight: {
          encoder: "html",
          pre_tags: ["<mark>"],
          post_tags: ["</mark>"],
          fields: { naam: {}, omschrijving: {}, tekst: { fragment_size: 160, number_of_fragments: 2 } },
        },
        _source: ["identificatie"],
      },
    });
    const hits = (r.body as { hits: { hits: { _id: string; _score: number; highlight?: Record<string, string[]> }[] } }).hits.hits;
    return hits.map((h) => ({
      identificatie: h._id,
      score: h._score,
      fragmenten: [...(h.highlight?.tekst ?? []), ...(h.highlight?.omschrijving ?? [])].slice(0, 3),
    }));
  }
}

// ---------------------------------------------------------------------------
// Tekst uit inhoud
// ---------------------------------------------------------------------------

type Knoop = DefaultTreeAdapterMap["node"];

/** Platte tekst uit html, met spaties tussen blokken; script en style tellen niet mee. */
export function tekstUitHtml(html: string): string {
  const delen: string[] = [];
  const loop = (n: Knoop): void => {
    if (n.nodeName === "#text") {
      delen.push((n as DefaultTreeAdapterMap["textNode"]).value);
      return;
    }
    if (n.nodeName === "script" || n.nodeName === "style") return;
    if ("childNodes" in n) {
      for (const k of (n as DefaultTreeAdapterMap["parentNode"]).childNodes) loop(k);
      delen.push(" ");
    }
  };
  loop(parseFragment(html));
  return delen.join("").replace(/\s+/g, " ").trim();
}

export function tekstUit(formaat: string, data: Buffer): string {
  if (formaat === "html") return tekstUitHtml(data.toString("utf8"));
  if (formaat === "tekst") return data.toString("utf8");
  return "";
}
