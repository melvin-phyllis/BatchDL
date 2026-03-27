import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["class"],
  content: ["./renderer/**/*.{ts,tsx}", "./renderer/index.html"],
  theme: {
    extend: {
      colors: {
        background: "#09090b",
        card: "#111113",
        border: "#27272a",
        muted: "#18181b",
        foreground: "#f4f4f5",
        primary: "#4f46e5",
        success: "#16a34a",
        warning: "#f59e0b",
        danger: "#dc2626"
      }
    }
  },
  plugins: []
};

export default config;
