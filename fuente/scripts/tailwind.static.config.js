// Config de Tailwind para la versión estática (fuente/preview/ → public/)
module.exports = {
  darkMode: 'class',
  content: [__dirname + '/../../public/index.html'], // fuente/scripts → public/ de la raíz
  theme: {
    extend: {
      colors: { ink: '#111214', paper: '#FAF8F4', pulse: '#E5372A', timer: '#F2A93B', catMundo: '#2563EB', catEcon: '#0F9D6B', catArg: '#4A9FD8', catTech: '#7C3AED' },
      fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'], serif: ['Newsreader', 'Georgia', 'serif'] }
    }
  }
};
