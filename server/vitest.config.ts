import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // dist/ (derlenmis build ciktisi) test dosyalarini da otomatik yakalayabiliyor -
    // bu, src/'deki testlerin ESKI/derlenmis bir kopyasini tekrar calistirip her testi
    // iki kez sayardi. Yalnizca kaynak (.ts) testlerle sinirla.
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
    globalSetup: ["./src/test/globalSetup.ts"],
    // Tum test dosyalari ayni SQLite dosyasini paylasiyor (roles/db baglantisi tekil);
    // paralel calisma testler-arasi veri carpismasina yol acabilir, bu yuzden kapali.
    fileParallelism: false,
    env: {
      NODE_ENV: "test",
      DATABASE_PATH: "./data/test.sqlite",
      SESSION_SECRET: "test-session-secret-must-be-at-least-32-characters-long",
      WEB_ORIGIN: "http://localhost:5173",
    },
  },
});
