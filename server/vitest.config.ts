import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
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
