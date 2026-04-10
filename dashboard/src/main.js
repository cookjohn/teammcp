import { createApp } from 'vue'
import { createI18n } from 'vue-i18n'
import App from './App.vue'
import en from './i18n/en.js'
import zh from './i18n/zh.js'
import './assets/variables.css'

// Determine initial locale from localStorage or browser
const savedLang = localStorage.getItem('tmcp-lang') || 'en'
const i18n = createI18n({
  legacy: false,  // use Composition API mode
  locale: savedLang,
  fallbackLocale: 'en',
  messages: { en, zh }
})

const app = createApp(App)
app.use(i18n)
app.mount('#app')
