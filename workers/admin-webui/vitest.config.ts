import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // discord-handler と同じく node 環境で純粋ロジックの unit test を回す。
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
