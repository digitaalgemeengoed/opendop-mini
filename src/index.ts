import { config } from "./config.js";
import { maakPool } from "./db.js";
import { maakOpslag } from "./opslag.js";
import { bouwServer } from "./server.js";
import { leesGemeenten, migreer } from "./migreer.js";
import { draaiWorker } from "./worker.js";

const opdracht = process.argv[2] ?? "server";

if (opdracht === "migreer") {
  await migreer(config.databaseUrlBeheer(), {
    appWachtwoord: config.appWachtwoord(),
    gemeenten: leesGemeenten(process.env.GEMEENTEN),
  });
} else if (opdracht === "worker") {
  await draaiWorker(config.databaseUrlBeheer());
  console.log("outbox-worker draait");
} else {
  maakPool(config.databaseUrl());
  const opslag = maakOpslag();
  const app = bouwServer({ opslag, dienstsleutel: config.dienstsleutel(), maxBytes: config.maxInhoudBytes });
  await app.listen({ port: config.poort, host: config.host });
}
