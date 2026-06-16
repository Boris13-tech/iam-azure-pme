// @ts-nocheck
import { defineConfig } from '@prisma/config';

export default defineConfig({
  studio: {
    port: 5555
  },
  datasource: {
    url: "file:./dev.db"
  }
});