/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/renderer/src/**/*.{js,ts,jsx,tsx}',
    './src/renderer/index.html',
    '../shared-ui/src/**/*.{js,ts,jsx,tsx}'
  ],
  theme: {
    extend: {
      fontSize: { '2xs': '0.65rem' }
    }
  },
  plugins: []
}
