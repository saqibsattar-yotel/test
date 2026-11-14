/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: ["selector", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        page: "var(--page)",
        surface: { 1: "var(--surface-1)", 2: "var(--surface-2)", 3: "var(--surface-3)" },
        line: "var(--line)",
        ink: { 1: "var(--ink-1)", 2: "var(--ink-2)", 3: "var(--ink-3)" },
        accent: "var(--accent)",
        bull: "var(--bull)",
        bear: "var(--bear)",
        gold: "var(--gold)",
        silver: "var(--silver)",
        warn: "var(--warning)",
        crit: "var(--critical)",
      },
      fontFamily: { sans: ["Inter", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"] },
      boxShadow: { card: "0 1px 0 0 var(--line) inset, 0 8px 24px -16px rgba(0,0,0,0.5)" },
      borderRadius: { xl: "14px" },
    },
  },
  plugins: [],
};
