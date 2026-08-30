const production = !process.env.ROLLUP_WATCH;
module.exports = {
  future: {
    purgeLayersByDefault: true,
    removeDeprecatedGapUtilities: true,
  },
  plugins: [],
  purge: {
    content: ["./src/**/*.svelte"],
    enabled: production, // disable purge in dev
  },
  theme: {
    //   screens: {
    //     sm: "480px",
    //     md: "768px",
    //     lg: "976px",
    //     xl: "1440px",
    //   },
    //   colors: {
    //     blue: "#1fb6ff",
    //     pink: "#ff49db",
    //     orange: "#ff7849",
    //     green: "#13ce66",
    //     "gray-dark": "#273444",
    //     gray: "#8492a6",
    //     "gray-light": "#d3dce6",
    //   },
    //   fontFamily: {
    //     sans: ["Graphik", "sans-serif"],
    //     serif: ["Merriweather", "serif"],
    //   },
    //   extend: {
    //     spacing: {
    //       128: "32rem",
    //       144: "36rem",
    //     },
    //     borderRadius: {
    //       "4xl": "2rem",
    //     },
    //   },

    container: {
      center: true,
      padding: {
        DEFAULT: "1rem",
        sm: "2rem",
        lg: "4rem",
        xl: "5rem",
        "2xl": "6rem",
      },
    },
  },
};
