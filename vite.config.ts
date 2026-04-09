import { defineConfig } from "vite-plus";
import { createDesignApiPlugin } from "./server/design-api.js";

export default defineConfig({
  plugins: [createDesignApiPlugin()],
  staged: {
    "*": "vp check --fix",
  },
  fmt: {},
  lint: { options: { typeAware: true, typeCheck: true } },
});
