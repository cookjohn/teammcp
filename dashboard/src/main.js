import { createApp } from 'vue'
import { createI18n } from 'vue-i18n'
import App from './App.vue'
import en from './i18n/en.js'
import zh from './i18n/zh.js'
import './assets/variables.css'

// One-time migration: pre-fix users had their language preference stored
// under the legacy key `teammcp_locale` (App.vue's local i18n). Copy it
// over before vue-i18n initializes so the toggle picks up where they left off.
if (!localStorage.getItem('tmcp-lang')) {
  const legacy = localStorage.getItem('teammcp_locale')
  if (legacy === 'en' || legacy === 'zh') localStorage.setItem('tmcp-lang', legacy)
}
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
