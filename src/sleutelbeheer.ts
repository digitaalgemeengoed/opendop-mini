import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * Sleutelbeheer (OA-ADR-008). Elk object krijgt een eigen sleutel. De inhoud
 * wordt versleuteld met een datasleutel; die datasleutel wordt verpakt door
 * een sleutel die alleen in het sleutelbeheer bestaat. Wie die sleutel
 * vernietigt, maakt alle versies van het object onleesbaar, ook in back-ups
 * van database en opslag. De registratie blijft bestaan.
 *
 * Werkt samen met Object Lock: de opslag weigert verwijderen, maar zonder
 * sleutel is de inhoud niet meer te lezen.
 */
export interface Sleutelbeheer {
  readonly soort: string;
  /** Maakt de sleutel van een nieuw object en geeft de verpakte datasleutel terug. */
  maakObjectsleutel(gemeente: string, objectId: string): Promise<string>;
  /** Pakt de datasleutel uit. Faalt als de sleutel is vernietigd. */
  pakUit(gemeente: string, objectId: string, verpakt: string): Promise<Buffer>;
  /** Vernietigt de sleutel van een object, onherroepelijk. */
  vernietig(gemeente: string, objectId: string): Promise<void>;
  /**
   * Een tweede sleutel bij een object, voor één deel ervan: de
   * persoonsgegevens van één AVG-categorie ("pii-c1", "pii-c2", "pii-c3").
   * Zelfde werking: verpakte datasleutel, vernietigen maakt alleen dat deel
   * onleesbaar.
   */
  maakDeelsleutel(gemeente: string, objectId: string, deel: Deel): Promise<string>;
  pakDeelUit(gemeente: string, objectId: string, deel: Deel, verpakt: string): Promise<Buffer>;
  vernietigDeel(gemeente: string, objectId: string, deel: Deel): Promise<void>;
}

export type Deel = "pii-c1" | "pii-c2" | "pii-c3";
const DEEL = /^pii-c[123]$/;

export class SleutelVernietigd extends Error {}

// ---------------------------------------------------------------------------
// Versleutelen van inhoud: AES-256-GCM, gebonden aan object en versie
// ---------------------------------------------------------------------------

const KOP = Buffer.from("OA1");

export function versleutel(dek: Buffer, data: Buffer, binding: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", dek, iv);
  c.setAAD(Buffer.from(binding));
  const geheim = Buffer.concat([c.update(data), c.final()]);
  return Buffer.concat([KOP, iv, c.getAuthTag(), geheim]);
}

export function ontsleutel(dek: Buffer, blob: Buffer, binding: string): Buffer {
  if (!blob.subarray(0, 3).equals(KOP)) throw new Error("Onbekend formaat van versleutelde inhoud");
  const iv = blob.subarray(3, 15);
  const tag = blob.subarray(15, 31);
  const d = createDecipheriv("aes-256-gcm", dek, iv);
  d.setAAD(Buffer.from(binding));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(blob.subarray(31)), d.final()]);
}

// ---------------------------------------------------------------------------
// OpenBao: transit-engine, één sleutel per object
// ---------------------------------------------------------------------------

/**
 * Gebruikt de transit-engine van OpenBao. Per object een transit-sleutel
 * "<voorvoegsel><gemeente>-<object>"; de datasleutel komt uit
 * transit/datakey en wordt alleen verpakt bewaard. Vernietigen = de
 * transit-sleutel verwijderen.
 *
 * Let op: snapshots van OpenBao bevatten de sleutels nog. Begrens hun
 * bewaartermijn, anders is vernietigen niet definitief.
 */
export class OpenBaoSleutelbeheer implements Sleutelbeheer {
  readonly soort = "openbao";

  constructor(
    private readonly adres: string,
    private readonly token: string,
    private readonly mount = "transit",
    private readonly voorvoegsel = "oa-",
  ) {}

  private naam(gemeente: string, objectId: string): string {
    return `${this.voorvoegsel}${gemeente}-${objectId}`;
  }

  private async vraag(methode: string, pad: string, body?: unknown): Promise<Record<string, any> | null> {
    const r = await fetch(`${this.adres.replace(/\/$/, "")}/v1/${this.mount}/${pad}`, {
      method: methode,
      headers: { "X-Vault-Token": this.token, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 204) return null;
    const tekst = await r.text();
    if (!r.ok) {
      const fouten = (() => {
        try {
          return (JSON.parse(tekst).errors ?? []).join("; ");
        } catch {
          return tekst.slice(0, 200);
        }
      })();
      const e = new Error(`OpenBao ${methode} ${pad}: ${r.status} ${fouten}`);
      if (r.status === 400 && /not found|no existing key/i.test(fouten)) throw new SleutelVernietigd(e.message);
      throw e;
    }
    return tekst ? JSON.parse(tekst) : null;
  }

  /**
   * Vernieuwt het eigen token (een periodiek token verloopt anders). Het
   * platform roept dit bij het starten en daarna elke twaalf uur aan.
   */
  async vernieuwToken(): Promise<number> {
    const r = await fetch(`${this.adres.replace(/\/$/, "")}/v1/auth/token/renew-self`, {
      method: "POST",
      headers: { "X-Vault-Token": this.token },
    });
    if (!r.ok) throw new Error(`OpenBao: token vernieuwen mislukt (${r.status})`);
    const j = (await r.json()) as { auth?: { lease_duration?: number } };
    return j.auth?.lease_duration ?? 0;
  }

  async maakObjectsleutel(gemeente: string, objectId: string): Promise<string> {
    const naam = this.naam(gemeente, objectId);
    await this.vraag("POST", `keys/${naam}`, { type: "aes256-gcm96", exportable: false });
    const r = await this.vraag("POST", `datakey/wrapped/${naam}`, { bits: 256 });
    return String(r!.data.ciphertext);
  }

  async pakUit(gemeente: string, objectId: string, verpakt: string): Promise<Buffer> {
    const r = await this.vraag("POST", `decrypt/${this.naam(gemeente, objectId)}`, { ciphertext: verpakt });
    return Buffer.from(String(r!.data.plaintext), "base64");
  }

  async vernietig(gemeente: string, objectId: string): Promise<void> {
    const naam = this.naam(gemeente, objectId);
    await this.vraag("POST", `keys/${naam}/config`, { deletion_allowed: true });
    await this.vraag("DELETE", `keys/${naam}`);
  }

  private deelnaam(gemeente: string, objectId: string, deel: Deel): string {
    if (!DEEL.test(deel)) throw new Error("Ongeldig deel");
    return `${this.naam(gemeente, objectId)}-${deel}`;
  }

  async maakDeelsleutel(gemeente: string, objectId: string, deel: Deel): Promise<string> {
    const naam = this.deelnaam(gemeente, objectId, deel);
    await this.vraag("POST", `keys/${naam}`, { type: "aes256-gcm96", exportable: false });
    const r = await this.vraag("POST", `datakey/wrapped/${naam}`, { bits: 256 });
    return String(r!.data.ciphertext);
  }

  async pakDeelUit(gemeente: string, objectId: string, deel: Deel, verpakt: string): Promise<Buffer> {
    const r = await this.vraag("POST", `decrypt/${this.deelnaam(gemeente, objectId, deel)}`, { ciphertext: verpakt });
    return Buffer.from(String(r!.data.plaintext), "base64");
  }

  async vernietigDeel(gemeente: string, objectId: string, deel: Deel): Promise<void> {
    const naam = this.deelnaam(gemeente, objectId, deel);
    await this.vraag("POST", `keys/${naam}/config`, { deletion_allowed: true });
    await this.vraag("DELETE", `keys/${naam}`);
  }
}

// ---------------------------------------------------------------------------
// Lokaal: voor ontwikkeling en tests. Zelfde gedrag, sleutels op schijf.
// ---------------------------------------------------------------------------

export class LokaalSleutelbeheer implements Sleutelbeheer {
  readonly soort = "lokaal";
  constructor(private readonly map: string) {}

  private pad(gemeente: string, objectId: string): string {
    if (!/^[a-z0-9-]+$/.test(gemeente) || !/^[0-9a-f-]{36}$/.test(objectId)) throw new Error("Ongeldige sleutelnaam");
    return join(resolve(this.map), `${gemeente}-${objectId}.sleutel`);
  }

  async maakObjectsleutel(gemeente: string, objectId: string): Promise<string> {
    await mkdir(this.map, { recursive: true });
    const kek = randomBytes(32);
    await writeFile(this.pad(gemeente, objectId), kek, { flag: "wx", mode: 0o600 });
    return versleutel(kek, randomBytes(32), objectId).toString("base64");
  }

  async pakUit(gemeente: string, objectId: string, verpakt: string): Promise<Buffer> {
    let kek: Buffer;
    try {
      kek = await readFile(this.pad(gemeente, objectId));
    } catch {
      throw new SleutelVernietigd("De sleutel van dit object bestaat niet meer");
    }
    return ontsleutel(kek, Buffer.from(verpakt, "base64"), objectId);
  }

  async vernietig(gemeente: string, objectId: string): Promise<void> {
    await rm(this.pad(gemeente, objectId), { force: true });
  }

  private deelpad(gemeente: string, objectId: string, deel: Deel): string {
    if (!DEEL.test(deel)) throw new Error("Ongeldig deel");
    return this.pad(gemeente, objectId).replace(/\.sleutel$/, `-${deel}.sleutel`);
  }

  async maakDeelsleutel(gemeente: string, objectId: string, deel: Deel): Promise<string> {
    await mkdir(this.map, { recursive: true });
    const kek = randomBytes(32);
    await writeFile(this.deelpad(gemeente, objectId, deel), kek, { flag: "wx", mode: 0o600 });
    return versleutel(kek, randomBytes(32), `${objectId}/${deel}`).toString("base64");
  }

  async pakDeelUit(gemeente: string, objectId: string, deel: Deel, verpakt: string): Promise<Buffer> {
    let kek: Buffer;
    try {
      kek = await readFile(this.deelpad(gemeente, objectId, deel));
    } catch {
      throw new SleutelVernietigd("De sleutel van dit deel bestaat niet meer");
    }
    return ontsleutel(kek, Buffer.from(verpakt, "base64"), `${objectId}/${deel}`);
  }

  async vernietigDeel(gemeente: string, objectId: string, deel: Deel): Promise<void> {
    await rm(this.deelpad(gemeente, objectId, deel), { force: true });
  }
}
