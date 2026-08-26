import { defineConfig } from "vitest/config";

/**
 * Web tarafinda test kosulan yer, DOM'a ihtiyac duymayan saf hesaplama modulleridir
 * (ör. kiosk/sunTimes.ts). Bilesen testleri icin bir DOM ortami gerekirse burada
 * environment degistirilir; bugun boyle bir test yok, gereksiz bagimlilik eklenmedi.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
  },
});
