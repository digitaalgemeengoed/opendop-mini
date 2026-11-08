import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  PutObjectLockConfigurationCommand,
} from "@aws-sdk/client-s3";
import { config } from "./config.js";

/**
 * Waar een stuk staat: zakelijk in de bucket van de gemeente (archief, met
 * Object Lock), persoonlijk in een eigen bucket zonder Object Lock.
 */
export type Ruimte = "zakelijk" | "persoonlijk";

/**
 * Opslag van representaties. Het platform schrijft elke versie als nieuw
 * object onder een sleutel die nooit wordt hergebruikt.
 */
export interface Opslag {
  schrijf(gemeente: string, sleutel: string, data: Buffer, mediaType: string, ruimte?: Ruimte): Promise<void>;
  lees(gemeente: string, sleutel: string, ruimte?: Ruimte): Promise<Buffer>;
  /** Zorgt dat de opslag voor deze gemeente bestaat. */
  bereidVoor(gemeente: string, ruimte?: Ruimte): Promise<void>;
  readonly soort: string;
}

/** Voor lokale ontwikkeling en tests: bestanden op schijf. Geen Object Lock. */
export class LokaleOpslag implements Opslag {
  readonly soort = "lokaal";
  constructor(private readonly basis: string) {}

  private pad(gemeente: string, sleutel: string, ruimte: Ruimte = "zakelijk"): string {
    const wortel = resolve(this.basis, ruimte === "persoonlijk" ? `${gemeente}-persoonlijk` : gemeente);
    const p = resolve(wortel, sleutel);
    if (!p.startsWith(wortel + "/")) throw new Error("Ongeldige opslagsleutel");
    return p;
  }

  async bereidVoor(gemeente: string, ruimte: Ruimte = "zakelijk"): Promise<void> {
    await mkdir(join(this.basis, ruimte === "persoonlijk" ? `${gemeente}-persoonlijk` : gemeente), { recursive: true });
  }

  async schrijf(gemeente: string, sleutel: string, data: Buffer, _mediaType?: string, ruimte: Ruimte = "zakelijk"): Promise<void> {
    const p = this.pad(gemeente, sleutel, ruimte);
    await mkdir(dirname(p), { recursive: true });
    try {
      await access(p);
      throw new Error("Opslagsleutel bestaat al; versies worden nooit overschreven");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    await writeFile(p, data, { flag: "wx" });
  }

  async lees(gemeente: string, sleutel: string, ruimte: Ruimte = "zakelijk"): Promise<Buffer> {
    return readFile(this.pad(gemeente, sleutel, ruimte));
  }
}

/**
 * S3-opslag (SILO of een andere S3 met Object Lock). Eén bucket per gemeente, aangemaakt met versiebeheer
 * en Object Lock: dat kan alleen bij het aanmaken van de bucket (OA-ADR-005).
 * Bewaartermijnen worden in het prototype nog niet gezet; de archieffuncties
 * zijn gesimuleerd. Persoonlijke stukken staan in een tweede bucket per
 * gemeente ("-persoonlijk"), zonder Object Lock: die vallen buiten het archief.
 */
export class S3Opslag implements Opslag {
  readonly soort = "s3";
  private readonly client: S3Client;
  private readonly voorbereid = new Set<string>();

  constructor() {
    this.client = new S3Client({
      endpoint: config.opslag.s3Endpoint,
      region: config.opslag.s3Regio,
      forcePathStyle: true,
      credentials: { accessKeyId: config.opslag.s3Sleutel, secretAccessKey: config.opslag.s3Geheim },
    });
  }

  private bucket(gemeente: string, ruimte: Ruimte = "zakelijk"): string {
    return `${config.opslag.bucketVoorvoegsel}${gemeente}${ruimte === "persoonlijk" ? "-persoonlijk" : ""}`;
  }

  async bereidVoor(gemeente: string, ruimte: Ruimte = "zakelijk"): Promise<void> {
    const Bucket = this.bucket(gemeente, ruimte);
    if (this.voorbereid.has(Bucket)) return;
    try {
      await this.client.send(new HeadBucketCommand({ Bucket }));
    } catch {
      if (ruimte === "persoonlijk") {
        // Buiten het archief: geen Object Lock.
        await this.client.send(new CreateBucketCommand({ Bucket }));
      } else {
        await this.client.send(new CreateBucketCommand({ Bucket, ObjectLockEnabledForBucket: true }));
        // Object Lock aan, nog zonder standaardbewaartermijn.
        await this.client.send(
          new PutObjectLockConfigurationCommand({ Bucket, ObjectLockConfiguration: { ObjectLockEnabled: "Enabled" } }),
        );
      }
    }
    this.voorbereid.add(Bucket);
  }

  async schrijf(gemeente: string, sleutel: string, data: Buffer, mediaType: string, ruimte: Ruimte = "zakelijk"): Promise<void> {
    await this.bereidVoor(gemeente, ruimte);
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket(gemeente, ruimte), Key: sleutel, Body: data, ContentType: mediaType, IfNoneMatch: "*" }),
    );
  }

  async lees(gemeente: string, sleutel: string, ruimte: Ruimte = "zakelijk"): Promise<Buffer> {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket(gemeente, ruimte), Key: sleutel }));
    return Buffer.from(await r.Body!.transformToByteArray());
  }
}

export function maakOpslag(): Opslag {
  return config.opslag.soort === "lokaal" ? new LokaleOpslag(config.opslag.lokaalPad) : new S3Opslag();
}
