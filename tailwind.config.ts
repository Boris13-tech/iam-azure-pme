import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        // Single LUXIA accent (see app/globals.css tokens).
        accent: { DEFAULT: "#1f5fbf", strong: "#194e9e", soft: "#eaf1fb", line: "#c9dbf3" },
      },
    },
  },
  plugins: [],
};
export default config;