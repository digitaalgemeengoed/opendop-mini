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
 * Opslag van representaties. Het platform schrijft elke versie als nieuw
 * object onder een sleutel die nooit wordt hergebruikt.
 */
export interface Opslag {
  schrijf(gemeente: string, sleutel: string, data: Buffer, mediaType: string): Promise<void>;
  lees(gemeente: string, sleutel: string): Promise<Buffer>;
  /** Zorgt dat de opslag voor deze gemeente bestaat. */
  bereidVoor(gemeente: string): Promise<void>;
  readonly soort: string;
}

/** Voor lokale ontwikkeling en tests: bestanden op schijf. Geen Object Lock. */
export class LokaleOpslag implements Opslag {
  readonly soort = "lokaal";
  constructor(private readonly basis: string) {}

  private pad(gemeente: string, sleutel: string): string {
    const wortel = resolve(this.basis, gemeente);
    const p = resolve(wortel, sleutel);
    if (!p.startsWith(wortel + "/")) throw new Error("Ongeldige opslagsleutel");
    return p;
  }

  async bereidVoor(gemeente: string): Promise<void> {
    await mkdir(join(this.basis, gemeente), { recursive: true });
  }

  async schrijf(gemeente: string, sleutel: string, data: Buffer): Promise<void> {
    const p = this.pad(gemeente, sleutel);
    await mkdir(dirname(p), { recursive: true });
    try {
      await access(p);
      throw new Error("Opslagsleutel bestaat al; versies worden nooit overschreven");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    await writeFile(p, data, { flag: "wx" });
  }

  async lees(gemeente: string, sleutel: string): Promise<Buffer> {
    return readFile(this.pad(gemeente, sleutel));
  }
}

/**
 * S3-opslag (MinIO). Eén bucket per gemeente, aangemaakt met versiebeheer
 * en Object Lock: dat kan alleen bij het aanmaken van de bucket (OA-ADR-005).
 * Bewaartermijnen worden in het prototype nog niet gezet; de archieffuncties
 * zijn gesimuleerd.
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

  private bucket(gemeente: string): string {
    return `${config.opslag.bucketVoorvoegsel}${gemeente}`;
  }

  async bereidVoor(gemeente: string): Promise<void> {
    if (this.voorbereid.has(gemeente)) return;
    const Bucket = this.bucket(gemeente);
    try {
      await this.client.send(new HeadBucketCommand({ Bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket, ObjectLockEnabledForBucket: true }));
      // Object Lock aan, nog zonder standaardbewaartermijn.
      await this.client.send(
        new PutObjectLockConfigurationCommand({ Bucket, ObjectLockConfiguration: { ObjectLockEnabled: "Enabled" } }),
      );
    }
    this.voorbereid.add(gemeente);
  }

  async schrijf(gemeente: string, sleutel: string, data: Buffer, mediaType: string): Promise<void> {
    await this.bereidVoor(gemeente);
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket(gemeente), Key: sleutel, Body: data, ContentType: mediaType, IfNoneMatch: "*" }),
    );
  }

  async lees(gemeente: string, sleutel: string): Promise<Buffer> {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket(gemeente), Key: sleutel }));
    return Buffer.from(await r.Body!.transformToByteArray());
  }
}

export function maakOpslag(): Opslag {
  return config.opslag.soort === "lokaal" ? new LokaleOpslag(config.opslag.lokaalPad) : new S3Opslag();
}
