/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        surface: {
          0: "#0a0a0b",
          1: "#111113",
          2: "#18181b",
          3: "#27272a",
        },
      },
      animation: {
        "progress-fill": "progress-fill 5s linear forwards",
      },
      keyframes: {
        "progress-fill": {
          from: { width: "0%" },
          to:   { width: "100%" },
        },
      },
    },
  },
  plugins: [],
};
