function nodig(naam: string): string {
  const w = process.env[naam];
  if (!w) throw new Error(`Omgevingsvariabele ${naam} ontbreekt`);
  return w;
}

export const config = {
  poort: Number(process.env.POORT ?? 4100),
  host: process.env.HOST ?? "0.0.0.0",
  /** Verbinding als oa_app: Row Level Security geldt. */
  databaseUrl: () => nodig("DATABASE_URL"),
  /** Verbinding als eigenaar: voor migraties en de worker. */
  databaseUrlBeheer: () => nodig("DATABASE_URL_BEHEER"),
  /** Wachtwoord dat de migratie op rol oa_app zet. */
  appWachtwoord: () => process.env.OA_APP_WACHTWOORD ?? "",
  /**
   * Gedeelde sleutel tussen integratielaag en platform. Alleen de
   * integratielaag mag het platform aanroepen. In productie: mTLS.
   */
  dienstsleutel: () => nodig("PLATFORM_DIENSTSLEUTEL"),
  opslag: {
    soort: (process.env.OPSLAG ?? "s3") as "s3" | "lokaal",
    lokaalPad: process.env.OPSLAG_PAD ?? "./data/opslag",
    s3Endpoint: process.env.S3_ENDPOINT ?? "http://localhost:9000",
    s3Regio: process.env.S3_REGIO ?? "eu-west-1",
    s3Sleutel: process.env.S3_SLEUTEL ?? "",
    s3Geheim: process.env.S3_GEHEIM ?? "",
    /** Bucket per gemeente: <voorvoegsel><gemeente>. */
    bucketVoorvoegsel: process.env.S3_BUCKET_VOORVOEGSEL ?? "oa-",
  },
  /** "uit", "lokaal" (sleutels op schijf, alleen ontwikkeling) of "openbao" (OA-ADR-008). */
  sleutelbeheer: {
    soort: (process.env.SLEUTELBEHEER ?? "uit") as "uit" | "lokaal" | "openbao",
    lokaalPad: process.env.SLEUTELBEHEER_PAD ?? "./data/sleutels",
    openbaoAdres: () => nodig("OPENBAO_ADRES"),
    openbaoToken: () => nodig("OPENBAO_TOKEN"),
    openbaoTransit: process.env.OPENBAO_TRANSIT ?? "transit",
  },
  /** "uit" of "opensearch" (OA-ADR-007). */
  zoekindex: {
    soort: (process.env.ZOEKINDEX ?? "uit") as "uit" | "opensearch",
    adres: () => nodig("OPENSEARCH_ADRES"),
    gebruiker: process.env.OPENSEARCH_GEBRUIKER ?? "",
    wachtwoord: process.env.OPENSEARCH_WACHTWOORD ?? "",
    voorvoegsel: process.env.OPENSEARCH_VOORVOEGSEL ?? "oa-",
  },
  maxInhoudBytes: Number(process.env.MAX_INHOUD_BYTES ?? 25 * 1024 * 1024),
};
