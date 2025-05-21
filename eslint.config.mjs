import { off } from 'node:process'
import withNuxt from './.nuxt/eslint.config.mjs'

export default withNuxt({
  rules: {
    '@typescript-eslint/no-explicit-any': 'off',
    'vue/no-multiple-template-root': 0,
    'vue/html-self-closing': off,
    'vue/no-v-html': off,
  },
})
