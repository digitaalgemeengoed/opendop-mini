import Ajv2020Module from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";

const Ajv2020 = (Ajv2020Module as unknown as { default?: typeof Ajv2020Module }).default ?? Ajv2020Module;

const ajv = new (Ajv2020 as unknown as new (o: object) => {
  compile: (s: object) => ValidateFunction;
  addKeyword: (k: string) => void;
})({ allErrors: true, strict: false, useDefaults: false });

export interface Toetsing {
  geldig: boolean;
  /** Fouten in wat er wél staat (type, lengte, waardelijst). */
  fouten: { veld: string; melding: string }[];
  /** Verplichte velden die nog leeg zijn. Leeg mag; het object is dan onvolledig. */
  ontbreekt: string[];
}

const cache = new Map<string, { volledig: ValidateFunction; gedeeltelijk: ValidateFunction }>();

/**
 * Toetst metadata tegen het schema van een objecttype. Een object mag
 * onvolledig zijn (dat signaleert de assistent), maar wat er staat moet
 * kloppen.
 */
export function toets(sleutel: string, schema: Record<string, unknown>, metadata: unknown): Toetsing {
  let v = cache.get(sleutel);
  if (!v) {
    const { required: _verplicht, ...zonderVerplicht } = schema as { required?: string[] };
    v = { volledig: ajv.compile(schema), gedeeltelijk: ajv.compile(zonderVerplicht) };
    cache.set(sleutel, v);
  }
  const geldig = v.gedeeltelijk(metadata) as boolean;
  const fouten = geldig ? [] : (v.gedeeltelijk.errors ?? []).map(leesbaar);
  const verplicht = ((schema as { required?: string[] }).required ?? []) as string[];
  const m = (metadata ?? {}) as Record<string, unknown>;
  const ontbreekt = verplicht.filter((veld) => m[veld] === undefined || m[veld] === null || m[veld] === "");
  return { geldig, fouten, ontbreekt };
}

function leesbaar(e: ErrorObject): { veld: string; melding: string } {
  const veld = e.instancePath.replace(/^\//, "") || String((e.params as { additionalProperty?: string }).additionalProperty ?? "");
  switch (e.keyword) {
    case "enum":
      return { veld, melding: "Kies een waarde uit de lijst." };
    case "maxLength":
      return { veld, melding: `Maximaal ${(e.params as { limit: number }).limit} tekens.` };
    case "minLength":
      return { veld, melding: `Minimaal ${(e.params as { limit: number }).limit} tekens.` };
    case "additionalProperties":
      return { veld, melding: "Dit veld hoort niet bij het objecttype." };
    case "pattern":
      return { veld, melding: "De waarde heeft niet de juiste vorm." };
    case "type":
      return { veld, melding: `Verwacht: ${(e.params as { type: string }).type}.` };
    default:
      return { veld, melding: e.message ?? "Ongeldige waarde." };
  }
}

/** Toetst of een schema zelf bruikbaar is (voor het publiceren van objecttypen). */
export function schemaBruikbaar(schema: unknown): string | null {
  try {
    ajv.compile(schema as object);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}
